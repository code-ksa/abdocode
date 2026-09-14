/**
 * Adapter failure -> explicit tool verdict (spec 3.2 / 8): one hop on the adapter machine
 * codes themselves (adapters.ts / runner.ts), never on receipt prose. A code we do not
 * recognise stays tool_failed and is flagged `unmapped`, so the ledger can count it apart
 * from receipts that carry no verdict at all. Lives outside cli.ts so it is unit-testable.
 */
import type { ToolVerdict, ToolVerdictReason } from "@abdo/engine-host"

/** §3.2: قفزة واحدة على رموز المحوّل الآليّة نفسها (adapters.ts / runner.ts) — لا على نثر الإيصال. */
export const adapterErrorVerdict = (error: string): { verdict: ToolVerdict; unmapped: boolean } => {
  const detail = error.slice(0, 160)
  const named = (reason: ToolVerdictReason, deniedFlag = false): { verdict: ToolVerdict; unmapped: boolean } =>
    ({ verdict: { ok: false, reason, denied: deniedFlag, detail }, unmapped: false })
  if (/^unknown_tool/u.test(error)) return named("unknown_tool")
  if (/^exit_\d+/u.test(error)) return named("nonzero_exit")
  if (/^timeout/u.test(error)) return named("timeout")
  if (/^aborted/u.test(error)) return named("aborted")
  const shellClass = /^(command_not_found|process_spawn_failed|isolation_refused|empty_failure_output)/u.exec(error)
  if (shellClass !== null) return named(shellClass[1] as ToolVerdictReason, shellClass[1] === "isolation_refused")
  return { verdict: { ok: false, reason: "tool_failed", denied: false, detail }, unmapped: true }
}
