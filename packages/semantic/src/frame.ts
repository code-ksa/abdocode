/**
 * الإطارُ الدلاليّ — ما تخرج به الطبقاتُ الحتميّة معاً، وما تستلمه الطبقةُ الرابعة.
 *
 * الطبقاتُ صفرٌ إلى ثلاثة **حتميّةٌ نقيّة** وتعمل بلا نموذجٍ ولا شبكة: لغةٌ، لهجةٌ، فعلٌ،
 * هدف. والطبقةُ الرابعة — «الدوافع» و«المطلوبُ المستنتَج» — نموذجيّةٌ بمفتاح المستخدم
 * ومزوّدِه، وهي **غائبةٌ صراحةً** من هذا الإطار حتى تُبنى وتُقاس: الحقلُ `inferred` لا يُملأ
 * بحدسٍ حتميّ يتظاهر بالاستنتاج. الغيابُ معلَن، والادّعاءُ ممنوع.
 */
import { detectDialect, type DialectRead } from "./dialect"
import { detectLanguage, type LanguageRead } from "./language"
import { parseFileIntent, type FileIntent } from "./intent"
import { fold } from "./normalize"

export interface Inferred {
  /** المرادُ بالجملة كما فهمه النموذج — سطرٌ واحد. */
  readonly meaning: string
  /** الدافع: لماذا يطلب هذا الآن. */
  readonly motive: string
  /** المطلوبُ المستنتَج: ما يجب فعلُه بلغةِ أدواتنا. */
  readonly request: string
  readonly confidence: number
  /** المزوّدُ والنموذج اللذان أنتجاه — بمفتاح المستخدم لا بمفتاحنا. */
  readonly by: string
}

export interface SemanticFrame {
  readonly text: string
  readonly normalized: string
  readonly language: LanguageRead
  readonly dialect: DialectRead
  readonly intent: FileIntent
  /** الطبقةُ الرابعة. `undefined` = لم تُشغَّل، لا «لم يُستنتَج شيء». */
  readonly inferred?: Inferred
}

export function semanticFrame(text: string): SemanticFrame {
  const language = detectLanguage(text)
  const arabicEnough = language.language === "ar" || (language.language === "mixed" && language.arabic >= 0.3)
  return Object.freeze({
    text,
    normalized: fold(text),
    language,
    dialect: detectDialect(text, arabicEnough),
    intent: parseFileIntent(text),
  })
}

/** سطرٌ واحدٌ يقرؤه الإنسان — للإيصالات واللوحة. */
export function describeFrame(frame: SemanticFrame): string {
  const d = frame.dialect
  const i = frame.intent
  const parts = [
    `لغة: ${frame.language.language}${frame.language.codeSwitch ? " (تبديل)" : ""}`,
    `لهجة: ${d.dialect} ${Math.round(d.confidence * 100)}%`,
    `فعل: ${i.action}`,
    `نوع: ${i.kind}`,
    i.target === undefined ? "هدف: —" : `هدف: «${i.target}»`,
    frame.inferred === undefined ? "استنتاج: لم يُشغَّل" : `استنتاج: ${frame.inferred.request}`,
  ]
  return parts.join(" · ")
}
