/**
 * 10-14 — «tool-failed» means «the last tool failed» (delegation.ts names it so). Measured with claude-sonnet-5-5 on m11: a `wait` timed
 * out mid-epoch, probe/look/console then succeeded and the model declared completion — but the sticky flag reported «tool-failed», so
 * every acceptance gate after it cost a model call. A later successful action clears the failure; a read alone does not.
 */
import { expect, test } from "bun:test"
import { runTextAgentLoop } from "../src"

const run = async (script: string[], failing: Set<string>) => {
  let i = 0
  return runTextAgentLoop({
    input: "ابنِ وتحقّق", history: [], maxRounds: 10, isCallable: () => true,
    ask: async () => script[i++] ?? "اكتمل العمل.",
    dispatch: async (command) => failing.has(command)
      ? { output: `${command}: timed out`, verdict: { ok: false, reason: "tool_failed", denied: false, detail: "timeout" } }
      : { output: `${command}: ok`, verdict: { ok: true } },
  })
}

test("a failed tool followed by a successful action, then prose, is a completion claim", async () => {
  const result = await run(["نفّذ: wait لا توجد مهام", "نفّذ: probe http://127.0.0.1:3000/", "اكتمل العمل."], new Set(["wait لا توجد مهام"]))
  expect(result.stopReason).toBe("complete")
})

test("the twins: a failure followed only by a read, or a failure as the last tool, stays tool-failed", async () => {
  const readOnly = await run(["نفّذ: run npm test", "نفّذ: read src/a.js", "الاختبارات تفشل."], new Set(["run npm test"]))
  expect(readOnly.stopReason).toBe("tool-failed")
  const last = await run(["نفّذ: probe http://127.0.0.1:3000/", "نفّذ: run npm test", "توقّفت."], new Set(["run npm test"]))
  expect(last.stopReason).toBe("tool-failed")
})
