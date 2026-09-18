import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { semanticFrame, describeFrame } from "@abdo/semantic"

// والريستارت والباكاب». المحرّكُ يسمّي العمليّة حتمياً قبل أوّل نداء، ويُوجّه النموذجَ إلى أداة `*_intent` الموصولة
// (مزوّدُ أدواتٍ موصول يملكها) — لا يخترع سكربتاً ولا يدفع بلا إذن.
test("the semantic frame names the operation and the engine routes it to a connected *_intent tool before the first call", () => {
  const f = semanticFrame("خد باكاب على جوجل درايف دلوقتي")
  expect(f.ops.action).toBe("backup")
  expect(describeFrame(f)).toContain("عمليّة: backup")
  const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8")
  expect(cli).toContain('if (frame.ops.action !== "none") {')
  expect(cli).toContain("const intentTool = [...externals.values()].flatMap((session) => session.tools()).map((tool) => tool.name).find((name) => /_intent$/u.test(name))")
  expect(cli).toContain("استدعِ ${intentTool} أوّلاً بنصّ الطلب كاملاً واقرأ دليلَها (الشروطُ ثمّ الخطوات) قبل أيّ أداةٍ أخرى")
  expect(cli).toContain("await emitEvent(turn.id, `🧭 عمليّةُ تشغيل «${frame.ops.action}» — الدليلُ عند ${intentTool}`)")
  // الموجزُ يُحقن في الحقبة الأولى فقط حين تُوجد الأداة: بلا مزوّدٍ موصول لا سطرَ يعد بدليلٍ غير موجود.
  const at = cli.indexOf('if (frame.ops.action !== "none") {')
  expect(cli.slice(at, at + 900)).toContain("if (intentTool !== undefined) {")
})
