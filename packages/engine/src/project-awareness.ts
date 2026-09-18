/**
 * S13.2 — وعي المشروع (الخاص): `ABDO-AWARENESS.md` في جذر المشروع.
 *
 * فهرسٌ حيّ (حقائق مقيسة، قرارات المالك للمشروع، فخاخه، حالة السبرنتات)
 * يتراكم من خلاصات الجلسات ويُقرأ **أولاً** في كل دور — نظيرُ `_ACCUMULATED`
 * في مساحة المشرف، منقولاً إلى المنتج بمفتاحٍ وبوابةٍ وإيصال.
 *
 * الوحدة **خالصة**: لا `node:` ولا قرص. المضيف يقرأ النصّ ويمرّره، ويكتب
 * ما تعيده — فيبقى الاختبار على النحو والدمج والحجب بلا نظام ملفات.
 *
 * **هذا ملفٌّ في مستودع شخصٍ آخر**، فأربعة قيود غير قابلة للتفاوض:
 * - **دمجٌ لا دهس**: ما كتبه إنسانٌ يبقى بايتاً — الديباجة قبل أول عنوان،
 *   وكلُّ قسمٍ ليس من أقسامنا، وكلُّ سطرٍ قائمٍ داخل أقسامنا. الترتيب حتميّ
 *   فلا يتغيّر الملفّ لمجرّد إعادة الكتابة.
 * - **مسقوف**: سقفٌ للقسم وسقفٌ للملفّ، والقصّ من **أقسامنا** وحدها ومن
 *   أقدمها — لا يُقصّ سطرُ إنسانٍ ولا قسمٌ غريب أبداً.
 * - **محجوب**: يمرّ بمفردات `secret-command-guard` نفسها (حجبٌ ثم كنس)، ثم
 *   يُرفض ما بقي شبيهاً بسرّ. ملفٌّ في جذر المشروع هو بالضبط الموضع الذي
 *   يُودَع فيه اعتمادٌ مسرَّب.
 *   أبداً — يُنشأ فارغاً ويُحفظ ما يكتبه المالك فيه. قرارات النموذج لها
 *   قسمها المسمّى باسمها، فلا يُنسب إلى المالك ما لم يقله.
 */
import { redactSecretValues, residualSecretMatches, sweepResidualSecrets } from "./secret-command-guard"
import type { SessionSummary, SummaryLine } from "@abdo/engine-host"

export const AWARENESS_FILE = "ABDO-AWARENESS.md"
export const AWARENESS_TITLE = "# ABDO-AWARENESS"
/** سطرُ نسبٍ صادق: من كتب الملفّ وبأيّ مفتاح — يُعاد توليده كل مرة. */
export const AWARENESS_NOTE =
  "<!-- فهرس وعي المشروع — يتراكم من خلاصات جلسات عبدو المراجَعة ضد الإيصالات (plugins.projectAwareness). ما تكتبه بيدك يبقى. -->"

export type AwarenessKey = "facts" | "owner" | "decisions" | "traps" | "sprints"

/** الترتيب هنا هو ترتيب أقسام الملفّ — حتميّ، ولا يُعاد ترتيبه أبداً. */
export const AWARENESS_SECTIONS: readonly { readonly key: AwarenessKey; readonly heading: string; readonly automatic: boolean }[] =
  Object.freeze([
    Object.freeze({ key: "facts" as const, heading: "## حقائق مقيسة", automatic: true }),
    Object.freeze({ key: "owner" as const, heading: "## قرارات المالك لهذا المشروع", automatic: false }),
    Object.freeze({ key: "decisions" as const, heading: "## قرارات الجلسات", automatic: true }),
    Object.freeze({ key: "traps" as const, heading: "## فخاخ هذا المشروع", automatic: true }),
    Object.freeze({ key: "sprints" as const, heading: "## حالة السبرنتات", automatic: true }),
  ])

export const AWARENESS_KEYS: readonly AwarenessKey[] = Object.freeze(AWARENESS_SECTIONS.map((s) => s.key))

/**
 * الأقسامُ الآليّة وحدها هي ما نملك قصَّه. `owner` ليس منها: قسمٌ أُعلن
 * `automatic: false` يكتبه المالك بيده، فقصُّه بسقفٍ حذفٌ صامتٌ لقرار إنسان
 * — وهو الشيءُ الذي تقول ديباجةُ هذه الوحدة إنه لا يقع أبداً.
 */
export const AWARENESS_AUTOMATIC_KEYS: readonly AwarenessKey[] =
  Object.freeze(AWARENESS_SECTIONS.filter((s) => s.automatic).map((s) => s.key))

/** سقف الأسطر في القسم الواحد من أقسامنا الآليّة. */
export const AWARENESS_SECTION_CAP = 40
/** سقف محارف الملفّ الذي نتحكّم فيه — يُبلغ بقصّ أقسامنا الآليّة وحدها. */
export const AWARENESS_MAX_CHARS = 8000
/**
 * سقف قراءة الملفّ **للموجز وحده**. لا يُقرأ به ما سيُعاد كتابته: دمجُ
 * مقروءٍ مبتورٍ ثم كتابتُه فوق الملفّ كلِّه يمحو ذيلَ مستودع شخصٍ آخر محواً
 * لا رجعة فيه.
 */
export const AWARENESS_READ_CAP = 64 * 1024

/**
 * وسمُ ما لم يُقَس. سطرُ «ملاحظة» يعبر إلى ملفِّ المشروع موسوماً أو لا يعبر
 * — ولا يستقرّ عارياً تحت عنوانٍ يقول إن ما تحته مراجَعٌ ضد الإيصالات.
 */
export const AWARENESS_NOTE_MARK = "(غير مقيس) "

export interface AwarenessUpdate {
  readonly facts?: readonly string[]
  readonly decisions?: readonly string[]
  readonly traps?: readonly string[]
  readonly sprints?: readonly string[]
}

interface ForeignSection {
  readonly heading: string
  readonly lines: readonly string[]
}

export interface AwarenessDoc {
  /** ما قبل أول عنوان (بعد العنوان الرئيسي وسطر النسب) — بايتاً. */
  readonly preamble: readonly string[]
  readonly managed: Readonly<Record<AwarenessKey, readonly string[]>>
  /** أقسامٌ ليست منّا — تُحفظ بترتيبها الأصليّ بايتاً. */
  readonly foreign: readonly ForeignSection[]
}

const HEADING_OF = new Map<string, AwarenessKey>(AWARENESS_SECTIONS.map((s) => [s.heading, s.key]))

const emptyManaged = (): Record<AwarenessKey, string[]> => ({ facts: [], owner: [], decisions: [], traps: [], sprints: [] })

const entryKey = (line: string): string => line.replace(/^\s*[-*]\s*/u, "").replace(/\s+/gu, " ").trim().toLowerCase()

/**
 * يحلّل ملفّاً قائماً. فشلٌ آمن لا مُغلق هنا عمداً: نصٌّ لا يشبه ملفَّنا
 * يُقرأ ديباجةً وأقساماً غريبة — أي **يُحفظ كلّه**. أسوأ ما يقع أن نُلحق
 * أقسامنا بملفٍّ كتبه إنسان، لا أن نمحوه.
 */
export const parseAwareness = (text: string): AwarenessDoc => {
  const lines = typeof text === "string" ? text.replace(/\r\n?/gu, "\n").split("\n") : []
  const managed = emptyManaged()
  const foreign: { heading: string; lines: string[] }[] = []
  const preamble: string[] = []
  let cursor: { kind: "preamble" } | { kind: "managed"; key: AwarenessKey } | { kind: "foreign"; at: number } = { kind: "preamble" }
  let seenTitle = false
  for (const raw of lines) {
    const line = raw.replace(/\s+$/u, "")
    if (!seenTitle && line.trim() === AWARENESS_TITLE) { seenTitle = true; continue }
    if (line.trim() === AWARENESS_NOTE) continue
    if (/^##\s/u.test(line.trim())) {
      const heading = line.trim()
      const key = HEADING_OF.get(heading)
      if (key !== undefined) cursor = { kind: "managed", key }
      else { foreign.push({ heading, lines: [] }); cursor = { kind: "foreign", at: foreign.length - 1 } }
      continue
    }
    if (cursor.kind === "preamble") preamble.push(line)
    else if (cursor.kind === "managed") { if (line.trim().length > 0) managed[cursor.key].push(line) }
    else foreign[cursor.at].lines.push(line)
  }
  while (preamble.length > 0 && preamble[0].trim().length === 0) preamble.shift()
  while (preamble.length > 0 && preamble[preamble.length - 1].trim().length === 0) preamble.pop()
  return Object.freeze({
    preamble: Object.freeze(preamble),
    managed: Object.freeze(Object.fromEntries(AWARENESS_KEYS.map((k) => [k, Object.freeze(managed[k])])) as Record<AwarenessKey, readonly string[]>),
    foreign: Object.freeze(foreign.map((section) => Object.freeze({ heading: section.heading, lines: Object.freeze(section.lines) }))),
  })
}

const renderDoc = (doc: {
  preamble: readonly string[]
  managed: Readonly<Record<AwarenessKey, readonly string[]>>
  foreign: readonly ForeignSection[]
}): string => {
  const out: string[] = [AWARENESS_TITLE, AWARENESS_NOTE, ""]
  if (doc.preamble.length > 0) out.push(...doc.preamble, "")
  for (const section of AWARENESS_SECTIONS) {
    out.push(section.heading)
    const lines = doc.managed[section.key]
    if (lines.length === 0) out.push("- (لا شيء مقيس بعد)")
    else out.push(...lines)
    out.push("")
  }
  for (const section of doc.foreign) {
    out.push(section.heading)
    const body = [...section.lines]
    while (body.length > 0 && body[body.length - 1].trim().length === 0) body.pop()
    out.push(...body, "")
  }
  while (out.length > 0 && out[out.length - 1].trim().length === 0) out.pop()
  return `${out.join("\n")}\n`
}

/** السطرُ النائب ليس محتوىً: يسقط حالما يصل سطرٌ حقيقيّ. */
const PLACEHOLDER = "- (لا شيء مقيس بعد)"

export interface AwarenessMerge {
  readonly text: string
  /** false = الملفّ على القرص مطابقٌ بايتاً لما سنكتبه؛ فلا كتابة أصلاً. */
  readonly changed: boolean
  readonly redactions: number
}

export interface AwarenessRefusal {
  readonly refused: string
}

export type AwarenessResult = AwarenessMerge | AwarenessRefusal

export const awarenessRefused = (result: AwarenessResult): result is AwarenessRefusal => "refused" in result

/** بصمةُ الترتيب في الصدر — تُكتب بالرمز العدديّ لا بمحرفٍ غير مرئيّ. */
const BOM = "﻿"

/**
 * نهايةُ السطر السائدة في الملفّ القائم. ملفٌّ كتبه إنسانٌ على ويندوز يبقى
 * CRLF: قلبُه إلى LF إعادةُ كتابةٍ كاملةٌ لمستودعٍ ليس لنا، وضجيجُ فرقٍ في
 * كل سطرٍ بلا محتوىً أُضيف.
 */
const dominantEol = (text: string): "\r\n" | "\n" => {
  let crlf = 0
  let lf = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) !== 10) continue
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf += 1
    else lf += 1
  }
  return crlf > 0 && crlf >= lf ? "\r\n" : "\n"
}

/**
 * يدمج تحديثاً في ملفٍّ قائم ويعيد نصّه الكامل بعد الحجب.
 *
 * الترتيب: تحليلٌ ⇒ **حجبُ الوارد قبل مفتاح التكرار** ⇒ إلحاقٌ بلا تكرار ⇒
 * قصُّ أقسامنا الآليّة عند السقوف ⇒ رسمٌ حتميّ ⇒ حجبٌ دقيقٌ على الوثيقة ⇒
 * رفضُ ما نُدخله نحن ولا يزال يشبه سرّاً ⇒ إعادةُ نهايةِ السطر والبصمة.
 *
 * ثلاثة دروسٍ مدفوعة في هذا الترتيب:
 * - **الحجب قبل المفتاح**: مفتاحٌ محسوبٌ على نصٍّ قبل الحجب لا يطابق أبداً
 *   ما استقرّ في الملفّ بعده، فيتكرّر السطر نفسه كلَّ دور حتى يطرد السقفُ
 *   محتوىً حقيقياً.
 * - **الكنسُ العريض على أسطرنا وحدها**: `sweepResidualSecrets` يحجب أيَّ
 *   أربعين محرفاً من محارف المسارات، فيمحو نثرَ إنسانٍ لا سرَّ فيه. الوثيقة
 *   كلُّها تمرّ بالحجب **الدقيق** وحده (رابطُ اتصالٍ، ترويسةُ اعتماد، مفتاح
 *   `sk-`) — وهو مقيسٌ أنه لا يمسّ نصّاً بريئاً.
 * - **الرفضُ عمّا نُدخله**: بقيّةٌ كانت في الملفّ قبلنا ليست سرّاً أدخلناه،
 *   ورفضُ الكتابة بسببها يشلّ الوعيَ كلَّه على ملفٍّ بريء.
 */
export const mergeProjectAwareness = (existing: string, update: AwarenessUpdate): AwarenessResult => {
  const source = typeof existing === "string" ? existing : ""
  const hadBom = source.startsWith(BOM)
  const eol = dominantEol(source)
  const body = hadBom ? source.slice(BOM.length) : source
  const doc = parseAwareness(body)
  const managed: Record<AwarenessKey, string[]> = emptyManaged()
  for (const key of AWARENESS_KEYS) managed[key] = doc.managed[key].filter((line) => line.trim() !== PLACEHOLDER)
  const seen = new Map<AwarenessKey, Set<string>>(AWARENESS_KEYS.map((k) => [k, new Set(managed[k].map(entryKey))]))
  let redactions = 0
  const cleanAddition = (raw: string): string => {
    const precise = redactSecretValues(raw)
    redactions += precise.redactions
    if (residualSecretMatches(precise.text).length === 0) return precise.text
    const swept = sweepResidualSecrets(precise.text)
    redactions += swept.redactions
    return swept.text
  }
  const appendable: readonly (readonly [AwarenessKey, readonly string[] | undefined])[] = [
    ["facts", update.facts],
    ["decisions", update.decisions],
    ["traps", update.traps],
    ["sprints", update.sprints],
  ]
  for (const [key, additions] of appendable) {
    for (const addition of additions ?? []) {
      const text = cleanAddition(addition).replace(/[\r\n]+/gu, " ").replace(/\s+/gu, " ").trim()
      if (text.length === 0) continue
      const entry = `- ${text}`
      const dedupe = entryKey(entry)
      if (seen.get(key)!.has(dedupe)) continue
      seen.get(key)!.add(dedupe)
      managed[key].push(entry)
    }
  }
  for (const key of AWARENESS_AUTOMATIC_KEYS) while (managed[key].length > AWARENESS_SECTION_CAP) managed[key].shift()
  const frozen = (): Record<AwarenessKey, readonly string[]> => ({
    facts: managed.facts,
    owner: managed.owner,
    decisions: managed.decisions,
    traps: managed.traps,
    sprints: managed.sprints,
  })
  /** أكبرُ قسمٍ **آليّ** فيه ما يُقصّ، أو `undefined` حين لا يبقى إلا البشريّ. */
  const largest = (): AwarenessKey | undefined => {
    let pick: AwarenessKey | undefined
    for (const key of AWARENESS_AUTOMATIC_KEYS) {
      if (managed[key].length === 0) continue
      if (pick === undefined || managed[key].length > managed[pick].length) pick = key
    }
    return pick
  }
  let rendered = renderDoc({ preamble: doc.preamble, managed: frozen(), foreign: doc.foreign })
  // القصّ من أقسامنا الآليّة وحدها: ملفٌّ تجاوز السقف بمحتوىً بشريّ (ديباجةً
  // أو قسماً غريباً أو قرارَ مالك) يبقى كما هو — كسرُ سقفٍ أهونُ من محو سطرٍ
  // كتبه إنسان.
  for (let victim = largest(); rendered.length > AWARENESS_MAX_CHARS && victim !== undefined; victim = largest()) {
    managed[victim].shift()
    rendered = renderDoc({ preamble: doc.preamble, managed: frozen(), foreign: doc.foreign })
  }
  const guarded = redactSecretValues(rendered)
  redactions += guarded.redactions
  const introduced = residualSecretMatches(guarded.text).filter((match) => !body.includes(match))
  if (introduced.length > 0) {
    return Object.freeze({ refused: `بقي ما يشبه سرّاً بعد الحجب (${introduced.length}) — لم يُكتب ${AWARENESS_FILE}` })
  }
  const text = `${hadBom ? BOM : ""}${eol === "\n" ? guarded.text : guarded.text.split("\n").join(eol)}`
  return Object.freeze({ text, changed: text !== source, redactions })
}

/**
 * موجزُ الموضع الأول في كل دور — رخيصٌ ومسقوف. يُقرأ الملفّ **مرةً واحدة
 * لكل دور** لا مرةً لكل حقبة: محتوىً لم يتغيّر لا يُعاد إدخاله في السياق.
 */
export const projectAwarenessBrief = (text: string, maxChars = 900, includeSessionDerived = true): string => {
  if (typeof text !== "string" || text.trim().length === 0) return ""
  const doc = parseAwareness(text)
  const parts: string[] = []
  for (const section of AWARENESS_SECTIONS) {
    if (!includeSessionDerived && section.automatic) continue
    const lines = doc.managed[section.key].filter((line) => line.trim() !== PLACEHOLDER)
    if (lines.length === 0) continue
    parts.push(`${section.heading.replace(/^##\s*/u, "")}: ${lines.map((l) => l.replace(/^\s*[-*]\s*/u, "")).join("؛ ")}`)
  }
  if (parts.length === 0) return ""
  const provenance = includeSessionDerived ? "متراكمٌ من جلسات سابقة، اقرأه قبل أي فعل" : "قرارات المالك المكتوبة لهذا المشروع"
  let brief = `وعي هذا المشروع (${AWARENESS_FILE} — ${provenance}):\n${parts.join("\n")}\n`
  if (brief.length > maxChars) brief = `${brief.slice(0, maxChars)}…\n`
  return brief
}

/** «حقائق مقيسة» تعني ما قيس: سطرٌ غيرُ مقيسٍ لا يدخلها بحال. */
const measuredOnly = (lines: readonly SummaryLine[] = []): string[] =>
  lines.filter((line) => line.status === "measured").map((line) => line.text)

/** قرارٌ أو مانعٌ غيرُ مقيسٍ يعبر **موسوماً** — لا يُغسَل فيصير كالمقيس. */
const markedNotes = (lines: readonly SummaryLine[] = []): string[] =>
  lines.map((line) => (line.status === "measured" ? line.text : `${AWARENESS_NOTE_MARK}${line.text}`))

/**
 * يشتقّ تحديثَ الملفّ من خلاصة الجلسة المخزَّنة وسطرِ حالة الدور.
 *
 * `فُعل` ⇒ حقائق مقيسة، `قُرّر` ⇒ قرارات الجلسات، `المانع` ⇒ فخاخ.
 * `فُهم` **لا يعبر**: الملفّ فهرسُ مقيسٍ لا دفترُ انطباعات، وفهمُ النموذج
 * ليس قياساً. وقرارات المالك لا تُملأ من هنا أبداً.
 *
 * والحالةُ تعبر مع السطر: ما لم يُراجَع ضد إيصالٍ يدخل موسوماً بـ
 * `AWARENESS_NOTE_MARK`، وحقائقُ القياس لا تقبل غيرَ المقيس أصلاً. غسلُ
 * ملاحظةٍ فتستقرّ في مستودع إنسانٍ بلا وسمٍ هو تسريبُ ادّعاءٍ في ثوب قياس.
 */
export const awarenessUpdateFrom = (summary: SessionSummary | undefined, sprintLine?: string): AwarenessUpdate =>
  Object.freeze({
    facts: Object.freeze(measuredOnly(summary?.sections.done)),
    decisions: Object.freeze(markedNotes(summary?.sections.decided)),
    traps: Object.freeze(markedNotes(summary?.sections.blocked)),
    sprints: Object.freeze(sprintLine === undefined || sprintLine.trim().length === 0 ? [] : [sprintLine]),
  })
