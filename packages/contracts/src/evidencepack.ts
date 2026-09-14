/**
 * The evidence pack (Sprint 30) — one question, answered from one place.
 *
 * The question is "why was sprint N considered done?", and it is asked months
 * later, usually by someone who was not there, usually because something broke.
 * Today the answer is spread across a run's receipts, a mission's transitions,
 * a verification verdict and a commit, and reconstructing it means knowing
 * which four things to fold and in what order. That is a skill, and an answer
 * that depends on a skill is an answer most people will not get.
 *
 * So the pack is assembled ONCE, at close, from the log — and it is assembled
 * from the same facts the gates used, not from a summary written afterwards.
 * The rule that keeps it honest: the pack records what the evidence SAYS,
 * including when the evidence is thin. A pack that cannot show a verdict says
 * so in the field where the verdict belongs, rather than omitting the field and
 * reading like a clean sprint.
 */
import type { DomainEvent } from "./event"
import { currentVerdict, type VerificationRecord } from "./verification"
import { foldMissions, type SprintRecord } from "./mission"

export const EvidencePackEventTypes = {
  Assembled: "evidence.pack_assembled",
} as const

export interface CommandEvidence {
  readonly command: string
  readonly exitCode: number | null
  readonly at: number
}

export interface TestEvidence {
  readonly suite: string
  readonly passed: number
  readonly failed: number
  readonly command?: string
}

export interface EvidencePack {
  readonly sprintId: string
  readonly missionId: string
  readonly title: string
  readonly state: string
  /** What the sprint said it had to achieve, before it started. */
  readonly acceptance: readonly string[]
  readonly runIds: readonly string[]
  /** Files the work touched, from the receipts rather than from a claim. */
  readonly filesChanged: readonly string[]
  readonly commands: readonly CommandEvidence[]
  readonly tests: readonly TestEvidence[]
  /** The Sprint 27 verdict, or the absence of one, stated either way. */
  readonly verdict?: VerificationRecord
  readonly verdictMissing?: string
  readonly commit?: string
  /** Where to go back to if this turns out to be wrong. */
  readonly rollbackPoint?: string
  /** Every state the sprint passed through, with reasons. */
  readonly history: readonly { readonly state: string; readonly at: number; readonly reason?: string }[]
  /** What the pack could NOT establish. Never empty by omission. */
  readonly gaps: readonly string[]
  readonly assembledAt: number
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined)

/**
 * Assemble the pack for one sprint from a log.
 *
 * `gaps` is the field that makes this usable. Every pack states what it could
 * not establish — no commands recorded, no tests recorded, no verdict, no
 * commit — because the alternative is a pack with three empty arrays that looks
 * exactly like a sprint which genuinely needed none of them.
 */
export function assembleEvidencePack(
  events: readonly DomainEvent[],
  sprintId: string,
  now = 0,
): EvidencePack | undefined {
  const mission = foldMissions(events).find((m) => m.sprints.some((s) => s.sprintId === sprintId))
  const sprint: SprintRecord | undefined = mission?.sprints.find((s) => s.sprintId === sprintId)
  if (mission === undefined || sprint === undefined) return undefined

  const runIds = [...new Set(sprint.tasks.flatMap((t) => t.runIds))]
  const runSet = new Set(runIds)

  const filesChanged = new Set<string>()
  const commands: CommandEvidence[] = []
  const tests: TestEvidence[] = []
  let rollbackPoint: string | undefined

  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, unknown>
    const runId = str(data.runId)
    // events that belong to this sprint's runs, plus sprint-scoped ones
    if (runId !== undefined && !runSet.has(runId)) continue

    switch (event.type) {
      case "tool.executed": {
        const path = str(data.path)
        if (path !== undefined) filesChanged.add(path)
        const command = str(data.command)
        if (command !== undefined) commands.push({ command, exitCode: num(data.exitCode) ?? null, at: event.occurredAt })
        break
      }
      case "command.completed": {
        const command = str(data.command)
        if (command !== undefined) commands.push({ command, exitCode: num(data.exitCode) ?? null, at: event.occurredAt })
        break
      }
      case "test.completed": {
        const suite = str(data.suite)
        if (suite !== undefined) {
          tests.push({
            suite,
            passed: num(data.passed) ?? 0,
            failed: num(data.failed) ?? 0,
            ...(str(data.command) !== undefined ? { command: str(data.command)! } : {}),
          })
        }
        break
      }
      case "reconciliation.checked": {
        // the HEAD the sprint started from is the point it can be undone to
        const head = str(data.head)
        if (head !== undefined && rollbackPoint === undefined) rollbackPoint = head
        break
      }
      case "workspace.released":
      case "workspace.abandoned": {
        for (const p of Array.isArray(data.changed) ? data.changed : []) {
          if (typeof p === "string") filesChanged.add(p)
        }
        break
      }
    }
  }

  const verdict = currentVerdict(events, sprintId)
  const gaps: string[] = []
  if (verdict === undefined) gaps.push("no verification verdict was recorded — nothing independent judged this work")
  if (commands.length === 0) gaps.push("no commands were recorded")
  if (tests.length === 0) gaps.push("no test results were recorded")
  if (filesChanged.size === 0) gaps.push("no file changes were recorded")
  if (sprint.commit === undefined) gaps.push("no commit was recorded")
  if (rollbackPoint === undefined) gaps.push("no rollback point was recorded — there is no stated state to return to")

  return {
    sprintId,
    missionId: mission.missionId,
    title: sprint.title,
    state: sprint.state,
    acceptance: sprint.acceptance,
    runIds,
    filesChanged: [...filesChanged].sort(),
    commands,
    tests,
    ...(verdict !== undefined
      ? { verdict }
      : { verdictMissing: "no verification verdict exists for this sprint" }),
    ...(sprint.commit !== undefined ? { commit: sprint.commit } : {}),
    ...(rollbackPoint !== undefined ? { rollbackPoint } : {}),
    history: sprint.history,
    gaps,
    assembledAt: now,
  }
}

/**
 * Does this pack answer "why was it considered done?" on its own?
 *
 * Deliberately strict about the one thing that matters: a sprint is done
 * because something independent verified it against criteria that existed
 * beforehand. Everything else is supporting detail.
 */
export function answersWhyItPassed(pack: EvidencePack): { ok: boolean; why: string } {
  if (pack.acceptance.length === 0)
    return { ok: false, why: "the sprint declared no acceptance criteria, so there is no standard it met" }
  if (pack.verdict === undefined)
    return { ok: false, why: pack.verdictMissing ?? "no verdict" }
  if (pack.verdict.decision !== "verified")
    return { ok: false, why: `the verdict was ${pack.verdict.decision}: ${pack.verdict.reasons.join("; ")}` }
  if (pack.verdict.builderRunId === pack.verdict.verifierRunId)
    return { ok: false, why: "the work was verified by the run that produced it" }
  return {
    ok: true,
    why:
      `verified by run ${pack.verdict.verifierRunId} against ${pack.acceptance.length} criteria; ` +
      `${pack.filesChanged.length} file(s), ${pack.commands.length} command(s), ${pack.tests.length} test result(s)` +
      (pack.commit !== undefined ? `, committed as ${pack.commit}` : ""),
  }
}

/** The pack as a human reads it — the shape a post-mortem starts from. */
export function formatEvidencePack(pack: EvidencePack): string {
  const lines: string[] = []
  lines.push(`sprint    ${pack.sprintId} — ${pack.title} [${pack.state}]`)
  lines.push(`accepted  ${pack.acceptance.length > 0 ? pack.acceptance.join(" | ") : "(none declared)"}`)
  const answer = answersWhyItPassed(pack)
  lines.push(`why       ${answer.ok ? answer.why : `NOT ESTABLISHED — ${answer.why}`}`)
  lines.push(`files     ${pack.filesChanged.length > 0 ? pack.filesChanged.join(", ") : "(none recorded)"}`)
  for (const test of pack.tests) lines.push(`test      ${test.suite}: ${test.passed} passed, ${test.failed} failed`)
  for (const command of pack.commands) lines.push(`command   ${command.command} -> ${command.exitCode}`)
  lines.push(`commit    ${pack.commit ?? "(none)"}`)
  lines.push(`rollback  ${pack.rollbackPoint ?? "(none)"}`)
  if (pack.gaps.length > 0) lines.push(`gaps      ${pack.gaps.join(" | ")}`)
  return lines.join("\n")
}
