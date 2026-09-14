import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

// ب8 — **اللوحُ الحيّ للاقتران الآليّ** يعمل تحت node لا bun (Playwright يعلّق تحت bun test — مقيس 09-14): الجسرُ الحقيقيّ يقلع
// بنافذة اقترانٍ مفتوحة، وإيدج حقيقيّ محمّلٌ بالإضافة بلا رمز يسأل /pair ويتّصل. الحقيقةُ من stderr الجسر وتخزين الإضافة.
// يحتاج ABDO_PLAYWRIGHT_PACKAGE (مسار package.json لـplaywright مثبَّت) وإيدج على الجهاز؛ وإلّا يُتخطّى باسمه لا بصمت.

const board = resolve(import.meta.dir, "..", "..", "browser-bridge", "scripts", "autopair-board.mjs")
const playwrightPackage = process.env.ABDO_PLAYWRIGHT_PACKAGE

test.skipIf(process.platform !== "win32" || !playwrightPackage || !existsSync(board))("an unpaired extension pairs itself while the bridge's pairing window is open (node board)", async () => {
  const child = Bun.spawn(["node", board], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ABDO_PLAYWRIGHT_PACKAGE: playwrightPackage! } })
  const out = await new Response(child.stdout).text()
  const err = await new Response(child.stderr).text()
  const code = await child.exited
  expect(out, err.slice(0, 1500)).toContain("✓ الإضافةُ سألت /pair وأخذت الرمز")
  expect(out).toContain("✓ الإضافةُ اتّصلت بالمقبس بالرمز الذي أخذته")
  expect(out).toContain("AUTOPAIR_BOARD_OK")
  expect(code).toBe(0)
}, 120_000)
