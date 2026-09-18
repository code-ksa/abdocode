/**
 * و`desk focus`، فتثبت الإحداثيّاتُ بين الجلسات ولا يعود النموذجُ يقيس من الصفر.
 *
 * المفتاحُ اسمُ العمليّة (بلا .exe، بأحرفٍ صغيرة) واختياريّاً نمطُ عنوانٍ: `desk layout save` يحفظ لاياوتَ البرنامج كلِّه،
 * و`desk layout save <اسم>` يحفظ لاياوتاً باسمٍ مقيَّداً بعنوان النافذة الحاليّة (نافذةُ «Extensions» في كروم غيرُ نافذة
 * الموقع). الاستعادةُ تفضّل المقيَّدَ بالعنوان على العامّ.
 *
 * **الحفظُ صريحٌ وحده**: تغييرُ المستخدم للنافذة بعد الحفظ لا يمسّ المحفوظ — لا كتابةَ في الملفّ إلا من `desk layout save`
 * و`desk layout forget`. الملفُّ `<حالة>/desk-layouts.json`، وهذه الوحدةُ صرفةٌ إلا القراءةَ والكتابةَ المحقونتين بالمسار.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export const LAYOUTS_FILE = "desk-layouts.json"
export const LAYOUTS_CAP = 200
export const LAYOUT_USAGE = "الصيغة: desk layout save [<اسم>] (يحفظ مستطيلَ النافذة المربوطة) | desk layout list | desk layout forget <اسم>"

export type LayoutState = "normal" | "maximized"
export interface SavedLayout {
  readonly name: string
  readonly process: string
  readonly titlePattern?: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly monitor: string
  readonly state: LayoutState
  readonly savedAt: string
}
export interface LayoutStore { readonly version: 1; readonly layouts: readonly SavedLayout[] }
export const EMPTY_STORE: LayoutStore = Object.freeze({ version: 1 as const, layouts: Object.freeze([]) as readonly SavedLayout[] })

export type LayoutCommand = { readonly op: "save"; readonly name?: string } | { readonly op: "list" } | { readonly op: "forget"; readonly name: string }

const NAME_RE = /^[\p{L}\p{N}_.-]{1,40}$/u

/** اسمُ العمليّة مفتاحاً: أحرفٌ صغيرة بلا لاحقة .exe ولا مسار. */
export const processKey = (process: string): string => process.trim().replace(/^.*[\\/]/u, "").replace(/\.exe$/iu, "").toLowerCase()

/** مطابقةُ العنوان بلا حساسيّةٍ للحالة ولا لفراغاتٍ مكرّرة. */
const foldTitle = (s: string): string => s.toLowerCase().replace(/\s+/gu, " ").trim()

export function parseLayoutCommand(rest: string): LayoutCommand | { readonly error: string } {
  const words = rest.trim().split(/\s+/u).filter((w) => w.length > 0)
  const [verb = "", name] = words
  switch (verb.toLowerCase()) {
    case "save": {
      if (name === undefined) return { op: "save" }
      const clean = name.replace(/^["'«»]+|["'«»]+$/gu, "")
      return NAME_RE.test(clean) ? { op: "save", name: clean } : { error: `اسمُ اللاياوت «${clean.slice(0, 20)}» غيرُ صالح: حروفٌ وأرقامٌ و_ . - حتى ٤٠ حرفاً` }
    }
    case "list": case "ls": case "": return { op: "list" }
    case "forget": case "rm": case "delete": {
      const clean = (name ?? "").replace(/^["'«»]+|["'«»]+$/gu, "")
      return clean.length === 0 ? { error: `desk layout forget <اسم> — ${LAYOUT_USAGE}` } : { op: "forget", name: clean }
    }
    default: return { error: LAYOUT_USAGE }
  }
}

const int = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && Math.abs(v) <= 100_000 ? v : undefined)

/** قراءةٌ متسامحةٌ مع الغياب، صارمةٌ مع الشكل: سطرٌ فاسد يُسقَط لا يُصلَح ولا يُخمَّن. */
export function loadLayouts(path: string): LayoutStore {
  if (!existsSync(path)) return EMPTY_STORE
  let raw: unknown
  try { raw = JSON.parse(readFileSync(path, "utf8")) } catch { return EMPTY_STORE }
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { layouts?: unknown }).layouts)) return EMPTY_STORE
  const layouts: SavedLayout[] = []
  for (const item of (raw as { layouts: unknown[] }).layouts) {
    if (typeof item !== "object" || item === null) continue
    const o = item as Record<string, unknown>
    const x = int(o.x), y = int(o.y), width = int(o.width), height = int(o.height)
    if (typeof o.name !== "string" || !NAME_RE.test(o.name) || typeof o.process !== "string" || o.process.length === 0 || x === undefined || y === undefined || width === undefined || height === undefined || width <= 0 || height <= 0) continue
    layouts.push({
      name: o.name, process: processKey(o.process), ...(typeof o.titlePattern === "string" && o.titlePattern.length > 0 ? { titlePattern: o.titlePattern.slice(0, 120) } : {}),
      x, y, width, height, monitor: typeof o.monitor === "string" ? o.monitor.slice(0, 64) : "", state: o.state === "maximized" ? "maximized" : "normal", savedAt: typeof o.savedAt === "string" ? o.savedAt : "",
    })
  }
  return { version: 1, layouts }
}

/** كتابةٌ ذرّيّة (ملفٌّ مؤقّت ثمّ إعادةُ تسمية) كي لا يبقى ملفٌّ نصفُه مكتوب إن انقطع المحرّك. */
export function saveLayouts(path: string, store: LayoutStore): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ version: 1, layouts: store.layouts }, null, 2)}\n`, "utf8")
  renameSync(tmp, path)
}

/** إدراجٌ أو تحديثٌ بالاسم؛ السقفُ يُطبَّق بإسقاط الأقدم حفظاً. */
export function upsertLayout(store: LayoutStore, layout: SavedLayout): LayoutStore {
  const kept = store.layouts.filter((l) => l.name !== layout.name)
  const next = [...kept, layout]
  const trimmed = next.length > LAYOUTS_CAP ? [...next].sort((a, b) => a.savedAt.localeCompare(b.savedAt)).slice(next.length - LAYOUTS_CAP) : next
  return { version: 1, layouts: trimmed }
}

export function forgetLayout(store: LayoutStore, name: string): { readonly store: LayoutStore; readonly removed: SavedLayout | undefined } {
  const removed = store.layouts.find((l) => l.name === name)
  return { store: { version: 1, layouts: store.layouts.filter((l) => l.name !== name) }, removed }
}

/** اللاياوتُ المناسب لنافذةٍ: يطابق العمليّةَ، ويفضَّل ما قُيِّد بعنوانٍ يطابق على العامّ؛ عنوانٌ مقيَّد لا يطابق لا يُستعمل. */
export function findLayout(store: LayoutStore, processName: string, title: string): SavedLayout | undefined {
  const key = processKey(processName)
  if (key.length === 0) return undefined
  const t = foldTitle(title)
  const candidates = store.layouts.filter((l) => l.process === key)
  const titled = candidates.filter((l) => l.titlePattern !== undefined && t.includes(foldTitle(l.titlePattern)))
  if (titled.length > 0) return [...titled].sort((a, b) => b.titlePattern!.length - a.titlePattern!.length)[0]
  return candidates.find((l) => l.titlePattern === undefined)
}

export interface MeasuredRect { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number; readonly maximized?: boolean }

/** هل النافذةُ الآن على لاياوتها المحفوظ؟ (تسامحُ بكسلين — DWM يزيح الإطارَ بكسلاً أحياناً.) المكبَّرةُ تُطابَق بالحالة لا بالمستطيل. */
export function layoutMatches(layout: SavedLayout, rect: MeasuredRect): boolean {
  if (layout.state === "maximized") return rect.maximized === true
  if (rect.maximized === true) return false
  const near = (a: number, b: number) => Math.abs(a - b) <= 2
  return near(rect.left, layout.x) && near(rect.top, layout.y) && near(rect.right - rect.left, layout.width) && near(rect.bottom - rect.top, layout.height)
}

/** لاياوتٌ من قياسٍ حيّ للنافذة المربوطة. */
export function layoutFromMeasure(m: { readonly name?: string; readonly process: string; readonly title: string; readonly rect: MeasuredRect; readonly monitor?: string; readonly now?: Date }): SavedLayout {
  const key = processKey(m.process)
  const named = m.name !== undefined && m.name.length > 0
  return {
    name: named ? m.name! : key, process: key, ...(named ? { titlePattern: m.title.slice(0, 120) } : {}),
    x: m.rect.left, y: m.rect.top, width: m.rect.right - m.rect.left, height: m.rect.bottom - m.rect.top,
    monitor: m.monitor ?? "", state: m.rect.maximized === true ? "maximized" : "normal", savedAt: (m.now ?? new Date()).toISOString(),
  }
}

const geometry = (l: SavedLayout): string => l.state === "maximized" ? `مكبَّرة على ${l.monitor.length > 0 ? l.monitor : "شاشتها"}` : `${l.width}×${l.height} @ (${l.x},${l.y})${l.monitor.length > 0 ? ` على ${l.monitor}` : ""}`

export const renderLayoutList = (store: LayoutStore): string =>
  store.layouts.length === 0
    ? "لا لاياوتاتٍ محفوظة بعد — ركّز نافذةً ثمّ «desk layout save [<اسم>]»."
    : `${store.layouts.length} لاياوت محفوظ:\n${[...store.layouts].sort((a, b) => a.name.localeCompare(b.name)).map((l) => `- ${l.name}: ${l.process}${l.titlePattern === undefined ? "" : ` «${l.titlePattern.slice(0, 50)}»`} — ${geometry(l)} (حُفظ ${l.savedAt.slice(0, 16).replace("T", " ")})`).join("\n")}`

export const saveReceipt = (l: SavedLayout, title: string): string =>
  `حفظتُ لاياوت «${l.name}» لنافذة «${title.slice(0, 60)}» (${l.process}${l.titlePattern === undefined ? "" : "، مقيَّدٌ بالعنوان"}): ${geometry(l)} — يُستعاد عند desk open/focus حتى «desk layout forget ${l.name}».`

export const restoreReceipt = (l: SavedLayout, title: string): string =>
  `أُعيدت نافذةُ «${title.slice(0, 60)}» إلى اللاياوت المحفوظ «${l.name}» ${geometry(l)}.`

export const alreadyReceipt = (l: SavedLayout): string => `(على لاياوتها المحفوظ «${l.name}» ${geometry(l)})`
