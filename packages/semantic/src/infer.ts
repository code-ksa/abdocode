/**
 * الاستنتاج — الطبقةُ الرابعة: «الدوافع، ويستنتج المطلوب — مثلما أنت تفعل».
 *
 * ما لا يُحسم حتمياً (لماذا يطلب هذا الآن؟ وما الذي يعنيه فعلاً؟) يُسأل عنه نموذجٌ —
 * **بمفتاح المستخدم ومزوّدِه** لا بمفتاحنا — في نداءٍ جانبيٍّ مقيَّد: بلا أدوات، بلا بثّ،
 * سقفٌ صغير، حرارةٌ صفر. والنموذجُ هنا **موجِّهٌ لا مؤلّف**: يخرج بأربعة أسطرٍ حرفيةٍ لا
 * غير، وأيُّ ردٍّ لا يطابقها حرفاً — سطرٌ ناقص، ثقةٌ غيرُ رقمية، ادّعاءُ تنفيذ، نداءُ
 * أداة، قطعٌ — يُرفض كلُّه فيبقى `inferred` غائباً. **الغيابُ معلَن، والحدسُ ممنوع.**
 *
 * هذه الوحدة نقيّةٌ: تبني الموجّه وتفسّر الردّ؛ أمّا النداءُ نفسه وميزانيتُه ودفترُه
 * فعند المحرّك، بالمسار الذي تسلكه بوّابةُ التوجيه نفسُها.
 */
import type { Inferred, SemanticFrame } from "./frame"

/** سقفُ إخراجٍ صغير: أربعةُ أسطرٍ لا مقالة. */
export const INFER_OUTPUT_TOKENS = 256

export const INFER_LABELS = Object.freeze({ meaning: "المراد", motive: "الدافع", request: "المطلوب", confidence: "الثقة" })

/** موجّهُ النظام — أربعةُ أسطرٍ بهذا الشكل الحرفيّ ولا شيءَ غيرها. */
export function buildInferSystem(): string {
  return [
    "أنت محلّلُ طلباتٍ لا منفّذ. يصلك طلبُ مستخدمٍ بلهجته ومعه ما فُهم منه حتمياً (اللغة، اللهجة، الفعل، الهدف).",
    "مهمّتك أن تكمل الفهم لا أن تنفّذ: ما المرادُ بالطلب فعلاً، ولماذا يطلبه الآن (الدافع)، وما المطلوبُ عملياً بلغةٍ يفهمها منفّذٌ آليّ.",
    "أجب بأربعة أسطرٍ فقط، بهذا الشكل الحرفيّ وبهذا الترتيب، بلغة المستخدم، كلُّ سطرٍ جملةٌ واحدة قصيرة:",
    `${INFER_LABELS.meaning}: …`,
    `${INFER_LABELS.motive}: …`,
    `${INFER_LABELS.request}: …`,
    `${INFER_LABELS.confidence}: رقمٌ بين 0 و1`,
    "قواعد صارمة: لا تنفّذ شيئاً، ولا تقل إنك فعلت أو أنشأت أو كتبت أو حذفت شيئاً، ولا تذكر أدوات، ولا تضف أسطراً أو شرحاً أو ترويسات. إن لم تفهم فاكتب الثقة 0.",
  ].join("\n")
}

/** محتوى المستخدم: النصُّ كما قيل، ومعه الإطارُ الحتميّ سطراً واحداً كسياقٍ لا كتعليمات. */
export function condenseForInfer(frame: SemanticFrame): string {
  const i = frame.intent
  const context = `فُهم حتمياً: لغة=${frame.language.language}${frame.language.codeSwitch ? "+تبديل" : ""} · لهجة=${frame.dialect.dialect} · فعل=${i.action} · نوع=${i.kind}${i.target === undefined ? "" : ` · هدف=«${i.target}»`}`
  return `الطلب: ${frame.text}\n${context}`
}

const THINK_BLOCK = /<think>[\s\S]*?<\/think>/gu
const INVISIBLE = /[​-‏﻿]/gu
const MAX_LINE = 240
/** ادّعاءُ أثرٍ: النموذجُ محلّلٌ لا منفّذ، فأيُّ «فعلتُ» يكذب ويُرفض الردُّ كلُّه. */
const CLAIMS_EFFECT = /(?<![\p{L}\p{N}])(?:تم|تمت|نفذت|نفّذت|انشات|أنشأت|انشأت|كتبت|حذفت|شغلت|شغّلت|عدلت|عدّلت|I (?:created|wrote|deleted|ran|executed)|done)(?![\p{L}\p{N}])/u

const lineOf = (label: string, text: string): string | undefined => {
  const m = new RegExp(`^\\s*${label}\\s*[:：]\\s*(.+?)\\s*$`, "mu").exec(text)
  return m?.[1]
}

export interface InferTurnLike {
  readonly kind: "final" | "tools"
  readonly text: string
  readonly truncated?: boolean
}

/**
 * التفسيرُ الصارم: أربعةُ أسطرٍ حرفية، وثقةٌ رقمية، ولا ادّعاءَ أثرٍ ولا نداءَ أداةٍ ولا قطع.
 * أيُّ خرقٍ = `undefined`: لا استنتاج — لا استنتاجٌ مصلَّح.
 */
export function interpretInferTurn(turn: InferTurnLike, by: string): Inferred | undefined {
  if (turn.kind === "tools" || turn.truncated === true) return undefined
  const text = turn.text.replace(THINK_BLOCK, "").replace(INVISIBLE, "").trim()
  if (text.length === 0) return undefined
  const meaning = lineOf(INFER_LABELS.meaning, text)
  const motive = lineOf(INFER_LABELS.motive, text)
  const request = lineOf(INFER_LABELS.request, text)
  const confidenceRaw = lineOf(INFER_LABELS.confidence, text)
  if (meaning === undefined || motive === undefined || request === undefined || confidenceRaw === undefined) return undefined
  const confidence = Number(confidenceRaw.replace("٫", ".").replace(",", ".").replace(/[٠-٩]/gu, (d) => String(d.charCodeAt(0) - 0x0660)))
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return undefined
  for (const line of [meaning, motive, request]) {
    if (line.length === 0 || line.length > MAX_LINE || line === "…") return undefined
    if (CLAIMS_EFFECT.test(line)) return undefined
  }
  return Object.freeze({ meaning, motive, request, confidence: Number(confidence.toFixed(2)), by })
}
