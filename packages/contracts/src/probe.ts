/**
 * Capability probes (Sprint 29) — `--version` is not evidence.
 *
 * Sprint 19 asked what a project ALREADY HAS. This asks a different question:
 * what can this machine actually DO, right now, for the task about to start.
 * The distinction matters because the usual check is a version string, and a
 * version string is the weakest possible signal:
 *
 *   docker --version   succeeds when the daemon is dead
 *   node --version     succeeds when the module resolution is broken
 *   psql --version     succeeds with no server, no credentials, no database
 *   git --version      succeeds inside a directory git refuses to operate on
 *
 * Every one of those produces a confident start and a failure twenty minutes
 * in, at the point where something has already been half-changed. So a probe
 * EXERCISES the capability: `docker run --rm hello-world`, a real query, an
 * actual clone. It costs a second and it buys the difference between "the
 * binary exists" and "this will work".
 *
 * Three states, because two would force a lie:
 *
 *   READY     the probe did the thing and it worked
 *   DEGRADED  it works with a limitation that matters — no network, no GPU,
 *             read-only, an old version below what the task needs
 *   FAILED    it does not work, or could not be probed at all
 *
 * DEGRADED is the state that earns its keep. Collapsing it into READY starts
 * tasks that cannot finish; collapsing it into FAILED refuses tasks that would
 * have been fine. The task says which it can tolerate.
 */

export type ProbeStatus = "ready" | "degraded" | "failed"

export type ProbeName =
  | "git"
  | "node"
  | "python"
  | "docker"
  | "browser"
  | "playwright"
  | "lsp"
  | "database"
  | "local_model"
  | "mcp"
  | "ssh"
  | "gpu"

export interface ProbeResult {
  readonly name: ProbeName
  readonly status: ProbeStatus
  /** What was actually run to find out — never "checked docker". */
  readonly evidence: string
  /** Why it is degraded or failed, in words a human can act on. */
  readonly detail?: string
  readonly version?: string
  readonly durationMs: number
}

export interface DoctorReport {
  readonly probes: readonly ProbeResult[]
  readonly at: number
  readonly ready: readonly ProbeName[]
  readonly degraded: readonly ProbeName[]
  readonly failed: readonly ProbeName[]
}

export function summariseProbes(probes: readonly ProbeResult[], at = 0): DoctorReport {
  const by = (status: ProbeStatus) => probes.filter((p) => p.status === status).map((p) => p.name)
  return { probes, at, ready: by("ready"), degraded: by("degraded"), failed: by("failed") }
}

/** What a task says it needs, and how much imperfection it can live with. */
export interface CapabilityRequirement {
  readonly name: ProbeName
  /** Whether a DEGRADED capability is good enough for this task. */
  readonly degradedAcceptable?: boolean
  /** Why the task needs it — quoted back in the refusal. */
  readonly why: string
}

export interface StartDecision {
  readonly allowed: boolean
  readonly blockedBy: readonly { readonly name: ProbeName; readonly status: ProbeStatus; readonly why: string }[]
  readonly warnings: readonly string[]
  readonly reason: string
}

/**
 * May a long task start?
 *
 * The rule the gate cares about: a task does NOT begin while a capability it
 * needs is DEGRADED or FAILED. Not "starts and handles it later" — an agent
 * that discovers at step 40 that docker never worked has already made forty
 * steps' worth of changes on a false premise, and the cleanup is worse than
 * the refusal would have been.
 *
 * A requirement that was never probed blocks too. "I did not look" is not
 * "it is fine" — the distinction this whole program keeps insisting on.
 */
export function canStart(
  report: DoctorReport,
  requirements: readonly CapabilityRequirement[],
): StartDecision {
  const blockedBy: { name: ProbeName; status: ProbeStatus; why: string }[] = []
  const warnings: string[] = []

  for (const requirement of requirements) {
    const probe = report.probes.find((p) => p.name === requirement.name)
    if (probe === undefined) {
      blockedBy.push({
        name: requirement.name,
        status: "failed",
        why: `${requirement.name} was never probed — "not checked" is not "working" (needed: ${requirement.why})`,
      })
      continue
    }
    if (probe.status === "failed") {
      blockedBy.push({
        name: requirement.name,
        status: "failed",
        why: `${requirement.name} failed its probe (${probe.detail ?? probe.evidence}) — needed: ${requirement.why}`,
      })
      continue
    }
    if (probe.status === "degraded") {
      if (requirement.degradedAcceptable === true) {
        warnings.push(`${requirement.name} is degraded (${probe.detail ?? "limited"}) and the task accepts that`)
      } else {
        blockedBy.push({
          name: requirement.name,
          status: "degraded",
          why: `${requirement.name} is degraded (${probe.detail ?? "limited"}) — needed: ${requirement.why}`,
        })
      }
    }
  }

  return {
    allowed: blockedBy.length === 0,
    blockedBy,
    warnings,
    reason:
      blockedBy.length === 0
        ? `all ${requirements.length} required capabilities are usable${warnings.length > 0 ? ` (${warnings.length} degraded and accepted)` : ""}`
        : `${blockedBy.length} capability requirement(s) are not met: ${blockedBy.map((b) => `${b.name}=${b.status}`).join(", ")}`,
  }
}

/** The report as `abdo doctor` prints it. */
export function formatDoctor(report: DoctorReport): string {
  const mark = (s: ProbeStatus) => (s === "ready" ? "ok  " : s === "degraded" ? "warn" : "FAIL")
  const lines = report.probes.map(
    (p) =>
      `${mark(p.status)}  ${p.name.padEnd(12)} ${p.evidence}` +
      (p.version !== undefined ? ` (${p.version})` : "") +
      (p.detail !== undefined ? ` — ${p.detail}` : ""),
  )
  lines.push(
    `\n${report.ready.length} ready, ${report.degraded.length} degraded, ${report.failed.length} failed`,
  )
  return lines.join("\n")
}
