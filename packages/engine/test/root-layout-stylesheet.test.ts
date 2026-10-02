import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { isRootLayout, orphanedStylesheet, orphanedStylesheetLine } from "../src/root-layout-stylesheet"

// 10-02 — measured: rewriting the root layout dropped `import "./globals.css"`; the whole site rendered unstyled and two later
// turns edited the same file without noticing. The guard: a root layout that imports no stylesheet while the one in app/ is
// imported by nothing else.

const LAYOUT_NO_CSS = `import type { Metadata } from "next"\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return <html lang="ar" dir="rtl"><body>{children}</body></html>\n}\n`
const LAYOUT_WITH_CSS = `import "./globals.css"\n${LAYOUT_NO_CSS}`

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "abdo-layout-"))
  for (const [p, body] of Object.entries(files)) { mkdirSync(join(dir, p, ".."), { recursive: true }); writeFileSync(join(dir, p), body) }
  return dir
}

describe("orphaned stylesheet", () => {
  test("a root layout with no stylesheet while app/globals.css is imported by nothing is caught, with the fix named", () => {
    const dir = project({ "src/app/layout.tsx": LAYOUT_NO_CSS, "src/app/globals.css": "@import \"tailwindcss\";\n", "src/app/page.tsx": "export default function P(){return null}\n" })
    try {
      expect(orphanedStylesheet(dir, "src/app/layout.tsx", LAYOUT_NO_CSS)).toBe("src/app/globals.css")
      expect(orphanedStylesheetLine("src/app/globals.css", "src/app/layout.tsx")).toContain('import "./globals.css"')
      // backslashes and ./ are the same file
      expect(orphanedStylesheet(dir, ".\\src\\app\\layout.tsx", LAYOUT_NO_CSS)).toBe("src/app/globals.css")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  test("twins: the layout imports a stylesheet, another file imports it, app/ has none, or it is not the root layout", () => {
    const dir = project({ "src/app/layout.tsx": LAYOUT_NO_CSS, "src/app/globals.css": "x{}\n" })
    const viaProviders = project({ "src/app/layout.tsx": LAYOUT_NO_CSS, "src/app/globals.css": "x{}\n", "src/components/providers.tsx": `import "../app/globals.css"\nexport const P = 1\n` })
    const noSheet = project({ "app/layout.tsx": LAYOUT_NO_CSS })
    try {
      expect(orphanedStylesheet(dir, "src/app/layout.tsx", LAYOUT_WITH_CSS)).toBeUndefined()
      expect(orphanedStylesheet(dir, "src/app/layout.tsx", `import styles from "./globals.css"\n${LAYOUT_NO_CSS}`)).toBeUndefined()
      expect(orphanedStylesheet(viaProviders, "src/app/layout.tsx", LAYOUT_NO_CSS)).toBeUndefined()
      expect(orphanedStylesheet(noSheet, "app/layout.tsx", LAYOUT_NO_CSS)).toBeUndefined()
      expect(orphanedStylesheet(dir, "src/app/workspaces/layout.tsx", LAYOUT_NO_CSS)).toBeUndefined()
      expect(isRootLayout("app/layout.js")).toBe(true)
      expect(isRootLayout("src/app/chat/layout.tsx")).toBe(false)
    } finally { for (const d of [dir, viaProviders, noSheet]) rmSync(d, { recursive: true, force: true }) }
  })
  test("cli refuses such a write and warns on such a read", () => {
    const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8")
    expect(cli).toContain("const orphanSheet = isRootLayout(normalizedTarget) ? orphanedStylesheet(PROJECT_DIR, normalizedTarget, after) : undefined")
    expect(cli).toContain("return refused(`رُفض: ${orphanedStylesheetLine(orphanSheet, normalizedTarget)} — لم يُكتب شيء.`)")
    expect(cli).toContain("(orphanSheet === undefined ? \"\" : `\\n\\n⚠ ${orphanedStylesheetLine(orphanSheet, file)}`)")
  })
})

const ROOT = resolve(import.meta.dir, "../../..")

test.skipIf(process.platform !== "win32")("the real read through the kernel carries the warning; with the import back it does not", () => {
  const dir = project({ "src/app/layout.tsx": LAYOUT_NO_CSS, "src/app/globals.css": "x{}\n", "package.json": "{\"name\":\"p\"}" })
  const env = { ...process.env, ABDO_CODE_STATE_DIR: join(dir, ".state"), USERPROFILE: dir, HOME: dir, ABDO_VAULT_HOME: dir }
  try {
    const run = () => Bun.spawnSync([process.execPath, join(ROOT, "packages/engine/src/cli.ts"), "read", "src/app/layout.tsx"], { cwd: dir, env, stdout: "pipe", stderr: "pipe" })
    const broken = run().stdout.toString()
    expect(broken).toContain("--- src/app/layout.tsx ---")
    expect(broken).toContain("⚠ الملفّ الجذر src/app/layout.tsx لا يستورد أيَّ ورقة أنماط")
    writeFileSync(join(dir, "src/app/layout.tsx"), LAYOUT_WITH_CSS)
    const fixed = run().stdout.toString()
    expect(fixed).toContain("--- src/app/layout.tsx ---")
    expect(fixed).not.toContain("لا يستورد أيَّ ورقة أنماط")
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 120_000)
