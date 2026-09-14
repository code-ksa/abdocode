/**
 * @abdo/semantic — المحرّكُ الدلاليّ: يفهم الطلبَ الطبيعيّ بلهجته، ويخرج بإطارٍ منظَّم.
 *
 * أمر المالك 2026-09-06: «يحدّد اللغة إيش، واللهجة داخل اللغة إيش، والمراد من قول الكلمة،
 * والدوافع، ويستنتج المطلوب — مثلما أنت تفعل — مع أيّ مزوّد».
 *
 * الطبقاتُ الحتميّة هنا (تطبيع ⇦ لغة ⇦ لهجة ⇦ فعل وهدف) تعمل بلا نموذج، فتُقاس في
 * ملّي ثوانٍ مع كلّ إيداع بمجموعةٍ ذهبية. والاستنتاجُ النموذجيّ (الدوافع، المطلوب) طبقةٌ
 * رابعة بمفتاح المستخدم: موجّهٌ ومفسِّرٌ صارمٌ هنا، والنداءُ وميزانيتُه عند المحرّك —
 * والغيابُ معلَنٌ لا مُدَّعى.
 *
 * حزمةُ نواة: لا تعرف منتَجاً، ولا مزوّداً، ولا قرصاً.
 */
export { fold, words, rawTokens, stems, wordRe, NOT_LETTER_BEFORE, NOT_LETTER_AFTER } from "./normalize"
export { detectLanguage, type Language, type LanguageRead } from "./language"
export { detectDialect, type Dialect, type DialectRead, type DialectEvidence, type DialectOptions, type Scored } from "./dialect"
export { parseFileIntent, type FileAction, type FileIntent, type TargetKind } from "./intent"
export { semanticFrame, describeFrame, type SemanticFrame, type Inferred } from "./frame"
export { INFER_OUTPUT_TOKENS, INFER_LABELS, buildInferSystem, condenseForInfer, interpretInferTurn, type InferTurnLike } from "./infer"
