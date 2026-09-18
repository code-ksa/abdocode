/**
 * S11 (2026-09-18) — سطرُ إيصال الأداة في دفتر الأحداث (`serve.output.emitted`).
 *
 * مقيس على دفاتر المثبّتات: الحمولةُ كانت تُقصّ عند 700 حرف (≈825 مع الرأس)، فشجرةُ
 * الصفحة ونتيجةُ `look` تصلان مبتورتين ولا يُتحقّق من الإيصال بعد الدور. السقفُ هنا
 * 4,000 حرف لكلّ حمولة — يخصّ دفترَ الأحداث وحده؛ بثُّ القشرة (`tool-result` عند 16k)
 * لا يُمسّ، وذاكرةُ الحقائق تبقى بقصّها.
 */
export const RECEIPT_LEDGER_CLIP = 4_000

/** الشكلُ الذي تقرؤه القشرة (`Trajectory.epochOfEvent`): «↻ حقبة N · <السطر الأوّل من الأمر>» ثمّ الحمولة. */
export const epochReceiptLine = (epoch: number, command: string, output: string): string =>
  `↻ حقبة ${epoch} · ${command.split("\n", 1)[0]}\n${output.slice(0, RECEIPT_LEDGER_CLIP)}`
