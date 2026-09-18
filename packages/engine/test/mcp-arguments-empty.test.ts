import { expect, test } from "bun:test"
import { argumentsFor } from "../src/mind/mcp"

// مقيس 09-15 (إضافةُ المتصفّح): `page` بلا وسائط رُفض «الأداةُ تحتاج كائنَ JSON بمفاتيح: بلا مفاتيح معلَنة» — نصٌّ فارغ لأداةٍ بلا مفاتيحَ إلزاميّة هو `{}`.
// التوأمُ السلبيّ: نصٌّ غيرُ فارغ لأداةٍ بلا مفاتيح يبقى مرفوضاً باسمه؛ ومفتاحٌ إلزاميّ بنصٍّ فارغ يبقى مرفوضاً.

test("empty text for a tool without required keys is an empty object", () => {
  expect(argumentsFor("", { type: "object", properties: {}, additionalProperties: false })).toEqual({ ok: true, value: {} })
  expect(argumentsFor("   ", { type: "object", properties: { count: { type: "number" } }, required: [] })).toEqual({ ok: true, value: {} })
})

test("non-empty text for a keyless tool, and empty text for a required key, are still refused by name", () => {
  const keyless = argumentsFor("styles", { type: "object", properties: {}, additionalProperties: false })
  expect(keyless.ok).toBe(false)
  expect("why" in keyless && keyless.why).toContain("بلا مفاتيح معلَنة")
  const required = argumentsFor("", { type: "object", properties: { url: { type: "string" } }, required: ["url"] })
  expect(required.ok).toBe(false)
  expect("why" in required && required.why).toContain("url")
})
