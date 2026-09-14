/**
 * اللهجة — الطبقةُ الثانية: «واللهجة داخل اللغة إيش».
 *
 * لا نصنّف بالنموذج بل **بعلاماتٍ فارقة**: كلماتٌ لا تكاد تُقال إلا في لهجةٍ بعينها.
 * «إزاي» مصرية، «وش» خليجية، «شو» شامية، «واش» مغاربية، «شكو» عراقية، «ماذا» فصحى.
 * والمشتركُ بين لهجتين («وين» في الخليج والشام والعراق) يُحسب لكلٍّ بوزنٍ أخفّ —
 * فالحكمُ لا يقوم على كلمةٍ واحدة بل على **مجموعِ الشواهد**، ويخرج معه دليلُه:
 * أيُّ كلمةٍ رجّحت أيَّ لهجة، كي يُراجَع الحكمُ لا أن يُصدَّق.
 *
 * والعربيةُ بلا علامةٍ عاميّة **فصحى بثقةٍ منخفضة** لا «مجهول»: الغيابُ هنا معلومةٌ
 * (لم يستعمل علاماتٍ عامّية) لا جهل. وغيرُ العربية «مجهول» — لا نحزر لهجةَ ما ليس عربياً.
 *
 * والتعادلُ التامّ بين لهجاتٍ (كلمةٌ مشتركة وحدها) يُحسم **باللهجة الأمّ** المضبوطة —
 * خليجيةٌ افتراضاً لمستخدمينا — ويُعلَن في الدليل أنه حسمُ تعادلٍ لا شاهد. وإن لم تكن
 * الأمُّ بين المتعادلين فالحكمُ فصحى بثقةٍ منخفضة.
 *
 * العلاماتُ تُطوى عند التجميع (`wordRe` يطويها) فتُكتب كما تُقال.
 */
import { fold, wordRe } from "./normalize"

export type Dialect = "msa" | "egyptian" | "gulf" | "levantine" | "maghrebi" | "iraqi" | "unknown"
export type Scored = Exclude<Dialect, "unknown">

export interface DialectEvidence {
  readonly token: string
  readonly dialects: readonly Scored[]
  readonly weight: number
}

export interface DialectRead {
  readonly dialect: Dialect
  /** 0–1: نسبةُ الأعلى إلى (الأعلى + الثاني). فصحى بلا علامات = 0.3 عمداً. */
  readonly confidence: number
  readonly scores: Readonly<Record<Scored, number>>
  readonly evidence: readonly DialectEvidence[]
  /** حُسم بتعادلٍ عبر اللهجة الأمّ لا بشاهدٍ فارق. */
  readonly tieBreak: boolean
}

interface Marker { readonly forms: readonly string[]; readonly weights: Readonly<Partial<Record<Scored, number>>> }

/** الوزن ٣ فارقٌ قاطع، ٢ قويّ، ١ مشترك. */
const MARKERS: readonly Marker[] = Object.freeze([
  // ── مصرية ──
  { forms: ["ازاي", "إزاي"], weights: { egyptian: 3 } },
  { forms: ["عايز", "عايزة", "عاوز", "عاوزة", "عايزين", "عاوزين"], weights: { egyptian: 3 } },
  { forms: ["دلوقتي", "دلوقت", "دلوك"], weights: { egyptian: 3 } },
  { forms: ["بتاع", "بتاعة", "بتاعت", "بتوع"], weights: { egyptian: 3 } },
  { forms: ["برضو", "برضه", "بردو"], weights: { egyptian: 3 } },
  { forms: ["لسه", "لسا"], weights: { egyptian: 2, levantine: 2 } },
  { forms: ["اهو", "أهو", "اهي", "اهم"], weights: { egyptian: 3 } },
  { forms: ["خالص"], weights: { egyptian: 2 } },
  { forms: ["معلش", "معليش"], weights: { egyptian: 2, gulf: 1, levantine: 1 } },
  { forms: ["مش"], weights: { egyptian: 2, levantine: 1 } },
  { forms: ["ده", "دي", "دول", "كده", "كدا", "كدة"], weights: { egyptian: 2 } },
  { forms: ["ليه"], weights: { egyptian: 2 } },
  { forms: ["فين"], weights: { egyptian: 2, maghrebi: 1 } },
  { forms: ["ايه", "إيه"], weights: { egyptian: 2 } },
  { forms: ["اعملي", "اعمللي", "اعمل لي", "هات لي", "هاتلي", "سيبك", "سيب"], weights: { egyptian: 2 } },
  { forms: ["عشان", "علشان"], weights: { egyptian: 1, gulf: 1 } },
  { forms: ["بقى", "بقا"], weights: { egyptian: 2 } },
  // ── خليجية / سعودية ──
  { forms: ["وش", "وشو", "وشلون"], weights: { gulf: 3 } },
  { forms: ["ابغى", "أبغى", "ابغا", "ابي", "أبي", "يبغى", "يبي", "نبي", "نبغى", "تبغى", "تبي"], weights: { gulf: 3 } },
  { forms: ["الحين", "الحينه", "هالحين", "دحين", "ذحين"], weights: { gulf: 3 } },
  { forms: ["زين"], weights: { gulf: 2, iraqi: 1 } },
  { forms: ["ودي", "ياخي", "يا خوي", "ياخوي", "خوي"], weights: { gulf: 3 } },
  { forms: ["ايش", "إيش", "ايشو", "شنهو", "شنهي"], weights: { gulf: 2 } },
  { forms: ["شلون", "شلونه", "شلونك"], weights: { gulf: 2, iraqi: 2 } },
  { forms: ["ماهو", "ماهي", "مو"], weights: { gulf: 1, iraqi: 1, levantine: 1 } },
  { forms: ["سوي", "سويلي", "سوي لي", "سو لي", "سولي", "اسوي"], weights: { gulf: 2, iraqi: 1 } },
  { forms: ["على طول", "علطول"], weights: { gulf: 1, egyptian: 1 } },
  { forms: ["هذيك", "هذاك", "هاذاك"], weights: { gulf: 1 } },
  // ── شامية ──
  { forms: ["شو"], weights: { levantine: 3 } },
  { forms: ["بدي", "بدك", "بدنا", "بده", "بدها", "بدكم"], weights: { levantine: 3 } },
  { forms: ["هلق", "هلا", "هلأ", "هلقيت"], weights: { levantine: 3 } },
  { forms: ["هيك", "هيكي"], weights: { levantine: 3 } },
  { forms: ["منيح", "مناح", "منيحة"], weights: { levantine: 3 } },
  { forms: ["كتير"], weights: { levantine: 2 } },
  { forms: ["تعا", "تعي", "تعو"], weights: { levantine: 2 } },
  { forms: ["ليش"], weights: { levantine: 2, gulf: 1, iraqi: 1 } },
  { forms: ["كمان"], weights: { levantine: 1, egyptian: 1 } },
  { forms: ["وين"], weights: { gulf: 1, levantine: 1, iraqi: 1 } },
  { forms: ["هون", "هونيك"], weights: { levantine: 2 } },
  // ── مغاربية ──
  { forms: ["واش"], weights: { maghrebi: 3 } },
  { forms: ["بغيت", "بغا", "بغينا", "بغيتي", "كنبغي"], weights: { maghrebi: 3 } },
  { forms: ["دابا"], weights: { maghrebi: 3 } },
  { forms: ["بزاف"], weights: { maghrebi: 3 } },
  { forms: ["شحال"], weights: { maghrebi: 3 } },
  { forms: ["كيفاش", "علاش", "فوقاش", "منين"], weights: { maghrebi: 3 } },
  { forms: ["كاين", "كاينة", "كاينين", "ماكاينش"], weights: { maghrebi: 3 } },
  { forms: ["غادي", "غادا"], weights: { maghrebi: 2 } },
  { forms: ["ديال", "ديالي", "ديالك"], weights: { maghrebi: 3 } },
  { forms: ["زعما", "نصاوب", "صاوب"], weights: { maghrebi: 2 } },
  // ── عراقية ──
  { forms: ["شكو", "ماكو", "اكو", "شكو ماكو"], weights: { iraqi: 3 } },
  { forms: ["هواية", "هوايه", "هواي"], weights: { iraqi: 3 } },
  { forms: ["هسه", "هسا"], weights: { iraqi: 3 } },
  { forms: ["خوش"], weights: { iraqi: 3 } },
  { forms: ["شنو", "شني"], weights: { iraqi: 2, maghrebi: 1 } },
  { forms: ["بيه"], weights: { iraqi: 1 } },
  // ── فصحى ──
  { forms: ["ماذا", "لماذا", "كيف", "متى", "أين", "اين", "هل"], weights: { msa: 2 } },
  { forms: ["الآن", "الان"], weights: { msa: 2 } },
  { forms: ["أريد", "اريد", "نريد", "أود", "اود", "أرغب", "ارغب"], weights: { msa: 2 } },
  { forms: ["سوف", "ليس", "ليست", "لن"], weights: { msa: 2 } },
  { forms: ["هذا", "هذه", "ذلك", "تلك", "هذين", "هاتين"], weights: { msa: 1 } },
  { forms: ["حيث", "أيضا", "ايضا", "بحيث", "من فضلك", "رجاء", "لو سمحت"], weights: { msa: 1 } },
  { forms: ["قم", "قومي", "يرجى", "يرجي"], weights: { msa: 2 } },
])

const COMPILED = MARKERS.map((m) => ({ marker: m, re: wordRe(m.forms, "gu") }))
const ZERO: Record<Scored, number> = { msa: 0, egyptian: 0, gulf: 0, levantine: 0, maghrebi: 0, iraqi: 0 }

export interface DialectOptions {
  /** اللهجةُ الأمّ لحسم التعادل التامّ. خليجيةٌ افتراضاً. */
  readonly home?: Scored
}

export function detectDialect(text: string, isArabic = true, options: DialectOptions = {}): DialectRead {
  const home = options.home ?? "gulf"
  if (!isArabic) return Object.freeze({ dialect: "unknown", confidence: 0, scores: Object.freeze({ ...ZERO }), evidence: Object.freeze([]), tieBreak: false })
  const folded = fold(text)
  const scores: Record<Scored, number> = { ...ZERO }
  const evidence: DialectEvidence[] = []
  for (const { marker, re } of COMPILED) {
    re.lastIndex = 0
    const hits = folded.match(re)
    if (hits === null) continue
    const dialects = Object.keys(marker.weights) as Scored[]
    for (const hit of hits) {
      let weight = 0
      for (const d of dialects) { const w = marker.weights[d] ?? 0; scores[d] += w; weight = Math.max(weight, w) }
      evidence.push(Object.freeze({ token: hit, dialects: Object.freeze([...dialects]), weight }))
    }
  }
  const ranked = (Object.entries(scores) as [Scored, number][]).sort((a, b) => b[1] - a[1])
  const top = ranked[0]!
  if (top[1] === 0) {
    // عربيةٌ بلا علامةٍ عاميّة: فصحى بثقةٍ منخفضة — الغيابُ معلومةٌ لا جهل.
    return Object.freeze({ dialect: "msa", confidence: 0.3, scores: Object.freeze(scores), evidence: Object.freeze(evidence), tieBreak: false })
  }
  const tied = ranked.filter(([, s]) => s === top[1]).map(([d]) => d)
  if (tied.length > 1) {
    const dialect: Dialect = tied.includes(home) ? home : "msa"
    return Object.freeze({ dialect, confidence: 0.3, scores: Object.freeze(scores), evidence: Object.freeze(evidence), tieBreak: true })
  }
  const second = ranked[1]![1]
  const confidence = second === 0 ? Math.min(1, 0.6 + top[1] * 0.1) : top[1] / (top[1] + second)
  return Object.freeze({ dialect: top[0], confidence: Number(confidence.toFixed(2)), scores: Object.freeze(scores), evidence: Object.freeze(evidence), tieBreak: false })
}
