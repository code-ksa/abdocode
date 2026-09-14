import { describe, expect, test } from "bun:test"
import { adapterErrorVerdict } from "../src/adapter-error-verdict"

// §3.2 / §8: the adapter's own machine code is mapped in one hop; anything else is
// tool_failed AND flagged unmapped so the 📐 line separates "explicit but generic"
// from "no verdict at all". Previously this lived inside cli.ts with no test.
describe("adapter error verdict — one hop on the adapter's machine codes", () => {
  test("a generic adapter error is tool_failed and unmapped", () => {
    expect(adapterErrorVerdict("something odd happened")).toEqual({
      verdict: { ok: false, reason: "tool_failed", denied: false, detail: "something odd happened" },
      unmapped: true,
    })
  })

  test("named codes map to their own reason and are never unmapped; isolation_refused alone is a denial", () => {
    expect(adapterErrorVerdict("unknown_tool: x")).toEqual({ verdict: { ok: false, reason: "unknown_tool", denied: false, detail: "unknown_tool: x" }, unmapped: false })
    expect(adapterErrorVerdict("exit_2")).toMatchObject({ verdict: { reason: "nonzero_exit", denied: false }, unmapped: false })
    expect(adapterErrorVerdict("timeout after 30s")).toMatchObject({ verdict: { reason: "timeout", denied: false }, unmapped: false })
    expect(adapterErrorVerdict("aborted by owner")).toMatchObject({ verdict: { reason: "aborted", denied: false }, unmapped: false })
    for (const cls of ["command_not_found", "process_spawn_failed", "empty_failure_output"]) {
      expect(adapterErrorVerdict(`${cls}: detail`)).toMatchObject({ verdict: { reason: cls, denied: false }, unmapped: false })
    }
    expect(adapterErrorVerdict("isolation_refused: sandbox")).toMatchObject({ verdict: { reason: "isolation_refused", denied: true }, unmapped: false })
  })

  test("codes are anchored at the start: a code word inside prose is still generic (unmapped)", () => {
    expect(adapterErrorVerdict("the runner hit a timeout")).toMatchObject({ verdict: { reason: "tool_failed" }, unmapped: true })
    expect(adapterErrorVerdict("see exit_1 above")).toMatchObject({ verdict: { reason: "tool_failed" }, unmapped: true })
  })

  test("detail is bounded to 160 chars and never decides the reason", () => {
    const long = "x".repeat(500)
    const mapped = adapterErrorVerdict(long)
    expect(mapped.unmapped).toBe(true)
    expect(mapped.verdict.ok).toBe(false)
    if (!mapped.verdict.ok) expect(mapped.verdict.detail).toBe("x".repeat(160))
  })
})
