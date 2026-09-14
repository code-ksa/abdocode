import { describe, expect, test } from "bun:test"
import { drainStream } from "../src/launcher"

/**
 * الفخُّ المقصود: حرفٌ متعدّدُ البايت **مقسومٌ بين قطعتين**.
 *
 * الاختبارُ الذي يشغّل عمليةً حقيقيّةً لا يضمن وقوعَ القسمة — قِيس أنّ الطفرة
 * (تفكيكٌ ساذجٌ لكلّ قطعةٍ وحدها) **لم تُحمِّره**، لأنّ الأنبوب لم يقسم حرفاً
 * في تلك الجولة. فحارسٌ يعتمد على مصادفةٍ في التقطيع ليس حارساً.
 *
 * هنا تُبنى القسمةُ بيدٍ: بايتاتُ الحرف تُقطَّع عمداً في أسوأ موضع، فيُقاس
 * السلوكُ لا يُرجى.
 */
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

const streamOf = (parts: readonly Uint8Array[]): ReadableStream =>
  new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part)
      controller.close()
    },
  })

describe("استنزافُ الأنبوب — الحرفُ المقسوم", () => {
  test("حرفٌ عربيٌّ مقسومٌ بين قطعتين يخرج سليماً، بلا محرفٍ بديل", async () => {
    const text = "مرحباً بالعالم"
    const all = bytes(text)
    // القسمُ في منتصف بايتَي حرفٍ عربيّ: البايتُ الأوّل في قطعة والثاني في التالية.
    const split = 3
    expect(all.length).toBeGreaterThan(split + 1)
    const chunks: string[] = []
    const out = await drainStream(streamOf([all.slice(0, split), all.slice(split)]), (c) => chunks.push(c))
    expect(out).toBe(text)
    expect(out).not.toContain("�")
    // والتوأمُ الإيجابي: القسمةُ وقعت فعلاً — قطعتان دخلتا، فالفحصُ ليس على عدم.
    expect(chunks.join("")).toBe(text)
  })

  test("قسمةٌ عند **كلّ** موضعٍ ممكن — لا موضعَ واحدٌ ينجو بالحظّ", async () => {
    const text = "عبدو كود — المتصفّحُ يعمل ✓"
    const all = bytes(text)
    for (let at = 1; at < all.length; at += 1) {
      const out = await drainStream(streamOf([all.slice(0, at), all.slice(at)]))
      expect(`split@${at}: ${out}`).toBe(`split@${at}: ${text}`)
    }
  })

  test("بايتٌ بايتٌ: أقسى تقطيعٍ ممكن يعطي النصَّ نفسَه", async () => {
    const text = "الحرفُ العربيُّ بايتان، والرمزُ ✓ ثلاثة، والوجهُ 😀 أربعة."
    const all = bytes(text)
    const parts = [...all].map((b) => new Uint8Array([b]))
    const chunks: string[] = []
    const out = await drainStream(streamOf(parts), (c) => chunks.push(c))
    expect(out).toBe(text)
    expect(out).not.toContain("�")
    // ولا قطعةَ مبثوثةٌ تحمل نصفَ حرف: المجموعُ يساوي النصَّ تماماً.
    expect(chunks.join("")).toBe(text)
  })

  test("مجرىً فارغٌ يعطي نصّاً فارغاً ولا يُنادي أحداً", async () => {
    const chunks: string[] = []
    expect(await drainStream(streamOf([]), (c) => chunks.push(c))) .toBe("")
    expect(chunks).toEqual([])
  })

  test("بلا ردِّ نداءٍ يعمل كما كان — البثُّ إضافةٌ لا شرط", async () => {
    const text = "لا مُنادى"
    expect(await drainStream(streamOf([bytes(text)]))).toBe(text)
  })
})
