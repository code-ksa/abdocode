/**
 * كلُّ إصدارٍ يشحن `release-lessons.json` (دروسٌ مراجَعة: عيبٌ مقيس ⇦ قاعدة). عند أوّل تشغيلٍ لإصدارٍ جديد تُرقّى الدروسُ إلى
 * الوعي العامّ المشترك **بقاعدة الترقية نفسِها** (الصنف ⇦ الحجب ⇦ الشكل ⇦ لا هويّةَ مشروع) — لا بابَ خلفيّاً. ما يُطبَّق يُسجَّل
 * بإصداره في `abdo-release-lessons-applied.json` فلا يتكرّر، وما يُرفض يُقال باسمه. الوحدةُ نقيّة: القراءةُ والكتابةُ تُحقنان.
 */
import { EMPTY_GENERAL_STORE, inspectGeneralStore, promoteLessons, serialiseGeneralStore, type GeneralStore } from "./general-awareness"

export const RELEASE_LESSONS_FILE = "release-lessons.json"
export const RELEASE_LESSONS_APPLIED_FILE = "abdo-release-lessons-applied.json"

export interface ReleaseLessonsDocument { readonly version: string; readonly lessons: readonly { readonly cls: string; readonly text: string }[] }

export interface ReleaseLessonsIo {
  /** نصُّ `release-lessons.json` المشحون، أو undefined إن غاب. */
  readonly readShipped: () => string | undefined
  /** نصُّ ملفّ «المطبَّق» أو undefined. */
  readonly readApplied: () => string | undefined
  readonly writeApplied: (text: string) => void
  readonly readStore: () => string | undefined
  readonly writeStore: (text: string) => void
  readonly now: () => number
}

export type ReleaseLessonsOutcome =
  | { readonly status: "absent" }
  | { readonly status: "already-applied"; readonly version: string }
  | { readonly status: "invalid"; readonly why: string }
  | { readonly status: "store-unreadable"; readonly why: string }
  | { readonly status: "applied"; readonly version: string; readonly promoted: number; readonly refused: readonly string[]; readonly changed: boolean }

export const parseReleaseLessons = (text: string): ReleaseLessonsDocument | { readonly why: string } => {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return { why: "ليس JSON" } }
  if (typeof parsed !== "object" || parsed === null) return { why: "ليس كائناً" }
  const doc = parsed as { version?: unknown; lessons?: unknown }
  if (typeof doc.version !== "string" || !/^\d+\.\d+\.\d+$/.test(doc.version)) return { why: "version غائبٌ أو مشوَّه" }
  if (!Array.isArray(doc.lessons) || doc.lessons.length === 0 || doc.lessons.length > 40) return { why: "lessons غائبةٌ أو فارغة أو فوق ٤٠" }
  const lessons: { cls: string; text: string }[] = []
  for (const item of doc.lessons) {
    if (typeof item !== "object" || item === null) return { why: "درسٌ ليس كائناً" }
    const { cls, text } = item as { cls?: unknown; text?: unknown }
    if (typeof cls !== "string" || typeof text !== "string" || text.trim().length === 0) return { why: "درسٌ بلا صنفٍ أو نصّ" }
    lessons.push({ cls, text: text.trim() })
  }
  return { version: doc.version, lessons }
}

/** يطبّق دروسَ الإصدار مرّةً لكلّ إصدار. لا يمسّ المخزنَ إن لم يُقرأ (مخزنٌ لا يُقرأ لا يُدهس). */
export const applyReleaseLessons = (io: ReleaseLessonsIo): ReleaseLessonsOutcome => {
  const shipped = io.readShipped()
  if (shipped === undefined) return { status: "absent" }
  const doc = parseReleaseLessons(shipped)
  if ("why" in doc) return { status: "invalid", why: doc.why }
  const appliedText = io.readApplied()
  if (appliedText !== undefined) {
    try { const applied = JSON.parse(appliedText) as { version?: unknown }; if (applied.version === doc.version) return { status: "already-applied", version: doc.version } } catch { /* ملفٌّ فاسد = لم يُطبَّق */ }
  }
  const storeText = io.readStore()
  const read = storeText === undefined ? { ok: true as const, store: EMPTY_GENERAL_STORE } : inspectGeneralStore(storeText)
  if (!read.ok) return { status: "store-unreadable", why: read.why }
  const run = promoteLessons(read.store as GeneralStore, doc.lessons, { projectTokens: [], now: io.now() })
  if (run.changed) io.writeStore(serialiseGeneralStore(run.store))
  io.writeApplied(`${JSON.stringify({ version: doc.version, at: new Date(io.now()).toISOString(), promoted: run.promoted.length, refused: run.refusals.length }, null, 2)}\n`)
  return { status: "applied", version: doc.version, promoted: run.promoted.length, refused: run.refusals.map((r) => r.slice(0, 90)), changed: run.changed }
}

export const releaseLessonsLine = (outcome: ReleaseLessonsOutcome): string | undefined => {
  switch (outcome.status) {
    case "applied": return `📚 دروسُ الإصدار ${outcome.version}: رُقّي ${outcome.promoted} إلى الوعي العامّ${outcome.refused.length > 0 ? `، رُفض ${outcome.refused.length} (${outcome.refused.slice(0, 2).join("؛ ")})` : ""}`
    case "invalid": return `📚 دروسُ الإصدار مشوَّهة: ${outcome.why}`
    case "store-unreadable": return `📚 دروسُ الإصدار لم تُطبَّق: ${outcome.why}`
    default: return undefined
  }
}
