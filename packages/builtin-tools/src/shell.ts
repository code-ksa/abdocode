/**
 * Shell tool — runs a command, but SAFELY:
 *   - high risk => routed through the approval gate by the policy engine
 *   - dangerous commands are caught by the runner's danger guard before here
 *   - honors ctx.signal (run cancel / timeout) AND its own timeout, and on abort
 *     kills the whole PROCESS TREE (taskkill /T on Windows, SIGKILL elsewhere) so
 *     a child shell never survives a cancelled run
 *
 * CL-16A2-B: this tool DOES NOT SPAWN. It builds the command, the verified cwd
 * and the complete child environment, then hands them to
 * `launchControlledProcess` — the one place a governed process starts. The CL-00A
 * guard enforces that by forbidding the process-execution primitive in this file,
 * so "the shell could still spawn directly" is not a state the codebase can
 * reach. Isolation, cancellation, the timeout, the process-tree kill and the
 * durable isolation record all live there; classification and the structured
 * failure contract stay here.
 *
 * FAILURES ARE STRUCTURED, NEVER POOR. `exit 1` with empty stdout/stderr must
 * still return exitCode/stdout/stderr/timedOut/aborted/durationMs/command plus
 * an honest `diagnostic` and a provable `failureClass` — a bare "exit 1: " gives
 * the model zero new information and drives blind identical retries (the
 * long-0 `npx jest` loop, 2026-07-23). A stable `resultFingerprint` (excludes
 * durationMs) lets the runtime detect that an identical call produced the
 * IDENTICAL result, not merely that it was invoked with the same arguments.
 */
import { createHash } from "crypto"
import {
  INHERIT_PROFILE,
  UNMEASURED_CAPABILITY,
  launchControlledProcess,
  policy,
  type ControlledExecutionGrant,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "@abdo/tools"
import { resolveInWorkspace } from "./workspace"
import { stripChildEnv } from "@abdo/tools/env-strip"

const DEFAULT_TIMEOUT_MS = 30_000

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex")

/** Only what the system can PROVE — never a guessed cause. */
export type ShellFailureClass =
  | "command_not_found" // bash exit 127 is definitionally "command not found"
  | "process_spawn_failed" // the shell process itself could not start
  | "nonzero_exit"
  | "empty_failure_output" // nonzero exit AND no stdout AND no stderr
  | "timeout"
  | "aborted"
  | "isolation_refused" // CL-16A2-B: the launcher refused BEFORE starting anything

export interface ShellOutput {
  readonly command: string
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly durationMs: number
  readonly failureClass?: ShellFailureClass
  readonly diagnostic?: string
}

function classify(exitCode: number | null, stdout: string, stderr: string, timedOut: boolean, aborted: boolean): ShellFailureClass {
  if (aborted) return "aborted"
  if (timedOut) return "timeout"
  if (exitCode === 127) return "command_not_found"
  if (stdout.length === 0 && stderr.length === 0) return "empty_failure_output"
  return "nonzero_exit"
}

function diagnose(cls: ShellFailureClass, exitCode: number | null, timeoutMs: number): string {
  switch (cls) {
    case "aborted":
      return "Command was aborted (run cancelled) before completing."
    case "timeout":
      return `Command was killed after ${timeoutMs}ms without completing.`
    case "command_not_found":
      return "Exit code 127: the command was not found. The tool/binary is not installed or not on PATH in this workspace."
    case "empty_failure_output":
      return `Command exited with code ${exitCode} and produced no stdout or stderr. Re-running it unchanged will return this exact result again.`
    case "nonzero_exit":
      return `Command exited with code ${exitCode}.`
    case "process_spawn_failed":
      return "The shell process itself failed to start."
    case "isolation_refused":
      return "The required execution isolation could not be delivered; nothing was executed."
  }
}

/** Stable across identical re-runs: durationMs deliberately excluded. */
function fingerprint(command: string, cwdRel: string, out: Omit<ShellOutput, "durationMs" | "diagnostic">): string {
  return sha256(
    JSON.stringify({
      tool: "shell",
      command,
      cwd: cwdRel,
      exitCode: out.exitCode,
      stdoutHash: sha256(out.stdout),
      stderrHash: sha256(out.stderr),
      timedOut: out.timedOut,
      aborted: out.aborted,
    }),
  )
}

export function shellTool(workspace: string): ToolDefinition {
  return {
    name: "shell",
    policy: policy({ risk: "high", requiresApproval: true, timeoutMs: DEFAULT_TIMEOUT_MS }),
    description: "Run a bash command inside the workspace. Requires approval.",
    // The enforcement point may hand this tool an environment it must apply
    // ABOVE the inherited one (CL-11 `suppressImplicitLifecycleScripts`). Declaring it is what
    // makes a constrained execution legal here at all: the PEP refuses to run a
    // constrained call on a tool that has not.
    honorsEnvOverlay: true,
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The bash command to run" },
        cwd: { type: "string", description: "Workspace-relative working dir (default '.')" },
        timeoutMs: { type: "integer", description: "Kill after this many ms (default 30000)" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async run(input, ctx: ToolContext): Promise<ToolResult> {
      const command = typeof (input as { command?: unknown }).command === "string" ? (input as { command: string }).command : ""
      if (!command) return { ok: false, error: "shell requires { command }" }
      const cwdRel = typeof (input as { cwd?: unknown }).cwd === "string" ? (input as { cwd: string }).cwd : "."
      const timeoutMs = Number((input as { timeoutMs?: unknown }).timeoutMs) || DEFAULT_TIMEOUT_MS

      let cwd: string
      try {
        cwd = resolveInWorkspace(workspace, cwdRel)
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
      if (ctx.dryRun) return { ok: true, output: { command, dryRun: true } }

      // The COMPLETE child environment, written down here rather than inherited.
      // MEASURED on Bun 1.3.14: mutating `process.env` after startup does not
      // reach a child, so an implicit inherit and an explicit env are different
      // things — and only the explicit one is auditable. The overlay goes LAST,
      // so it beats the inherited environment and anything this tool would
      // otherwise set. It cannot reach an inline assignment inside the command
      // text (`VAR=x npm install`), which is why the decision point refuses to
      // claim the constraint whenever the command writes a protected key at all.
      // نزعُ الاعتمادات: هذه الأداةُ مسجَّلةٌ مطفأةً في المحرّك، والحارسُ
      // يُوضع قبل أن تُشعل لا بعدها — أداةٌ صدفةٍ كاملةٍ هي أوسعُ سطحٍ ممكن.
      const { env: childEnv } = stripChildEnv(process.env)
      Object.assign(childEnv, ctx.envOverlay ?? {})

      // The isolation this run gets comes from the ENFORCEMENT POINT. There is
      // deliberately no way to read it out of `input`: the schema forbids extra
      // properties, and this line reads `ctx`, which the model cannot write.
      const grant: ControlledExecutionGrant = ctx.execution ?? { profile: INHERIT_PROFILE, capability: UNMEASURED_CAPABILITY, approvalGranted: false }

      const t0 = Date.now()
      const res = await launchControlledProcess({
        executable: "bash",
        argv: ["-lc", command],
        cwd,
        env: childEnv,
        isolationProfile: grant.profile,
        capability: grant.capability,
        cancellation: ctx.signal,
        timeoutMs,
        evidence: grant,
      })

      // REFUSED: the isolation the decision assumed could not be delivered, or
      // something it rested on moved. No process ran; say exactly that.
      if (res.outcome === "refused") {
        const base = { command, exitCode: null, stdout: "", stderr: "", timedOut: false, aborted: false }
        const output: ShellOutput = {
          ...base,
          durationMs: res.durationMs,
          failureClass: "isolation_refused",
          diagnostic: `${res.reasonCode}: ${res.detail}. Nothing was executed.`,
        }
        return { ok: false, error: output.diagnostic!, output, resultFingerprint: fingerprint(command, cwdRel, { ...base, failureClass: "isolation_refused" }) }
      }
      if (res.outcome === "spawn_failed") {
        const base = { command, exitCode: null, stdout: "", stderr: "", timedOut: false, aborted: false }
        const output: ShellOutput = {
          ...base,
          durationMs: res.durationMs,
          failureClass: "process_spawn_failed",
          diagnostic: `The shell process itself failed to start: ${res.detail}`,
        }
        return { ok: false, error: output.diagnostic!, output, resultFingerprint: fingerprint(command, cwdRel, { ...base, failureClass: "process_spawn_failed" }) }
      }

      const { stdout, stderr, exitCode, timedOut, aborted } = res
      const durationMs = Date.now() - t0
      if (exitCode === 0 && !timedOut && !aborted) {
        const output: ShellOutput = { command, exitCode, stdout, stderr, timedOut: false, aborted: false, durationMs }
        return { ok: true, output, resultFingerprint: fingerprint(command, cwdRel, output) }
      }
      const cls = classify(exitCode, stdout, stderr, timedOut, aborted)
      const diagnostic = diagnose(cls, exitCode, timeoutMs)
      const output: ShellOutput = { command, exitCode, stdout, stderr, timedOut, aborted, durationMs, failureClass: cls, diagnostic }
      // The error string carries the PROVEN facts (class + code + diagnostic +
      // any captured output) — never a bare "exit 1: " with nothing behind it.
      const error = `${cls} (exit ${exitCode}): ${diagnostic}${stderr ? `\nstderr: ${stderr.slice(0, 500)}` : ""}${stdout ? `\nstdout: ${stdout.slice(0, 500)}` : ""}`
      return { ok: false, error, output, resultFingerprint: fingerprint(command, cwdRel, output) }
    },
  }
}
