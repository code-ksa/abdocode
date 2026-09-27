/**
 * بحثٌ معمّق — الفجوة #2 في جدول 2026-09-27 (ChatGPT وClaude يعيدان جواباً مستشهَداً من صفحاتٍ قُرئت فعلاً).
 *
 * الأنبوبُ حتميٌّ كلُّه والنموذجُ يكتب الجوابَ وحده (PHILOSOPHY §1: النموذجُ موجِّهٌ لا مؤلّف):
 *   نتائجُ الويب (PSE أو DuckDuckGo) ⇦ أعلى الصفحات تُقرأ عبر محوّل النواة ⇦ تُقطَّع مقاطعَ ⇦ تُرتَّب بـBM25 (مالكُ
 *   الترتيب `candidate-recall.ts`، بتطبيعه العربيّ) ⇦ أدلّةٌ مرقّمة [n] بمصادرها. لا ادّعاءَ بلا مقطع، ولا مصدرَ لم يُقرأ.
 */
import { rankByRelevance } from "../candidate-recall"

export const RESEARCH_PAGES_DEFAULT = 4
export const RESEARCH_PAGES_MAX = 6
const EVIDENCE_TOTAL = 8
const EVIDENCE_PER_SOURCE = 3
const PASSAGE_MIN = 240
const PASSAGE_MAX = 700

export interface ResearchRequest { readonly question: string; readonly pages: number }

/** `research <سؤال> [--pages N]` */
export function parseResearchCommand(rest: string): ResearchRequest {
  let pages = RESEARCH_PAGES_DEFAULT
  const question = rest.replace(/\s--pages\s+(\d+)\b/u, (_whole, n: string) => { pages = Number(n); return " " }).replace(/\s+/gu, " ").trim()
  if (question.length < 3) throw new Error("research يحتاج سؤالاً: research <سؤال> [--pages 4]")
  return { question: question.slice(0, 300), pages: Math.min(RESEARCH_PAGES_MAX, Math.max(1, Math.round(pages))) }
}

/** نصُّ صفحةٍ من إيصال `fetch`: المحتوى المقروء بلا أسطر الدليل الملحقة — والروابطُ باقيةٌ لأنّ كثافتَها تكشف التنقّل. */
export function pageTextOf(fetchOutput: string): string {
  const cut = fetchOutput.search(/\n(?:… \[قُصّ الخرج بحدٍّ معلن\]\n)?بصمة الدليل: /u)
  return cut >= 0 ? fetchOutput.slice(0, cut) : fetchOutput
}

const LINK = /\[([^\]]*)\]\([^)\s]*\)/gu

/** مقاطعُ متّصلة من أسطر الصفحة: القصيرُ يُضمّ حتى ~240 محرفاً، والطويلُ يُقصّ عند ~700، وما دون ثماني كلماتٍ فتاتُ تنقّل. */
export function passagesOf(text: string): string[] {
  const out: string[] = []
  let chunk = ""
  const flush = () => {
    const clean = chunk.replace(/\s+/gu, " ").trim()
    if (clean.split(" ").length >= 8) out.push(clean.length > PASSAGE_MAX ? `${clean.slice(0, PASSAGE_MAX)}…` : clean)
    chunk = ""
  }
  for (const line of text.split("\n")) {
    // مقيس حيّاً 2026-09-27 على وثائق Bun: قوائمُ التنقّل أسطرٌ من روابطَ متجاورة («[Docs](/docs) [Guides](/guides) …»)
    // فتسرّبت إلى الأدلّة. سطرٌ نصفُ نصِّه أو أكثرُ نصوصُ روابط تنقّلٌ لا محتوى.
    let linked = 0
    const trimmed = line.replace(LINK, (_whole, text: string) => { linked += text.length; return text }).trim()
    if (trimmed.length > 0 && linked / trimmed.length >= 0.5) continue
    if (trimmed.length === 0) { if (chunk.length >= PASSAGE_MIN) flush(); continue }
    // سطرٌ دون خمس كلماتٍ فتاتُ تنقّلٍ أو عنوانٌ مجرّد («Home | Docs | Blog») — لا يُلصق بالفقرة التي تليه.
    if ((trimmed.match(/[\p{L}\p{N}]+/gu) ?? []).length < 5) continue
    chunk = chunk.length === 0 ? trimmed : `${chunk} ${trimmed}`
    if (chunk.length >= PASSAGE_MIN) flush()
  }
  flush()
  return out
}

export interface ResearchSource { readonly title: string; readonly url: string; readonly text?: string; readonly failure?: string }
export interface Evidence { readonly source: number; readonly text: string }

/** أوثقُ المقاطع صلةً بالسؤال عبر كلّ المصادر المقروءة — بحدٍّ لكلّ مصدر كي لا يبتلع موقعٌ واحدٌ الأدلّة. */
export function selectEvidence(sources: readonly ResearchSource[], question: string): Evidence[] {
  const candidates: { id: number; text: string; shown: string; source: number }[] = []
  sources.forEach((source, index) => {
    if (source.text === undefined) return
    // عنوانُ الصفحة ليس دليلاً: مقيسٌ حيّاً أنّ فقرةً تسويقيّة تكرّر العنوانَ مرّتين تصدّرت الأدلّةَ بكلماته. يُنزع للترتيب وحده.
    const title = source.title.replace(/\s*[|\-–—]\s*[^|\-–—]+$/u, "").trim()
    for (const passage of passagesOf(source.text)) candidates.push({ id: candidates.length, text: title.length >= 8 ? passage.split(title).join(" ") : passage, shown: passage, source: index + 1 })
  })
  const ranked = rankByRelevance(candidates, question, candidates.length)
  const perSource = new Map<number, number>()
  const picked: Evidence[] = []
  for (const id of ranked) {
    const candidate = candidates[id]!
    const used = perSource.get(candidate.source) ?? 0
    if (used >= EVIDENCE_PER_SOURCE) continue
    perSource.set(candidate.source, used + 1)
    picked.push({ source: candidate.source, text: candidate.shown })
    if (picked.length >= EVIDENCE_TOTAL) break
  }
  return picked
}

export function formatResearch(question: string, via: string, sources: readonly ResearchSource[], evidence: readonly Evidence[]): string {
  const read = sources.filter((s) => s.text !== undefined).length
  const head = `بحثٌ معمّق عن «${question}» — ${via}؛ قُرئت ${read} من ${sources.length} صفحات، والمقاطعُ مرتّبةٌ بالصلة (BM25):`
  const list = sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}${s.failure === undefined ? "" : ` (تعذّرت قراءتها: ${s.failure})`}`).join("\n")
  if (evidence.length === 0) return `${head}\n${list}\nلا مقطعَ يطابق كلماتِ السؤال في الصفحات المقروءة — لا يُبنى عليها جواب. أعد الصياغة أو ضيّق السؤال.`
  return `${head}\nالمصادر:\n${list}\nالأدلّة:\n${evidence.map((e) => `[${e.source}] «${e.text}»`).join("\n")}\nاكتب الجوابَ من هذه الأدلّة وحدها واستشهد بـ[n] بعد كلّ ادّعاء؛ وما لا دليلَ عليه هنا قُل إنّه غيرُ مثبت.`
}
