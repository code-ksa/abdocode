import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// 09-30 (مقيس على المحرّك المثبَّت 4.0.93): وسائطُ git الشائعة رُفضت فدار النموذجُ حتى أوقفه كاشفُ التكرار بعد عملٍ مكتمل.
const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8")

test("git read runs the base verb and says the extra arguments were dropped; write verbs name their tools", () => {
  expect(cli).toContain('const [verb = "status", ...gitArgs] = (rest || "status").trim().split(/\\s+/u)')
  expect(cli).toContain('runAdapterV("git-read", "git_read", { action: verb }')
  expect(cli).toContain("لا تُمرَّر — هذه قراءةُ ${verb} الافتراضيّة كاملةً؛ لا تُعِد الطلبَ بوسائط.")
  expect(cli).toContain('commit: "git-commit <رسالة>"')
  expect(cli).toContain("git للقراءة وحدها — لـ«${verb}» استعمل الأداة")
  expect(cli).not.toContain("git: اختر status أو diff أو log أو branch أو show بلا وسائط إضافية")
})
