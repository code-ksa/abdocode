/**
 * خطّافاتُ المستخدم — الفجوة #3 في جدول 2026-09-27 (Claude Code وCodex يشغّلان أوامرَ المشروع حول أدوات الوكيل).
 *
 * `.abdo/hooks.json` في المشروع:
 *   { "afterEdit": [{ "match": "\\.tsx?$", "run": "npx prettier --write {file}" }],
 *     "beforeDone": [{ "run": "npm run lint" }] }
 *
 * · afterEdit — بعد كلّ كتابةٍ ناجحة لملفٍّ يطابق `match`، ويُلحق خرجُه بإيصال الكتابة فيراه النموذجُ في الحال.
 * · beforeDone — حين يعلن النموذجُ الإكمالَ بعد مسِّ الشيفرة: فشلُ أيٍّ منها يعيد خرجَه إليه ليصلح، ولا إكمالَ قبل نجاحها.
 *
 * 🔴 ملفُّ خطّافاتٍ في مستودعٍ مستنسخ **شيفرةٌ تعمل بمجرّد فتح المشروع** — الهجومُ المعروف. فلا يعمل خطّافٌ إلّا بعد أن
 * يوافق المستخدمُ على **هذا المحتوى بعينه** (بصمةُ الملفّ)، بسؤالٍ لا يُعفي منه نمطُ الوصول الكامل، وأيُّ تغييرٍ في
 * الملفّ يُسقط الموافقة. وكلُّ خطّافٍ يمرّ من مسار `run` نفسِه: إدخالُ النواة ودفترُها — لا قناةَ جانبيّة.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

export const HOOKS_FILE = ".abdo/hooks.json"
const MAX_HOOKS = 8
const MAX_COMMAND = 300
const EVENTS = ["afterEdit", "beforeDone"] as const
export type HookEvent = (typeof EVENTS)[number]

export interface ProjectHook { readonly event: HookEvent; readonly run: string; readonly match?: RegExp }
export interface HooksFile { readonly digest: string; readonly hooks: readonly ProjectHook[] }

/** `undefined` = لا ملفّ. وإلّا الملفُّ صالحاً أو سببُ رفضه مسمّى — ملفٌّ نصفُ صالحٍ لا يُفعَّل نصفُه. */
export function readHooks(projectDir: string): { readonly file?: HooksFile; readonly error?: string } | undefined {
  const path = join(projectDir, HOOKS_FILE)
  if (!existsSync(path)) return undefined
  const raw = readFileSync(path)
  const digest = createHash("sha256").update(raw).digest("hex")
  let parsed: unknown
  try { parsed = JSON.parse(raw.toString("utf8")) } catch { return { error: `${HOOKS_FILE} ليس JSON صالحاً` } }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { error: `${HOOKS_FILE}: المتوقّع كائنٌ بمفاتيح afterEdit وbeforeDone` }
  const hooks: ProjectHook[] = []
  for (const [key, list] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(EVENTS as readonly string[]).includes(key)) return { error: `${HOOKS_FILE}: حدثٌ غيرُ معروف «${key.slice(0, 30)}» — المعروف: ${EVENTS.join("، ")}` }
    if (!Array.isArray(list)) return { error: `${HOOKS_FILE}: «${key}» يجب أن يكون قائمة` }
    for (const entry of list) {
      const item = entry as { run?: unknown; match?: unknown }
      if (typeof item?.run !== "string" || item.run.trim().length === 0) return { error: `${HOOKS_FILE}: كلُّ خطّافٍ يحتاج «run» نصّاً` }
      if (item.run.length > MAX_COMMAND || /[\r\n\0]/u.test(item.run)) return { error: `${HOOKS_FILE}: أمرٌ أطولُ من ${MAX_COMMAND} محرفاً أو متعدّدُ الأسطر` }
      let match: RegExp | undefined
      if (item.match !== undefined) {
        if (key !== "afterEdit") return { error: `${HOOKS_FILE}: «match» لـafterEdit وحده` }
        if (typeof item.match !== "string" || item.match.length > 200) return { error: `${HOOKS_FILE}: «match» تعبيرٌ نصّيّ قصير` }
        try { match = new RegExp(item.match, "u") } catch { return { error: `${HOOKS_FILE}: «match» تعبيرٌ غيرُ صالح: ${item.match.slice(0, 60)}` } }
      }
      if (key === "beforeDone" && item.run.includes("{file}")) return { error: `${HOOKS_FILE}: {file} لـafterEdit وحده` }
      hooks.push({ event: key as HookEvent, run: item.run.trim(), ...(match === undefined ? {} : { match }) })
    }
  }
  if (hooks.length === 0) return { error: `${HOOKS_FILE} بلا خطّافات` }
  if (hooks.length > MAX_HOOKS) return { error: `${HOOKS_FILE}: أكثرُ من ${MAX_HOOKS} خطّافات` }
  return { file: { digest, hooks } }
}

const approvalsPath = (stateDir: string) => join(stateDir, "hooks-approvals.json")
const projectKey = (projectDir: string) => resolve(projectDir).toLowerCase()

export function approvedDigest(stateDir: string, projectDir: string): string | undefined {
  try {
    const all = JSON.parse(readFileSync(approvalsPath(stateDir), "utf8")) as Record<string, unknown>
    const digest = all[projectKey(projectDir)]
    return typeof digest === "string" ? digest : undefined
  } catch { return undefined }
}

export function recordApproval(stateDir: string, projectDir: string, digest: string): void {
  let all: Record<string, string> = {}
  try { all = JSON.parse(readFileSync(approvalsPath(stateDir), "utf8")) as Record<string, string> } catch { /* أوّلُ موافقة */ }
  all[projectKey(projectDir)] = digest
  mkdirSync(dirname(approvalsPath(stateDir)), { recursive: true })
  writeFileSync(approvalsPath(stateDir), JSON.stringify(all, null, 2))
}

export const hooksSummary = (hooks: readonly ProjectHook[]): string =>
  hooks.map((h) => `${h.event}${h.match === undefined ? "" : ` (${h.match.source})`}: ${h.run}`).join(" · ")

/** المسارُ في `{file}` بمحارفَ آمنةٍ وحدها وبين علامتي تنصيص — مسارٌ فيه محرفُ صَدَفة يُرفض ولا يُهرَّب. */
export function commandFor(hook: ProjectHook, file?: string): string | undefined {
  if (!hook.run.includes("{file}")) return hook.run
  if (file === undefined || !/^[\p{L}\p{N}_./\\ @+-]+$/u.test(file)) return undefined
  return hook.run.split("{file}").join(`"${file}"`)
}

export const hookLine = (event: HookEvent, command: string, ok: boolean, tail: string): string =>
  `🪝 ${event} «${command}»: ${ok ? "نجح" : "فشل"}${tail.length > 0 ? ` — ${tail}` : ""}`
