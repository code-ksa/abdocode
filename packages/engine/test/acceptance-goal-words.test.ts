import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { goalRequiresBuild, goalRequiresTests, goalRequiresTypecheck, goalWordsOnly } from "../src/acceptance-goal-words"

// ن3 — كلماتُ القبول تُقرأ من كلمات المهمّة لا من المسارات: «ui-test/sample.txt» أشعل شرطَ الاختبارات حيّاً (09-15) فسقط دورُ متصفّحٍ بلا كود.

test("paths, file names and hyphenated tokens are not acceptance words", () => {
  expect(goalRequiresTests("ارفع الملف ui-test/sample.txt إلى حقل Resume")).toBe(false)
  expect(goalRequiresTests("open C:\\Users\\x\\test.txt and read it")).toBe(false)
  expect(goalRequiresTests("use the latest features")).toBe(false)
  expect(goalRequiresTests("edit test-utils.ts")).toBe(false)
  expect(goalRequiresBuild("copy build/out.js to dist")).toBe(false)
  expect(goalRequiresBuild("open the pre-build notes")).toBe(false)
  expect(goalWordsOnly("run ui-test/sample.txt then test")).not.toContain("ui-test")
})

test("real acceptance words still fire, in both languages", () => {
  expect(goalRequiresTests("run the tests after the change")).toBe(true)
  expect(goalRequiresTests("npm test must pass")).toBe(true)
  expect(goalRequiresTests("أضف اختبارات للوحدة")).toBe(true)
  expect(goalRequiresTests("write a test for the parser")).toBe(true)
  expect(goalRequiresBuild("build the project and report")).toBe(true)
  expect(goalRequiresBuild("نفّذ البناء ثم لخّص")).toBe(true)
  expect(goalRequiresTypecheck("run typecheck before finishing")).toBe(true)
  expect(goalRequiresTypecheck("type-check the package")).toBe(true)
})

test("cli.ts derives the three predicates from the module, not from inline regexes", () => {
  const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")
  expect(cli).toContain('import { goalRequiresBuild, goalRequiresTests, goalRequiresTypecheck } from "./acceptance-goal-words"')
  expect(cli).toContain("const requiresBuild = !planningOnly && goalRequiresBuild(effectiveGoal)")
  expect(cli).toContain("const requiresTypecheck = !planningOnly && goalRequiresTypecheck(effectiveGoal)")
  expect(cli).toContain("const requiresTests = !planningOnly && goalRequiresTests(effectiveGoal)")
  expect(cli).not.toContain("/(?:npm\\s+(?:run\\s+)?test|اختبار|اختبارات|tests?\\b)/iu.test(effectiveGoal)")
})
