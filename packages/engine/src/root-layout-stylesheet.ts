/**
 * The root layout of a Next app router project (`app/layout.tsx`, or under `src/`) that imports no stylesheet while a stylesheet
 * sits in `app/` and nothing else imports it: the whole site renders with browser defaults.
 *
 * Measured 10-02: rewriting the root layout dropped `import "./globals.css"`; every page shipped unstyled, and two later turns
 * edited the same file without noticing (one of them never ran audit). The guard refuses such a write and warns on every read,
 * naming the stylesheet and the line that brings it back. It never fires when the layout imports any `.css`, when another file
 * imports the stylesheet, or when `app/` holds no stylesheet.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const ROOT_LAYOUT = /^(?:src\/)?app\/layout\.(?:tsx|jsx|ts|js)$/u
const CSS_IMPORT = /import\s+(?:[\w*{}\s,]+\s+from\s+)?["'][^"']+\.css["']/u
const SKIP = new Set(["node_modules", ".next", ".git", "dist", "build", "out", ".turbo"])

export const isRootLayout = (normalizedTarget: string): boolean => ROOT_LAYOUT.test(normalizedTarget.replaceAll("\\", "/").replace(/^\.\//u, ""))

function sourceFiles(dir: string, out: string[], budget: { n: number }): void {
  if (budget.n <= 0) return
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return }
  for (const name of names) {
    if (SKIP.has(name) || budget.n <= 0) continue
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) sourceFiles(p, out, budget)
    else if (/\.(?:tsx|jsx|ts|js|mjs)$/u.test(name)) { out.push(p); budget.n -= 1 }
  }
}

/** The orphaned stylesheet's project-relative path when the given root-layout content leaves the site unstyled; else undefined. */
export function orphanedStylesheet(projectDir: string, normalizedTarget: string, content: string): string | undefined {
  const target = normalizedTarget.replaceAll("\\", "/").replace(/^\.\//u, "")
  if (!ROOT_LAYOUT.test(target) || CSS_IMPORT.test(content)) return undefined
  const appDir = join(projectDir, target.slice(0, target.lastIndexOf("/")))
  let sheets: string[] = []
  try { sheets = readdirSync(appDir).filter((n) => /\.css$/iu.test(n)) } catch { return undefined }
  if (sheets.length === 0) return undefined
  const files: string[] = []
  sourceFiles(join(projectDir, existsSync(join(projectDir, "src")) ? "src" : "app"), files, { n: 3000 })
  const layoutAbs = join(projectDir, target)
  for (const sheet of sheets) {
    const imported = files.some((f) => {
      if (f === layoutAbs) return false
      try { return new RegExp(`["'][^"']*${sheet.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}["']`, "u").test(readFileSync(f, "utf8")) } catch { return false }
    })
    if (!imported) return relative(projectDir, join(appDir, sheet)).replaceAll("\\", "/")
  }
  return undefined
}

export const orphanedStylesheetLine = (sheet: string, target: string): string =>
  `الملفّ الجذر ${target} لا يستورد أيَّ ورقة أنماط، و${sheet} موجودٌ ولا يستورده ملفٌّ آخر — الموقعُ كلُّه يُعرض بأنماط المتصفّح الافتراضيّة. ` +
  `أضف في أوّل الملفّ: import "./${sheet.slice(sheet.lastIndexOf("/") + 1)}"`
