/**
 * حارسُ المالك — المحرّكُ الذي فقد أباه يخرج ذاتياً.
 *
 * مقيس 2026-09-14 (يتيمُ 10236): سطحُ المكتب 4.0.23 قُتل قسراً (Stop-Process) فبقي محرّكُه `abdocode.exe serve`
 * حيّاً قابضاً على قفل دليل الحالة، والتطبيقُ الجديد (4.0.24) رفض تشغيلَ محرّكه: «دليل الحالة مملوك لهارنس حيّ
 * (pid 10236)». نهايةُ stdin لا تكفي دليلاً على موت الأب: مجرى الأنبوب قد يرثه طفلٌ آخر (WebView2، خادمُ دور)
 * فلا يصل EOF. سطحُ المكتب يمرّر `ABDO_DESKTOP_OWNER_PID` منذ زمن ولم يقرأه المحرّك قطّ — هنا يُقرأ.
 *
 * الحكمُ بالـpid: `process.kill(pid, 0)` — ESRCH = مات؛ EPERM = حيٌّ لا نملكه (System = 4) فيُعدّ حيّاً.
 * غيابان متتاليان (لا واحد) قبل الحكم كي لا يقتل خطأٌ عابر محرّكاً يعمل.
 */

export const OWNER_WATCH_INTERVAL_MS = 5_000
export const OWNER_WATCH_MISSES = 2

export const parseOwnerPid = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw.trim().length === 0) return undefined
  const pid = Number(raw)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

export const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch (error) { return (error as { code?: string }).code !== "ESRCH" }
}

export const ownerGoneLine = (pid: number): string =>
  `مالكُ المحرّك (pid ${pid}) مات — خروجٌ ذاتيّ يحرّر قفل الحالة`

/**
 * يراقب المالكَ كلَّ `intervalMs` ويستدعي `onGone` مرّةً واحدة بعد `misses` غياباتٍ متتالية. يعيد دالّةَ إيقاف.
 * المؤقّتُ لا يُبقي العمليةَ حيّةً وحده (`unref`) — الحارسُ لا يصير هو اليتيم.
 */
export const watchOwner = (
  pid: number,
  onGone: () => void,
  options: { readonly intervalMs?: number; readonly misses?: number; readonly alive?: (pid: number) => boolean } = {},
): (() => void) => {
  const intervalMs = options.intervalMs ?? OWNER_WATCH_INTERVAL_MS
  const needed = Math.max(1, options.misses ?? OWNER_WATCH_MISSES)
  const alive = options.alive ?? pidAlive
  let consecutive = 0
  let fired = false
  const timer = setInterval(() => {
    if (fired) return
    if (alive(pid)) { consecutive = 0; return }
    consecutive += 1
    if (consecutive < needed) return
    fired = true
    clearInterval(timer)
    onGone()
  }, intervalMs)
  ;(timer as { unref?: () => void }).unref?.()
  return () => clearInterval(timer)
}
