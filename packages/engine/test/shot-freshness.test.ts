import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// 09-30 (مقيس بلا شاشة على مشروع Next حقيقيّ): shot بعد إصلاحٍ وبناءٍ وإعادة تشغيل الخادم التقط الوثيقةَ القديمة نفسَها (22797 بايت
// مرّتين) فرأت العينُ الخطأَ المُصلَح؛ وshot بلا سطحٍ قال «لا سطحَ موصول» والخادمُ المُدار حيّ.
const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8")

test("shot reloads a local page loaded before the managed server (re)started, and says so", () => {
  expect(cli).toContain("let surfaceLoadedAt = 0")
  expect(cli).toContain("let managedServerStartedAt = 0")
  expect(cli).toContain('if (startedSay.startsWith("⚙ الخادم يعمل تحت إدارة النواة")) managedServerStartedAt = Date.now()')
  // «خادمك يعمل فعلاً» (لا إعادةَ تشغيل) لا يحرّك الطابع — التوأم
  expect(cli).not.toContain('startedSay.startsWith("⚙ خادمك يعمل فعلاً")) managedServerStartedAt')
  const shot = cli.indexOf('    if (name === "shot") {')
  const reload = cli.indexOf("if (managedServerStartedAt > surfaceLoadedAt && /^https?:\\/\\/(?:127\\.0\\.0\\.1|localhost)", shot)
  const capture = cli.indexOf("const capture = async ()", shot)
  expect(reload).toBeGreaterThan(shot)
  expect(reload).toBeLessThan(capture) // الإعادةُ قبل الالتقاط — لا بعده
  expect(cli).toContain("return reloadNote + described + where")
  expect(cli).toContain("return reloadNote + (route.reaches")
  // والفتحُ يختم الطابع
  expect(cli).toContain("      surfaceUrl = rest\r\n      surfaceLoadedAt = Date.now()".replace(/\r\n/gu, cli.includes("\r\n") ? "\r\n" : "\n"))
})

test("shot with no surface opens the live managed server first, like open falls back to ui", () => {
  // 10-01: audit وcompare وseo تفتح الخادمَ المُدار بالشرط نفسِه.
  const at = cli.indexOf('if ((name === "shot" || name === "audit" || name === "compare" || name === "seo") && surface === undefined) {')
  expect(at).toBeGreaterThan(0)
  expect(at).toBeLessThan(cli.indexOf('if (surface === undefined) return "لا سطحَ موصول'))
  expect(cli).toContain('const opened = await runSurfaceTool("ui", `http://127.0.0.1:${port}/`, turnId)')
})
