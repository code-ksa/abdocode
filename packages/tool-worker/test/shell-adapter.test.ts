import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { ToolAdmissionWorker, adapterToolSpec } from "../src/index"

/**
 * محوّلُ الشِّلّ بصنفه الصادق: `Irreversible` — دليلٌ بلا خطّةِ تعويض. سطرُ أمرٍ قد
 * يحذف أو ينشر أو يدفع، وادّعاءُ عمليّةِ تعويضٍ له خيالٌ يثق به الكتالوج بعد ذلك.
 */
describe("the shell adapter declares what a command line really is", () => {
  test("its spec is Irreversible with evidence and no recovery plan", () => {
    const spec = adapterToolSpec("shell")
    expect(spec.tool_id as unknown as bigint).toBe(6n)
    expect(spec.effect.tag).toBe("Irreversible")
    const value = spec.effect.value as Record<string, unknown>
    expect(Object.keys(value)).toEqual(["evidence_operation_digest"])
    expect("recovery" in value).toBe(false)
  })

  test("the other adapters keep their classes — the new entry moved nothing", () => {
    expect(adapterToolSpec("write").effect.tag).toBe("Mutate")
    expect(adapterToolSpec("git-read").effect.tag).toBe("Read")
    expect(adapterToolSpec("network").effect.tag).toBe("Reach")
  })

  const worker = join(import.meta.dir, "..", "..", "kernel", "target", "release", process.platform === "win32" ? "abdo-tool-worker.exe" : "abdo-tool-worker")

  test.skipIf(!existsSync(worker))("THE REAL WORKER admits it, and says how much it can enforce", async () => {
    // مقيس 2026-09-27: توقّعتُ رفضاً على مضيفٍ بلا عزلِ نظام، فأعطى العاملُ `Partial` بثغرةٍ
    // مسمّاة — و`Partial` ليس `Unavailable`، فالنواةُ تُدخِله وتسجّل الثغرة. والاختبارُ يقبل
    // الإنفاذَين الصادقَين ولا يقبل غيرَهما: إدخالٌ بلا إنفاذٍ مسمّى لا يُعدّ إدخالاً.
    const admission = await new ToolAdmissionWorker(worker).admit("shell")
    const report = admission.report as unknown as { enforcement: string }
    expect(["Full", "Partial"]).toContain(report.enforcement)
  })
})
