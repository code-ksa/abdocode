/**
 * قرأها `page` — تُدوَّن في `<حالة>/ui-book/<البرنامج أو الأصل>/<شاشة>.json`: متى، وأين كان الإطار، وبأيّ وضع، وملخّصُ
 * الشجرة (الأدوارُ والأسماءُ والصناديق مسقوفةً)، وملخّصُ الأنماط المحسوبة إن جاءت من المتصفّح، ومسارُ لقطةٍ إن وُجدت،
 * ومسارُ الكود المرتبط (ملفّاتُ المشروع الحاليّ التي تشبه أسماؤها عنوانَ الشاشة أو مسارَها — حتى عشرة).
 *
 * الدفترُ **ذاكرةٌ لا حَكَم**: ما فيه قياسٌ ماضٍ يُقرأ ليُوجّه، ولا يُستعمل بديلاً عن قراءةٍ حيّة. السقفُ ٥٠٠ شاشةٍ لكلّ تطبيق
 * والأقدمُ يُطرد أوّلاً. القراءةُ والكتابةُ بالمسار المحقون؛ الفهرسُ المرتبط يُبنى من قائمةِ ملفّاتٍ تُمرَّر (اختبارٌ حتميّ) أو تُمسح.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ProjectIndex } from "@abdo/project-index"
import type { ViewMode, Rect } from "./viewport-map"

export const UI_BOOK_DIR = "ui-book"
export const UI_BOOK_CAP = 500
export const UI_BOOK_TREE_CAP = 150
export const UI_BOOK_STYLES_CAP = 4000
export const UI_BOOK_USAGE = "الصيغة: ui-book [list | show <تطبيق>/<شاشة>]"

export interface UiBookNode { readonly role: string; readonly name: string; readonly box?: Rect; readonly ref?: string }
export interface UiBookEntry {
  readonly capturedAt: string
  readonly source: "desk" | "browser"
  /** اسمُ العمليّة (desk) أو أصلُ الموقع (browser). */
  readonly app: string
  readonly title: string
  /** مسارُ الصفحة (browser) إن وُجد. */
  readonly route?: string
  readonly slug: string
  readonly rect: Rect
  readonly mode: ViewMode
  readonly tree: { readonly total: number; readonly roles: Readonly<Record<string, number>>; readonly nodes: readonly UiBookNode[] }
  readonly styles?: string
  readonly screenshot?: string
  readonly codePaths: readonly string[]
}

const ARABIC_MARKS = new RegExp(`[${String.fromCharCode(0x064b)}-${String.fromCharCode(0x0652)}${String.fromCharCode(0x0640)}]`, "gu")

/** معرّفُ مجلّدٍ أو ملفٍّ آمن: حروفٌ وأرقامٌ وشرطات، بلا مسارٍ ولا نقاطٍ متتالية؛ الفارغُ «untitled». */
export function slugify(text: string, max = 60): string {
  const s = text.normalize("NFKC").replace(ARABIC_MARKS, "").toLowerCase().replace(/^https?:\/\//u, "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/gu, "").replace(/-{2,}/gu, "-").slice(0, max).replace(/-+$/u, "")
  return s.length === 0 ? "untitled" : s
}

/** مفتاحُ التطبيق: اسمُ العمليّة (بلا .exe) أو أصلُ الرابط (host[:port]). */
export function appSlug(programOrOrigin: string): string {
  const t = programOrOrigin.trim()
  try { if (/^https?:\/\//iu.test(t)) { const u = new URL(t); return slugify(u.host) } } catch { /* ليس رابطاً */ }
  return slugify(t.replace(/^.*[\\/]/u, "").replace(/\.exe$/iu, ""))
}

/** معرّفُ الشاشة: مسارُ الصفحة إن وُجد (الجذرُ «home»)، وإلّا العنوان. */
export function screenSlug(title: string, route?: string): string {
  if (route !== undefined) { const r = route.replace(/[?#].*$/u, ""); return r === "/" || r.length === 0 ? "home" : slugify(r) }
  return slugify(title)
}

const round = (n: number): number => Math.round(n)

/** ملخّصُ شجرة `desk ui`: العناصرُ ذاتُ المعنى أوّلاً حتى السقف. */
export function treeFromDesk(elements: readonly { readonly ref: number; readonly type: string; readonly name: string; readonly x: number; readonly y: number; readonly w: number; readonly h: number }[]): UiBookEntry["tree"] {
  const roles: Record<string, number> = {}
  for (const e of elements) roles[e.type] = (roles[e.type] ?? 0) + 1
  const nodes = elements.filter((e) => e.name.length > 0 || e.x >= 0).slice(0, UI_BOOK_TREE_CAP).map((e) => ({ role: e.type, name: e.name.slice(0, 80), ref: `u${e.ref}`, ...(e.x >= 0 ? { box: { x: round(e.x), y: round(e.y), width: round(e.w), height: round(e.h) } } : {}) }))
  return { total: elements.length, roles, nodes }
}

/** ملخّصُ شجرة `page`: مسطَّحةً بالعمق أوّلاً حتى السقف (لا صناديقَ في شجرة الوصول؛ الصندوقُ من `page dom` حين يُطلب). */
export function treeFromPage(nodes: readonly { readonly ref: string; readonly role: string; readonly name: string; readonly children?: readonly unknown[] }[]): UiBookEntry["tree"] {
  const roles: Record<string, number> = {}
  const flat: UiBookNode[] = []
  let total = 0
  const walk = (list: readonly { readonly ref: string; readonly role: string; readonly name: string; readonly children?: readonly unknown[] }[]) => {
    for (const n of list) {
      total += 1
      roles[n.role] = (roles[n.role] ?? 0) + 1
      if (flat.length < UI_BOOK_TREE_CAP) flat.push({ role: n.role, name: n.name.slice(0, 80), ref: n.ref })
      if (Array.isArray(n.children)) walk(n.children as typeof list)
    }
  }
  walk(nodes)
  return { total, roles, nodes: flat }
}

/** كلماتُ البحث عن الكود: من العنوان والمسار، بلا كلماتٍ عامّة، ≥ ٣ حروف. */
const STOP = new Set(["the", "and", "for", "with", "page", "home", "index", "www", "com", "net", "org", "http", "https", "html", "google", "chrome", "microsoft", "edge", "window", "untitled", "new", "tab"])
export function codeHints(title: string, route?: string): string[] {
  const words = `${title} ${route ?? ""}`.normalize("NFKC").replace(ARABIC_MARKS, "").toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []
  return [...new Set(words.filter((w) => !STOP.has(w) && !/^\d+$/u.test(w)))].slice(0, 12)
}

const SKIP_DIR = /(?:^|\/)(?:node_modules|\.next|dist|build|target|\.git|coverage|\.turbo|vendor|tmp)\//u
const CODE_PATTERN = "**/*.{ts,tsx,js,jsx,mjs,cjs,py,rs,go,php,kt,java,cs,rb,vue,svelte,html,css,scss}"
export const CODE_SCAN_CAP = 400

/** ملفّاتُ المشروع مرشَّحةً للمسح (مسقوفة؛ المجلّداتُ الثقيلة تُتخطّى). */
export function scanProjectFiles(projectDir: string, cap = CODE_SCAN_CAP): string[] {
  const files: string[] = []
  try {
    for (const file of new Bun.Glob(CODE_PATTERN).scanSync({ cwd: projectDir, onlyFiles: true })) {
      const clean = file.replace(/\\/gu, "/")
      if (SKIP_DIR.test(clean)) continue
      files.push(clean)
      if (files.length >= cap) break
    }
  } catch { /* مشروعٌ بلا ملفّات أو غيرُ مقروء */ }
  return files
}

/**
 * مسارُ الكود المرتبط بالشاشة: فهرسُ المشروع (@abdo/project-index) يُسأل بالمسار أوّلاً (اسمُ الملفّ = كلمةٌ من العنوان/المسار)
 * ثمّ يُرتَّب الباقي بعدد الكلمات التي يحملها المسار — حتى ١٠ مرشّحين، حتميٌّ من قائمة الملفّات المعطاة.
 */
export function relatedCodePaths(files: readonly string[], hints: readonly string[], max = 10): string[] {
  if (files.length === 0 || hints.length === 0) return []
  const index = new ProjectIndex()
  for (const f of files) index.upsert(f, "")
  const score = new Map<string, number>()
  for (const hint of hints) {
    for (const path of index.lookupPath(hint)) score.set(path, (score.get(path) ?? 0) + 10)
    for (const f of files) { const p = f.toLowerCase(); if (p.includes(hint)) score.set(f, (score.get(f) ?? 0) + (p.split("/").pop()!.includes(hint) ? 3 : 1)) }
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([p]) => p)
}

const entryPath = (root: string, app: string, slug: string): string => join(root, UI_BOOK_DIR, app, `${slug}.json`)

/** تدوينُ شاشة (كتابةٌ ذرّيّة): إن وُجدت بالمعرّف نفسه تُحدَّث، وإن تجاوز التطبيقُ السقفَ يُطرد الأقدمُ تدويناً. */
export function recordScreen(root: string, entry: UiBookEntry): { readonly path: string; readonly evicted: readonly string[] } {
  const app = appSlug(entry.app)
  const dir = join(root, UI_BOOK_DIR, app)
  mkdirSync(dir, { recursive: true })
  const path = entryPath(root, app, entry.slug)
  // التحديثُ يُثري لا يمحو: أنماطٌ أو لقطةٌ أو شجرةٌ دُوِّنت من قبل تبقى حين لا يحمل التدوينُ الجديد بديلاً لها.
  let prior: Partial<UiBookEntry> | undefined
  if (existsSync(path)) { try { prior = JSON.parse(readFileSync(path, "utf8")) as Partial<UiBookEntry> } catch { prior = undefined } }
  const styles = entry.styles ?? prior?.styles
  const screenshot = entry.screenshot ?? prior?.screenshot
  const tree = entry.tree.total === 0 && prior?.tree !== undefined && prior.tree.total > 0 ? prior.tree : entry.tree
  const codePaths = entry.codePaths.length === 0 && Array.isArray(prior?.codePaths) ? prior!.codePaths! : entry.codePaths
  const body: UiBookEntry = { ...entry, tree, ...(styles === undefined ? {} : { styles: styles.slice(0, UI_BOOK_STYLES_CAP) }), ...(screenshot === undefined ? {} : { screenshot }), codePaths: codePaths.slice(0, 10) }
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8")
  renameSync(tmp, path)
  const evicted: string[] = []
  const names = readdirSync(dir).filter((n) => n.endsWith(".json"))
  if (names.length > UI_BOOK_CAP) {
    const dated = names.map((n) => { let at = ""; try { at = (JSON.parse(readFileSync(join(dir, n), "utf8")) as { capturedAt?: string }).capturedAt ?? "" } catch { at = "" } return { n, at } })
    dated.sort((a, b) => a.at.localeCompare(b.at) || a.n.localeCompare(b.n))
    for (const { n } of dated.slice(0, names.length - UI_BOOK_CAP)) { if (n === `${entry.slug}.json`) continue; try { rmSync(join(dir, n), { force: true }); evicted.push(n.replace(/\.json$/u, "")) } catch { /* مقفول */ } }
  }
  return { path, evicted }
}

export function listBook(root: string): readonly { readonly app: string; readonly screens: readonly { readonly slug: string; readonly title: string; readonly capturedAt: string; readonly mode: string }[] }[] {
  const base = join(root, UI_BOOK_DIR)
  if (!existsSync(base)) return []
  const apps: { app: string; screens: { slug: string; title: string; capturedAt: string; mode: string }[] }[] = []
  for (const app of readdirSync(base).sort()) {
    const dir = join(base, app)
    try { if (!statSync(dir).isDirectory()) continue } catch { continue }
    const screens: { slug: string; title: string; capturedAt: string; mode: string }[] = []
    for (const n of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
      try { const e = JSON.parse(readFileSync(join(dir, n), "utf8")) as Partial<UiBookEntry>; screens.push({ slug: n.replace(/\.json$/u, ""), title: String(e.title ?? ""), capturedAt: String(e.capturedAt ?? ""), mode: String(e.mode ?? "") }) } catch { /* ملفٌّ فاسد يُتجاهل */ }
    }
    apps.push({ app, screens })
  }
  return apps
}

/** `show <تطبيق>/<شاشة>` أو `<شاشة>` وحدها إن كانت فريدةً عبر التطبيقات. */
export function showScreen(root: string, ref: string): UiBookEntry | { readonly error: string } {
  const clean = ref.trim().replace(/\\/gu, "/").replace(/\.json$/u, "")
  if (clean.length === 0 || clean.includes("..")) return { error: UI_BOOK_USAGE }
  const parts = clean.split("/").filter((p) => p.length > 0)
  const read = (app: string, slug: string): UiBookEntry | undefined => { const p = entryPath(root, slugify(app), slugify(slug)); try { return JSON.parse(readFileSync(p, "utf8")) as UiBookEntry } catch { return undefined } }
  if (parts.length >= 2) { const e = read(parts[0]!, parts.slice(1).join("-")); return e ?? { error: `لا شاشةَ «${clean.slice(0, 60)}» في الدفتر — ui-book list` } }
  const hits = listBook(root).flatMap((a) => a.screens.filter((s) => s.slug === slugify(parts[0]!)).map((s) => ({ app: a.app, slug: s.slug })))
  if (hits.length === 0) return { error: `لا شاشةَ «${clean.slice(0, 60)}» في الدفتر — ui-book list` }
  if (hits.length > 1) return { error: `«${clean.slice(0, 40)}» موجودةٌ في ${hits.length} تطبيقات: ${hits.map((h) => `${h.app}/${h.slug}`).join("، ")} — سمِّ التطبيق` }
  return read(hits[0]!.app, hits[0]!.slug) ?? { error: `تعذّرت قراءةُ ${hits[0]!.app}/${hits[0]!.slug}` }
}

export const renderBookList = (apps: ReturnType<typeof listBook>): string =>
  apps.length === 0 || apps.every((a) => a.screens.length === 0)
    ? "دفترُ الواجهات فارغ — يُدوَّن تلقائيّاً عند desk ui وpage."
    : apps.filter((a) => a.screens.length > 0).map((a) => `${a.app} (${a.screens.length}):\n${a.screens.slice(0, 40).map((s) => `  - ${a.app}/${s.slug}: «${s.title.slice(0, 50)}» [${s.mode}] ${s.capturedAt.slice(0, 16).replace("T", " ")}`).join("\n")}${a.screens.length > 40 ? `\n  ⋯ (${a.screens.length - 40} أخرى)` : ""}`).join("\n")

export const renderScreen = (e: UiBookEntry): string => {
  const roles = Object.entries(e.tree.roles).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([r, n]) => `${r}×${n}`).join("، ")
  const nodes = e.tree.nodes.slice(0, 60).map((n) => `  ${n.ref === undefined ? "" : `${n.ref} `}[${n.role}]${n.name.length > 0 ? ` «${n.name}»` : ""}${n.box === undefined ? "" : ` @(${n.box.x},${n.box.y} ${n.box.width}×${n.box.height})`}`).join("\n")
  return [
    `${e.app} / ${e.slug} — «${e.title.slice(0, 80)}» (${e.source === "desk" ? "سطح المكتب" : "المتصفّح"}${e.route === undefined ? "" : `، المسار ${e.route}`}) دُوِّنت ${e.capturedAt.slice(0, 16).replace("T", " ")}`,
    `الوضع: ${e.mode}، الإطار ${e.rect.width}×${e.rect.height} @ (${e.rect.x},${e.rect.y})`,
    `الشجرة: ${e.tree.total} عنصراً — ${roles}`,
    nodes,
    ...(e.styles === undefined ? [] : [`الأنماط: ${e.styles.slice(0, 1200)}`]),
    ...(e.screenshot === undefined ? [] : [`اللقطة: ${e.screenshot}`]),
    e.codePaths.length === 0 ? "الكود المرتبط: لا مرشّح في المشروع الحاليّ." : `الكود المرتبط: ${e.codePaths.join("، ")}`,
  ].join("\n")
}

export type UiBookCommand = { readonly op: "list" } | { readonly op: "show"; readonly ref: string }
export function parseUiBookCommand(rest: string): UiBookCommand | { readonly error: string } {
  const [verb = "", ...more] = rest.trim().split(/\s+/u).filter((w) => w.length > 0)
  switch (verb.toLowerCase()) {
    case "": case "list": case "ls": return { op: "list" }
    case "show": return more.length === 0 ? { error: `ui-book show <تطبيق>/<شاشة> — ${UI_BOOK_USAGE}` } : { op: "show", ref: more.join(" ") }
    default: return { error: UI_BOOK_USAGE }
  }
}
