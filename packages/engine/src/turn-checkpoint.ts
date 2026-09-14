/**
 * نقاطُ الرجوع لكلّ دور (م9ط — فكرةُ Kilo «checkpoints»، مكتوبةٌ هنا): قبل أوّل كتابةٍ لملفٍّ في الدور تُحفظ نسختُه
 * الأصليّة (أو علامةُ «لم يكن موجوداً») تحت مجلّد الحالة، فيستطيع المشغّل بكلمة «rollback» إعادةَ ما قبل الدور بضغطة.
 *
 * حدودٌ مقصودة: الكتابةُ عبر أدوات write/edit/medit/patch وحدها تُلتقط (أوامرُ `run` التي تكتب بنفسها لا تُرى)؛
 * الملفُّ الأكبر من ٢ ميغابايت لا يُنسخ ويُسمّى؛ ٢٠٠ ملفٍّ لكلّ دور؛ الاستعادةُ تُرفض لمشروعٍ غير المشروع الحاليّ.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"

export const CHECKPOINT_FILE_CAP = 200
export const CHECKPOINT_BYTES_CAP = 2 * 1024 * 1024
export const CHECKPOINT_KEEP_TURNS = 30

export type CheckpointFile = { readonly path: string; readonly existed: boolean; readonly bytes: number; readonly sha256: string; readonly blob?: string }
export type CheckpointManifest = {
  readonly version: 1
  readonly sessionId: string
  readonly turnId: string
  readonly project: string
  readonly createdAt: string
  readonly files: CheckpointFile[]
  readonly skipped: { readonly path: string; readonly why: string }[]
}
export type RecordVerdict = "recorded" | "already" | "skipped-large" | "skipped-cap"
export type RestoreReport = { readonly ok: true; readonly turnId: string; readonly restored: string[]; readonly removed: string[]; readonly skipped: string[] } | { readonly ok: false; readonly why: string }

const safeSegment = (value: string): string => value.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 80)
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex")
const inside = (root: string, path: string): boolean => {
  const base = resolve(root); const target = resolve(path)
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep)
}

export class CheckpointStore {
  readonly #root: string
  constructor(root: string) { this.#root = resolve(root) }

  #dir(sessionId: string, turnId: string): string { return join(this.#root, safeSegment(sessionId), safeSegment(turnId)) }
  #manifestPath(sessionId: string, turnId: string): string { return join(this.#dir(sessionId, turnId), "manifest.json") }
  #read(sessionId: string, turnId: string): CheckpointManifest | undefined {
    try { return JSON.parse(readFileSync(this.#manifestPath(sessionId, turnId), "utf8")) as CheckpointManifest } catch { return undefined }
  }
  #write(manifest: CheckpointManifest): void {
    const dir = this.#dir(manifest.sessionId, manifest.turnId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2))
  }

  /** قبل الكتابة: يحفظ الأصلَ مرّةً واحدة لكلّ مسارٍ في الدور. لا يمسّ الملفَّ الهدف. */
  record(sessionId: string, turnId: string, project: string, absPath: string): RecordVerdict {
    const path = resolve(absPath)
    const manifest = this.#read(sessionId, turnId) ?? { version: 1 as const, sessionId, turnId, project: resolve(project), createdAt: new Date().toISOString(), files: [], skipped: [] }
    if (manifest.files.some((f) => f.path === path) || manifest.skipped.some((s) => s.path === path)) return "already"
    if (manifest.files.length >= CHECKPOINT_FILE_CAP) { manifest.skipped.push({ path, why: `فوق سقف ${CHECKPOINT_FILE_CAP} ملفّاً للدور` }); this.#write(manifest); return "skipped-cap" }
    const existed = existsSync(path) && statSync(path).isFile()
    if (!existed) { manifest.files.push({ path, existed: false, bytes: 0, sha256: "" }); this.#write(manifest); return "recorded" }
    const bytes = readFileSync(path)
    if (bytes.length > CHECKPOINT_BYTES_CAP) { manifest.skipped.push({ path, why: `أكبر من ${CHECKPOINT_BYTES_CAP} بايت` }); this.#write(manifest); return "skipped-large" }
    const blob = `f${manifest.files.length}`
    mkdirSync(this.#dir(sessionId, turnId), { recursive: true })
    writeFileSync(join(this.#dir(sessionId, turnId), blob), bytes)
    manifest.files.push({ path, existed: true, bytes: bytes.length, sha256: digest(bytes), blob })
    this.#write(manifest)
    return "recorded"
  }

  /** يعيد الملفّات إلى ما قبل الدور: الموجودُ يُكتب من نسخته، وما لم يكن موجوداً يُحذف. لا يلمس خارج مشروع الاستعادة. */
  restore(sessionId: string, turnId: string, project: string): RestoreReport {
    const manifest = this.#read(sessionId, turnId)
    if (manifest === undefined) return { ok: false, why: `لا نقطةَ رجوعٍ للدور ${turnId}` }
    if (manifest.project !== resolve(project)) return { ok: false, why: `نقطةُ الرجوع لمشروعٍ آخر (${manifest.project}) — افتح ذلك المشروعَ أوّلاً` }
    const restored: string[] = [], removed: string[] = [], skipped: string[] = manifest.skipped.map((s) => `${s.path} (${s.why})`)
    for (const file of manifest.files) {
      if (!inside(manifest.project, file.path)) { skipped.push(`${file.path} (خارج المشروع)`); continue }
      try {
        if (!file.existed) { if (existsSync(file.path)) { unlinkSync(file.path); removed.push(file.path) } continue }
        const bytes = readFileSync(join(this.#dir(sessionId, turnId), file.blob ?? ""))
        if (digest(bytes) !== file.sha256) { skipped.push(`${file.path} (نسخةُ الرجوع تالفة)`); continue }
        mkdirSync(dirname(file.path), { recursive: true })
        writeFileSync(file.path, bytes)
        restored.push(file.path)
      } catch (error) { skipped.push(`${file.path} (${String(error).slice(0, 80)})`) }
    }
    return { ok: true, turnId, restored, removed, skipped }
  }

  /** عددُ الملفّات المحفوظة لدورٍ (0 = لا نقطةَ رجوع) — لإطار `done` كي تعرض القشرةُ زرَّ الرجوع. */
  count(sessionId: string, turnId: string): number { return this.#read(sessionId, turnId)?.files.length ?? 0 }

  /** م9ح — تغييراتُ الدور لحارة المراجعة: الأصلُ من نقطة الرجوع والحاليُّ من القرص (الملفُّ غيرُ النصّيّ أو المتروك يُسمّى بلا محتوى). */
  changes(sessionId: string, turnId: string, project: string): { readonly path: string; readonly before?: string; readonly after?: string }[] {
    const manifest = this.#read(sessionId, turnId)
    if (manifest === undefined || manifest.project !== resolve(project)) return []
    const text = (bytes: Buffer | undefined): string | undefined => bytes === undefined || bytes.includes(0) ? undefined : bytes.toString("utf8")
    const out: { path: string; before?: string; after?: string }[] = []
    for (const file of manifest.files) {
      let beforeBytes: Buffer | undefined
      if (file.existed) { try { beforeBytes = readFileSync(join(this.#dir(sessionId, turnId), file.blob ?? "")) } catch { beforeBytes = undefined } }
      let afterBytes: Buffer | undefined
      try { if (existsSync(file.path) && statSync(file.path).isFile() && statSync(file.path).size <= CHECKPOINT_BYTES_CAP) afterBytes = readFileSync(file.path) } catch { afterBytes = undefined }
      if (beforeBytes === undefined && afterBytes === undefined) continue
      if (beforeBytes !== undefined && afterBytes !== undefined && beforeBytes.equals(afterBytes)) continue
      const before = text(beforeBytes), after = text(afterBytes)
      // ثنائيٌّ تغيّر: يُسمّى بلا محتوى — لا يُخفى ولا يُعرض بايتاتٍ للنموذج
      out.push({ path: file.path, ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) })
    }
    return out
  }

  /** نقاطُ الرجوع للجلسة (الأحدثُ أوّلاً) — للمشروع المفتوح وحده. */
  list(sessionId: string, project: string): { readonly turnId: string; readonly createdAt: string; readonly files: number; readonly skipped: number }[] {
    const dir = join(this.#root, safeSegment(sessionId))
    let turns: string[] = []
    try { turns = readdirSync(dir) } catch { return [] }
    const out = turns.map((t) => this.#read(sessionId, t)).filter((m): m is CheckpointManifest => m !== undefined && m.project === resolve(project))
      .map((m) => ({ turnId: m.turnId, createdAt: m.createdAt, files: m.files.length, skipped: m.skipped.length }))
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /** يُبقي آخرَ N نقاط للجلسة ويحذف الأقدم — بلا لمسٍ للمشروع. */
  prune(sessionId: string, keep = CHECKPOINT_KEEP_TURNS): number {
    const dir = join(this.#root, safeSegment(sessionId))
    let turns: { name: string; createdAt: string }[] = []
    try { turns = readdirSync(dir).map((name) => ({ name, createdAt: this.#read(sessionId, name)?.createdAt ?? "" })) } catch { return 0 }
    turns.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    let removed = 0
    for (const t of turns.slice(keep)) { try { rmSync(join(dir, t.name), { recursive: true, force: true }); removed += 1 } catch { /* يُترك */ } }
    return removed
  }
}

/** سطرُ التقرير للمشغّل — يسمّي الأعداد والمتروك، ولا يدّعي استعادةَ ما لم يُستعَد. */
export function restoreReportLine(report: RestoreReport): string {
  if (!report.ok) return `↩ تعذّر الرجوع: ${report.why}`
  const parts = [`↩ استُعيد ما قبل الدور ${report.turnId}: ${report.restored.length} ملفّاً أُعيد`, `${report.removed.length} أُزيل (لم يكن موجوداً)`]
  if (report.skipped.length > 0) parts.push(`${report.skipped.length} تُرك: ${report.skipped.slice(0, 5).join("؛ ")}`)
  return parts.join(" · ")
}
