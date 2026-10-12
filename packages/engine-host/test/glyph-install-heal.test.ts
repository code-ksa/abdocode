/**
 * 10-11 (مقيس على m11 بالمثبَّت 4.0.140): «⚙ run npm install» رُفض «سطرَ سجلّ أداة» وكلّف نداءً كاملاً — التثبيتُ يمرّ بحرّاس الأوامر
 * كأيّ نداء، فيُشفى نداءً كما يُشفى البناءُ والاختبار. والربطُ في الصدفة يبقى رفضاً.
 */
import { expect, test } from "bun:test"
import { healNarratedReads } from "../src"

test("a narrated install is a call", () => {
  expect(healNarratedReads("⚙ run npm install")).toBe("نفّذ: run npm install")
  expect(healNarratedReads("⚙ run pnpm i")).toBe("نفّذ: run pnpm i")
  expect(healNarratedReads("⚙ run npm ci")).toBe("نفّذ: run npm ci")
})

test("the twin: chaining after it, or a different verb, is never healed", () => {
  expect(healNarratedReads("⚙ run npm install && rm -rf dist")).toBe("⚙ run npm install && rm -rf dist")
  expect(healNarratedReads("⚙ run npm init -y")).toBe("⚙ run npm init -y")
  expect(healNarratedReads("⚙ run npm install left-pad")).toBe("⚙ run npm install left-pad")
  expect(healNarratedReads("⚙ run npm install --no-audit")).toBe("نفّذ: run npm install --no-audit")
  expect(healNarratedReads("⚙ run npm install ✓ added 32 packages")).toBe("⚙ run npm install ✓ added 32 packages")
})
