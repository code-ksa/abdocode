/**
 * 09-29 — القتلُ بالرقم لا بالملكيّة: الحارسُ القائم يرفض `Stop-Process -Name` و`taskkill /IM`، لكنّ
 * `Get-Process node | Select Id` ثمّ `Stop-Process -Id 22472, 52448, 80340, 86024, 94596 -Force` مرّ — خمسُ عمليّات node
 * على الجهاز كلِّه، منها ما ليس للمشروع (مقيس على مهمّة OpenRouter 2026-09-29). الرقمُ لا يُثبت الملكيّة؛ الملكيّةُ تُقاس:
 * عمليّةٌ تديرها النواة لهذا الدور، أو تشغيلٌ خلفيّ بدأته الجلسة، أو عمليّةٌ سطرُ أوامرها يقع داخل مجلّد المشروع. وما سوى ذلك
 * «قتلُها قرارُها لا قرارُك».
 */

/** الأرقامُ المستهدفة بأمر إيقافٍ بالرقم — فارغةٌ حين لا إيقافَ بالرقم في الأمر. */
export function killByPidTargets(cmd: string): number[] {
  const out = new Set<number>()
  const add = (list: string) => {
    for (const piece of list.split(/[\s,]+/u)) {
      const n = Number(piece)
      if (Number.isSafeInteger(n) && n > 0) out.add(n)
    }
  }
  for (const m of cmd.matchAll(/\bStop-Process\b[^|;]*?-Id\s+((?:\d+\s*,?\s*)+)/giu)) add(m[1]!)
  for (const m of cmd.matchAll(/\bStop-Process\s+((?:\d+\s*,?\s*)+)(?=-|$|[;|])/giu)) add(m[1]!)
  for (const m of cmd.matchAll(/\btaskkill\b[^|;]*?\/PID\s+(\d+)/giu)) add(m[1]!)
  for (const m of cmd.matchAll(/(?:^|[;&|]\s*)kill\s+(?:-\w+\s+)?((?:\d+\s*)+)/giu)) add(m[1]!)
  return [...out]
}

const normalize = (path: string): string => path.replace(/[\\/]+/gu, "/").replace(/\/+$/u, "").toLowerCase()

/**
 * هل العمليّةُ ملكُ الدور؟ `owned` أرقامُ ما تديره النواة أو بدأته الجلسة؛ وغيرُها يُسأل عن سطر أوامرها (`query`، PowerShell)
 * فتُعدّ ملكاً إن ذكر مجلّدَ المشروع. الفشلُ في السؤال = غيابٌ = رفض.
 */
export function pidOwnedByProject(pid: number, projectDir: string, owned: ReadonlySet<number>, query: (pid: number) => string | undefined): boolean {
  if (owned.has(pid)) return true
  const line = query(pid)
  if (line === undefined || line.length === 0) return false
  return normalize(line).includes(normalize(projectDir))
}

/** سطرُ أوامر عمليّةٍ بالرقم عبر PowerShell — `undefined` حين لا عمليّة أو فشل السؤال. */
export function pidCommandLine(pid: number, spawn: (argv: string[]) => { stdout: string; ok: boolean }): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  const result = spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`])
  if (!result.ok) return undefined
  const text = result.stdout.trim()
  return text.length === 0 ? undefined : text
}

export function killRefusal(foreign: readonly number[]): string {
  return `رُفض إيقافُ عمليّاتٍ لا يملكها هذا الدور (pid ${foreign.join("، ")}): الرقمُ لا يُثبت الملكيّة — «قتلُها قرارُها لا قرارُك». ` +
    "خوادمُ الدور تُوقَف بـstop <pid> المذكور في إيصالها، وتشغيلاتُك الخلفيّة بـstop <معرّف>؛ وعمليّةٌ سطرُ أوامرها داخل مجلّد المشروع تُقبل بالرقم."
}
