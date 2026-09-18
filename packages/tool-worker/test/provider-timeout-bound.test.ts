/**
 * حدُّ مهلةِ نداء المزوّد — رقمان في ملفّين كانا يفترقان بصمت.
 *
 * ⚠ المقيس 2026-09-04 على **النسخة المشحونة**: المحرّك يطلب 360 ألف مللي،
 * وهذا المُرمِّز يرفض ما فوق 300 ألف، فكان كلُّ دورِ وكيلٍ على أيّ مزوّدٍ
 * سحابيّ يسقط قبل أن يُرسل بـ`provider_worker_timeout_invalid` — وأولاما
 * وحدَه ينجو لأنّه محلّيّ. اختبارٌ أخضرُ واحدٌ ما كان ليكشفه: لكلٍّ من الطرفين
 * فحصُه، ولا أحدَ يقابل بينهما. فهذا الملفّ **يقابل**.
 */
import { describe, expect, test } from "bun:test"
import {
  encodeModelProviderWorkerRequest,
  PROVIDER_WORKER_TIMEOUT_MS_MAX,
  PROVIDER_WORKER_TIMEOUT_MS_MIN,
} from "../src/provider"

const request = (timeoutMs: number) => ({
  provider: "qwen",
  url: "https://example.invalid/v1/chat/completions",
  body: JSON.stringify({ model: "m", messages: [] }),
  timeoutMs,
})

describe("سقفُ مهلة المزوّد — معلَنٌ لا مخبوء", () => {
  test("السقفُ نفسُه يمرّ، وما فوقه بمللٍ واحد يُرفض باسمه", () => {
    expect(() => encodeModelProviderWorkerRequest(request(PROVIDER_WORKER_TIMEOUT_MS_MAX))).not.toThrow()
    expect(() => encodeModelProviderWorkerRequest(request(PROVIDER_WORKER_TIMEOUT_MS_MAX + 1)))
      .toThrow("provider_worker_timeout_invalid")
  })

  test("الأرضيّةُ تمرّ، وما دونها يُرفض", () => {
    expect(() => encodeModelProviderWorkerRequest(request(PROVIDER_WORKER_TIMEOUT_MS_MIN))).not.toThrow()
    expect(() => encodeModelProviderWorkerRequest(request(PROVIDER_WORKER_TIMEOUT_MS_MIN - 1)))
      .toThrow("provider_worker_timeout_invalid")
  })

  /**
   * البوّابةُ الحاكمة: **مهلةُ المحرّك تُقرأ من مصدرها** وتُقابل بالسقف. لو
   * أعاد أحدٌ رقماً منسوخاً فوق السقف، يحمرّ هذا السطر قبل أن يشحن.
   */
  test("مهلةُ حارة الوكيل في المحرّك لا تتجاوز السقفَ أبداً", async () => {
    const source = await Bun.file(new URL("../../engine/src/cli.ts", import.meta.url)).text()
    const declared = /const DEFAULT_AGENT_MODEL_TIMEOUT_MS = ([^\n]+)/u.exec(source)
    expect(declared).not.toBeNull()
    const rhs = declared![1]!.trim()
    // إمّا يستورد السقفَ نصّاً، وإمّا رقمٌ نقيسه.
    const value = rhs === "PROVIDER_WORKER_TIMEOUT_MS_MAX"
      ? PROVIDER_WORKER_TIMEOUT_MS_MAX
      : Number(rhs.replace(/_/gu, ""))
    expect(Number.isFinite(value)).toBe(true)
    expect(value <= PROVIDER_WORKER_TIMEOUT_MS_MAX).toBe(true)
    // والتوأمُ الإيجابيّ: القيمةُ ليست صفراً ولا تافهة — مهلةٌ تصلح لدورِ وكيل.
    expect(value >= 60_000).toBe(true)
    // والقصُّ حاضرٌ عند المُنادي، لا نيّةً في تعليق.
    expect(source).toContain("Math.min(wanted, PROVIDER_WORKER_TIMEOUT_MS_MAX)")
  })
})
