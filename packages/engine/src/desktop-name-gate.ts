/**
 * أ2 — بوّابةٌ بالاسم لإدخال سطح المكتب (أمرُ المالك 09-14/15؛ مقيس: حين سُرقت المقدّمةُ إلى نافذة «Claude» ركّزها النموذجُ بـpid
 * وكاد يكتب فيها). الإدخالُ (نقر/كتابة/مفاتيح/تمرير/set/press) يُقبل في نافذةٍ واحدةٍ من ثلاث:
 *   ١) فتحها الوكيلُ بنفسه (`desk open`) أو ظهرت نتيجةَ فعله (نافذةٌ جديدة بعد فعل، أو `desk wait` وجدها) — الثقةُ بالمقبض؛
 *   ٢) سمّاها المستخدمُ في مهمّته: عنوانُها (أو جزءٌ معنويّ منه) أو رقمُ pid أو اسمُ البرنامج بالعربيّة (المفكرة/كروم…) وردَ في النصّ؛
 *   ٣) أو أذن المستخدمُ عامّةً («أيّ نافذة»، «كل النوافذ»، any window).
 * وإلّا رفضٌ مسمّى يقول للنموذج أن يطلب من المستخدم تسميتَها — لا موافقةٌ ضمنيّة حتى في «صلاحيّة كاملة». الوحدةُ نقيّة.
 */
import { normalizeArabic } from "./front-gate"

/** كلماتٌ عامّة في عناوين النوافذ لا تدلّ على نافذةٍ بعينها. */
const GENERIC = new Set(["google", "chrome", "microsoft", "edge", "mozilla", "firefox", "windows", "window", "new", "tab", "untitled", "profile", "file", "explorer", "program", "manager", "app", "the", "and", "for", "with", "https", "http", "www", "com", "net", "org", "html", "page", "home", "main", "document", "documents", "user", "users", "desktop"])

/** أسماءُ برامجٍ بالعربيّة كما يكتبها المستخدم ⇦ ما يظهر في العنوان. */
const ALIASES: ReadonlyArray<readonly [RegExp, RegExp]> = [
  [/المفكر[ةه]|مفكر[ةه]/u, /notepad/iu],
  [/الحاسب[ةه]|حاسب[ةه]|آل[ةه] حاسب/u, /calculator|calc\b/iu],
  [/الرس[اّ]م|رسام|paint/u, /paint/iu],
  [/كروم|جوجل كروم/u, /google chrome/iu],
  [/إيدج|ايدج|ايج/u, /microsoft.?edge/iu],
  [/فايرفوكس|فيرفوكس/u, /firefox/iu],
  [/إكسل|اكسل/u, /excel/iu],
  [/وورد|ورد\b/u, /\bword\b/iu],
  [/باوربوينت|بوربوينت/u, /powerpoint/iu],
  [/بليندر/u, /blender/iu],
  [/فوتوشوب/u, /photoshop/iu],
  [/مستكشف الملفات|مستكشف/u, /file explorer|explorer/iu],
  [/الطرفي[ةه]|طرفي[ةه]|terminal|cmd|powershell/u, /terminal|command prompt|powershell|cmd/iu],
  [/الإعدادات|اعدادات/u, /settings/iu],
  [/متجر|store/u, /store/iu],
  [/vs ?code|فيجوال/u, /visual studio code/iu],
]

const fold = (s: string): string => normalizeArabic(s).toLowerCase()
const tokensOf = (title: string): string[] => fold(title).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3 && !GENERIC.has(t))

export type NameGateVerdict = { readonly ok: true; readonly why: "trusted" | "named" | "pid" | "alias" | "blanket" } | { readonly ok: false; readonly why: string }

export interface NameGateInput {
  readonly title: string
  readonly pid: number
  readonly hwnd: number
  readonly taskText: string
  readonly trustedHwnds: ReadonlySet<number>
}

export const BLANKET_ALLOW = /أيّ? نافذ[ةه]|كلّ? النوافذ|any window|all windows|whatever window/iu

export const windowAllowedByTask = (input: NameGateInput): NameGateVerdict => {
  if (input.trustedHwnds.has(input.hwnd)) return { ok: true, why: "trusted" }
  const task = fold(input.taskText)
  if (BLANKET_ALLOW.test(input.taskText)) return { ok: true, why: "blanket" }
  if (new RegExp(`pid:?\\s*${input.pid}\\b`, "u").test(task)) return { ok: true, why: "pid" }
  const tokens = tokensOf(input.title)
  if (tokens.some((t) => task.includes(t))) return { ok: true, why: "named" }
  // الأسماءُ العربيّة تُطابَق على النصّ المطبَّع (بلا تشكيلٍ ولا همزاتٍ متفرّقة) — «الرسّام» و«الرسام» واحد.
  for (const [arabic, titleRe] of ALIASES) if ((arabic.test(input.taskText) || arabic.test(task)) && titleRe.test(input.title)) return { ok: true, why: "alias" }
  return { ok: false, why: `رُفض الإدخال: نافذةُ «${input.title.slice(0, 60)}» (pid ${input.pid}) لم يسمِّها المستخدمُ في مهمّته، ولم تفتحها أنت، ولم تظهر نتيجةَ فعلك — اطلب من المستخدم أن يسمّي النافذةَ (أو يقول «أيّ نافذة»)، أو افتح البرنامجَ المطلوب بـdesk open واعمل فيه.` }
}
