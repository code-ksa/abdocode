/**
 * CL-16A2-D-R §1 — the report parser must refuse, never guess.
 *
 * These are the tests for the thing that WRITES THE OFFICIAL NUMBERS. If the
 * parser silently mis-reads a suite that was truncated, killed, or produced by a
 * future bun with a different format, every measurement downstream inherits the
 * error while looking exactly like a clean result. `skip=-1` in the last report
 * was that failure in its mildest possible form.
 *
 * The sentinel case is `an incomplete summary is not a pass`: the suite output
 * arrives cut off, and the only acceptable behaviours are a refusal or a number
 * that is demonstrably right. There is no third option in which the gate prints
 * something reassuring.
 */
import { describe, expect, test } from "bun:test"
import { ReportParseUnknown, formatTotals, parseSuiteTotals } from "./suite-report"

/** Built rather than pasted, so this source file stays plain ASCII. */
const ESC = String.fromCharCode(27)

/** The EXACT bytes bun 1.3.14 produced, captured for this slice. */
const REAL_WITH_SKIPS = [" 2 pass", " 1 skip", " 1 todo", " 0 fail", " 2 expect() calls", "Ran 4 tests across 1 file. [36.00ms]"].join("\n")

/** The shape the real suite produces: no skip line at all, because it is zero. */
const REAL_NO_SKIPS = ["", " 98 pass", " 0 fail", " 245 expect() calls", "Ran 98 tests across 6 files. [404.50s]"].join("\n")

const parseFails = (output: string): ReportParseUnknown => {
  let thrown: unknown
  try {
    parseSuiteTotals(output)
  } catch (e) {
    thrown = e
  }
  expect(thrown).toBeInstanceOf(ReportParseUnknown)
  expect((thrown as ReportParseUnknown).reasonCode).toBe("report_parse_unknown")
  return thrown as ReportParseUnknown
}

describe("the suite report is parsed deterministically", () => {
  test("the real measured format, including skip and todo", () => {
    expect(parseSuiteTotals(REAL_WITH_SKIPS)).toEqual({ pass: 2, fail: 0, skip: 1, todo: 1, ran: 4, files: 1 })
  })

  test("an omitted skip line means ZERO, and is reported as 0 - never as -1", () => {
    const t = parseSuiteTotals(REAL_NO_SKIPS)
    expect(t).toEqual({ pass: 98, fail: 0, skip: 0, todo: 0, ran: 98, files: 6 })
    // The whole point of this slice: the official line can no longer say -1.
    expect(formatTotals(t)).toContain("0 skip")
    expect(formatTotals(t)).not.toContain("-1")
  })

  test("colour codes do not defeat the parse", () => {
    const coloured = [`${ESC}[32m 7 pass${ESC}[0m`, `${ESC}[31m 0 fail${ESC}[0m`, "Ran 7 tests across 2 files. [1.00s]"].join("\n")
    expect(parseSuiteTotals(coloured).pass).toBe(7)
  })

  test("CRLF output parses identically to LF", () => {
    expect(parseSuiteTotals(REAL_WITH_SKIPS.replace(/\n/g, "\r\n"))).toEqual(parseSuiteTotals(REAL_WITH_SKIPS))
  })
})

describe("incomplete or unexpected output is REFUSED, not read as success", () => {
  test("a truncated run - the suite died before printing its summary", () => {
    const truncated = ["ok 1 - something", " 42 pass", "<killed>"].join("\n")
    const e = parseFails(truncated)
    expect(e.message).toContain("Ran")
  })

  test("no summary at all", () => {
    parseFails("bun test v1.3.14\nsome noise\n")
  })

  test("empty output", () => {
    parseFails("")
  })

  test("a missing pass line", () => {
    parseFails([" 0 fail", "Ran 3 tests across 1 file. [1ms]"].join("\n"))
  })

  test("a missing fail line", () => {
    parseFails([" 3 pass", "Ran 3 tests across 1 file. [1ms]"].join("\n"))
  })

  test("THE COUNTER-WENT-MISSING DETECTOR: a summary that does not add up", () => {
    // pass+fail+skip+todo = 3, but bun says it ran 9. Whatever the cause - a
    // counter this parser cannot read, a format change - the totals are not
    // facts and must not be printed as if they were.
    const e = parseFails([" 3 pass", " 0 fail", "Ran 9 tests across 1 file. [1ms]"].join("\n"))
    expect(e.message).toContain("does not add up")
  })

  test("a duplicated counter", () => {
    parseFails([" 1 pass", " 2 pass", " 0 fail", "Ran 3 tests across 1 file. [1ms]"].join("\n"))
  })

  test("a test that PRINTS something summary-shaped cannot fake a result", () => {
    // A test whose own stdout contains " 5 pass" and no real summary follows.
    // Reading that as a passing suite is exactly the class of error this parser
    // exists to prevent.
    parseFails(["console output from a test:", " 5 pass", " 0 fail", "and then the process was killed"].join("\n"))
  })

  test("summary-shaped noise EARLIER in the log does not override the real block", () => {
    const noisy = ["a test logged this:", " 999 pass", " 999 fail", "", " 4 pass", " 0 fail", "Ran 4 tests across 1 file. [1ms]"].join("\n")
    // The blank line ends the block, so the noise above it is not absorbed.
    expect(parseSuiteTotals(noisy)).toEqual({ pass: 4, fail: 0, skip: 0, todo: 0, ran: 4, files: 1 })
  })
})

describe("a zero-test run is reported honestly", () => {
  test('"Ran 0 tests" parses as 0 and is never a pass', () => {
    const t = parseSuiteTotals([" 0 pass", " 0 fail", "Ran 0 tests across 0 files. [1ms]"].join("\n"))
    expect(t.ran).toBe(0)
    expect(t.pass).toBe(0)
    // The gate's own rule (`ran > 0 && pass > 0`) is what rejects it; this test
    // pins that the parser hands over an honest zero rather than throwing, so
    // the gate can say WHY it failed.
  })
})
