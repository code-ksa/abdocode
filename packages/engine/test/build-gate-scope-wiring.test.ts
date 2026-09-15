import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// د7 (مقيس 09-15 على 4.0.33): «أنشئ ملفّ hello_abdo.py» أشعل بوّابةَ البناء؛ المشروعُ فيه package.json بلا build فطُلب npm run build وبدأ النموذجُ
// يضيف سكربتَ build إلى package.json (قوطع بيدي). المسامير: كلماتُ الإنشاء ليست بناءً؛ بوّابتا npm تنطبقان حين يعرّف package.json السكربت؛
// حزمةٌ بلا build عند الاكتمال = «لا ينطبق» بحدثٍ مسمّى، لا استمرارٌ يطلب npm run build.
const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")

test("create words no longer imply a build, and the npm gates require the script to exist", () => {
  expect(cli).toContain("const requiresBuild = !planningOnly && /(?:\\bbuild\\b|البناء|ابنِ?|بناءً)/iu.test(effectiveGoal)")
  expect(cli).not.toContain("|بناءً|أنشئ|انشئ|إنشاء|انشاء)/iu.test(effectiveGoal)")
  expect(cli).toContain("const packageHasScript = (name: string): boolean =>")
  expect(cli).toContain('requiresTypecheck && !successfulTypecheck && pending === undefined && packageHasScript("typecheck")')
  expect(cli).toContain('requiresBuild && !successfulBuild && pending === undefined && packageHasScript("build")')
  const notApplicable = cli.indexOf('!packageHasScript("build")) {')
  const demand = cli.indexOf('pending = hasPackage ? "run npm run build" : undefined')
  expect(notApplicable).toBeGreaterThan(0)
  expect(notApplicable).toBeLessThan(demand) // «لا ينطبق» يسبق فرعَ الطلب ويعزله بـelse if
  expect(cli).toContain("شرطُ البناء لا ينطبق: package.json بلا سكربت build — لا يُضاف سكربتٌ لإرضاء البوّابة")
})
