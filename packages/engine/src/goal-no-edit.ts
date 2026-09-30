/**
 * هدفٌ يحظر التعديل — يُحترم حتميّاً لا بحسن ظنّ النموذج.
 *
 * مقيس 2026-09-30 على المحرّك المثبَّت 4.0.94: هدفٌ نصُّه «… لا تعدّل أيّ ملفّ» انتهى بـ
 * `npm update next eslint-config-next @next/eslint-plugin-next` («added 700 packages») — استبدل
 * مجلّدَ الاعتماديات كلَّه. النموذجُ قرأ الحظرَ وخالفه؛ الحارسُ النصّيّ هو ما يُلزمه.
 *
 * الحظرُ «شامل» فقط: بلا مفعول، أو بمفعولٍ عامّ (أيّ ملفّ، الملفّات، المشروع، الكود، شيئاً،
 * anything…). «لا تعدّل package.json» حظرٌ مقيَّد لا يمنع غيرَه، و«لا تعدّل شيئاً إلا README»
 * استثناءٌ لا يُخمَّن — كلاهما لا يُطلق الحارس (الاتجاهُ المعاكس: حارسٌ يحجب كلَّ شيء عطل).
 */
import { normalizeArabic } from "./front-gate"

const END = String.raw`(?=\s*(?:$|[.,،؛;!?؟:\n)(]|و\s|ثم\s|then\b|and\b|just\b|only\b|فقط|ابدا|نهائيا|خالص))`
// مفعولٌ عامّ لا يتبعه تقييدٌ بمكانٍ غيرِ المشروع («شيئاً في الواجهة» مقيَّد).
const NOT_SCOPED_AR = String.raw`(?!\s+(?:في|من|داخل|ب)\s+(?!(?:ال)?مشروع|المستودع))`
const NOT_SCOPED_EN = String.raw`(?!\s+(?:in|inside|under|within)\s+(?!the\s+(?:project|repo)))`
const UNIVERSAL_AR = String.raw`(?:اي\s*(?:ملف|شي|شيء|حاجه|سطر|كود)|(?:ال)?ملفات|(?:ال)?مشروع|(?:ال)?كود|(?:ال)?شيفره|شي(?:ء|يا|ا)?|حاجه)(?![\p{L}])${NOT_SCOPED_AR}`
const UNIVERSAL_EN = String.raw`(?:anything|any\s+files?|any\s+code|files|the\s+files|the\s+code|the\s+project|the\s+repo(?:sitory)?|the\s+codebase)\b${NOT_SCOPED_EN}`

// أمرُ المخاطَب وحده: «لا/ما تعدّل» أو العامّيّة «متعدّلش» (بالشين إلزاماً — وإلا صار «متغيّر» حظراً).
// الغائبُ («لا يعدّل الملفات») وصفٌ لسلوك شيفرة لا أمر.
const VERB = String.raw`(?:عدل|غير|لمس|مس)`
const AR_VERB = String.raw`(?:(?:^|[^\p{L}])(?:لا|ما)\s+ت${VERB}(?:وا|ي)?ش?|(?:^|[^\p{L}])مت${VERB}(?:وا|ي)?ش)`
const AR_NOUN = String.raw`(?:^|[^\p{L}])(?:بلا|بدون|دون|من\s+غير|ممنوع)\s+(?:ال)?(?:تعديل|تغيير|لمس|تعديلات|تغييرات)`
const EN_VERB = String.raw`\b(?:don'?t|do\s+not|never|without)\s+(?:modify(?:ing)?|chang(?:e|ing)|edit(?:ing)?|touch(?:ing)?|writ(?:e|ing)\s+to)`

const BLANKET: readonly RegExp[] = [
  new RegExp(String.raw`(?:${AR_VERB}|${AR_NOUN})\s*(?:${UNIVERSAL_AR}|${END})`, "iu"),
  // «للقراءة فقط» وصفُ مهمّة لا وصفُ حقل: في رأس جملة أو بعد فعلِ عمل («اجعل الحقل للقراءة فقط» لا يُطلقه).
  new RegExp(String.raw`(?:^|[.,،؛;:\n(-]\s*|(?:مهمه|اعمل|اشتغل|ابق|خليك|وضع|بوضع)\s+)(?:لل)?قراءه\s+فقط`, "iu"),
  new RegExp(String.raw`${EN_VERB}\s*(?:${UNIVERSAL_EN}|${END})`, "iu"),
  /(?:^|[.,;:(\n-]\s*|\b(?:stay|be|keep\s+it|work|in)\s+)read[\s-]only\b|\bread[\s-]only\s+(?:mode|task|pass|review|audit|check)\b/iu,
  /\b(?:make|with)\s+no\s+(?:edits|changes|modifications)\b/iu,
]
const EXCEPTION = /(?:(?:^|[^\p{L}])(?:الا|عدا|سوي|باستثناء)(?:[^\p{L}]|$)|\b(?:except|other\s+than|besides|apart\s+from)\b)/iu

/** هل يحظر الهدفُ كلَّ تعديلٍ في المشروع؟ */
export function goalForbidsEdits(goal: string): boolean {
  const text = normalizeArabic(goal)
  if (!BLANKET.some((pattern) => pattern.test(text))) return false
  return !EXCEPTION.test(text)
}

const MUTATING_TOOLS = new Set(["write", "edit", "patch", "git-stage", "git-unstage", "git-commit"])
const PACKAGE_MUTATION = /^(?:npm|pnpm|yarn|bun)\s+(?:i|install|ci|add|remove|rm|uninstall|un|update|up|upgrade|dedupe|prune|link|audit\s+fix)\b/iu
const SHELL_MUTATION = /^(?:rm|del|erase|rmdir|rd|mv|move|ren|rename|Remove-Item|Move-Item|Rename-Item|git\s+(?:add|commit|checkout|restore|reset|clean|stash|rebase|merge|pull|apply|rm|mv))\b/iu

/**
 * سببُ الرفض حين يحظر الهدفُ التعديلَ والأمرُ يعدّل، وإلا `undefined`.
 * `toolName` الاسمُ المحلول، و`command` سطرُ الأداة كاملاً (`run npm update …`).
 */
export function noEditGoalRefusal(goal: string, toolName: string, command: string): string | undefined {
  if (!goalForbidsEdits(goal)) return undefined
  if (MUTATING_TOOLS.has(toolName)) return `رُفضت ${toolName}: الهدفُ يحظر تعديلَ المشروع («لا تعدّل…») — اقرأ وافحص وأجب دون تغيير ملفّ.`
  if (toolName !== "run") return undefined
  const shell = command.trim().replace(/^run\s+/iu, "")
  for (const part of shell.split(/\s*(?:&&|\|\||;|\|)\s*/u)) {
    const step = part.trim().replace(/^npx\s+(?=npm|pnpm|yarn)/iu, "")
    if (PACKAGE_MUTATION.test(step) || SHELL_MUTATION.test(step))
      return `رُفض «${part.trim().slice(0, 80)}»: الهدفُ يحظر تعديلَ المشروع — تغييرُ الحزم أو الملفّات تعديلٌ. أبلغ بما وجدت واقترح الأمرَ للمالك بدل تنفيذه.`
  }
  return undefined
}
