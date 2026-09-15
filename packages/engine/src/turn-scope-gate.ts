/**
 * د7ب — نطاقُ الدور للكتابة (أمرُ المالك 09-14/15؛ مقيس: بعد إتمام المهمّة مضى النموذجُ إلى ما لم يُطلب — npm run build
 * في حزمةٍ بلا سكربت، وكاد يلمس package.json). تعديلُ ملفٍّ **موجود** يُقبل في واحدةٍ من خمس:
 *   ١) سمّاه المستخدمُ في مهمّته (مسارُه أو اسمُه بامتداده أو جذعُه إن كان معنويّاً)؛
 *   ٢) قرأه النموذجُ في هذا الدور (`read`) فهو يعدّل ما رأى؛
 *   ٣) أنشأه النموذجُ في هذا الدور؛
 *   ٤) وُلد أو تغيّر بعد بداية الدور (سقالةُ `create-next-app` مثلاً) — فهو أثرُ الدور نفسه؛
 *   ٥) أو أذن المستخدمُ عامّةً («كلّ الملفّات»، «المشروع كلّه»، all files, whole project).
 * الملفُّ الجديد يمرّ دائماً (الإنشاءُ أثرٌ يُرى)، وملفّاتُ بروتوكول الهارنس (ABDO-SPRINTS.md، ‎.abdo/) خارج الحكم.
 * وإلّا رفضٌ مسمّى يقول للنموذج: اقرأه أوّلاً إن كان من المهمّة، وإلّا فلا تلمسه واسأل المستخدم — لا موافقةٌ ضمنيّة.
 */
import { normalizeArabic } from "./front-gate"

/** جذوعٌ عامّة لا تدلّ على ملفٍّ بعينه حين تظهر في نصّ المهمّة (index/page/main...). */
const GENERIC_STEMS = new Set(["index", "page", "main", "app", "test", "tests", "spec", "src", "lib", "utils", "util", "config", "readme", "style", "styles", "layout", "types", "type", "server", "client", "route", "api", "data", "setup", "build", "dist", "public", "package", "next", "vite", "tsconfig"])

export const BLANKET_FILES = /كل الملفات|جميع الملفات|المشروع كله|كل المشروع|all files|every file|any file|whole project|entire project|across the project/iu
/** ملفّاتُ بروتوكول الهارنس تُكتب بحكمها الخاصّ لا بنطاق الدور. */
const PROTOCOL = /^(?:abdo-sprints\.md|\.abdo\/.*|\.abdocode\/.*|abdo\.md|agents\.md|claude\.md)$/iu

export type TurnScopeInput = Readonly<{
  /** المسارُ النسبيّ كما طلبه النموذج (بأيّ شرطات). */
  target: string
  exists: boolean
  /** آخرُ تعديلٍ على القرص (ms) إن كان الملفُّ موجوداً. */
  modifiedAtMs?: number
  turnStartedAtMs: number
  taskText: string
  readThisTurn: ReadonlySet<string>
  createdThisTurn: ReadonlySet<string>
}>

export type TurnScopeVerdict =
  | Readonly<{ ok: true; why: "new" | "protocol" | "named" | "read" | "created" | "fresh" | "blanket" }>
  | Readonly<{ ok: false; why: string }>

/** مفتاحٌ واحد للمسار: شرطاتٌ أماميّة، بلا `./`، بأحرفٍ صغيرة — الطرفان (التسجيلُ والحكم) يستعملانه. */
export const scopeKey = (path: string): string => path.replace(/\\/g, "/").replace(/^(?:\.\/)+/u, "").replace(/\/+/g, "/").toLowerCase()

const foldTask = (text: string): string => normalizeArabic(text).toLowerCase().replace(/\\/g, "/")

const namedInTask = (key: string, task: string): boolean => {
  if (key.length === 0) return false
  if (task.includes(key)) return true
  const base = key.slice(key.lastIndexOf("/") + 1)
  if (base.length > 0 && task.includes(base)) return true
  const stem = base.replace(/\.[^.]+$/u, "")
  if (stem.length >= 4 && !GENERIC_STEMS.has(stem) && new RegExp(`(?:^|[^a-z0-9_])${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9_])`, "u").test(task)) return true
  return false
}

export const fileEditAllowedByTurn = (input: TurnScopeInput): TurnScopeVerdict => {
  const key = scopeKey(input.target)
  if (!input.exists) return { ok: true, why: "new" }
  if (PROTOCOL.test(key)) return { ok: true, why: "protocol" }
  if (input.createdThisTurn.has(key)) return { ok: true, why: "created" }
  if (input.readThisTurn.has(key)) return { ok: true, why: "read" }
  const task = foldTask(input.taskText)
  // الطرفان يُطوَيان بالتطبيع نفسه: «خطّة.md» في المهمّة و«خطة.md» على القرص اسمٌ واحد.
  if (namedInTask(scopeKey(normalizeArabic(input.target)), task)) return { ok: true, why: "named" }
  if (BLANKET_FILES.test(task) || BLANKET_FILES.test(input.taskText)) return { ok: true, why: "blanket" }
  if (input.modifiedAtMs !== undefined && input.modifiedAtMs >= input.turnStartedAtMs) return { ok: true, why: "fresh" }
  return {
    ok: false,
    why: `رُفض تعديل ${input.target}: الملفُّ موجودٌ ولم يسمِّه المستخدمُ في المهمّة ولم تقرأه ولم تُنشئه في هذا الدور. إن كان تعديله جزءاً من المهمّة فاقرأه أوّلاً (read ${input.target}) ثمّ عدِّل ما رأيت؛ وإن لم يطلبه المستخدمُ فلا تلمسه — أنهِ الدور واسأله.`,
  }
}
