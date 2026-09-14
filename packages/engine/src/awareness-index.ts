/**
 * S13.4 — الفهرس الرابط والاسترجاع بالبحث.
 *
 * الطبقات الأربع صارت موجودة (وعي الدور، خلاصة الجلسة، وعي المشروع، الوعي
 * العام)، وبقيت المسألة التي تجعلها نظاماً لا أكواماً: **أيّ طبقةٍ تجيب هذا
 * السؤال، وبأيّ نسب؟** فهنا شيئان:
 *
 * 1. **جدولٌ رابط**: مشروع ↔ جلسة ↔ حقائق ↔ خلاصات. ووصلةٌ لا تُدّعى إلا
 *    حين **يوجد طرفاها معاً** في المدخلات — جلسةٌ بلا خلاصةٍ محفوظة لا تنشأ
 *    لها وصلةُ «جلسة ← خلاصة»، مهما بدا معقولاً أن لها واحدة. فهرسٌ يدّعي
 *    وصلةً غير موجودة أسوأ من فهرسٍ ناقص: الناقص يُقاس، والمدّعي يُصدَّق.
 *
 * 2. **استرجاعٌ بالبحث** بدل مقطعٍ ثابت بـ700 حرف: السؤال يُطوى ويُقطَّع
 *    كلماتٍ، وتُرتَّب المطابقات بنسبها، ويُقصّ الخرج بسقف. و**الغياب يُقال
 *    لا يُملأ**: صفرُ مطابقاتٍ يعني «لا شيء مقيس» حرفياً — لا جواباً مؤلَّفاً
 *    من لا شيء. كلُّ سطرٍ يخرج من هنا نصُّ مُدخلٍ بعينه، لا صياغةٌ عنه.
 *
 * الوحدة **خالصة**: لا قرص ولا ساعة ولا نموذج. البحث نصّيّ حتميّ: النتيجة
 * نفسها لنفس المدخل مهما تكرّر.
 */
import { AWARENESS_FILE, AWARENESS_SECTIONS, parseAwareness } from "./project-awareness"
import { foldText, GENERAL_CLASS_LABEL, type GeneralStore } from "./general-awareness"
import type { SessionSummary, SummarySection } from "@abdo/engine-host"
import { SUMMARY_LABELS, SUMMARY_SECTIONS } from "@abdo/engine-host"

/** ترتيبُ الطبقات هو ترتيبُ الأولويّة عند التساوي: المقيسُ الأقرب أولاً. */
export const AWARENESS_LAYERS = Object.freeze(["turn", "session", "project", "general"] as const)
export type AwarenessLayer = (typeof AWARENESS_LAYERS)[number]

export const LAYER_LABEL: Readonly<Record<AwarenessLayer, string>> = Object.freeze({
  turn: "حقائق المشروع (مقيسة من إيصالات)",
  session: "خلاصة الجلسة (مراجَعة ضد الإيصالات)",
  project: `وعي المشروع (${AWARENESS_FILE})`,
  general: "معرفة عامّة (ليست قياساً عن هذا المشروع)",
})

const LAYER_RANK: Readonly<Record<AwarenessLayer, number>> =
  Object.freeze(Object.fromEntries(AWARENESS_LAYERS.map((layer, index) => [layer, index])) as Record<AwarenessLayer, number>)

export interface AwarenessEntry {
  readonly layer: AwarenessLayer
  readonly key: string
  readonly text: string
  /**
   * غائبٌ في طبقة العامّ **بنيوياً**: الدرس العامّ لا مشروع له، وحملُه
   * معرّفَ مشروعٍ هو عينُ التسريب الذي يمنعه `general-awareness`.
   */
  readonly projectId?: string
  readonly sessionId?: string
  /** نسبٌ صادق يُعرض مع المطابقة — من أين جاء هذا السطر بالضبط. */
  readonly provenance: string
}

// ---------------------------------------------------------------------------
// بناء المُدخلات من الطبقات الأربع
// ---------------------------------------------------------------------------

export interface FactRow {
  readonly key: string
  readonly value: unknown
  readonly sessionId?: string
}

const flatten = (value: unknown): string =>
  (typeof value === "string" ? value : JSON.stringify(value ?? "")).replace(/\s+/gu, " ").trim()

/** خلاصةُ الجلسة تُخزَّن حقيقةً بمفتاح `session:<id>:summary` — لا تُعامَل حقيقةَ دور. */
export const SUMMARY_KEY = /^session:(.+):summary$/u

/** الطبقة الأولى: حقائق المشروع الدائمة (بلا خلاصات الجلسات). */
export const entriesFromFacts = (facts: readonly FactRow[], projectId: string): readonly AwarenessEntry[] =>
  Object.freeze((facts ?? [])
    .filter((fact) => typeof fact?.key === "string" && !SUMMARY_KEY.test(fact.key))
    .map((fact) => Object.freeze({
      layer: "turn" as const,
      key: fact.key,
      text: flatten(fact.value),
      projectId,
      ...(fact.sessionId === undefined ? {} : { sessionId: fact.sessionId }),
      provenance: `${LAYER_LABEL.turn} · ${fact.key}`,
    }))
    .filter((entry) => entry.text.length > 0))

/** الطبقة الثانية: خلاصة الجلسة، سطراً سطراً، بحالته (مقيس/ملاحظة). */
export const entriesFromSummary = (
  summary: SessionSummary | undefined,
  projectId: string,
  sessionId: string,
): readonly AwarenessEntry[] => {
  if (summary === undefined) return Object.freeze([])
  const out: AwarenessEntry[] = []
  for (const section of SUMMARY_SECTIONS as readonly SummarySection[]) {
    const lines = summary.sections?.[section] ?? []
    lines.forEach((line, index) => {
      const text = flatten(line?.text)
      if (text.length === 0) return
      const measured = line.status === "measured"
      out.push(Object.freeze({
        layer: "session" as const,
        key: `session:${sessionId}:${section}:${index + 1}`,
        text,
        projectId,
        sessionId,
        provenance: `${LAYER_LABEL.session} ${sessionId} · ${SUMMARY_LABELS[section]}${measured ? "" : " (غير مقيس)"}`,
      }))
    })
  }
  return Object.freeze(out)
}

/** الطبقة الثالثة: `ABDO-AWARENESS.md` كما هو على القرص، قسماً قسماً. */
export const entriesFromProjectAwareness = (text: string, projectId: string): readonly AwarenessEntry[] => {
  if (typeof text !== "string" || text.trim().length === 0) return Object.freeze([])
  const doc = parseAwareness(text)
  const out: AwarenessEntry[] = []
  for (const section of AWARENESS_SECTIONS) {
    doc.managed[section.key].forEach((line, index) => {
      const body = flatten(line.replace(/^\s*[-*]\s*/u, ""))
      if (body.length === 0 || body === "(لا شيء مقيس بعد)") return
      out.push(Object.freeze({
        layer: "project" as const,
        key: `${AWARENESS_FILE}:${section.key}:${index + 1}`,
        text: body,
        projectId,
        provenance: `${LAYER_LABEL.project} · ${section.heading.replace(/^##\s*/u, "")}`,
      }))
    })
  }
  return Object.freeze(out)
}

/**
 * الطبقة الرابعة: المخزن العامّ. **بلا `projectId`** — ولا يُلحق به واحد
 * هنا ولا في المُنادي: الدرس العامّ لا ينتسب إلى مشروع، وهذا هو الفرق بين
 * «معرفةٌ عامّة» و«قياسٌ عن مشروعك».
 */
export const entriesFromGeneral = (store: GeneralStore | undefined): readonly AwarenessEntry[] =>
  Object.freeze((store?.lessons ?? []).map((lesson) => Object.freeze({
    layer: "general" as const,
    key: `general:${lesson.cls}:${lesson.key.slice(0, 60)}`,
    text: lesson.text,
    provenance: `${LAYER_LABEL.general} · ${GENERAL_CLASS_LABEL[lesson.cls]} (رُقّي ${lesson.seen}×)`,
  })))

// ---------------------------------------------------------------------------
// الجدول الرابط — وصلةٌ لا تُدّعى إلا بطرفَيها
// ---------------------------------------------------------------------------

export const LINK_RELATIONS = Object.freeze([
  "project→session",
  "session→summary",
  "project→fact",
  "project→awareness",
  "install→general",
] as const)
export type LinkRelation = (typeof LINK_RELATIONS)[number]

export interface AwarenessLink {
  readonly relation: LinkRelation
  readonly from: string
  readonly to: string
}

export interface AwarenessIndex {
  readonly projectId: string
  readonly entries: readonly AwarenessEntry[]
  readonly nodes: readonly string[]
  readonly links: readonly AwarenessLink[]
  readonly counts: Readonly<Record<AwarenessLayer, number>>
  /** مُدخلاتٌ من مشروعٍ آخر أُسقطت عند البناء — القضيب العابر عند القراءة. */
  readonly foreignDropped: number
}

/**
 * يبني الفهرس لمشروعٍ واحد.
 *
 * قضيبان لا يُتفاوض عليهما:
 * - **إسقاطُ الغريب**: مُدخلٌ يحمل `projectId` غير مشروع السؤال يُسقَط ويُعدّ.
 *   طبقةُ العامّ وحدها بلا مشروع، فتمرّ — ونصّها مرَّ قبلاً بقاعدة الترقية.
 * - **الوصلةُ بطرفَيها**: كلّ وصلةٍ تُختبر على مجموعة العقد المبنيّة من
 *   المُدخلات الفعليّة، فلا تُدّعى وصلةٌ إلى عقدةٍ لا وجود لها.
 */
export const buildAwarenessIndex = (input: {
  readonly projectId: string
  readonly entries: readonly AwarenessEntry[]
}): AwarenessIndex => {
  const projectId = typeof input.projectId === "string" ? input.projectId : ""
  const kept: AwarenessEntry[] = []
  let foreignDropped = 0
  for (const entry of input.entries ?? []) {
    if (entry === undefined || entry === null) continue
    if (entry.projectId !== undefined && entry.projectId !== projectId) { foreignDropped += 1; continue }
    kept.push(entry)
  }
  const nodes = new Set<string>()
  const projectNode = `project:${projectId}`
  if (kept.some((entry) => entry.projectId === projectId)) nodes.add(projectNode)
  for (const entry of kept) {
    if (entry.sessionId !== undefined) nodes.add(`session:${entry.sessionId}`)
    if (entry.layer === "turn") nodes.add(`fact:${entry.key}`)
    if (entry.layer === "project") nodes.add(`awareness:${projectId}`)
    if (entry.layer === "general") nodes.add("general")
  }
  // عقدةُ الخلاصة توجد فقط حين وُجد سطرُ خلاصةٍ لتلك الجلسة بعينها.
  for (const entry of kept) {
    if (entry.layer === "session" && entry.sessionId !== undefined) nodes.add(`summary:${entry.sessionId}`)
  }
  const candidates: AwarenessLink[] = []
  for (const node of nodes) {
    if (node.startsWith("session:")) candidates.push({ relation: "project→session", from: projectNode, to: node })
  }
  for (const node of nodes) {
    if (node.startsWith("summary:")) candidates.push({ relation: "session→summary", from: `session:${node.slice("summary:".length)}`, to: node })
  }
  for (const node of nodes) {
    if (node.startsWith("fact:")) candidates.push({ relation: "project→fact", from: projectNode, to: node })
  }
  if (nodes.has(`awareness:${projectId}`)) candidates.push({ relation: "project→awareness", from: projectNode, to: `awareness:${projectId}` })
  if (nodes.has("general")) candidates.push({ relation: "install→general", from: "install", to: "general" })
  // الادّعاء يسقط هنا: طرفٌ غير موجودٍ في العقد = لا وصلة. («install» عقدةُ
  // دليل التثبيت نفسه — تُقبل طرفاً مصدرياً لأن المخزن العامّ يسكنه.)
  const links = candidates.filter((link) => (link.from === "install" || nodes.has(link.from)) && nodes.has(link.to))
  const order = (link: AwarenessLink) => LINK_RELATIONS.indexOf(link.relation)
  links.sort((a, b) => (order(a) !== order(b) ? order(a) - order(b) : a.to < b.to ? -1 : a.to > b.to ? 1 : 0))
  const counts = Object.fromEntries(AWARENESS_LAYERS.map((layer) => [layer, kept.filter((entry) => entry.layer === layer).length])) as Record<AwarenessLayer, number>
  return Object.freeze({
    projectId,
    entries: Object.freeze(kept),
    nodes: Object.freeze([...nodes].sort()),
    links: Object.freeze(links),
    counts: Object.freeze(counts),
    foreignDropped,
  })
}

// ---------------------------------------------------------------------------
// الاسترجاع — بحثٌ نصّيّ بدل المقطع الثابت
// ---------------------------------------------------------------------------

/** نصُّ الغياب حرفياً. لا يُصاغ في موضعين: مفردةٌ واحدة يقيس عليها الاختبار. */
export const RECALL_NOTHING = "لا شيء مقيس"

/**
 * نصُّ الطبقةِ التي **لم تُقرأ**. مفردةٌ ثالثةٌ لازمة: «لا شيء مقيس» جوابٌ
 * عن طبقةٍ قُرئت فلم يوجد فيها شيء، و«لم تُقرأ» اعترافٌ بأنّي لم أنظر. خلطُهما
 * يقلب «لم أستطع» إلى «لا يوجد» — وهو عينُ ما تمنعه قاعدةُ «الغياب رفضٌ لا إذن».
 */
export const RECALL_UNREAD = "طبقاتٌ لم تُقرأ"

export const RECALL_MAX_MATCHES = 6
export const RECALL_MAX_CHARS = 900
/** كلمةٌ أقصر من هذا لا تُبحث. */
const TERM_MIN = 2

/**
 * كلماتُ الوظيفة — مغلقةٌ، مطويّةٌ سلفاً بمفردة `foldText`.
 *
 * قيس (2026-09-03): بمخزنٍ سطرُه الوحيد «سرُّ العميل … يعيش في القاعدة»، ردَّ
 * السؤالُ «ما هو المنفذ في الخادم» ذلك السطرَ بنسبةٍ كاملة — لأن «في» وحدها
 * طابقت مطابقةً تامّة. فالطبقةُ التي وُضعت لتقول «لا شيء مقيس» صارت تجيب عن
 * غير المقيس بأقرب سطرٍ موجود، وهو أسوأ من الصمت: جوابٌ مؤلَّفٌ يلبس نسباً.
 *
 * والقاعدةُ التي تحرس هذا بعدها: **مطابقةٌ تامّة واحدة على الأقلّ** لكلمةٍ
 * ليست وظيفيّة قبل أن يقال «استرجاع» — ووزنُ البادئة يرتّب ولا ينشئ مطابقة.
 */
export const RECALL_STOPWORDS: ReadonlySet<string> = Object.freeze(new Set([
  "في", "من", "عن", "الي", "علي", "مع", "ما", "ماذا", "هل", "لا", "لم", "لن", "قد", "كم", "كيف",
  "ان", "انه", "او", "ثم", "كل", "بعض", "هذا", "هذه", "ذلك", "تلك", "التي", "الذي", "هو", "هي", "هم",
  "شيء", "شي", "بين", "عند", "بعد", "قبل", "حتي", "اذا", "كان", "يكون", "نحن", "انت", "انا",
  "the", "and", "for", "with", "that", "this", "was", "are", "you", "not", "but", "from", "its", "has", "have",
]))

const isStopword = (term: string): boolean => RECALL_STOPWORDS.has(term)

/**
 * السوابق المتّصلة. بلا نزعها يفوت السؤالُ جوابَه لأتفه سبب: «والقاعدة» في
 * السؤال و«القاعدة» في الحقيقة كلمتان مختلفتان عند أيّ مطابقةٍ حرفيّة —
 * والدرس مدفوعٌ من قبل (حدود الكلمة اللاتينيّة لا تعرف العربيّة أصلاً).
 * النزع مشروطٌ ببقاء ثلاثة أحرف: «ولد» لا يصير «د».
 */
const CLITIC = /^(?:وال|فال|بال|كال|لل|ال|و|ف|ب|ك|ل)/u
const CLITIC_MIN = 3

const stem = (word: string): string => {
  const hit = CLITIC.exec(word)
  if (hit === null) return word
  const rest = word.slice(hit[0].length)
  return rest.length >= CLITIC_MIN ? rest : word
}

/** كلماتُ نصٍّ مطويّةً، مع جذعِ كلٍّ منها — مفردةٌ واحدة للسؤال والمُدخل معاً. */
const wordForms = (text: string): Set<string> => {
  const forms = new Set<string>()
  for (const word of foldText(text).split(/[^\p{L}\p{N}]+/gu)) {
    if (word.length === 0) continue
    forms.add(word)
    forms.add(stem(word))
  }
  return forms
}

export const recallTerms = (question: string): readonly string[] => {
  const folded = foldText(question)
  const terms = folded
    .split(/[^\p{L}\p{N}]+/gu)
    .filter((term) => term.length >= TERM_MIN && !isStopword(term) && !isStopword(stem(term)))
  return Object.freeze([...new Set(terms)])
}

export interface RecallMatch {
  readonly layer: AwarenessLayer
  readonly key: string
  readonly text: string
  readonly score: number
  readonly terms: readonly string[]
  readonly provenance: string
}

export interface RecallAnswer {
  readonly question: string
  /** false = لا مطابقة؛ والنصّ يقول ذلك ولا يخترع جواباً. */
  readonly measured: boolean
  readonly matches: readonly RecallMatch[]
  readonly text: string
  readonly searched: number
  /** طبقاتٌ لم يُتَح فتحها — تُقال ولا تُحسب غياباً. */
  readonly unread: readonly string[]
}

const EXACT_WEIGHT = 3
const PREFIX_WEIGHT = 1
const PREFIX_MIN = 4
/** أقصرُ نصٍّ يبقى من مطابقةٍ مقصوصة ليظلّ مفهوماً. */
const MATCH_MIN_TEXT = 24

/**
 * يجيب سؤالاً من الطبقات المبنيّة. الترتيب: النتيجة نزولاً، ثمّ الطبقة
 * (المقيسُ الأقرب أولاً)، ثمّ المفتاح — حتميٌّ تماماً.
 *
 * **لا اختلاق**: كلّ `text` يعود هنا هو `entry.text` بعينه (لا اقتباسٌ ولا
 * إعادةُ صياغة)، والصفرُ يعود «لا شيء مقيس». الجوابُ المؤلَّف من لا شيء هو
 * بالضبط ما جاءت هذه الطبقة لتمنعه.
 */
export const recallSearch = (
  question: string,
  entries: readonly AwarenessEntry[],
  opts: { readonly maxMatches?: number; readonly maxChars?: number; readonly unread?: readonly string[] } = {},
): RecallAnswer => {
  const asked = (typeof question === "string" ? question : "").replace(/\s+/gu, " ").trim()
  const maxMatches = Number.isSafeInteger(opts.maxMatches) && opts.maxMatches! > 0 ? opts.maxMatches! : RECALL_MAX_MATCHES
  const maxChars = Number.isSafeInteger(opts.maxChars) && opts.maxChars! > 0 ? opts.maxChars! : RECALL_MAX_CHARS
  const unread = Object.freeze([...new Set((opts.unread ?? []).filter((why) => typeof why === "string" && why.length > 0))])
  const unreadLine = unread.length === 0 ? "" : `\n(${RECALL_UNREAD}: ${unread.join("، ")} — هذا «لم أستطع القراءة» لا «لا يوجد».)`
  const pool = (entries ?? []).filter((entry) => entry !== undefined && entry !== null && typeof entry.text === "string" && entry.text.length > 0)
  const terms = recallTerms(asked)
  const scored: RecallMatch[] = []
  if (terms.length > 0) {
    for (const entry of pool) {
      const words = wordForms(entry.text)
      const keyWords = wordForms(entry.key)
      const hit: string[] = []
      let score = 0
      let exact = 0
      for (const raw of terms) {
        const term = words.has(raw) || keyWords.has(raw) ? raw : stem(raw)
        if (words.has(term) || keyWords.has(term)) { score += EXACT_WEIGHT; exact += 1; hit.push(raw); continue }
        if (term.length < PREFIX_MIN) continue
        let prefixed = false
        for (const word of words) { if (word.startsWith(term) || term.startsWith(word) && word.length >= PREFIX_MIN) { prefixed = true; break } }
        if (!prefixed) for (const word of keyWords) { if (word.startsWith(term)) { prefixed = true; break } }
        if (prefixed) { score += PREFIX_WEIGHT; hit.push(raw) }
      }
      // البادئةُ ترتّب ولا تنشئ: مطابقةٌ مبنيّةٌ على وزن البادئة وحده صدفةُ
      // رسمٍ لا جواب، وقبولُها يعيد «أقرب سطرٍ موجود» بابَ الاختلاق نفسه.
      if (exact > 0) {
        scored.push(Object.freeze({ layer: entry.layer, key: entry.key, text: entry.text, score, terms: Object.freeze(hit), provenance: entry.provenance }))
      }
    }
  }
  scored.sort((a, b) =>
    b.score !== a.score
      ? b.score - a.score
      : LAYER_RANK[a.layer] !== LAYER_RANK[b.layer]
        ? LAYER_RANK[a.layer] - LAYER_RANK[b.layer]
        : a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  const ranked = scored.slice(0, maxMatches)
  if (ranked.length === 0) {
    return Object.freeze({
      question: asked,
      measured: false,
      matches: Object.freeze([]),
      text: `${RECALL_NOTHING} عن «${asked.slice(0, 120)}» في طبقات الوعي الأربع (بُحث في ${pool.length} مُدخلاً) — لا تخمين، ولا جواب من لا شيء.${unreadLine}`,
      searched: pool.length,
      unread,
    })
  }
  const head = `استرجاعٌ عن «${asked.slice(0, 120)}» — ${ranked.length} مطابقةً من ${pool.length} مُدخلاً، مرتّبةً بنسبها:`
  // **السقفُ على السطر لا على النصّ المجموع**: قصُّ السلسلة كلّها في آخرها كان
  // يبتر نسبَ آخر مطابقةٍ أو يحذفه كلّه، فتعود مطابقةٌ بلا «من أين» — وهي
  // بالضبط ما تعد به هذه الوحدة. فالنسبُ لا يُقصّ أبداً: إمّا سطرٌ كامل النسب
  // ونصُّه مقصوصٌ بعلامة، وإمّا لا سطر.
  const lines: string[] = []
  const emitted: RecallMatch[] = []
  let length = head.length + 1 + unreadLine.length
  for (const match of ranked) {
    const prefix = `- [${match.score}] `
    const tail = `\n  ↳ ${match.provenance}`
    const room = maxChars - length - prefix.length - tail.length - 1
    if (room < MATCH_MIN_TEXT) {
      // لا موضعَ لمطابقةٍ مفهومة؛ ولا يُترك الجواب بلا سطرٍ واحد.
      if (emitted.length > 0) break
    }
    const budget = Math.max(MATCH_MIN_TEXT, room)
    const body = match.text.length <= budget ? match.text : `${match.text.slice(0, budget - 1)}…`
    const line = `${prefix}${body}${tail}`
    lines.push(line)
    emitted.push(match)
    length += line.length + 1
  }
  return Object.freeze({
    question: asked,
    measured: true,
    // ما يُدّعى هو ما يُعرض: `matches` هي المعروضة بعينها لا الترتيب كلّه.
    matches: Object.freeze(emitted),
    text: `${head}\n${lines.join("\n")}\n${unreadLine === "" ? "" : `${unreadLine.slice(1)}\n`}`,
    searched: pool.length,
    unread,
  })
}

// ---------------------------------------------------------------------------
// عرضُ الطبقات الأربع للمشغّل — أمر `awareness`
// ---------------------------------------------------------------------------

/**
 * `unread` يفرّق ما لا يجوز خلطه: طبقةٌ **قُرئت فلم يوجد فيها شيء** تقول «لا
 * شيء مقيس»، وطبقةٌ **لم تُفتح** تقول ذلك بنصّه وتسمّي السبب. الأولى قياس،
 * والثانية اعترافٌ — وطبعُ الثانية بصيغة الأولى يقلب «لم أنظر» إلى «لا يوجد».
 */
export const renderAwarenessIndex = (
  index: AwarenessIndex,
  maxChars = 4000,
  unread: Partial<Readonly<Record<AwarenessLayer, string>>> = {},
): string => {
  const out: string[] = [
    `فهرس الوعي — المشروع ${index.projectId}`,
    `الطبقات: ${AWARENESS_LAYERS.map((layer) => `${LAYER_LABEL[layer]}=${unread[layer] === undefined ? index.counts[layer] : "لم تُقرأ"}`).join(" · ")}`,
    ...(index.foreignDropped > 0 ? [`أُسقط ${index.foreignDropped} مُدخلاً من مشروعٍ آخر (قضيب العبور عند القراءة).`] : []),
    "",
    `الوصلات المُثبَتة بطرفَيها (${index.links.length}):`,
    ...(index.links.length === 0
      ? [`- ${RECALL_NOTHING}: لا وصلةَ طرفاها موجودان.`]
      : index.links.map((link) => `- ${link.relation}: ${link.from} → ${link.to}`)),
    "",
  ]
  for (const layer of AWARENESS_LAYERS) {
    const rows = index.entries.filter((entry) => entry.layer === layer)
    const why = unread[layer]
    out.push(`${LAYER_LABEL[layer]} (${why === undefined ? rows.length : "لم تُقرأ"}):`)
    if (why !== undefined) out.push(`- ${RECALL_UNREAD}: ${why} — لا يُقال عنها «لا شيء مقيس».`)
    else if (rows.length === 0) out.push(`- ${RECALL_NOTHING} في هذه الطبقة.`)
    else for (const row of rows.slice(0, 12)) out.push(`- ${row.key}: ${row.text.slice(0, 160)}`)
    if (rows.length > 12) out.push(`- … و${rows.length - 12} غيرها`)
    out.push("")
  }
  const text = out.join("\n").replace(/\n+$/u, "\n")
  return text.length > maxChars ? `${text.slice(0, maxChars)}…\n` : text
}
