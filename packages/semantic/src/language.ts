/**
 * اللغة — الطبقةُ الأولى: «يحدّد اللغة إيش».
 *
 * تُعدّ **الكلماتُ** بخطّها لا الحروف: «افتح ملف config.json» فيها كلمتان عربيتان
 * ومعرّفٌ لاتينيّ واحد — لغتُها عربية وإن كانت حروفُ المعرّف أكثر. فالمعرّفاتُ (ما فيه
 * نقطةٌ أو مائلٌ أو شرطةٌ سفلية) لا تصوّت على اللغة، لكنها تُعلن **التبديلَ داخل الجملة**
 * كي لا تطويها طبقاتُ الهدف.
 *
 * والتعادلُ بين الخطّين عربيٌّ عمداً — لغةُ المنتَج الأمّ — ويُعلَن في الدليل.
 */

export type Language = "ar" | "en" | "mixed" | "unknown"

export interface LanguageRead {
  readonly language: Language
  /** كلماتٌ عربيةُ الخطّ. */
  readonly arabic: number
  /** كلماتٌ لاتينيةُ الخطّ (بلا المعرّفات). */
  readonly latin: number
  /** معرّفاتٌ لاتينية (`config.json`، `app/page.tsx`، `.env`). */
  readonly identifiers: number
  /** خطّان في جملةٍ واحدة — معرّفٌ أو كلمةٌ من الخطّ الآخر. */
  readonly codeSwitch: boolean
  readonly evidence: string
}

const ARABIC = /\p{Script=Arabic}/u
const LATIN = /\p{Script=Latin}/u
const IDENTIFIER_SHAPE = /^[\p{L}\p{N}_.\\/-]*[._\\/-][\p{L}\p{N}_.\\/-]*$/u

export function detectLanguage(text: string): LanguageRead {
  let arabic = 0, latin = 0, identifiers = 0
  for (const raw of text.trim().split(/\s+/u)) {
    const token = raw.replace(/^[«"“'‘`(\[]+|[»"”'’`)\],.؟?!:;،]+$/gu, "")
    if (token.length === 0) continue
    if (ARABIC.test(token)) { arabic++; continue }
    if (!LATIN.test(token)) continue
    if (IDENTIFIER_SHAPE.test(token)) identifiers++
    else latin++
  }
  const voters = arabic + latin
  if (voters === 0 && identifiers === 0) return Object.freeze({ language: "unknown", arabic, latin, identifiers, codeSwitch: false, evidence: "لا كلماتَ عربيةً ولا لاتينية" })
  if (voters === 0) return Object.freeze({ language: "en", arabic, latin, identifiers, codeSwitch: false, evidence: "معرّفاتٌ فقط" })
  const codeSwitch = (arabic > 0 && (latin > 0 || identifiers > 0)) || (latin > 0 && arabic > 0)
  const language: Language = arabic >= latin ? "ar" : "en"
  const tie = arabic === latin && arabic > 0
  return Object.freeze({
    language,
    arabic,
    latin,
    identifiers,
    codeSwitch,
    evidence: `عربي ${arabic} · لاتيني ${latin} · معرّفات ${identifiers}${tie ? " · تعادلٌ ⇦ العربية" : ""}${codeSwitch ? " · تبديلٌ داخل الجملة" : ""}`,
  })
}
