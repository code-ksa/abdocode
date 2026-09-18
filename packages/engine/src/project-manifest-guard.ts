import type { ProjectIdentityWrite } from "./project-identity-guard"

const freshRuntimeDependencies = new Set(["next", "react", "react-dom"])
const freshDevelopmentDependencies = new Set([
  "@types/node", "@types/react", "@types/react-dom", "typescript",
])

/**
 * الكومةُ التي يسمّيها الهدف تحكم قائمةَ التأسيس (مقيس 2026-09-13: المستخدم طلب Vite + Tailwind فرفض الحارسُ vite
 * وأمر بـNext، فبنى النموذجُ Next بخلاف الطلب). Next هو الافتراضُ حين لا يُسمّى شيء؛ Vite حين يُسمّى؛ وTailwind
 * تُضاف حين تُطلب — الحدُّ يبقى: لا اعتمادَ خارج الكومة المسمّاة قبل أوّل بناء.
 */
export function foundingAllowlist(goal = ""): { readonly stack: "next" | "vite"; readonly runtime: ReadonlySet<string>; readonly development: ReadonlySet<string> } {
  const g = goal.toLowerCase()
  // «vitejs» يُحسب؛ وحين يُسمّى الاثنان («من Next إلى Vite») يفوز الأخيرُ ذكراً لا Next افتراضاً (مراجعة 09-14).
  const viteAt = g.search(/(?<!\p{L})(?:vite(?:js)?|فيت|ڤيت)(?!\p{L})/iu), nextAt = g.search(/(?<!\p{L})(?:next(?:\.js)?|نكست|نيكست)(?!\p{L})/iu)
  const vite = viteAt >= 0 && (nextAt < 0 || viteAt > nextAt)
  const tailwind = /tailwind|تيلويند|تيل ويند|تايلويند|تايل ويند/u.test(g)
  const runtime = new Set(vite ? ["react", "react-dom", "react-router-dom"] : freshRuntimeDependencies)
  const development = new Set(vite ? ["vite", "@vitejs/plugin-react", "typescript", "@types/react", "@types/react-dom", "@types/node"] : freshDevelopmentDependencies)
  if (tailwind) for (const d of ["tailwindcss", "postcss", "autoprefixer", "@tailwindcss/vite", "@tailwindcss/postcss"]) development.add(d)
  return { stack: vite ? "vite" : "next", runtime, development }
}

type JsonRecord = Record<string, unknown>
const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * The first package manifest is a supply-chain boundary. Keep the bootstrap
 * deterministic and minimal; later, task-specific dependency additions can
 * be reviewed against an existing manifest instead of riding inside scaffold
 * generation.
 */
export function projectManifestViolation(input: ProjectIdentityWrite, goal = ""): string | undefined {
  if (input.operation !== "write" || input.normalizedTarget !== "package.json") return undefined
  let manifest: unknown
  try { manifest = JSON.parse(input.after) } catch { return "package.json ليس JSON صالحاً أو يحمل نصاً خارج الكائن" }
  if (!isRecord(manifest)) return "package.json يجب أن يكون كائن JSON"
  if (input.before.length > 0) return undefined

  const founding = foundingAllowlist(goal)
  for (const [section, allowed] of [
    ["dependencies", founding.runtime],
    ["devDependencies", founding.development],
  ] as const) {
    const dependencies = manifest[section]
    if (dependencies === undefined) continue
    if (!isRecord(dependencies)) return `${section} يجب أن يكون كائن JSON`
    const unexpected = Object.keys(dependencies).filter((name) => !allowed.has(name))
    if (unexpected.length > 0) return `اعتماد تأسيس غير مسموح قبل أول بناء (الكومة المطلوبة: ${founding.stack}): ${unexpected.join(", ")}`
  }
  return undefined
}
