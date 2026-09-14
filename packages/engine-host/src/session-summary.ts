/**
 * S13.1 — وعي الجلسة: خلاصةٌ يكتبها النموذج بعد كل حقبة، تُراجَع ضد
 * الإيصالات قبل أن تُخزَّن، وتُحقن في **كل** حقبة لا الأولى وحدها.
 *
 * الوحدة **خالصة**: لا حالة، ولا I/O، ولا معرفة بالحلقة ولا بالذاكرة
 * الدائمة. البيئة تُمرَّر إليها (الإيصالات وسيطاً، والخلاصة المخزَّنة
 * وسيطاً)، والمضيف وحده يقرأ ويكتب.
 *
 * **الكلفة**: صفرُ نداءٍ إضافيّ. الخلاصة تركب الردَّ نفسه الذي تنتهي به
 * الحقبة ككتلةٍ ذيليّة اختيارية — الآليةُ نفسها التي يركب بها سطرُ النيّة
 * (`intent-line`) — فتُرفع عن النصّ **قبل** `parseCommand`، ولا تُعاد إلى
 * النموذج بنصّها أبداً بل مُلخَّصةً مسقوفة. أيُّ تصميمٍ يضيف `ask()` ثانياً
 * لكل حقبة يكون قد نقض تسعةَ سبرنتات أُنفقت في وقف نزف التوكنز.
 *
 * **الخلاصة ادّعاءٌ لا حقيقة**: النموذج كاتبها، فتُراجَع ضد إيصالات هذا
 * الدور بمفردات الأحكام القائمة (`verdictFailed`/`toolReceiptFailed`) لا
 * بمفرداتٍ ثانية. سطرٌ يدّعي أثراً بلا إيصالٍ يسنده **يُسقَط** — لا يُخزَّن
 * كأنه مقيس. هذا هو الرفضُ نفسه الذي يرفض به المنتجُ نموذجاً يدّعي أثراً
 * لم يفعله. والدليلُ **مربوطٌ بالأثر**: إيصالٌ من صنف القراءة لا يشهد
 * لكتابةٍ ولا لبناء، وأمرٌ سمّاه السطرُ وفشل يُكذّبه ولو نجح إيصالٌ شقيق،
 * ورمزٌ عارٍ (`test`، `run`) لا يسند شيئاً. والحالةُ تُخزَّن مع السطر:
 * الملاحظةُ لا تُعرض أبداً تحت عنوان المقيس. والنصّ يمرّ بحاجب الأسرار
 * **مُحقناً** قبل أن يستقرّ، كما يمرّ به سطرُ النيّة بالضبط.
 *
 * ثلاثة قيود مقصودة:
 * - **الكتلة ذيليّةٌ ذاتُ نحوٍ مغلق**: سطرُ رأسٍ وحده على سطره، ثم أسطرٌ
 *   موسومةٌ بأربعة عناوين لا غير. أيُّ انحرافٍ = ليست كتلة، والنصّ يبقى
 *   بايتاً (فحمولةُ `write` لا تُشقّ إلا إذا كانت هي نفسها خلاصةً تامّة
 *   النحو — وعندها يرفض المضيف الجمعَ بين استدعاءٍ وخلاصة أصلاً).
 * - **الغياب ليس فشلاً**: ردٌّ بلا كتلة يعود كما هو؛ نموذجٌ صغير لم يلتزم
 *   بالصيغة لا يعطّل تقدّماً.
 * - **مسقوفةٌ عند كل خطوة**: سطرٌ، وقسمٌ، وخلاصةٌ مخزَّنة، ونصٌّ محقون.
 */
import { sanitizeIntent, stripMeasure } from "./intent-line"
// مفردتا الفشل من الوحدة الورقة `tool-verdict` وحدها — لا دورةَ استيراد مع
// الحلقة (القاعدة المكتوبة هناك)، ولا تعبيرَ فشلٍ ثانٍ يفترق عنها بصمت.
import { toolReceiptFailed, verdictFailed, type ToolReceipt } from "./tool-verdict"

/** سطر رأس الكتلة — بنحو الشرطة نفسه الذي تستعمله أسطر «— النية». */
export const SUMMARY_HEAD = "— خلاصة الحقبة:"

export const SUMMARY_SECTIONS = Object.freeze(["done", "understood", "decided", "blocked"] as const)
export type SummarySection = (typeof SUMMARY_SECTIONS)[number]

/** العنوان العربيّ لكل قسم — هو ما يكتبه النموذج وما يُعرض في الحقن. */
export const SUMMARY_LABELS: Readonly<Record<SummarySection, string>> = Object.freeze({
  done: "فُعل",
  understood: "فُهم",
  decided: "قُرّر",
  blocked: "المانع",
})

/** ≤ 25 سطراً بنصّ البرنامج — سقفُ الكتلة الواردة وسقفُ المخزَّن معاً. */
export const SUMMARY_MAX_LINES = 25
/** سقف القسم الواحد في الخلاصة المخزَّنة. */
export const SUMMARY_SECTION_CAP = 8
/** سقف نصّ الخلاصة المحقونة في كل حقبة (محارف). */
export const SUMMARY_MAX_CHARS = 1200
/** سقف عدد الحقب المسجَّلة في الخلاصة — كـEPOCH_CAP في جرد الإضافات. */
export const SUMMARY_EPOCH_CAP = 64

/**
 * الجملة التي تُوجَّه للنموذج حين يكون المفتاح مفعَّلاً. تُلحق بتعليمة كل
 * حقبة (لا بالأولى وحدها)، وهي **قصيرة عمداً**: كل محرفٍ فيها يُدفع ثمنه
 * في كل حقبة. تشترط الكتلة على الردّ الخاتم بلا استدعاء — لأن الجمع بين
 * استدعاءٍ وخلاصةٍ مرفوضٌ فيضيّع دوراً.
 */
export const SUMMARY_INSTRUCTION =
  `في ردّك الخاتم لهذه الحقبة (الذي لا يحمل «نفّذ:») ألحق في آخره:\n${SUMMARY_HEAD}\n` +
  `${SUMMARY_LABELS.done}: ما فعلتَه فعلاً بإيصال (سمِّ الملف أو الأمر)\n` +
  `${SUMMARY_LABELS.understood}: ما فهمتَه عن المشروع\n` +
  `${SUMMARY_LABELS.decided}: ما قرّرتَه\n` +
  `${SUMMARY_LABELS.blocked}: ما يمنع التقدّم\n` +
  `سطرٌ واحد لكل عنوان، وما لا إيصال له يُسقَط.\n`

export interface SummaryDraft {
  readonly done: readonly string[]
  readonly understood: readonly string[]
  readonly decided: readonly string[]
  readonly blocked: readonly string[]
}

const EMPTY_DRAFT: SummaryDraft = Object.freeze({
  done: Object.freeze([]),
  understood: Object.freeze([]),
  decided: Object.freeze([]),
  blocked: Object.freeze([]),
})

/**
 * تشكيلُ العربية زينةُ رسمٍ لا حدُّ معنى — يُطوى قبل مطابقة العنوان، فيقبل
 * «فعل» و«فُعل» سواء. يُكتب بالرموز العددية لا بمحارف حرفية.
 */
const foldDiacritics = (text: string): string => text.replace(/[\u064B-\u0652\u0670]/gu, "")

const LABEL_OF = new Map<string, SummarySection>(
  SUMMARY_SECTIONS.map((section) => [foldDiacritics(SUMMARY_LABELS[section]), section]),
)

const LABEL_LINE = /^\s*([\u0600-\u06FF]{2,12})\s*:\s*(.*)$/u

export interface SummarySplit {
  /** غائبة حين لا كتلة تامّة النحو في الذيل. */
  readonly summary?: SummaryDraft
  /** النصّ بعد رفع الكتلة — هو وحده ما يُسلَّم إلى `parseCommand`. */
  readonly body: string
}

/**
 * يرفع كتلةً ذيليّةً تامّة النحو، ويعيد الباقي. النحو مغلق: آخر سطرٍ نصّه
 * **هو** الرأسُ وحده، ثم لا شيء بعده غير أسطرٍ فارغة أو أسطرٍ عنوانُها
 * أحدُ الأربعة. سطرٌ واحدٌ خارجُ ذلك ⇒ ليست كتلة، والنصّ يعود بايتاً كما
 * هو (بعد تصفية المقيس وحدها، كـ`splitIntent`).
 *
 * لا تعرف هذه الدالّة شيئاً عن الاستدعاءات: المضيف هو من يرفض الجمعَ بين
 * استدعاءٍ وخلاصة، فلا يتكرّر هنا كاشفُ «نفّذ:» تعبيراً ثانياً يفترق عن
 * `parseCommand` بصمت.
 */
export const splitSummary = (text: string): SummarySplit => {
  const stripped = stripMeasure(text)
  const lines = stripped.split("\n")
  let head = -1
  for (let i = 0; i < lines.length; i += 1) if ((lines[i] ?? "").trim() === SUMMARY_HEAD) head = i
  if (head < 0) return Object.freeze({ body: stripped })
  const buckets: Record<SummarySection, string[]> = { done: [], understood: [], decided: [], blocked: [] }
  let labelled = 0
  for (const raw of lines.slice(head + 1)) {
    if (raw.trim().length === 0) continue
    const match = LABEL_LINE.exec(raw)
    const section = match === null ? undefined : LABEL_OF.get(foldDiacritics(match[1] ?? ""))
    // انحرافٌ واحد يكفي: الذيل ليس خلاصةً، فلا يُمسّ النصّ.
    if (section === undefined) return Object.freeze({ body: stripped })
    labelled += 1
    if (labelled > SUMMARY_MAX_LINES) continue
    const value = sanitizeIntent(match?.[2] ?? "")
    if (value !== undefined) buckets[section].push(value)
  }
  if (labelled === 0) return Object.freeze({ body: stripped })
  return Object.freeze({
    summary: Object.freeze({
      done: Object.freeze(buckets.done),
      understood: Object.freeze(buckets.understood),
      decided: Object.freeze(buckets.decided),
      blocked: Object.freeze(buckets.blocked),
    }),
    body: lines.slice(0, head).join("\n").trim(),
  })
}

// ---------------------------------------------------------------------------
// المراجعة ضد الإيصالات — الادّعاء لا يصير حقيقةً بكتابته
// ---------------------------------------------------------------------------

/** مفرداتُ النجاح القائمة: الحكم الصريح إن وُجد، وإلا نصّ الإيصال. لا ثالث. */
const receiptSucceeded = (receipt: ToolReceipt): boolean =>
  receipt.verdict !== undefined ? !verdictFailed(receipt.verdict) : !toolReceiptFailed(receipt.command, receipt.output)

/**
 * **صنفُ الأثر** — الإيصالُ يشهد لصنفه وحده.
 *
 * الدرسُ المدفوع: مطابقةُ رمزٍ عارٍ بنصّ الأمر تجعل `read a.ts` الناجحة تشهد
 * لادّعاء «كتبتُ a.ts وبنيتُ ونشرت». الصلةُ إذن بين **الأثر المدّعى** وصنفِ
 * الإيصال، لا بين حرفين تصادفا. صنفُ التنفيذ (`write|edit|patch|run`) هو
 * مفردةُ `advancesWorkspace` نفسها في الحلقة — لا تعبيرَ ثانياً يفترق بصمت.
 */
export type ActClass = "write" | "run" | "read"

const CLASS_OF_COMMAND: readonly (readonly [ActClass, RegExp])[] = Object.freeze([
  Object.freeze(["write", /^(?:write|edit|patch)\b/u] as const),
  Object.freeze(["run", /^run\b/u] as const),
  Object.freeze(["read", /^(?:read|list|glob|grep)\b/u] as const),
])

/**
 * أفعالُ كلِّ صنف — **بلا تشكيل** (النصّ يُطوى قبل المطابقة) و**بحدٍّ عربيّ**.
 *
 * `\b` لا تطابق العربية، فالحدُّ يُبنى بـ`\p{L}`: جذرٌ عارٍ داخل كلمةٍ أخرى
 * يقرأ «البنية» بناءً و«كتابتها» كتابةً، فيُسقِط قراراً بريئاً بحجّة أنه
 * ادّعاءُ أثرٍ بلا إيصال. تُقبل واو العطف وفاؤه بادئةً، ولواحقُ الضمير
 * والتاء لاحقةً — وما لا يُعرف فعلُه يسقط إلى الشرط الأعمّ (تنفيذٌ في `فُعل`،
 * وأيُّ صنفٍ في غيره) لا إلى القبول.
 */
const verbPattern = (roots: readonly string[]): RegExp =>
  new RegExp(`(?<!\\p{L})[وف]?(?:${roots.join("|")})(?:تها|ته|تهما|تما|نا|ت|ها|هما|وا)?(?!\\p{L})`, "u")

const CLASS_OF_VERB: readonly (readonly [ActClass, RegExp])[] = Object.freeze([
  Object.freeze([
    "write",
    verbPattern(["كتب", "أنشأ", "انشأ", "انشا", "عدل", "صحح", "أصلح", "اصلح", "حذف", "أضاف", "اضاف", "أضف", "اضف", "حرر"]),
  ] as const),
  Object.freeze([
    "run",
    verbPattern([
      "بني", "بنى", "شغل", "نفذ", "ثبت", "اختبر", "نشر", "سلم", "نجح", "فشل", "أنجز", "انجز", "أتم", "اتم", "رفع", "جرب",
    ]),
  ] as const),
  Object.freeze(["read", verbPattern(["قرأ", "قرا", "اطلع", "فحص", "بحث", "استعرض", "عاين"])] as const),
])

/** مسارٌ بشرطة مائلة، أو ملفٌّ بامتداد — أقوى دليلٍ يمكن مطابقته بالإيصال. */
const PATH_TOKEN = /[A-Za-z0-9_.@-]+(?:[/\\][A-Za-z0-9_.@-]+)+|\b[A-Za-z0-9_.@-]+\.[A-Za-z]{1,8}\b/gu
/** أسماءُ الأدوات — اسمُ فاعلٍ حقيقيّ يظهر في الإيصال، فيصلح سنداً. */
const TOOL_TOKEN = /\b(?:npm|pnpm|yarn|bun|npx|git|cargo|tsc|deno|make|docker|python|node)\b/giu
/**
 * كلماتُ الأمر العارية — **لا تسند شيئاً وحدها أبداً**. «test» تطابق داخل
 * `latest.json`، و«run» تطابق أيّ أمرٍ منفَّذ، فيشهد إيصالٌ لما لم يفعله.
 * تُجمع للتناقض وحده (أمرٌ سمّاه السطرُ وفشل)، لا للسند.
 */
const BARE_COMMAND_TOKEN = /\b(?:run|write|edit|patch|build|test|audit|typecheck|install|lint|serve|check|format)\b/giu

const collect = (text: string, pattern: RegExp): string[] => {
  const out: string[] = []
  for (const match of text.matchAll(pattern)) out.push(match[0].toLowerCase())
  return out
}

/** الرموزُ التي تصلح سنداً: مسارٌ أو اسمُ أداة. */
const strongTokensOf = (text: string): string[] => [
  ...new Set([...collect(text, PATH_TOKEN), ...collect(text, TOOL_TOKEN)]),
]
/** الرموزُ التي لا تصلح سنداً وتصلح تكذيباً. */
const weakTokensOf = (text: string): string[] => [...new Set(collect(text, BARE_COMMAND_TOKEN))]

interface ReceiptFacts {
  readonly act?: ActClass
  readonly tokens: ReadonlySet<string>
  readonly ok: boolean
}

/**
 * رموزُ الإيصال تُستخرج من **سطر الأمر الأول** وحده وتُخزَّن مجموعةً لكلِّ
 * إيصالٍ على حدة — لا نصّاً مضفوراً: الضفرُ يجعل رمزاً من إيصالٍ يكمّل رمزاً
 * من آخر، والاحتواءُ النصّيّ يجعل `test` تطابق داخل `latest.json`.
 */
const factsOf = (receipt: ToolReceipt): ReceiptFacts => {
  const head = receipt.command.split("\n", 1)[0] ?? ""
  const normalised = head.trimStart().toLowerCase()
  const act = CLASS_OF_COMMAND.find(([, pattern]) => pattern.test(normalised))?.[0]
  return Object.freeze({
    ...(act === undefined ? {} : { act }),
    tokens: new Set<string>([...strongTokensOf(head), ...weakTokensOf(head)]),
    ok: receiptSucceeded(receipt),
  })
}

export type ClaimStatus =
  /** ادّعاءُ أثرٍ وجد إيصالاً **من صنفه** يسنده. */
  | "measured"
  /** ليس ادّعاءَ أثر (فهمٌ أو قرار) — يُحفظ ملاحظةً لا قياساً. */
  | "note"

export interface SummaryClaim {
  readonly section: SummarySection
  readonly text: string
  readonly status: ClaimStatus
}

export interface DroppedClaim {
  readonly section: SummarySection
  readonly text: string
  /**
   * `no-receipt`: ادّعى أثراً ولا إيصالَ من صنفه يسنده.
   * `contradicted`: سمّى أمراً **فشل** في هذه الحقبة — إيصالٌ شقيقٌ نجح لا ينقذه.
   */
  readonly why: "no-receipt" | "contradicted"
}

export interface SummaryVerdict {
  readonly claims: readonly SummaryClaim[]
  readonly dropped: readonly DroppedClaim[]
}

/**
 * يراجع المسوَّدة ضد إيصالات هذا الدور. الدليلُ مربوطٌ بالأثر المدّعى، لا
 * بأيّ رمزٍ تصادف وجودُه في أيّ أمر:
 *
 * - **التناقض قبل السند**: سطرٌ سمّى أمراً فشل في هذه الحقبة يُسقَط
 *   `contradicted` — ولو نجح إيصالٌ شقيقٌ يشاركه رمزاً. (`المانع` مستثنى:
 *   الفشلُ نفسه شهادتُه.)
 * - **الصنف يجب أن يطابق**: قراءةٌ ناجحة لا تشهد لكتابةٍ ولا لبناءٍ ولا
 *   لاختبار. سطرٌ يدّعي صنفين يلزمه إيصالٌ ناجحٌ من كلٍّ منهما.
 * - **كلُّ رمزٍ قويّ مطالَبٌ بشاهد**: لا يكفي أن يُسند أحدُها؛ وإلا كافأنا
 *   الغموضَ المعلَّق بمسارٍ مذكور.
 * - **الرموزُ العارية لا تسند**: سطرٌ بلا مسارٍ ولا اسمِ أداةٍ يُسقَط.
 * - `فُعل` يدّعي أثراً بتعريف القسم، فيلزمه إيصالُ تنفيذٍ ولو خلا من فعل.
 * - سطرٌ في بقيّة الأقسام لا يدّعي أثراً يُحفظ **ملاحظةً** لا قياساً.
 */
export const verifySummary = (draft: SummaryDraft, receipts: readonly ToolReceipt[]): SummaryVerdict => {
  const facts = receipts.map(factsOf)
  const succeeded = facts.filter((fact) => fact.ok)
  const failed = facts.filter((fact) => !fact.ok)
  const claims: SummaryClaim[] = []
  const dropped: DroppedClaim[] = []
  for (const section of SUMMARY_SECTIONS) {
    for (const text of draft[section]) {
      const folded = foldDiacritics(text)
      const strong = strongTokensOf(text)
      const weak = weakTokensOf(text)
      const acts = [...new Set(CLASS_OF_VERB.filter(([, pattern]) => pattern.test(folded)).map(([act]) => act))]
      const asserts = section === "done" || acts.length > 0 || strong.length > 0 || weak.length > 0
      if (!asserts) {
        claims.push(Object.freeze({ section, text, status: "note" as const }))
        continue
      }
      const named = [...strong, ...weak]
      if (section !== "blocked" && failed.some((fact) => named.some((token) => fact.tokens.has(token)))) {
        dropped.push(Object.freeze({ section, text, why: "contradicted" as const }))
        continue
      }
      // `المانع` يشهد له كلُّ إيصال وبأيّ صنف؛ وما عداه يشهد له الناجحُ من صنفه.
      const pool = section === "blocked" ? facts : succeeded
      const required: readonly (readonly ActClass[])[] =
        acts.length > 0
          ? acts.map((act) => Object.freeze([act]))
          : section === "done"
            ? [Object.freeze(["write", "run"] as const)]
            : [Object.freeze(["write", "run", "read"] as const)]
      const witnesses = (allowed: readonly ActClass[], token: string): boolean =>
        pool.some((fact) =>
          (section === "blocked" || (fact.act !== undefined && allowed.includes(fact.act))) && fact.tokens.has(token))
      const supported =
        strong.length > 0 && required.every((allowed) => strong.every((token) => witnesses(allowed, token)))
      if (supported) claims.push(Object.freeze({ section, text, status: "measured" as const }))
      else dropped.push(Object.freeze({ section, text, why: "no-receipt" as const }))
    }
  }
  return Object.freeze({ claims: Object.freeze(claims), dropped: Object.freeze(dropped) })
}

// ---------------------------------------------------------------------------
// الدمج في الخلاصة المخزَّنة `session:<id>:summary`
// ---------------------------------------------------------------------------

/**
 * سطرٌ مخزَّن **بحالته**. الحالة لا تموت عند حدّ التخزين: سطرُ ملاحظةٍ
 * وسطرٌ مقيسٌ لا يجوز أن يصيرا متطابقين بايتاً ثم يُعرضا معاً تحت عنوانٍ
 * يقول «مراجَعة ضد الإيصالات» — ذلك بعينه تقديمُ ادّعاءِ النموذج له حقيقةً.
 */
export interface SummaryLine {
  readonly text: string
  readonly status: ClaimStatus
}

export interface SessionSummary {
  readonly sections: Readonly<Record<SummarySection, readonly SummaryLine[]>>
  /** أرقام الحقب التي أسهمت — مرتَّبة، بلا تكرار، مسقوفة. */
  readonly epochs: readonly number[]
}

export const EMPTY_SESSION_SUMMARY: SessionSummary = Object.freeze({
  sections: Object.freeze({
    done: Object.freeze([]),
    understood: Object.freeze([]),
    decided: Object.freeze([]),
    blocked: Object.freeze([]),
  }),
  epochs: Object.freeze([]),
})

/**
 * حاجبُ الأسرار — يُحقن ولا يُستورَد: `secret-command-guard` يسكن حزمة
 * المحرّك، وهذه الحزمة تحتها فلا تستوردها (دورةُ استيراد). المضيف يمرّر
 * التركيبَ نفسه الذي يمرّره لسطر النيّة — مفردةٌ واحدة لا ثانية لها.
 */
export type SummaryRedactor = (text: string) => string

const dedupeKey = (text: string): string => foldDiacritics(text).replace(/\s+/gu, " ").trim().toLowerCase()

const renderedLength = (sections: Readonly<Record<SummarySection, readonly SummaryLine[]>>): number =>
  SUMMARY_SECTIONS.reduce((sum, section) => sum + sections[section].reduce((n, line) => n + line.text.length + 2, 0), 0)

/**
 * يدمج حكمَ حقبةٍ في الخلاصة المخزَّنة. **متساوي القوى**: دمجُ الحكم نفسه
 * بالحقبة نفسها مرّتين يعطي الشيء نفسه بايتاً — فإعادةُ تشغيلٍ أو نداءٌ
 * مكرّر لا ينفخ الخلاصة.
 *
 * الأسطر المُسقَطة لا تدخل أبداً. القصّ عند العبور من **الأقدم**: الأحدث
 * يبقى، كقاعدة الضغط في بقيّة المنتج.
 *
 * **الحجبُ يسبق المفتاح**: نصُّ النموذج يمرّ بالحاجب أولاً، ثم يُحسب مفتاح
 * التكرار على النصّ المحجوب — وهو نفسه ما يُخزَّن ويُحقن ويُكتب. حجبٌ بعد
 * المفتاح يجعل كلَّ سطرٍ يُحجب مختلفاً عن مخزَّنه أبداً فيتكرّر كل حقبة.
 */
export const mergeSessionSummary = (
  previous: SessionSummary | undefined,
  verdict: SummaryVerdict,
  epoch: number,
  redact: SummaryRedactor,
): SessionSummary => {
  const sections: Record<SummarySection, SummaryLine[]> = {
    done: [...(previous?.sections.done ?? [])],
    understood: [...(previous?.sections.understood ?? [])],
    decided: [...(previous?.sections.decided ?? [])],
    blocked: [...(previous?.sections.blocked ?? [])],
  }
  const seen = new Map<SummarySection, Set<string>>(
    SUMMARY_SECTIONS.map((section) => [section, new Set(sections[section].map((line) => dedupeKey(line.text)))]),
  )
  for (const claim of verdict.claims) {
    const keys = seen.get(claim.section)!
    const text = sanitizeIntent(redact(claim.text))
    if (text === undefined) continue
    const key = dedupeKey(text)
    if (key.length === 0 || keys.has(key)) continue
    keys.add(key)
    sections[claim.section].push(Object.freeze({ text, status: claim.status }))
  }
  for (const section of SUMMARY_SECTIONS) {
    while (sections[section].length > SUMMARY_SECTION_CAP) sections[section].shift()
  }
  const totalLines = () => SUMMARY_SECTIONS.reduce((n, section) => n + sections[section].length, 0)
  const largest = (): SummarySection =>
    SUMMARY_SECTIONS.reduce((a, b) => (sections[b].length > sections[a].length ? b : a))
  while (totalLines() > SUMMARY_MAX_LINES) sections[largest()].shift()
  while (renderedLength(sections) > SUMMARY_MAX_CHARS && totalLines() > 0) sections[largest()].shift()
  const epochs = [...new Set([...(previous?.epochs ?? []), epoch])].sort((a, b) => a - b).slice(-SUMMARY_EPOCH_CAP)
  return Object.freeze({
    sections: Object.freeze({
      done: Object.freeze(sections.done),
      understood: Object.freeze(sections.understood),
      decided: Object.freeze(sections.decided),
      blocked: Object.freeze(sections.blocked),
    }),
    epochs: Object.freeze(epochs),
  })
}

/**
 * يقرأ خلاصةً مخزَّنة من قيمةٍ مجهولة الشكل (الذاكرة الدائمة تخزّن `unknown`).
 * فشلٌ مُغلق: أيُّ انحرافٍ في الشكل يعود `undefined` — لا خلاصةً نصفَ مبنيّة.
 * والحالةُ جزءٌ من الشكل: سطرٌ بلا حالةٍ معروفة يُرفض، فلا يعود مخزَّنٌ قديم
 * (أو مصنوع) بأسطرٍ عاريةٍ تُعرض بعدُ كأنها مقيسة.
 */
export const parseStoredSummary = (value: unknown): SessionSummary | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const rawSections = record.sections
  if (typeof rawSections !== "object" || rawSections === null || Array.isArray(rawSections)) return undefined
  const bySection = rawSections as Record<string, unknown>
  const sections: Record<SummarySection, SummaryLine[]> = { done: [], understood: [], decided: [], blocked: [] }
  for (const section of SUMMARY_SECTIONS) {
    const lines = bySection[section]
    if (lines === undefined) continue
    if (!Array.isArray(lines)) return undefined
    for (const line of lines) {
      if (typeof line !== "object" || line === null || Array.isArray(line)) return undefined
      const entry = line as Record<string, unknown>
      if (typeof entry.text !== "string") return undefined
      if (entry.status !== "measured" && entry.status !== "note") return undefined
      const clean = sanitizeIntent(entry.text)
      if (clean !== undefined) sections[section].push(Object.freeze({ text: clean, status: entry.status }))
    }
  }
  const rawEpochs = record.epochs
  if (rawEpochs !== undefined && !Array.isArray(rawEpochs)) return undefined
  const epochs = (rawEpochs ?? []).filter((n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0)
  return Object.freeze({
    sections: Object.freeze({
      done: Object.freeze(sections.done),
      understood: Object.freeze(sections.understood),
      decided: Object.freeze(sections.decided),
      blocked: Object.freeze(sections.blocked),
    }),
    epochs: Object.freeze([...new Set(epochs)].sort((a, b) => a - b).slice(-SUMMARY_EPOCH_CAP)),
  })
}

/** عنوانُ المقيس — ما تحته مراجَعٌ ضد إيصالٍ من صنفه. */
export const SUMMARY_MEASURED_HEADING = "خلاصة هذه الجلسة (مراجَعة ضد الإيصالات — لا تعِد ما فيها):"
/** عنوانُ الملاحظة — ما تحته قولُ النموذج وحده، لم يُقَس ولا يُعامَل قياساً. */
export const SUMMARY_NOTE_HEADING = "ملاحظة النموذج (غير مقيسة — قولُه لا قياس):"

const groupBySection = (summary: SessionSummary, status: ClaimStatus): string[] => {
  const parts: string[] = []
  for (const section of SUMMARY_SECTIONS) {
    const lines = summary.sections[section].filter((line) => line.status === status)
    if (lines.length === 0) continue
    parts.push(`${SUMMARY_LABELS[section]}: ${lines.map((line) => line.text).join("؛ ")}`)
  }
  return parts
}

/**
 * نصّ الحقن — يدخل تعليمة **كل** حقبة. مُلخَّصٌ ومسقوف، ولا يُعاد نصُّ
 * الردّ الأصليّ بحرفه أبداً.
 *
 * عنوانان لا واحد: ما رُوجع بإيصال، وما قاله النموذج ولم يُقَس. جمعُهما تحت
 * عنوانٍ يقول «مراجَعة ضد الإيصالات» يعيد إلى النموذج ادّعاءَه موسوماً بأنه
 * قياس — وهو الكذبُ الذي وُضع هذا السبرنت كلُّه ليمنعه.
 */
export const renderSessionSummary = (summary: SessionSummary, maxChars = SUMMARY_MAX_CHARS): string => {
  const measured = groupBySection(summary, "measured")
  const notes = groupBySection(summary, "note")
  if (measured.length === 0 && notes.length === 0) return ""
  const blocks: string[] = []
  if (measured.length > 0) blocks.push(`${SUMMARY_MEASURED_HEADING}\n${measured.join("\n")}`)
  if (notes.length > 0) blocks.push(`${SUMMARY_NOTE_HEADING}\n${notes.join("\n")}`)
  let text = `${blocks.join("\n")}\n`
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}…\n`
  return text
}

/** سطرُ المشغّل بعد كل حقبة — للأحداث وحدها، لا يراه النموذج. */
export const summaryEventLine = (epoch: number, verdict: SummaryVerdict): string => {
  const measured = verdict.claims.filter((claim) => claim.status === "measured").length
  const notes = verdict.claims.length - measured
  return `🧠 خلاصة الحقبة ${epoch}: مقيس=${measured} · ملاحظات=${notes} · أُسقط بلا إيصال=${verdict.dropped.length}`
}

export { EMPTY_DRAFT as EMPTY_SUMMARY_DRAFT }
