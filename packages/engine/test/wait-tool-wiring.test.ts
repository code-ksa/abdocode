import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ProductTools as Tools } from "@abdo/tools"
import { TOOL_FAMILIES } from "../src/tool-exposure"

// ن4 (أمرُ المالك 09-15، نقدُ التحكّم): `wait <نصّ|[rN]> [ث]` للمتصفّح (المملوك والإضافة، مركَّبٌ فوق page) و`desk wait <نصّ> [ث]` لسطح المكتب
// (مركَّبٌ فوق windows/ui). الاستطلاعُ محدودٌ (≤ ٦٠ ث) ويسمّي ما ظهر أو لم يظهر؛ عربيّةُ المطابقة مطبَّعة.
const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")

test("wait is catalogued, exposed with the browser family, bounded, normalised, and composed over page", () => {
  const tool = Tools.TOOLS.find((t) => t.name === "wait")
  expect(tool?.agentCallable).toBe(true)
  expect(tool?.effect).toBe("read")
  expect(tool?.runner).toBe("surface")
  expect(TOOL_FAMILIES.browser).toContain("wait")
  expect(cli).toContain('if (name === "wait") {')
  expect(cli).toContain('const seconds = Math.min(60, Math.max(1, Number.parseInt(m?.[2] ?? "15", 10) || 15))')
  expect(cli).toContain("const fold = (s: string) => normalizeArabic(s).toLowerCase()")
  expect(cli).toContain('last = await runSurfaceTool("page", "", turnId)')
  expect(cli.indexOf('if (name === "wait") {')).toBeLessThan(cli.indexOf('if (name === "dismiss") {'))
  expect(cli).toContain("interpretGateTurn, normalizeArabic, parseGateMode")
})

test("desk wait is composed over windows and the bound window's ui tree, before the desktop parser", () => {
  const desk = Tools.TOOLS.find((t) => t.name === "desk")
  expect(desk?.usage).toContain("desk wait <نصّ> [ث]")
  const wait = cli.indexOf('if (/^wait\\s+/u.test(rest.trim())) {')
  const parse = cli.indexOf("const action = parseDesktopCommand(rest)")
  expect(wait).toBeGreaterThan(0)
  expect(wait).toBeLessThan(parse)
  expect(cli).toContain('const w = await runDesktop({ kind: "windows" }, { shotsDir })')
  expect(cli).toContain('const ui = await runDesktop({ kind: "ui", depth: 8 }, { shotsDir, bound: desktopBound })')
  expect(cli).toContain("desktopUi = { depth: 8, elements: ui.elements! }")
})
