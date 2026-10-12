import type { ToolVerdict } from "@abdo/engine-host"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { exitZero } from "./failure-tiering"

const nextEntryCandidates = [
  "app/page.tsx", "app/page.jsx", "app/page.ts", "app/page.js",
  "src/app/page.tsx", "src/app/page.jsx", "src/app/page.ts", "src/app/page.js",
  "pages/index.tsx", "pages/index.jsx", "pages/index.ts", "pages/index.js",
  "src/pages/index.tsx", "src/pages/index.jsx", "src/pages/index.ts", "src/pages/index.js",
] as const

const manifestDependencies = (projectDir: string): Record<string, unknown> => {
  try {
    const manifest = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf-8")) as {
      dependencies?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
    }
    return { ...manifest.dependencies, ...manifest.devDependencies }
  } catch { return {} }
}
const isNextProject = (projectDir: string): boolean => manifestDependencies(projectDir).next !== undefined

/** CSS files under a build output folder (bounded walk — a build folder, not the project). */
const cssUnder = (dir: string, budget = { files: 400 }): string[] => {
  const out: string[] = []
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    if (budget.files-- <= 0) break
    const full = join(dir, name)
    try {
      const st = statSync(full)
      if (st.isDirectory()) out.push(...cssUnder(full, budget))
      else if (name.endsWith(".css") && st.size < 8_000_000) out.push(full)
    } catch { /* vanished mid-walk */ }
  }
  return out
}

/**
 * 10-09 — مقيس في مقارنة m11 (Vite + Tailwind + SQLite) على الأداتين معاً: tailwindcss مثبّتٌ في package.json والبناءُ يخرج 0، لكنّ
 * dist بلا ملفّ CSS أصلاً (لا `@import "tailwindcss"` ولا ملحقُ Vite لـv4 — tailwind.config.js بصيغة v3 وحده). البناءُ «أخضر» والموقعُ بلا
 * أنماط؛ وتحذيرُ project-stack لا يظهر إلا في توجيه أوّل الدور قبل وجود package.json. الحكمُ من مخرَج البناء على القرص لا من الإعداد.
 */
export function tailwindBuildViolation(projectDir: string): string | undefined {
  const deps = manifestDependencies(projectDir)
  const range = deps.tailwindcss
  if (typeof range !== "string" || deps.vite === undefined) return undefined
  const outDir = join(projectDir, "dist")
  if (!existsSync(outDir)) return undefined
  const compiled = cssUnder(outDir).some((file) => {
    try { const css = readFileSync(file, "utf-8"); return /tailwindcss v\d|--tw-/u.test(css) } catch { return false }
  })
  if (compiled) return undefined
  const v4 = /^[~^>=\s]*4\./u.test(range) || range === "latest"
  return v4
    ? "البناء خرج 0 لكنّ dist بلا CSS من Tailwind (tailwindcss " + range + " مثبّت). Tailwind 4 لا يعمل بالتثبيت ولا بـtailwind.config.js وحده: " +
      "npm i -D @tailwindcss/vite ⇦ في vite.config: import tailwindcss from '@tailwindcss/vite' وplugins: [tailwindcss()] ⇦ ملفّ CSS فيه @import \"tailwindcss\"; " +
      "يستورده مدخلُ الواجهة (import './style.css') ⇦ أعد البناء وتأكّد أنّ dist/assets/*.css يحمل «tailwindcss v4»."
    : "البناء خرج 0 لكنّ dist بلا CSS من Tailwind (tailwindcss " + range + " مثبّت). Tailwind 3 يحتاج postcss.config بـtailwindcss وautoprefixer، " +
      "وملفّ CSS فيه @tailwind base; @tailwind components; @tailwind utilities; يستورده مدخلُ الواجهة، وcontent في tailwind.config يشمل index.html وsrc ⇦ أعد البناء."
}

/** A zero-exit Next build that only emits /404 is not a customer website; a Vite build with Tailwind installed must emit Tailwind CSS. */
export function projectBuildViolation(projectDir: string, output: string, verdict?: ToolVerdict): string | undefined {
  if (!exitZero(output, verdict)) return undefined
  const tailwind = tailwindBuildViolation(projectDir)
  if (tailwind !== undefined) return tailwind
  if (!isNextProject(projectDir)) return undefined
  if (nextEntryCandidates.some((candidate) => existsSync(join(projectDir, candidate)))) return undefined
  return "بناء Next.js خرج 0 لكنه لا يملك صفحة رئيسية app/page أو pages/index؛ خرج البناء صفحة 404 فقط ولا يمثل موقعاً قابلاً للتسليم"
}
