/** IDEA 2 — حقل النيّة ودروس المخالفة (`plugins.intentField`).
 *
 * فكرةٌ ممتصّة من anton (`core/memory/cerebellum.py`): النيّة نموذجٌ أماميّ،
 * والفرق بينها وبين ما وقع فعلاً هو **وحده** ما يستحقّ أن يُحفظ. عندهم
 * يُستدعى نموذجٌ في آخر الدور ليكتب الفرق جملةً واحدة؛ عندنا لا نداء أصلاً:
 * النيّة تأتي في ردّ النموذج نفسه (صفر تكلفة)، والفرق يُقطَّر حتمياً من
 * الحكم الصريح (`ToolVerdict`) وبصمة الخطأ المطبَّعة (`failure-tiering`).
 *
 * القواعد الحاكمة هنا:
 * - **لا درسَ بلا نيّة مصرَّحة**: الغياب يُعدّ ولا يُخترع له درس.
 * - **إيصالات `run` وحدها**: قيدُ الجدران والمعدِّن نفسه — إيصال `write`
 *   يردّد محتوى ملفٍ فيه كلمة error، وتقطيرُه يسرّب بايتات المشروع إلى
 *   ذاكرةٍ دائمة تُحقن لاحقاً في المُوجِّه.
 * - **رفضُ السياسة ليس عطباً**: `verdictIsBreakage` — الحارس الذي رفض قرارٌ
 *   لا خللٌ في النموذج الأماميّ.
 * - **مفرداتٌ واحدة**: السبب من اتحاد `ToolVerdictReason` (والغائب هو الحرف
 *   الاتحاديّ `tool_failed`)، والبصمة من `normalizeErrorSignature` — فتنطبق
 *   حادثتان تختلفان في مسارٍ أو رقمٍ على مفتاحٍ واحد.
 * - **النيّة بياناتٌ من النموذج**: تُحجب أسرارها بمفردات الحجب القائمة قبل
 *   أن تلمس القرص، ولا تُنفَّذ ولا تُعاد إلى النموذج إيصالاً.
 */

import { REASONS, verdictIsBreakage, type ToolVerdict, type ToolVerdictReason } from "@abdo/engine-host"
import { classifyFailureTier, normalizeErrorSignature, receiptFailed } from "./failure-tiering"
import { redactSecretValues, sweepResidualSecrets } from "./secret-command-guard"
import type { DistilledFact } from "./turn-memory"

/** سقف كلمات الدرس — «جملة واحدة، دون خمسٍ وعشرين كلمة» (cerebellum.py:92-97). */
export const LESSON_WORD_CAP = 25
/** سقف الدروس لكل دور: استرجاع الحقبة الأولى يقرأ آخر ١٢ حقيقة — لا تُزاحَم كلّها. */
export const LESSONS_PER_TURN_CAP = 6
/** ذيل البصمة في المفتاح — مِن صيغة `wallFact` نفسها (failure-tiering.ts). */
export const SIGNATURE_KEY_CHARS = 80
const LESSON_PREFIX = "lesson:"
const RESOLVED_PREFIX = "resolved:"
/** قيد الجدران والمعدِّن نفسه: إيصالات التنفيذ وحدها تُقطَّر. */
const RUN_RECEIPT = /^run\b/iu

/** السبب حين لا حكم صريح — حرفٌ من الاتحاد لا اختراعٌ محلّيّ. */
export const INFERRED_REASON: ToolVerdictReason = "tool_failed"
// فشلٌ مُغلق عند التحميل: لو خرج الحرف من الاتحاد لم يُسمَّ سببٌ لا يعرفه أحد.
if (!REASONS.includes(INFERRED_REASON)) throw new Error("intent_field_reason_vocabulary_drift")

const collapse = (text: string): string => text.replace(/\s+/gu, " ").trim()

/** حجبٌ ثم مصفاةٌ طويلة — المفردات القائمة نفسها، لا قاموس ثانٍ. */
const redact = (text: string): string => sweepResidualSecrets(redactSecretValues(text).text).text

/** يقصّ إلى `max` كلمة بعد طيّ الفراغات — الدرس جملةٌ واحدة لا فقرة. */
export const capWords = (text: string, max = LESSON_WORD_CAP): string =>
  collapse(text).split(" ").filter((word) => word.length > 0).slice(0, max).join(" ")

const commandHead = (command: string): string => (command.split("\n", 1)[0] ?? "").slice(0, 60)

/**
 * البصمة: **حجبٌ قبل التطبيع** ثم حجبٌ بعده. الترتيب مقيس لا ذوق:
 * `normalizeErrorSignature` يبدأ بـ`toLowerCase()`، ومفردات الحارس العارية
 * (`AKIA`/`AIza`/`eyJ`/`xox*`) حسّاسةٌ لحالة الحرف — فحجبٌ بعد التطبيع وحده
 * يفوّتها فتستقرّ في درسٍ دائم يُحقن لاحقاً في المُوجِّه. والحجب الثاني
 * لأنّ التطبيع نفسه قد يولّد بقيّةً طويلة، والحجب متساوي القوى.
 */
const signatureOf = (output: string): string => redact(normalizeErrorSignature(redact(output)))

/**
 * مفتاح الأمر: كلمة الأداة وأوّل رمزٍ بعدها («run npm» من «run npm test -- x»).
 * التصحيح يجب أن يشارك الكسرَ في **الأمر** لا في نصّ النيّة وحده: بلا هذا
 * كان `run echo ok` تحت نيّة «أصلح الاختبارات» يُسجَّل حلّاً لفشل `run npm test`،
 * ويُعاد حَقنه في المُوجِّه حقيقةً مثبتة لا تُعاد إثباتها.
 */
const commandKey = (command: string): string =>
  collapse(commandHead(command)).toLowerCase().split(" ").slice(0, 2).join(" ")

/**
 * مفتاح النيّة المعلَّقة: الأمر ثم النيّة — لا نصّ النيّة وحده. الفاصل
 * `U+0000` مهروبٌ في المصدر (لا بايتاً حرفياً) ولا يرد في أيّ من الطرفين،
 * فلا يلتبس «run npm» + « x» بـ«run npm x» + «».
 */
const pendingKeyOf = (command: string, stated: string): string =>
  `${commandKey(command)}\u0000${stated.toLowerCase()}`

/**
 * الفرق بين النيّة والواقع درساً دائماً، أو `undefined` حين لا درسَ فيه:
 * نيّةٌ غائبة، أو إيصالٌ ليس `run`، أو نجاحٌ، أو رفض سياسة.
 */
export function distillIntentLesson(
  intent: string | undefined,
  command: string,
  output: string,
  verdict?: ToolVerdict,
): DistilledFact | undefined {
  const stated = collapse(intent ?? "")
  if (stated.length === 0) return undefined
  if (!RUN_RECEIPT.test(command)) return undefined
  if (verdict !== undefined ? !verdictIsBreakage(verdict) : !receiptFailed(output)) return undefined
  const reason: ToolVerdictReason = verdict !== undefined && !verdict.ok ? verdict.reason : INFERRED_REASON
  const signature = signatureOf(output)
  const tier = classifyFailureTier(output)
  return Object.freeze({
    kind: "known_error" as const,
    key: `${LESSON_PREFIX}${signature.slice(-SIGNATURE_KEY_CHARS)}`,
    value: capWords(`${redact(stated)} → فشل (${reason}, ${tier}): ${signature.slice(-160)}`),
  })
}

/** جملة الوضع النصّيّ في مُوجِّه النظام — نصٌّ واحد لا نسختان. */
export const intentInstruction = (): string =>
  "قبل كل استدعاء اكتب سطراً واحداً «— النية: …» يقول ما تتوقع أن تفعله الأداة، ثم «نفّذ: <الأمر>» في السطر التالي.\n"

export interface IntentSnapshot {
  readonly stated: number
  readonly missing: number
  readonly lessons: number
  /** دروسٌ قُطّرت بلا حكمٍ صريح (من نصّ الإيصال) — تُعدّ ولا تُخفى. */
  readonly inferred: number
  readonly resolved: number
  /** كتاباتٌ أُسقطت لتكرار المفتاح في هذا الدور (درساً كانت أو حلّاً). */
  readonly deduped: number
  /** كتاباتٌ أُسقطت بسقف الدور (درساً كانت أو حلّاً). */
  readonly capped: number
}

export interface IntentObservation {
  readonly lesson?: DistilledFact
  readonly resolved?: DistilledFact
}

const NOTHING: IntentObservation = Object.freeze({})

/**
 * دفترُ نيّاتٍ لدورٍ واحد. العدّادات تُصفَّر لكل حقبة (السطر 🎯 يصف حقبته)،
 * أمّا منعُ التكرار وسقف الكتابات وخريطةُ النيّات الفاشلة فمدى الدور كلّه —
 * فبصمةٌ تكرّرت في حقبتين لا تُكتب مرّتين، وتصحيحٌ في حقبةٍ لاحقة يُعرف.
 *
 * **الميزانية واحدة للدرس والحلّ**: كلاهما كتابةٌ في ذاكرةٍ دائمة، فيمرّان
 * على المنع نفسه والسقف نفسه (`LESSONS_PER_TURN_CAP`). كان الحلّ يفلت منهما
 * فيكتب صفّاً جديداً لكل دورةِ فشلٍ‑ثمّ‑نجاح — لا سقف ولا منع.
 */
export class IntentLedger {
  #stated = 0
  #missing = 0
  #lessons = 0
  #inferred = 0
  #resolved = 0
  #deduped = 0
  #capped = 0
  /** مفاتيح كل ما كُتب في هذا الدور — `lesson:` و`resolved:` في مجموعةٍ واحدة. */
  readonly #signatures = new Set<string>()
  /** النيّات التي **خزَّنّا لها درساً** فعلاً، مفتاحُها الأمرُ ثمّ النيّة. */
  readonly #failedIntents = new Map<string, string>()
  /** ميزانية الكتابات الدائمة لهذا الدور — الدروس والحلول معاً. */
  #turnWrites = 0

  /**
   * يستهلك إيصالاً واحداً. يعيد ما يجب أن يُحفظ (درسٌ و/أو حلٌّ) — والحفظ
   * شأن المستدعي: الدفتر لا يلمس ذاكرةً ولا قرصاً.
   */
  observe(command: string, intent: string | undefined, output: string, verdict?: ToolVerdict): IntentObservation {
    const stated = collapse(intent ?? "")
    if (stated.length === 0) { this.#missing += 1; return NOTHING }
    this.#stated += 1
    if (!RUN_RECEIPT.test(command)) return NOTHING
    const key = pendingKeyOf(command, stated)
    const succeeded = verdict !== undefined ? verdict.ok : !receiptFailed(output)
    if (succeeded) {
      const signature = this.#failedIntents.get(key)
      if (signature === undefined) return NOTHING
      this.#failedIntents.delete(key)
      const resolvedKey = `${RESOLVED_PREFIX}${signature}`
      // الحلّ كتابةٌ دائمة كالدرس — فالمنعُ والسقف عليه أيضاً، وإلّا كتبت
      // دورةُ فشلٍ‑ثمّ‑نجاحٍ متكرّرة صفوفاً متطابقة بلا حدّ.
      if (this.#signatures.has(resolvedKey)) { this.#deduped += 1; return NOTHING }
      if (this.#turnWrites >= LESSONS_PER_TURN_CAP) { this.#capped += 1; return NOTHING }
      this.#signatures.add(resolvedKey)
      this.#turnWrites += 1
      this.#resolved += 1
      return Object.freeze({
        resolved: Object.freeze({
          kind: "resolved_error" as const,
          key: resolvedKey,
          value: capWords(`${redact(stated)} نجح بعد: ${redact(commandHead(command))}`),
        }),
      })
    }
    const lesson = distillIntentLesson(stated, command, output, verdict)
    if (lesson === undefined) return NOTHING
    if (verdict === undefined) this.#inferred += 1
    if (this.#signatures.has(lesson.key)) { this.#deduped += 1; return NOTHING }
    if (this.#turnWrites >= LESSONS_PER_TURN_CAP) { this.#capped += 1; return NOTHING }
    this.#signatures.add(lesson.key)
    this.#turnWrites += 1
    this.#lessons += 1
    // التسليح **بعد** البوّابتين: درسٌ لم يُخزَّن لا يُسلِّح حلّاً لاحقاً
    // يدّعي إصلاح كسرٍ لا أثر له في الذاكرة.
    this.#failedIntents.set(key, lesson.key.slice(LESSON_PREFIX.length))
    return Object.freeze({ lesson })
  }

  snapshot(): IntentSnapshot {
    return Object.freeze({
      stated: this.#stated,
      missing: this.#missing,
      lessons: this.#lessons,
      inferred: this.#inferred,
      resolved: this.#resolved,
      deduped: this.#deduped,
      capped: this.#capped,
    })
  }

  /** لكل حقبة — كالعدّاد 📐؛ ومنعُ التكرار وسقفُ الكتابات خارج التصفير عمداً. */
  reset(): void {
    this.#stated = 0
    this.#missing = 0
    this.#lessons = 0
    this.#inferred = 0
    this.#resolved = 0
    this.#deduped = 0
    this.#capped = 0
  }

  /** سطرٌ للمضيف وحده — لا يُرسل إلى النموذج أبداً. صفرٌ ⇒ «—». */
  line(epoch: number): string {
    const s = this.snapshot()
    if (s.stated + s.missing === 0) return `🎯 نيّات الحقبة ${epoch}: —`
    return `🎯 نيّات الحقبة ${epoch}: مصرَّح=${s.stated} · غائب=${s.missing} · دروس=${s.lessons} (مستنتَج=${s.inferred}) · حُلّ=${s.resolved}`
  }
}
