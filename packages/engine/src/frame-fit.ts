/**
 * 10-10 (مقيس على المثبَّت 4.0.127): جلسةُ مهمّة n8n الطويلة صار إطارُ «archive» لها 1,093,846 بايت، والقناةُ إلى القشرة سقفُها 1 MiB —
 * فرمى encodeLocalJsonFrame استثناءً داخل emit فسقط المحرّك عند الإقلاع («المحرّك سقط — لا إعادة تشغيل خلسة»)، وكلُّ إحياءٍ يسقط ثانيةً
 * لأنّ الواجهةَ تستعيد الجلسةَ نفسَها. إطارٌ كبير لا يُسقط المحرّكَ أبداً: الأرشيفُ يُقصّ إلى ما يتّسع (الأحدثُ يبقى، ويُقال كم قُصّ)،
 * وأيُّ إطارٍ آخر يتجاوز السقفَ يُستبدل بإطارٍ يسمّيه. Pure — بلا ترميز؛ القياسُ بطول JSON بالبايت.
 */
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8")

type ArchiveTurn = { id: string; body: string; lines: string[]; attachments?: unknown }

/**
 * 10-11 (مقيس بعد 4.0.135): أرشيفٌ مقصوصٌ إلى ~864KB وصل القشرةَ مرّتين متتاليتين فتوقّف المرحِّلُ بين المحرّك والواجهة في الاتّجاهين
 * («لم يؤكد المحرك إنشاء المحادثة الجديدة» ثمّ لا إطارَ يصل). الواجهةُ تعرض الأحدثَ وحده، والتاريخُ كاملاً في المحرّك — فميزانيّةُ الأرشيف للعرض صغيرة.
 */
export const ARCHIVE_DISPLAY_BUDGET = 300_000

/** يعيد الإطارَ كما هو إن اتّسع، أو نسخةً مقصوصة تتّسع، أو إطارَ رفضٍ يسمّي ما أُسقط. `limit` بايتات الحمولة. */
export function fitFrame(frame: Record<string, unknown>, limit: number): Record<string, unknown> {
  const size = bytes(frame)
  const cap = frame.kind === "archive" ? Math.min(limit, ARCHIVE_DISPLAY_BUDGET) : limit
  if (size <= cap) return frame
  const budget = Math.floor(cap * 0.9)
  if (frame.kind === "archive" && Array.isArray(frame.turns)) {
    const turns = (frame.turns as ArchiveTurn[]).map((t) => ({ ...t, lines: [...(t.lines ?? [])] }))
    let clippedLines = 0, droppedTurns = 0
    // ١) كلُّ سطرٍ طويل يُقصّ إلى 4000 حرف (مخرجاتُ أدواتٍ ضخمة)، ٢) أسطرُ الأدوار القديمة تُختصر إلى آخر 40، ٣) أقدمُ الأدوار تسقط.
    for (const t of turns) t.lines = t.lines.map((line) => { if (typeof line === "string" && line.length > 4000) { clippedLines += 1; return `${line.slice(0, 4000)} …[قُصّ للعرض]` } return line })
    const fits = () => bytes({ ...frame, turns }) <= budget
    for (let i = 0; i < turns.length - 1 && !fits(); i++) if (turns[i]!.lines.length > 40) { clippedLines += turns[i]!.lines.length - 40; turns[i]!.lines = turns[i]!.lines.slice(-40) }
    while (turns.length > 1 && !fits()) { turns.shift(); droppedTurns += 1 }
    if (!fits() && turns.length === 1) { const t = turns[0]!; clippedLines += Math.max(0, t.lines.length - 40); t.lines = t.lines.slice(-40) }
    const fitted = { ...frame, turns, truncated: { droppedTurns, clippedLines, originalBytes: size } }
    if (bytes(fitted) <= cap) return fitted
  }
  return { kind: "refused", why: `إطارُ «${String(frame.kind ?? "?")}» (${size} بايت) أكبر من سقف القناة (${limit}) — أُسقط عرضُه بدل أن يسقط المحرّك.` }
}
