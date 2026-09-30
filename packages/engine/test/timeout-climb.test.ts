import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { MODEL_TIMEOUT_ATTEMPTS, timedOutWithoutResponse } from "../src/attempt-budget"

// 09-30 (مقيس): مزوّدٌ لا يُجيب في 300 ث أُعيد عليه سبعاً (٣٥ دقيقة) قبل سلّم المالك. المهلةُ بلا ردٍّ تُعاد مرّةً واحدة ثمّ يُصعَد.
const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8")

test("a response-less deadline is retried once, then thrown so ask() climbs the owner's ladder; 429/503 keep seven attempts", () => {
  expect(MODEL_TIMEOUT_ATTEMPTS).toBe(2)
  expect(timedOutWithoutResponse("transport failed before response: tool timed out after 300000ms")).toBe(true)
  expect(timedOutWithoutResponse("transport failed before response: connect ECONNRESET")).toBe(false)
  expect(timedOutWithoutResponse("transport failed before response")).toBe(false)
  const at = cli.indexOf("if (timedOutWithoutResponse(failure.reason) && n >= MODEL_TIMEOUT_ATTEMPTS) {")
  expect(at).toBeGreaterThan(0)
  // الترتيب: بعد شرط الرمي العامّ وقبل الانتظار — فلا نومَ قبل الرمي.
  expect(at).toBeGreaterThan(cli.indexOf("if (!options.retryTransport || failure.retry !== \"bounded-backoff\" || n >= MODEL_RETRY_ATTEMPTS"))
  expect(at).toBeLessThan(cli.indexOf("const waitMs = MODEL_RETRY_BACKOFF_MS[n - 1] ?? 4_000"))
  // والسلّمُ يصعد على bounded-backoff (التصنيفُ نفسُه) — لا تغييرَ في شرط الصعود.
  expect(cli).toContain("const climbable = error instanceof ModelRequestFailure && (error.failure.retry === \"bounded-backoff\"")
})
