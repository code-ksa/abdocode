import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileWriteViaShellViolation } from "../src/shell-command-guard"

// 09-29 (مقيس على تطبيق المالك): ٧ محاولاتِ Set-Content لكتابة test/health.test.js، وchrome.open/chrome.shot في كروم المستخدم
// رغم اختيار المتصفّح المملوك.

describe("كتابةُ الشيفرة عبر الصدفة تُردّ إلى write", () => {
  test("Set-Content بحمولةٍ شبيهةٍ بالشيفرة أو متعدّدة الأسطر تُرفض باسم الملفّ وبالأداة البديلة", () => {
    const v = fileWriteViaShellViolation("powershell -Command \"Set-Content -Path 'test/health.test.js' -Value \\\"import { test } from 'node:test';`nimport assert from 'node:assert';\\\"\"")
    expect(v).toContain("test/health.test.js")
    expect(v).toContain("write test/health.test.js <<<")
    expect(fileWriteViaShellViolation("powershell -Command \"echo import { test } from 'node:test'; > test/health.test.js; echo import assert from 'node:assert'; >> test/health.test.js; echo. >> test/health.test.js\"")).toContain("write test/health.test.js <<<")
    expect(fileWriteViaShellViolation("New-Item -ItemType File -Path 'test/health.test.js' -Force; Add-Content -Path 'test/health.test.js' -Value 'import { test } from \"node:test\";'")).toContain("write")
  })
  test("التوأم: سطرٌ قصير بلا شيفرة يمرّ، وأمرٌ بلا كتابة يمرّ", () => {
    expect(fileWriteViaShellViolation("echo ok > out.txt")).toBeUndefined()
    expect(fileWriteViaShellViolation("Set-Content -Path notes.txt -Value 'hello'")).toBeUndefined()
    expect(fileWriteViaShellViolation("npm run build")).toBeUndefined()
    expect(fileWriteViaShellViolation("Get-Content package.json")).toBeUndefined()
  })
})

describe("أدواتُ إضافة المتصفّح مقفلةٌ خلف «browser extension»", () => {
  const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8")
  test("الاستدعاءُ يُرفض باسم البديل، والعرضُ يُخفيها، حين المتصفّحُ المختار مملوك", () => {
    // 10-12: الخلفيّةُ تُقرأ من متصفّح الدور (طلبٌ في متصفّح المستخدم يفتحها لدوره وحده) — والإعدادُ المحفوظ هو الافتراض.
    expect(cli).toContain("if (chromeBridgeId !== undefined && word.startsWith(`${chromeBridgeId}.`) && browserBackendNow() !== \"extension\") {")
    expect(cli).toContain("const browserBackendNow = (): \"owned\" | \"extension\" | \"off\" => turnBrowserBackend ?? loadSettings().browserBackend ?? \"owned\"")
    expect(cli).toContain("استعمل open/page/shot/tap؛ أدواتُ ${chromeBridgeId}.* لتبويب المستخدم فقط بعد «browser extension»")
    expect(cli).toContain("const hideChrome = chromeBridgeId !== undefined && browserBackendNow() !== \"extension\"")
    expect(cli).toContain("const shellWrite = violationAcrossVariants(cmd, fileWriteViaShellViolation)")
  })
})
