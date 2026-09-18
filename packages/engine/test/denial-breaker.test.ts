/**
 * سجلُّ الرفض وقاطعُه — مُخفِّضٌ نقيٌّ يُقاس وحده.
 *
 * وأكثرُ الفحوص هنا **سلبيّةٌ بقصد**: رفضُ `command` لا يعدّ رفضاً لـ`read`،
 * وهدفٌ غائبٌ لا يُعدّ أصلاً، والموافقةُ تمحو ما قبلها. قاطعٌ يقطع البريءَ
 * أسوأُ من غيابه — يعلّم المشغّلَ تجاهلَه.
 */
import { describe, expect, test } from "bun:test"
import { BREAKER_AT, brokenLine, count, empty, forgive, keyOf, list, record, reset } from "../src/denial-breaker"

describe("عدُّ الرفض — الصنفُ والهدفُ معاً", () => {
  test("يُعدّ لهدفه وصنفه، ولا يعبر إلى صنفٍ آخر", () => {
    let state = record(empty(), "command", "drive.upload")
    state = record(state, "command", "drive.upload")
    expect(count(state, "command", "drive.upload")).toBe(2)
    // ⚠ رفضُ التنفيذ ليس رفضاً للقراءة: طلبان مختلفان بالمعنى.
    expect(count(state, "read", "drive.upload")).toBe(0)
    expect(count(state, "command", "drive.list")).toBe(0)
    expect(keyOf("command", "x")).toBe("command|x")
  })

  test("هدفٌ غائبٌ أو فارغٌ لا يُعدّ — بلا هدفٍ لا يوجد «هذا الطلب»", () => {
    expect(record(empty(), "command", undefined)).toEqual(empty())
    expect(record(empty(), "command", "")).toEqual(empty())
  })

  test("المحوُ يزيل عدّاداً بعينه، والغائبُ لا يُخترع", () => {
    let state = record(record(empty(), "command", "a"), "network", "b")
    state = reset(state, "command", "a")
    expect(count(state, "command", "a")).toBe(0)
    expect(count(state, "network", "b")).toBe(1)
    // محوُ ما ليس موجوداً يعيد الحالةَ نفسَها بلا رمي.
    expect(reset(state, "command", "لا-شيء")).toBe(state)
  })

  test("الموافقةُ تمحو التاريخ — قرارٌ جديدٌ ينسخ ما قبله", () => {
    let state = record(record(empty(), "command", "a"), "command", "a")
    expect(count(state, "command", "a")).toBe(2)
    state = forgive(state, "command", "a")
    expect(count(state, "command", "a")).toBe(0)
  })

  test("العرضُ ثابتُ الترتيب، وسطرُ القطع يقول العددَ وطريقَ العودة", () => {
    let state = record(empty(), "network", "z.fetch")
    state = record(record(state, "command", "a.b"), "command", "a.b")
    expect(list(state)).toEqual([
      { request: "command", target: "a.b", denials: 2 },
      { request: "network", target: "z.fetch", denials: 1 },
    ])
    const line = brokenLine("a.b", 3)
    expect(line).toContain("a.b")
    expect(line).toContain("3")
    // ورفضٌ بلا مخرجٍ عطلٌ لا حماية: السطرُ يقول كيف يُمحى.
    expect(line).toContain("الصلاحيات")
  })

  test("الحدُّ ثالثةٌ بعد رفضين — لا رقمَ سحريٌّ مخبّأ", () => {
    expect(BREAKER_AT).toBe(3)
    let state = empty()
    for (const expected of [1, 2, 3]) {
      state = record(state, "command", "loop.tool")
      expect(count(state, "command", "loop.tool")).toBe(expected)
    }
    expect(count(state, "command", "loop.tool") >= BREAKER_AT).toBe(true)
  })
})
