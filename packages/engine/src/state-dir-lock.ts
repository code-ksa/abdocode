/** كتالوج 10.4 — قفل دليل الحالة: هارنسٌ واحد لكل دليل.
 *
 * قيس حيّاً مرتين في يوم: هارنسان متراكبان على دليل حالةٍ واحد تداخلت
 * كتاباتهما في دفتر serve فانكسر تسلسله (`serve_output_sequence_gap:
 * 910->906`) ورفض الدفتر الفتح — فشلٌ مغلقٌ صحيح لكنه خسر الجلسة كلها.
 * القفل يمنع الجريمة بدل معاقبتها: الثاني يُرفض بسببٍ مسمّى وربّ قفلٍ حيّ،
 * والقفل اليتيم (صاحبه مات) يُستولى عليه بإعلان.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const LOCK = "serve.lock"

const pidAlive = (pid: number): boolean => {
  try {
    // إشارة 0 لا تقتل — تفحص الوجود فقط (تعمل على ويندوز في Bun/Node).
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export type LockResult =
  | { readonly ok: true; readonly note?: string }
  | { readonly ok: false; readonly why: string }

/** يحاول امتلاك دليل الحالة. الرفض يسمّي المالك الحيّ. */
export function acquireStateDirLock(stateDir: string): LockResult {
  const path = join(stateDir, LOCK)
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf-8").trim()
    const owner = Number.parseInt(raw, 10)
    if (Number.isSafeInteger(owner) && owner > 0 && pidAlive(owner) && owner !== process.pid) {
      return {
        ok: false,
        why: `دليل الحالة مملوك لهارنس حيّ (pid ${owner}) — هارنسان على دليلٍ واحد يكسران تسلسل الدفتر (قيس: sequence_gap). انتظر انتهاءه أو استعمل دليلاً آخر.`,
      }
    }
    // قفلٌ يتيم: صاحبه مات — يُستولى عليه بإعلان لا بصمت.
    writeFileSync(path, String(process.pid))
    return { ok: true, note: `قفلٌ يتيم من pid ${raw} اُستولي عليه` }
  }
  writeFileSync(path, String(process.pid))
  return { ok: true }
}

export function releaseStateDirLock(stateDir: string): void {
  const path = join(stateDir, LOCK)
  try {
    if (existsSync(path) && readFileSync(path, "utf-8").trim() === String(process.pid)) rmSync(path)
  } catch { /* زوال القفل مع العملية مقبول — اليتيم يُستولى عليه */ }
}
