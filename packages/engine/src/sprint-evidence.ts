/**
 * 09-30 — مقيس على مهمّة OpenRouter (المصدر، بعد 4.0.99): أُغلق «Sprint 0» بدليلٍ نصُّه
 * «npm run build passes, npm test passes, page / renders with Header and Hero sections» — البناءُ والاختبارُ قيسا حقّاً،
 * أمّا «الصفحة تعرض الرأس والبطل» فلم يُفتح لها probe ولا page ولا shot بعد آخر تعديل: ادّعاءٌ مرّ لأنّ `sprint done` يكتفي بطول النصّ.
 * ساعةُ دليلٍ صغيرة: متى قيست صفحةٌ آخرَ مرّة، ومتى عُدّلت شيفرةٌ آخرَ مرّة. دليلٌ يذكر عرضَ صفحةٍ بلا قياسٍ بعد آخر تعديل يُرفض
 * ويُسمّى الإيصالُ الناقص؛ ودليلٌ لا يدّعي صفحةً (build/test وحدهما) يمرّ كما كان.
 */
import { editsCode } from "./verify-after-edit"

export interface EvidenceClock {
  pageAt: number
  codeAt: number
}

export const newEvidenceClock = (): EvidenceClock => ({ pageAt: 0, codeAt: 0 })

const PAGE_TOOLS = new Set(["probe", "page", "shot", "look"])

/** يسجّل إيصالاً: قياسُ صفحةٍ ناجح، أو تعديلُ شيفرةٍ ناجح. `command` سطرُ الأداة كما نُفّذ. */
export function noteEvidence(clock: EvidenceClock, command: string, ok: boolean, now = Date.now()): void {
  if (!ok) return
  const word = command.trim().split(/\s+/u, 1)[0]?.toLowerCase() ?? ""
  if (PAGE_TOOLS.has(word)) clock.pageAt = now
  else if (editsCode(command.trim())) clock.codeAt = now
}

/** دليلٌ يدّعي عرضَ صفحةٍ أو ردَّها — بالعربيّة أو الإنجليزيّة. */
const PAGE_CLAIM = /(?:\bpage\s*\/|\brenders?\b|\bshows?\b|\bdisplays?\b|\bvisible\b|\bprobe\b|\bshot\b|\bscreenshot\b|\bHTTP\s*200\b|\b200\s*OK\b|(?:^|\s)\/[a-z][\w/-]*\s+(?:→|=>|->)?\s*200\b|تظهر|يظهر|تعرض|يعرض|تُعرض|ظاهر|الصفحة\s+ترد|ترد\s+200)/iu

/** سببُ رفض إغلاق السبرنت، أو `undefined` حين يُقبل الدليل. */
export function sprintEvidenceRefusal(evidence: string, clock: EvidenceClock): string | undefined {
  if (!PAGE_CLAIM.test(evidence)) return undefined
  if (clock.pageAt > 0 && clock.pageAt >= clock.codeAt) return undefined
  const why = clock.pageAt === 0 ? "لم تُقَس أيُّ صفحةٍ في هذه الجلسة" : "آخرُ قياسٍ لصفحةٍ سبق آخرَ تعديلٍ للشيفرة"
  return `رُفض إغلاقُ السبرنت: الدليلُ يدّعي عرضَ صفحة و${why}. قِسها الآن — probe <المسار> (الردّ) أو page/shot على الصفحة (العناصر) — ثمّ أعد sprint done بما قيس.`
}
