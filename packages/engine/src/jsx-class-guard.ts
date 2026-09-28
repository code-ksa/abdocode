/**
 * حارسُ «أصنافُ Tailwind بلا Tailwind» — بلاغُ المالك 2026-09-28 (nemotron-ultra-253b): صفحةُ page.tsx بأسماءٍ دلاليّة مثل
 * `text-muted` و`items-list` و`bg-card` رُفضت ثلاثَ مرّاتٍ «أصناف Tailwind كثيرة» فمات الدور. الحارسُ القديم عدّ أيَّ
 * `text-…`/`bg-…`/`items-…` صنفَ Tailwind؛ والآن يعدّ **قواعدَ Tailwind بسُلَّمها** فقط (أرقامٌ ودرجاتُ لونٍ وكلماتُها
 * المحفوظة)، ويُسقط ما عرّفه المشروعُ في ملفّات CSS الخاصّة به — حارسٌ يمسك الشكلَ الذي يكتبه Tailwind لا كلَّ ما يشبهه.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const TAILWIND_UTILITY = /\b(?:(?:bg|text|border|from|to|ring)-(?:[a-z]+-(?:50|[1-9]00|950)|white|black|transparent)|(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|w|h|min-h|max-w|rounded|shadow|text|leading|tracking)-(?:\d+(?:\.\d+)?|xs|sm|md|lg|xl|\dxl|full|screen|auto|none|px)|(?:grid-cols|col-span|items|justify|self)-(?:\d+|center|start|end|between|around|stretch)|(?:hover|focus|md|lg|sm|dark):[a-z0-9-]+)\b/gu

/** الأصنافُ التي يعرّفها المشروعُ نفسُه في CSS (حتى 20 ملفّاً و200 كيلوبايت لكلٍّ) — ليست Tailwind ولو شابهته. */
export function definedCssClasses(projectDir: string): ReadonlySet<string> {
  const found = new Set<string>()
  const roots = ["app", "src/app", "src", "styles", "src/styles", "public", "."]
  let budget = 20
  const visit = (dir: string, depth: number): void => {
    if (budget <= 0 || depth > 3 || !existsSync(dir)) return
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const entry of entries) {
      if (budget <= 0) return
      if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue
      const full = join(dir, entry)
      let info
      try { info = statSync(full) } catch { continue }
      if (info.isDirectory()) { visit(full, depth + 1); continue }
      if (!/\.css$/iu.test(entry) || info.size > 200 * 1024) continue
      budget -= 1
      try {
        for (const match of readFileSync(full, "utf-8").matchAll(/\.([A-Za-z_][\w-]*)\s*[{,:.\s>[]/gu)) found.add(match[1]!)
      } catch { /* ملفٌّ لا يُقرأ — يُتجاوز */ }
    }
  }
  for (const root of roots) visit(join(projectDir, root), 0)
  return found
}

/** عددُ أصناف Tailwind الحقيقيّة في مصدر JSX بعد إسقاط ما عرّفه المشروع. */
export function tailwindUtilityCount(source: string, defined: ReadonlySet<string>): number {
  let count = 0
  for (const match of source.matchAll(TAILWIND_UTILITY)) {
    const token = match[0]
    if (!defined.has(token)) count += 1
  }
  return count
}

/** يُرفض حين تكثر قواعدُ Tailwind الحقيقيّة (≥ 8) بلا tailwindcss في المشروع. */
export const TAILWIND_REFUSAL_THRESHOLD = 8
