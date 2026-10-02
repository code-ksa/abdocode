/**
 * Tailwind 4: `@apply` takes utilities (built-in, or defined with `@utility`), not a class written as plain CSS in the same file.
 * `.card-hover { … }` then `@apply … card-hover;` makes Tailwind throw "Cannot apply unknown utility class" and every page is a 500.
 *
 * Measured 10-02: that line turned the whole site into a 500, so the model removed `import "./globals.css"` from the root layout
 * to get pages back — and shipped an unstyled site for hours. The CSS parser accepts the file (the syntax is valid); only
 * Tailwind's own compile fails. This check runs before the write and on every read of such a stylesheet.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

const PLAIN_CLASS = /(?:^|[\s,}>+~(])\.(-?[A-Za-z_][\w-]*)(?=[\s,:{.[>+~)])/gu
const UTILITY = /@utility\s+([A-Za-z_][\w-]*)/gu
const APPLY = /@apply\s+([^;]+);/gu

function tailwindMajorAt(projectDir: string): number | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    const v = pkg.dependencies?.tailwindcss ?? pkg.devDependencies?.tailwindcss
    const m = v === undefined ? null : /(\d+)/u.exec(v)
    return m === null ? undefined : Number(m[1])
  } catch { return undefined }
}

/** The first `@apply` of a plain class (with its line) in a Tailwind 4 stylesheet, or undefined. */
export function tailwindApplyViolation(projectDir: string, normalizedTarget: string, css: string): string | undefined {
  if (!/\.css$/iu.test(normalizedTarget)) return undefined
  const major = tailwindMajorAt(projectDir)
  if (major === undefined || major < 4) return undefined
  // comments out, so a commented-out rule neither defines nor applies anything
  const text = css.replace(/\/\*[\s\S]*?\*\//gu, (c) => c.replace(/[^\n]/gu, " "))
  const utilities = new Set([...text.matchAll(UTILITY)].map((m) => m[1]!))
  const plain = new Set<string>()
  for (const m of text.matchAll(PLAIN_CLASS)) if (!utilities.has(m[1]!)) plain.add(m[1]!)
  for (const m of text.matchAll(APPLY)) {
    for (const raw of m[1]!.trim().split(/\s+/u)) {
      const name = raw.replace(/^!|!$/gu, "").split(":").pop()!
      if (plain.has(name)) {
        const line = text.slice(0, m.index).split("\n").length
        return `Tailwind 4: «@apply … ${name}» (سطر ${line}) — ${name} صنفٌ مكتوبٌ CSS عاديّاً في الملفّ نفسِه لا أداة (utility)، فيرفضه Tailwind ` +
          `بـ«Cannot apply unknown utility class» وتصير كلُّ صفحةٍ 500. عرّفه بـ«@utility ${name} { … }» بدل «.${name} { … }»، أو انسخ تصريحاته مكانَ @apply`
      }
    }
  }
  return undefined
}
