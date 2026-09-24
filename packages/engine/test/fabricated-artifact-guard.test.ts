/**
 * صورةٌ تُصنع بالبايتات لتوهم بلقطةٍ لم تُؤخذ.
 *
 * مقيسٌ حرفيّاً 2026-09-24: بعد أن رفض حارسُ الخروجِ المضيفَ، ورفض `page shot` بلا سطح،
 * ورفض `image` ملفّاً غائباً — كتب الوكيلُ بنفسه:
 *
 *     Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAA…", "base64")
 *
 * سبعون بايتاً، PNG صحيحُ التوقيع، أبعادُه **1×1**. ولكلّ منعٍ هنا توأمُه الإيجابيّ:
 * صورةٌ حقيقيّةٌ تمرّ، وإلّا كان الحارسُ يشتكي من كلّ صورة.
 */
import { describe, expect, test } from "bun:test"
import { fabricatedImage, imageShape, looksLikeShot, MIN_DIMENSION, MIN_SHOT_BYTES } from "../src/fabricated-artifact-guard"

/** البكسلُ الواحدُ الذي كُتب فعلاً في الجولة — بنصّه. */
const ONE_PIXEL = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"))

/** PNG بأبعادٍ معقولةٍ وحجمٍ معقول — يُبنى بترويسةٍ صحيحةٍ وحمولةٍ مصطنعة. */
const bigPng = (w: number, h: number, bytes: number): Uint8Array => {
  const out = new Uint8Array(Math.max(bytes, 24))
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  out.set([0, 0, 0, 13], 8)
  out.set([0x49, 0x48, 0x44, 0x52], 12)
  out.set([(w >> 24) & 255, (w >> 16) & 255, (w >> 8) & 255, w & 255], 16)
  out.set([(h >> 24) & 255, (h >> 16) & 255, (h >> 8) & 255, h & 255], 20)
  return out
}

describe("قراءةُ الشكل من البايتات لا من الامتداد", () => {
  test("البكسلُ الواحد يُقرأ 1×1", () => {
    const shape = imageShape(ONE_PIXEL)
    expect(shape.kind).toBe("png")
    expect(shape.width).toBe(1)
    expect(shape.height).toBe(1)
    expect(shape.bytes).toBe(70)
  })

  test("وصورةٌ حقيقيّةٌ تُقرأ بأبعادها", () => {
    const shape = imageShape(bigPng(1280, 720, 40_000))
    expect(shape.width).toBe(1280)
    expect(shape.height).toBe(720)
  })

  test("وما ليس صورةً لا يُحكم عليه", () => {
    expect(imageShape(Uint8Array.from([1, 2, 3, 4])).kind).toBe("unknown")
    expect(fabricatedImage("notes.txt", Uint8Array.from(Buffer.from("مرحباً")))).toBeUndefined()
  })
})

describe("🔴 الاختلاقُ يُسمّى، ولا تُمنع الكتابة", () => {
  test("البكسلُ الواحدُ يُسمّى اختلاقاً بأبعاده وحجمه", () => {
    const why = fabricatedImage("docs/reference-stats.png", ONE_PIXEL, true)
    expect(why).toBeDefined()
    expect(why!).toContain("1×1")
    expect(why!).toContain("70")
    expect(why!).toContain("docs/reference-stats.png")
    // والمخرجُ الصادق مذكورٌ: قُل إنّك تعجز، ولا تكتب ما يُوهم.
    expect(why!).toContain("فقُل")
  })

  test("وأيُّ بُعدٍ دون الحدّ يُسمّى — لا البكسلُ الواحدُ وحده", () => {
    expect(fabricatedImage("a.png", bigPng(1, 500, 5000))).toBeDefined()
    expect(fabricatedImage("a.png", bigPng(500, 2, 5000))).toBeDefined()
    expect(MIN_DIMENSION).toBe(8)
  })

  test("🔴 وملفٌّ يُسمّى لقطةً وحجمُه تافهٌ يُسمّى، ولو كانت أبعادُه معقولة", () => {
    const why = fabricatedImage("docs/screenshot.png", bigPng(1280, 720, 300), true)
    expect(why).toBeDefined()
    expect(why!).toContain("300")
    expect(MIN_SHOT_BYTES).toBe(2048)
  })
})

describe("التوأمُ الإيجابيّ: ما يجب أن يمرّ", () => {
  test("صورةٌ حقيقيّةٌ بأبعادٍ وحجمٍ معقولَين تمرّ — كلقطةٍ وكغيرها", () => {
    expect(fabricatedImage("docs/reference-stats.png", bigPng(1280, 720, 40_000), true)).toBeUndefined()
    expect(fabricatedImage("assets/logo.png", bigPng(64, 64, 3_000))).toBeUndefined()
  })

  test("وأيقونةٌ صغيرةٌ ليست لقطةً تمرّ بحجمٍ صغير — الحدُّ يشتدّ على اللقطة وحدها", () => {
    expect(fabricatedImage("assets/dot.png", bigPng(16, 16, 200))).toBeUndefined()
    expect(fabricatedImage("assets/dot.png", bigPng(16, 16, 200), true)).toBeDefined()
  })

  test("واسمُ اللقطة يُعرف من اسمه", () => {
    expect(looksLikeShot("docs/reference-stats.png")).toBe(true)
    expect(looksLikeShot("docs/screenshot-1.png")).toBe(true)
    expect(looksLikeShot("assets/logo.png")).toBe(false)
  })
})
