/**
 * `run_command` (Sprint 21) — the structured sibling of the shell tool.
 *
 * Identical governance: it does not spawn, it hands a verified cwd, an explicit
 * child environment and the isolation grant to `launchControlledProcess`, which
 * is the one place a governed process starts. The difference is upstream — the
 * caller supplies an executable and an ARRAY of arguments, so nothing is ever
 * concatenated into a sentence that has to be quoted correctly on the way back
 * out. There is no quoting to get wrong when there is no string.
 */
import { createHash } from "crypto"
import { repairCommandSpec } from "./repair-command"
import { stripChildEnv } from "@abdo/tools/env-strip"
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
import { renderForDisplay, toArgv, validateCommand, type CommandSpec } from "./command"
import { resolveInWorkspace } from "./workspace"

const DEFAULT_TIMEOUT_MS = 30_000
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex")

export interface RunCommandOutput {
  /** For humans and logs. NOT what ran — `argv` is what ran. */
  readonly display: string
  readonly argv: readonly string[]
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly durationMs: number
  readonly failureClass?: string
  readonly diagnostic?: string
  /**
   * Set when the call was mechanically repaired before running (Sprint 47).
   *
   * The repair's whole justification is that it is MARKED, so a call that
   * needed fixing never looks identical to one that arrived correct — and the
   * mark was only ever emitted on the failure path. A repair nobody is told
   * about teaches the model that its malformed shape works.
   */
  readonly repaired?: string
}

export function runCommandTool(workspace: string): ToolDefinition {
  return {
    name: "run_command",
    policy: policy({ risk: "high", requiresApproval: true, timeoutMs: DEFAULT_TIMEOUT_MS }),
    description:
      "Run a program with an explicit argument array (no shell). Use this whenever the command has no pipes, redirection or globbing — arguments reach the process exactly as given.",
    honorsEnvOverlay: true,
    inputSchema: {
      type: "object",
      properties: {
        executable: { type: "string", description: "The program to run (no arguments baked in)" },
        args: { type: "array", description: "Arguments, one per element, unquoted — never pre-quoted" },
        cwd: { type: "string", description: "Workspace-relative working dir (default '.')" },
        timeoutMs: { type: "integer", description: "Kill after this many ms (default 30000)" },
      },
      required: ["executable"],
      additionalProperties: false,
    },
    async run(input, ctx: ToolContext): Promise<ToolResult> {
      const raw = (input ?? {}) as Partial<CommandSpec>
      const spec: CommandSpec = {
        executable: typeof raw.executable === "string" ? raw.executable : "",
        args: Array.isArray(raw.args) ? raw.args : [],
        ...(typeof raw.cwd === "string" ? { cwd: raw.cwd } : {}),
        ...(typeof raw.timeoutMs === "number" ? { timeoutMs: raw.timeoutMs } : {}),
      }

      // Sprint 47, wired live after a 2B model sent `executable: "ls -la data/"`
      // five times across three runs — with the error message telling it plainly
      // each time what the two fields are for. A mechanically repairable
      // argument should be repaired rather than refused; a run that dies of a
      // formatting convention has failed for no reason.
      //
      // The repair is bounded (one shape of mistake), mechanical (a quote-aware
      // split, never a model asked what was meant), and MARKED — the result
      // says it was repaired, so a call that needed fixing never looks
      // identical to one that arrived correct.
      const repair = repairCommandSpec(spec)
      const effective = repair.spec

      const problems = validateCommand(effective)
      if (problems.length > 0) {
        // A list of what is wrong, because the caller is usually a model and a
        // list is actionable where a stack trace is not. When the repair
        // DECLINED — shell features, or a contradictory args[] — its reason is
        // the more useful half and goes first.
        const detail = problems.map((p) => `${p.field}: ${p.detail}`).join("; ")
        return { ok: false, error: `invalid command: ${repair.note !== undefined ? `${repair.note} | ` : ""}${detail}` }
      }

      let cwd: string
      try {
        cwd = resolveInWorkspace(workspace, effective.cwd ?? ".")
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }

      // FOUND BY AUDIT (2026-08-20): everything below used `spec`, the
      // UNREPAIRED input, while `validateCommand` above judged `effective`.
      // The gate approved one command and the runtime ran a different one — so
      // Sprint 47's repair, which exists precisely because a 2B model sent
      // `executable: "ls -la data/"` five times, was computed, validated, and
      // then discarded. The model's malformed call passed the check and then
      // failed at exec, which is the worst of both: the guard says yes and the
      // work still does not happen.
      const argv = toArgv(effective)
      const display = renderForDisplay(effective)
      if (ctx.dryRun) return { ok: true, output: { display, argv, dryRun: true } }

      // نزعُ الاعتمادات قبل التسليم. كان هذا نسخاً كاملاً لـ`process.env`،
      // فأمرٌ واحدٌ يوافق عليه المشغّل يقرأ `ABDO_SHELL_TOKEN` (وبه تُنتحل
      // القشرة على أنبوبها) وكلَّ ما تحمله جلسةُ ويندوز من اعتمادات المشغّل.
      // النزعُ هنا لا في `isolationEnv`: تغييرُ `ISOLATION_STRIPPED_ENV` يحرّك
      // `launcherIdentity()` التي يقارنها حارسُ TOCTOU ببصمةٍ مسجَّلة — وذاك
      // رفعُ نسخةٍ مقصود لا إصلاحٌ عابر.
      // ⚠ حدُّه المقيس: يغلق رمزَ القشرة واعتماداتِ البيئة، **ولا يغلق
      // الخزنة** — فهي DPAPI لمستخدم ويندوز نفسه تحت APPDATA، وابنٌ يعمل
      // بالمستخدم ذاته يفكّها بصرف النظر عمّا ورث. يُقال بحدّه لا أوسع.
      const { env: childEnv } = stripChildEnv(process.env)
      Object.assign(childEnv, ctx.envOverlay ?? {})

      const grant: ControlledExecutionGrant =
        ctx.execution ?? { profile: INHERIT_PROFILE, capability: UNMEASURED_CAPABILITY, approvalGranted: false }

      const res = await launchControlledProcess({
        executable: effective.executable,
        argv: [...effective.args],
        cwd,
        env: childEnv,
        isolationProfile: grant.profile,
        capability: grant.capability,
        cancellation: ctx.signal,
        // البثُّ يمرّ كما هو: الأداةُ لا تفسّره ولا تعيد تجميعه — تمريرةٌ
        // واحدةٌ من المُطلِق إلى من يعرض، فلا موضعَ ثانٍ يقصّ أو يبدّل.
        ...(ctx.onOutput === undefined ? {} : { onOutput: ctx.onOutput }),
        timeoutMs: effective.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        evidence: grant,
      })

      if (res.outcome === "refused") {
        const output: RunCommandOutput = {
          display,
          argv,
          exitCode: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          aborted: false,
          durationMs: res.durationMs,
          failureClass: "isolation_refused",
          diagnostic: res.detail,
        }
        return {
          ok: false,
          error: `isolation_refused: ${res.reasonCode}: ${res.detail}`,
          output,
          resultFingerprint: sha256(`refused:${display}:${res.detail}`),
        }
      }

      // The launcher has a third outcome: the process never started. Treated as
      // its own class, because "could not start" and "ran and failed" call for
      // different next moves.
      if (res.outcome === "spawn_failed") {
        const output: RunCommandOutput = {
          display,
          argv,
          exitCode: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          aborted: false,
          durationMs: res.durationMs,
          failureClass: res.reasonCode,
          diagnostic: res.detail,
        }
        return {
          ok: false,
          error: `${res.reasonCode}: ${res.detail}`,
          output,
          resultFingerprint: sha256(`spawn_failed:${display}:${res.detail}`),
        }
      }

      const output: RunCommandOutput = {
        display,
        argv,
        exitCode: res.exitCode,
        stdout: res.stdout,
        stderr: res.stderr,
        timedOut: res.timedOut,
        aborted: res.aborted,
        durationMs: res.durationMs,
        ...(repair.note !== undefined ? { repaired: repair.note } : {}),
      }
      const fingerprint = sha256([display, String(res.exitCode), sha256(res.stdout), sha256(res.stderr)].join("\0"))

      if (res.exitCode === 0 && !res.timedOut && !res.aborted) {
        return { ok: true, output, resultFingerprint: fingerprint }
      }
      const failureClass = res.timedOut ? "timeout" : res.aborted ? "aborted" : "nonzero_exit"
      return {
        ok: false,
        error: `${failureClass}: ${display}`,
        output: { ...output, failureClass },
        resultFingerprint: fingerprint,
      }
    },
  }
}
