/**
 * الحزمُ المضمَّنة مع عبدو كود — `extensions/bundled/<id>/` تُشحن بجوار المحرّك (payload/extensions/bundled) وتظهر في
 * الإعدادات ← الامتدادات ← «المضمَّنة» كي يراجعها المستخدم ويثبّتها بالمسار نفسِه الذي يثبّت به أيّ مجلّد (مراجعة ⇦
 * تثبيت ⇦ تفعيل). هذه الوحدة **تقرأ وتصف** فقط: لا تثبّت ولا تشغّل ولا تفكّ ملفّاً، والقشرةُ تعرض ما تعيده كمعطياتٍ لا أوامر.
 *
 * ما يُعاد لكلّ حزمة: المعرّف والاسم والإصدار والوصف والمسار المطلق وقائمةُ المهارات (اسمٌ ووصفٌ من مقدّمة SKILL.md).
 * الحزمةُ التي لا تطابق عقدَ المانيفست (الحقولُ الخمسة، معرّفٌ ≤16) تُسقَط بسبب — لا تُعرض ناقصة.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

export interface BundledSkill { readonly id: string; readonly description: string }
export interface BundledExtension {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly description: string
  /** المسارُ المطلق لمجلّد الحزمة — يُمرَّر إلى `extensions_preview` كما لو اختاره المستخدم من الحوار. */
  readonly path: string
  readonly skills: readonly BundledSkill[]
  /** نوعُ الحزمة كما يعلنه FEATURES.md أو المانيفست: developer | knowledge-work | skills. */
  readonly kind: string
}
export interface BundledListing { readonly root: string | undefined; readonly entries: readonly BundledExtension[]; readonly dropped: readonly string[] }

const SLUG = /^[a-z0-9][a-z0-9-]{0,15}$/
const SKILL_NAME = /^[a-z][a-z0-9-]{0,47}$/

/** أوّلُ مجلّدٍ موجود من المرشّحين: متغيّرُ البيئة (اختبارات)، ثمّ بجوار المحرّك (المثبَّت)، ثمّ جذرُ المستودع (التطوير). */
export function bundledRoot(candidates: readonly (string | undefined)[]): string | undefined {
  for (const c of candidates) {
    if (c === undefined || c.length === 0) continue
    const dir = resolve(c)
    try { if (statSync(dir).isDirectory()) return dir } catch { /* يُجرَّب التالي */ }
  }
  return undefined
}

function skillHeader(file: string): BundledSkill | undefined {
  let text: string
  try { text = readFileSync(file, "utf8") } catch { return undefined }
  if (text.length > 64 * 1024) return undefined
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  if (!m) return undefined
  const fields: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) { const k = line.match(/^([a-z]+):\s*(.*)$/); if (k) fields[k[1]] = k[2].trim() }
  const id = fields.name ?? ""
  if (!SKILL_NAME.test(id)) return undefined
  return { id, description: (fields.description ?? "").slice(0, 300) }
}

function kindOf(dir: string): string {
  try {
    const features = readFileSync(join(dir, "FEATURES.md"), "utf8")
    const m = features.match(/\*\*النوع\*\*:\s*([a-z-]+)/)
    if (m) return m[1]
  } catch { /* بلا ملفّ ميزات */ }
  return "developer"
}

export function listBundledExtensions(root: string | undefined): BundledListing {
  if (root === undefined) return { root, entries: [], dropped: [] }
  const entries: BundledExtension[] = []
  const dropped: string[] = []
  let names: string[]
  try { names = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() } catch { return { root, entries, dropped: ["unreadable root"] } }
  for (const name of names) {
    const dir = join(root, name)
    const manifestFile = join(dir, "abdocode-extension.json")
    if (!existsSync(manifestFile)) { dropped.push(`${name}: no manifest`); continue }
    let manifest: Record<string, unknown>
    try { manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Record<string, unknown> } catch { dropped.push(`${name}: manifest unreadable`); continue }
    const keys = Object.keys(manifest).sort().join(",")
    if (keys !== "description,id,mcpServers,name,schemaVersion,skills,version" || manifest.schemaVersion !== 1) { dropped.push(`${name}: manifest shape`); continue }
    const id = String(manifest.id)
    if (!SLUG.test(id) || id !== name) { dropped.push(`${name}: id`); continue }
    const skillDirs = Array.isArray(manifest.skills) ? (manifest.skills as unknown[]).filter((s): s is string => typeof s === "string") : []
    const skills: BundledSkill[] = []
    for (const rel of skillDirs) {
      if (rel.includes("..") || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) { skills.length = 0; break }
      const header = skillHeader(join(dir, rel, "SKILL.md"))
      if (header !== undefined) skills.push(header)
    }
    if (skills.length === 0) { dropped.push(`${name}: no valid skill`); continue }
    entries.push({ id, name: String(manifest.name).slice(0, 120), version: String(manifest.version).slice(0, 32), description: String(manifest.description).slice(0, 1000), path: dir, skills, kind: kindOf(dir) })
  }
  return { root, entries, dropped }
}
