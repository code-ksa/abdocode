/**
 * Agent modes (Sprint 25) — what the agent may do at all, before anyone asks
 * whether it may do it this time.
 *
 * Sprint 20 answered "does this operation need a permit or a human?". This
 * answers a question that comes first: is an operation of this KIND even on the
 * table right now. An agent exploring a codebase has no business writing to it,
 * and the way to guarantee that is not to instruct it politely — it is to make
 * the write impossible at the enforcement point.
 *
 * A mode is a CEILING, never a grant. It can only remove permissions; every
 * permit and approval from Sprint 20 still applies underneath. DEPLOY does not
 * mean "may deploy", it means "deploying is not excluded by the mode, now go
 * and satisfy the policy engine like everything else". Reading a mode as a
 * grant would turn the ceiling into a floor and quietly widen access.
 *
 * The mode is set by the RUNTIME for a run. It is deliberately not reachable
 * from tool input: a mode a model can choose is a mode a model can leave.
 */
import type { RiskClass } from "./riskclass"

export type AgentMode =
  /** Looking around. Nothing is written anywhere. */
  | "EXPLORE"
  /** Deciding what to do. Still nothing is written. */
  | "PLAN"
  /** Doing the work, inside this workspace. */
  | "BUILD"
  /** Checking the work. Reads, plus whatever a check itself writes. */
  | "VERIFY"
  /** Shipping. Production and external effects become possible — not granted. */
  | "DEPLOY"
  /** Putting things back. Destructive compensation becomes possible. */
  | "RECOVER"

export const AGENT_MODES: readonly AgentMode[] = ["EXPLORE", "PLAN", "BUILD", "VERIFY", "DEPLOY", "RECOVER"]

/**
 * The risk classes each mode leaves on the table.
 *
 * `credential_use` is allowed from BUILD onward because real work reads
 * configuration, and it still requires its permit.
 *
 * `external_side_effect` is allowed in BUILD, and the first version of this
 * table excluded it "on purpose" — on the theory that a build reaching the
 * network is either a dependency install with its own governed path, or
 * something nobody asked for. There is no separate governed path: an install
 * goes through the same tool as everything else, and CL-05 rates
 * `package.install` as an external side effect. So the exclusion did not stop
 * something suspicious, it stopped `npm install` — it made BUILD unable to
 * build. Four crash-recovery tests failed on it within minutes.
 *
 * The control that belongs here stays where Sprint 20 put it: an external side
 * effect still requires a human approval. The mode's job is the ceiling, and a
 * ceiling that excludes the ordinary case is a ceiling people remove.
 */
export const MODE_ALLOWS: Readonly<Record<AgentMode, readonly RiskClass[]>> = {
  EXPLORE: ["read"],
  PLAN: ["read"],
  BUILD: ["read", "local_write", "credential_use", "external_side_effect"],
  VERIFY: ["read", "local_write"],
  DEPLOY: ["read", "local_write", "credential_use", "production_write", "external_side_effect", "financial"],
  RECOVER: ["read", "local_write", "credential_use", "destructive"],
}

export interface ModeVerdict {
  readonly allowed: boolean
  readonly mode: AgentMode
  /** The classes that the mode does not permit — empty when allowed. */
  readonly excluded: readonly RiskClass[]
  readonly reason: string
}

/**
 * Is an operation of these classes permitted in this mode?
 *
 * Every class must be allowed. An operation that is a local write AND a
 * production write is not made acceptable in BUILD by the local half — the
 * strictest reading wins, the same rule Sprint 20 applies to requirements.
 */
export function evaluateMode(mode: AgentMode, classes: readonly RiskClass[]): ModeVerdict {
  const allowed = MODE_ALLOWS[mode]
  const excluded = classes.filter((c) => !allowed.includes(c))
  return excluded.length === 0
    ? { allowed: true, mode, excluded: [], reason: `${mode} permits ${classes.join(", ") || "read"}` }
    : {
        allowed: false,
        mode,
        excluded,
        reason: `${mode} does not permit ${excluded.join(", ")} — this operation needs a mode that does`,
      }
}

/** The narrowest mode that would permit these classes, for a helpful refusal. */
export function narrowestModeFor(classes: readonly RiskClass[]): AgentMode | undefined {
  return AGENT_MODES.find((mode) => evaluateMode(mode, classes).allowed)
}

/**
 * Modes that write nothing at all. Kept as a list rather than a predicate so a
 * new read-only mode has to be added here deliberately.
 */
export const READ_ONLY_MODES: readonly AgentMode[] = ["EXPLORE", "PLAN"]

export const isReadOnlyMode = (mode: AgentMode): boolean => READ_ONLY_MODES.includes(mode)
