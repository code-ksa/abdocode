/**
 * CL-16A2-D-R §1 — read the suite's own totals DETERMINISTICALLY, or refuse.
 *
 * The gate report previously printed `skip=-1`. That -1 was the parser's way of
 * saying "I looked for a skip line and did not find one", and it was rendered
 * into an official measurement as though it were a count. A number nobody can
 * account for must never appear in a report that decides whether a security
 * mechanism is trustworthy: the honest outcomes are the real number, or a
 * refusal to report at all.
 *
 * MEASURED format (bun 1.3.14, captured rather than assumed):
 *
 *      2 pass
 *      1 skip
 *      1 todo
 *      0 fail
 *      2 expect() calls
 *     Ran 4 tests across 1 file. [36.00ms]
 *
 * Two facts decide the design:
 *
 *   1. `skip` and `todo` are OMITTED when they are zero, so their absence is
 *      meaningful and must be read as 0 rather than as "unknown". `pass` and
 *      `fail` are always printed.
 *   2. `pass + skip + todo + fail == ran`. That identity is the load-bearing
 *      part: it is an independent cross-check that catches a counter this
 *      parser failed to read, a format change in a future bun, and a truncated
 *      run. A summary that does not add up is refused instead of believed.
 */

export class ReportParseUnknown extends Error {
  readonly reasonCode = "report_parse_unknown"
  constructor(detail: string) {
    super(`report_parse_unknown: ${detail}`)
  }
}

export interface SuiteTotals {
  readonly pass: number
  readonly fail: number
  readonly skip: number
  readonly todo: number
  readonly ran: number
  readonly files: number
}

/** Colour codes only, anchored to the ESC byte so ordinary text like "[1m" survives. */
const ANSI = /\x1b\[[0-9;]*m/g
const RAN = /^Ran (\d+) tests? across (\d+) files?\./
const COUNTER = /^\s*(\d+)\s+(pass|fail|skip|todo)\s*$/
/** Part of the same block, and deliberately not a test counter. */
const EXPECT_CALLS = /^\s*\d+\s+expect\(\) calls\s*$/

/**
 * Parse the totals, or throw `ReportParseUnknown`.
 *
 * The summary block is located by finding the `Ran ...` line and walking
 * BACKWARDS over the counter lines directly above it. Anchoring to that block
 * is what makes the parse deterministic: a test that prints "5 pass" in its own
 * output cannot be mistaken for the suite's summary, because the walk stops at
 * the first line that is not part of the block.
 */
export function parseSuiteTotals(output: string): SuiteTotals {
  const lines = output.split(/\r?\n/).map((l) => l.replace(ANSI, ""))

  let ranIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (RAN.test(lines[i]!)) {
      ranIdx = i
      break
    }
  }
  if (ranIdx < 0) {
    throw new ReportParseUnknown('no "Ran N tests across M files." line: the suite did not finish, or its output was lost')
  }
  const ranMatch = RAN.exec(lines[ranIdx]!)!
  const ran = Number(ranMatch[1])
  const files = Number(ranMatch[2])

  const counters = new Map<string, number>()
  for (let i = ranIdx - 1; i >= 0; i--) {
    const line = lines[i]!
    const c = COUNTER.exec(line)
    if (c) {
      const key = c[2]!
      if (counters.has(key)) throw new ReportParseUnknown(`the summary block reports "${key}" more than once`)
      counters.set(key, Number(c[1]))
      continue
    }
    if (EXPECT_CALLS.test(line)) continue
    break
  }

  const required = (key: "pass" | "fail"): number => {
    const v = counters.get(key)
    if (v === undefined) throw new ReportParseUnknown(`the summary block has no "${key}" line`)
    return v
  }
  const pass = required("pass")
  const fail = required("fail")
  // Absent means zero — measured, not assumed (see the header).
  const skip = counters.get("skip") ?? 0
  const todo = counters.get("todo") ?? 0

  const sum = pass + fail + skip + todo
  if (sum !== ran) {
    throw new ReportParseUnknown(
      `the summary does not add up: pass ${pass} + fail ${fail} + skip ${skip} + todo ${todo} = ${sum}, but bun ran ${ran}. ` +
        `A counter was missed or the format changed; the totals cannot be reported as fact.`,
    )
  }
  return { pass, fail, skip, todo, ran, files }
}

export const formatTotals = (t: SuiteTotals) =>
  `${t.pass} pass, ${t.fail} fail, ${t.skip} skip, ${t.todo} todo, ${t.ran} ran across ${t.files} file(s)`
