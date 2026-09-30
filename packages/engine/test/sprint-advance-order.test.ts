import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// 09-30 (مقيس بلا شاشة): أُغلق سبرنت 2 في الملفّ ثمّ حجبت المراجعةُ المستقلّة فوقف الدور قبل أن تُرى الحافّة — ولم يبدأ سبرنت 3؛
// والمراجِعُ حكم على «اكمل» وحدَها فقلب معنى السبرنت.
const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8")

test("the sprint advance edge runs before the independent review in the completion branch", () => {
  const advance = cli.indexOf("const advance = sprintAdvance(PROJECT_DIR, sprintOpenAtStart)")
  expect(advance).toBeGreaterThan(0)
  const branch = cli.lastIndexOf('if (loop.stopReason === "complete") {', advance)
  expect(advance - branch).toBeLessThan(900) // أوّلُ ما في فرع الاكتمال
  const review = cli.indexOf("if (superActive) {", advance)
  expect(review).toBeGreaterThan(advance)
  expect(review - advance).toBeLessThan(900) // والمراجعةُ بعدها مباشرةً
  expect(cli.split("const advance = sprintAdvance(PROJECT_DIR, sprintOpenAtStart)").length).toBe(2) // مرّةً واحدة
})

test("judges (review, verifier, refutation) get the sprint plan state when the turn resumes a plan", () => {
  expect(cli).toContain("const judgeGoal = (): string =>")
  expect(cli).toContain("متابعةُ خطّة ABDO-SPRINTS.md")
  expect(cli).toContain("buildVerifierPrompt(judgeGoal(), loop.answer, allReceipts, diskNow()), {")
  expect(cli).toContain("buildRefutePrompt(judgeGoal(), loop.answer, allReceipts, lens), {")
  expect(cli).toContain("buildVerifierPrompt(judgeGoal(), loop.answer, allReceipts, diskNow()), hooks, [], judge)")
  expect(cli).not.toContain("buildVerifierPrompt(effectiveGoal,")
})

test("09-30: the turn's due sprints (open at its start, with gates) feed the judges and the browser gate", () => {
  expect(cli).toContain('const sprintsDue = parallelWorker ? "" : openSprintsSummary(PROJECT_DIR)')
  expect(cli).toContain("فلا يُطالَب بدليله هنا")
  expect(cli.split("browserProofVerdict(proofGoal, allReceipts.slice(outputEvidenceFloor), browserAvailable)").length - 1).toBe(2)
  expect(cli).not.toContain("browserProofVerdict(effectiveGoal,")
})
