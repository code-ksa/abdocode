/**
 * البثُّ الحيّ — ويُقاس بأنّه **لا يغيّر بايتاً** من النتيجة.
 *
 * كان الخرجُ يُستنزف كاملاً ثمّ يُعاد بعد خروج العملية، فما تراه القشرةُ
 * «بثّاً» إعادةُ عرضٍ لنصٍّ اكتمل. صار يُبثّ قطعةً قطعة — والخطرُ الحقيقيّ
 * في ذلك ليس الأداء بل **الترميز**: الحرفُ العربيُّ بايتان في UTF-8،
 * والقطعةُ تنقطع حيث تشاء. فتفكيكٌ ساذجٌ لكلّ قطعةٍ وحدها يستبدل نصفَ الحرف
 * بـ«�» ويُشوّه الكلمة، ويجعل المجموعَ مختلفاً عمّا كان.
 *
 * فالفحصُ الحاكم هنا يشغّل عمليةً حقيقيّةً تكتب عربيّةً كثيرة، ويقارن
 * **المبثوثَ المجموعَ بالمُعاد** حرفاً بحرف.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { INHERIT_PROFILE, UNMEASURED_CAPABILITY, launchControlledProcess } from "@abdo/tools"

const ARABIC_LINE = "المتصفّحُ والبحثُ يصلان النموذجَ الآن — والحرفُ العربيُّ بايتان في UTF-8."

const run = async (script: string, onOutput?: (c: { stream: string; text: string }) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-stream-"))
  try {
    writeFileSync(join(dir, "emit.mjs"), script)
    return await launchControlledProcess({
      executable: process.execPath,
      argv: ["emit.mjs"],
      cwd: dir,
      env: { PATH: process.env["PATH"] ?? "", SystemRoot: process.env["SystemRoot"] ?? "" },
      isolationProfile: INHERIT_PROFILE,
      capability: UNMEASURED_CAPABILITY,
      timeoutMs: 30_000,
      evidence: { profile: INHERIT_PROFILE, capability: UNMEASURED_CAPABILITY, approvalGranted: false },
      ...(onOutput === undefined ? {} : { onOutput: onOutput as never }),
    } as never)
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch { /* ويندوز قد يمسك المقبض */ }
  }
}

describe("بثُّ خرج الأوامر", () => {
  test("المبثوثُ المجموعُ يساوي المُعادَ حرفاً بحرف — والعربيّةُ لا تُشوَّه", async () => {
    // مئتا سطرٍ عربيّ بكتاباتٍ متتابعة: القطعُ تنقطع حتماً وسط حرفٍ متعدّد البايت.
    const script = `for (let i = 0; i < 200; i++) process.stdout.write(${JSON.stringify(ARABIC_LINE)} + i + "\\n");\n`
    const chunks: string[] = []
    const result = (await run(script, (c) => { if (c.stream === "stdout") chunks.push(c.text) })) as { outcome: string; stdout?: string }
    expect(result.outcome).toBe("ran")
    const streamed = chunks.join("")
    // التوأمُ الإيجابي: بُثَّ فعلاً بأكثر من قطعة — وإلا كان الفحصُ يقارن
    // قطعةً واحدةً بنفسها ويمرّ على أيّ تنفيذ.
    expect(chunks.length).toBeGreaterThan(1)
    expect(streamed.length).toBeGreaterThan(5_000)
    // ولا محرفَ بديل: «�» هو أثرُ الحرف المقسوم بالضبط.
    expect(streamed).not.toContain("\uFFFD")
    expect(result.stdout).not.toContain("\uFFFD")
    // والحكمُ الحاكم: المبثوثُ = المُعاد، بايتاً بايتاً.
    expect(streamed).toBe(result.stdout ?? "")
  }, 60_000)

  test("بلا ردِّ نداءٍ: السلوكُ القديم حرفياً — يُجمَّع ويُعاد ولا يُنادى أحد", async () => {
    const script = `process.stdout.write(${JSON.stringify(ARABIC_LINE)});\n`
    const withCb: string[] = []
    const a = (await run(script, (c) => withCb.push(c.text))) as { stdout?: string }
    const b = (await run(script)) as { stdout?: string }
    expect(a.stdout ?? "").toBe(ARABIC_LINE)
    // الغيابُ لا يغيّر العائد — البثُّ إضافةٌ لا استبدال.
    expect(b.stdout ?? "").toBe(a.stdout ?? "")
    expect(withCb.join("")).toBe(ARABIC_LINE)
  }, 60_000)

  test("stdout وstderr يصلان موسومَين ولا يختلطان في البثّ", async () => {
    const script = `process.stdout.write("out-مخرج\\n"); process.stderr.write("err-خطأ\\n");\n`
    const seen: { stream: string; text: string }[] = []
    const result = (await run(script, (c) => seen.push(c))) as { stdout?: string; stderr?: string }
    const out = seen.filter((c) => c.stream === "stdout").map((c) => c.text).join("")
    const err = seen.filter((c) => c.stream === "stderr").map((c) => c.text).join("")
    // الفصلُ يُحفظ عند المصدر — دمجُهما لاحقاً قرارُ من يعرض، لا قدرٌ محتوم.
    expect(out).toBe(result.stdout ?? "")
    expect(err).toBe(result.stderr ?? "")
    expect(out).toContain("مخرج")
    expect(err).toContain("خطأ")
    expect(out).not.toContain("خطأ")
  }, 60_000)
})
