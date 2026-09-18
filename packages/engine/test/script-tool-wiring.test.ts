import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ProductTools as Tools } from "@abdo/tools"

// و`script backup <ملف>` يحفظ الكودَ القديم قبل تعديله. المسمار: الأداةُ في الكتالوج بشكلها، والدخولُ من كتلة exec قبل بوّابة run.
const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")

test("script is agent-callable on the exec runner, maps extensions to interpreters, and backs up inside the project only", () => {
  const tool = Tools.TOOLS.find((t) => t.name === "script")
  expect(tool?.agentCallable).toBe(true)
  expect(tool?.runner).toBe("exec")
  expect(tool?.usage).toContain("script backup <ملف>")
  expect(tool!.summary.length).toBeLessThanOrEqual(512)
  expect(cli).toContain('if (spec.name === "script") {')
  expect(cli).toContain('py: "python", js: "node", mjs: "node", cjs: "node", ts: "bun", ps1: "powershell -NoProfile -ExecutionPolicy Bypass -File", sh: "bash"')
  expect(cli).toContain("if (file.length === 0 || !abs.startsWith(resolve(PROJECT_DIR))) return invalid(\"script backup <ملف داخل المشروع>\")")
  expect(cli).toContain('await gate(turnId, "edit", `نسخةٌ احتياطيّة قبل التعديل: ${file}`)')
  // التشغيلُ يمرّ ببوّابة run نفسِها بعد التحويل: التحويلُ يسبق الفحصَ والبوّابة
  expect(cli.indexOf('if (spec.name === "script") {')).toBeLessThan(cli.indexOf('const ok = await gate(turnId, spec.effect, `تنفيذ${background ? " (خلفيّ)" : ""}: ${command}`)'))
})
