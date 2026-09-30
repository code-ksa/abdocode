import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { goalForbidsEdits, noEditGoalRefusal } from "../src/goal-no-edit"

// الحالةُ المقيسة 2026-09-30 على المثبَّت 4.0.94 — نصُّ الهدف كما كُتب.
const MEASURED = "شغّل next على هذا المشروع وأخبرني ما الخطوة التالية — لا تعدّل أيّ ملفّ."

test("blanket forbids fire — Arabic, colloquial, English (the measured goal first)", () => {
  for (const goal of [
    MEASURED,
    "لا تعدل اي ملف",
    "افحص المشروع بدون تعديل",
    "راجع الكود دون تعديل، وأعطني تقريراً",
    "لا تغيّر شيئاً",
    "لا تلمس الملفات",
    "متعدّلش حاجة، بس قولي المشكلة",
    "مهمة للقراءة فقط: اشرح البنية",
    "للقراءة فقط — ما الذي يكسر البناء؟",
    "Explain the build failure. Don't modify anything.",
    "Review the repo but do not change any files",
    "audit this without touching the code",
    "Stay read-only and list the routes",
    "make no changes, just report",
  ]) expect([goal, goalForbidsEdits(goal)]).toEqual([goal, true])
})

test("the opposite direction: scoped forbids, exceptions and look-alikes do not fire", () => {
  for (const goal of [
    "أصلح زر الدخول ولا تعدّل package.json",
    "لا تعدّل أيّ ملفّ إلا README.md",
    "لا تغيّر شيئاً في الواجهة، أصلح الخادم",
    "أضف متغيّر بيئة جديداً، واختبره",
    "تأكّد أن السكربت لا يعدّل الملفات",
    "اجعل الحقل للقراءة فقط",
    "add a read-only field to the form",
    "if there are no changes, stop",
    "don't modify the tests, fix the code",
    "Don't change anything in the header, fix the footer",
    "ابنِ موقعاً بـ next.js وشغّل npm audit",
  ]) expect([goal, goalForbidsEdits(goal)]).toEqual([goal, false])
})

test("under a blanket forbid: writes and package/file mutations are refused, reads run", () => {
  for (const [tool, command] of [
    ["write", "write src/a.ts"],
    ["edit", "edit package.json"],
    ["patch", "patch"],
    ["git-commit", "git-commit fix"],
    ["run", "run npm update next eslint-config-next @next/eslint-plugin-next"],
    ["run", "run npm i"],
    ["run", "run pnpm add zod"],
    ["run", "run npm audit fix --force"],
    ["run", "run npm run build && npm install"],
    ["run", "run rm -rf .next"],
    ["run", "run git checkout -- ."],
    ["run", "run npx npm install left-pad"],
  ] as const) expect([command, noEditGoalRefusal(MEASURED, tool, command) !== undefined]).toEqual([command, true])
  // التوأمُ الإيجابيّ: القراءةُ والتشغيلُ والتدقيقُ بلا إصلاح تمرّ — حارسٌ يحجب كلَّ شيء عطل.
  for (const [tool, command] of [
    ["read", "read package.json"],
    ["grep", "grep next"],
    ["run", "run npm run build"],
    ["run", "run npm test"],
    ["run", "run npm audit --audit-level=high"],
    ["run", "run npm outdated"],
    ["run", "run git status"],
    ["run", "run git log --oneline -5"],
  ] as const) expect([command, noEditGoalRefusal(MEASURED, tool, command)]).toEqual([command, undefined])
})

test("without a forbid nothing is refused", () => {
  expect(noEditGoalRefusal("حدّث next إلى آخر إصدار", "run", "run npm update next")).toBeUndefined()
  expect(noEditGoalRefusal("fix the login button", "write", "write src/login.tsx")).toBeUndefined()
})

test("the guard stands at the single dispatcher, and the audit gate waits for an edit", () => {
  const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")
  const dispatch = cli.indexOf("if (!planningToolAllowed(Tools.tool(word)?.name ?? word, planningPhase))")
  const guard = cli.indexOf("noEditGoalRefusal(currentGoalText, Tools.tool(word)?.name ?? word, body.trim())")
  expect(dispatch).toBeGreaterThan(0)
  expect(guard).toBeGreaterThan(dispatch)
  expect(guard - dispatch).toBeLessThan(600)
  // التدقيقُ شرطٌ لجولةٍ عدّلت شيفرةً أو اعتماديات — لا لمهمّة قراءة ذُكرت فيها كلمةُ npm.
  expect(cli.match(/requiresNpmAudit && \(codeEditedThisTurn \|\| depsTouchedThisTurn\)/gu)?.length).toBe(3)
  // والإبطالُ يسبق التنفيذ: أمرٌ يرفضه الحارس لا يُحسب تعديلاً (قيس حيّاً على 4.0.95 — رفضُ npm update أطلق بوّابةَ التدقيق).
  const invalidate = cli.indexOf("const invalidateAcceptanceFor = (command: string) => {")
  const skip = cli.indexOf("noEditGoalRefusal(currentGoalText, Tools.tool(invalidatingWord)?.name ?? invalidatingWord, command.trim()) !== undefined) return", invalidate)
  const firstMark = cli.indexOf("if (editsCode(command)) { codeEditedThisTurn = true", invalidate)
  expect(invalidate).toBeGreaterThan(0)
  expect(skip).toBeGreaterThan(invalidate)
  expect(skip).toBeLessThan(firstMark)
})
