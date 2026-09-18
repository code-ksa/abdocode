import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// مقيس 09-14 على المثبَّت: المهمّةُ قالت «browser extension» فاستدعى النموذجُ `skill browser extension` سبعَ مرّاتٍ بأشكالٍ مختلفة وانتهى الدورُ بلا فعل.
// المسمار: `skill <أداة …>` يعيد الأداةَ والنداءَ الصحيح بدل «مرجعٌ مشوَّه» — بالأشكال الثلاثة (فراغ، شرطة، شرطة سفليّة) والاقتباس.
const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")

test("skill <tool> names the tool and writes the right call", () => {
  expect(cli).toContain("Tools.TOOLS.some((t) => t.name === toolWord)) return `«${toolWord}» أداةٌ لا مهارة — نفّذ: ")
  expect(cli).toContain("split(/[\\s_-]+/u)[0]")
  // الفحصُ يسبق رفضَ الشكل: «browser-extension» و«\"browser extension\"» يصلان إلى التلميح لا إلى «مرجعٌ مشوَّه»
  expect(cli.indexOf("أداةٌ لا مهارة")).toBeLessThan(cli.indexOf("if (!SKILL_REF.test(ref)) return `مرجعٌ مشوَّه"))
})
