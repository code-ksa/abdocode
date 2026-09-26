import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { workerExitReason } from "../src/exit-reason"

/**
 * 🔴 **رمزُ خروجٍ بلا كلمةٍ يوقف التشخيص عند حدّه.**
 *
 * مقيس 2026-09-26 في جولةِ قياسٍ حيّة: `tool_worker_refused: exit 66` — ولا شيءَ
 * غيرُه، فلا يُعرف أين يُبحث. و66 تعني **أنّه لم يستطع قراءةَ طلبِه**، وهو خبرٌ
 * مختلفٌ تماماً عن «رفضَ العاملُ الطلب».
 */
describe("a silent exit code is translated, and a spoken reason is preferred to it", () => {
  test("stderr wins whenever the worker said anything at all", () => {
    expect(workerExitReason(66, "  policy denied: tool not allowed  ")).toBe("policy denied: tool not allowed")
    // ولو نطق مع رمزٍ معروفٍ يبقى نصُّه هو الحُكم — لا يُزاحمه تفسيرٌ عامّ.
    expect(workerExitReason(75, "upstream said slow down")).toBe("upstream said slow down")
  })

  test("THE MEASURED CASE: exit 66 says the request never reached it", () => {
    const said = workerExitReason(66, "")
    expect(said).toContain("66")
    expect(said).toContain("EX_NOINPUT")
    expect(said).toContain("stderr")
  })

  test("a kill (no code) and an unknown code are both said plainly, never invented", () => {
    expect(workerExitReason(null, "")).toContain("إشارةٍ أو مهلةٍ")
    expect(workerExitReason(undefined, "   ")).toContain("إشارةٍ أو مهلةٍ")
    const unknown = workerExitReason(123, "")
    expect(unknown).toContain("123")
    expect(unknown).toContain("غيرُ معروف")
  })

  test("no refusal path is left with a bare exit code", () => {
    // الفحصُ على المصدر: ثلاثةُ مواضع كانت تطبع `exit ${exitCode}` عارياً.
    for (const file of ["index.ts", "provider.ts"]) {
      const source = readFileSync(join(import.meta.dir, "..", "src", file), "utf8")
      expect(source).not.toContain("|| `exit ${exitCode}`")
    }
  })
})
