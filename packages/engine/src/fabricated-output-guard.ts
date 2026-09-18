/**
 * م11 — كاشفُ الخرج المختلَق: النموذجُ الضعيف يسرد في نصّه سطوراً بشكل خرج أمرٍ («drwxr-xr-x 5 someone staff … Oct 15»،
 * جدولُ dir، «Tests: 3 passed») لم تُنتجها أداةٌ — مقيس على omni-30b 2026-09-14 (`ls -la` مختلَق والأداةُ ردّت «غير موجود: -la»).
 * الحكمُ من الإيصالات: سطرٌ بشكل خرجٍ لا يقابله إيصالٌ في الدور = ادّعاءٌ يُقال للمشغّل ويُصحَّح في النداء التالي.
 * لا يمسّ تنفيذَ الأدوات ولا يرفض الردّ — يسمّي فقط. الوحدة نقيّة.
 */

const OUTPUT_SHAPES: readonly RegExp[] = Object.freeze([
  /^[-dl][rwxsStT-]{9}\s+\d+\s+\S+/u, // ls -l
  /^total \d+$/u, // ls -l header
  /^Mode\s+LastWriteTime\s+Length\s+Name/u, // PowerShell dir table
  /^[d-][a-][r-][h-][s-]-?\s+\d{1,2}\/\d{1,2}\/\d{4}\s/u, // PowerShell dir row
  /^Tests?:\s+\d+\s+(?:passed|failed)/u, // jest/vitest summary
  /^\s*\d+ (?:passed|failed)(?:,|\s|$)/u, // pytest/bun summary
  /^(?:PASS|FAIL)\s+\S+\.(?:test|spec)\.[a-z]+/u,
  /^npm (?:ERR!|WARN)\s/u,
  /^Compiled successfully/u,
  // 09-16 — أشكالٌ تخترعها النماذجُ الصغيرة أيضاً: علامةُ نجاحٍ بشكل مشغّل اختبارات، وخلاصةُ git --stat، وTAP.
  /^[✓✔√]\s+\S+\.(?:test|spec)\.[a-z]+/u, // vitest/jest per-file tick
  /^[✓✔√]\s+\d+\s+(?:tests?|passed|passing)(?![\p{L}])/u, // "✓ 12 tests passed"
  /^(?:ok|not ok)\s+\d+\s+-\s+/u, // TAP
  /^\s*\d+\s+files? changed(?:,|\s|$)/u, // git diff --stat summary
  /^\s*\d+ (?:passing|pending|failing)(?:\s|$)/u, // mocha summary
  /^File changed:\s+\S/u,
  // 09-16 (مقيس على لوحة القياس b3 بنموذج nemotron): النموذجُ يكتب سطورَ إيصالاتِ المحرّك نفسِها («⚙ open …»، «↻ حقبة 1 · shot ⏎ …»)
  // بلا أيّ أداة — ومرّ الدورُ «مكتملاً» بصفر أدوات. الإيصالُ يكتبه المحرّكُ وحده؛ في نصّ النموذج هو اختلاق.
  /^⚙\s+\S/u,
  /^↻\s+حقبة\s+\d+\s+·/u,
  // 09-16 (مقيس على 4.0.44، nemotron): «تم تنفيذ desk click 285 385 وإيصاله: نقرتُ عند الإحداثيّات (285, 385) …» — إيصالُ فعلٍ لم يقع،
  // والدورُ أُغلق «مكتملاً» بأداةٍ أخرى (read). أفعالُ الإيصالات بصيغة المتكلّم هي جملُ المحرّك؛ في نصّ النموذج بلا إيصالٍ يطابقها = اختلاق.
])

/** جملُ إيصالات المحرّك بصيغة المتكلّم — تغطيتُها فضفاضة (بدايةُ الجملة داخل إيصال) لأنّ النموذجَ يعيد صياغتها بصدق. */
const RECEIPT_SENTENCES: readonly RegExp[] = Object.freeze([
  /^(?:نقرتُ|انتقلتُ|كتبتُ|ركّزتُ|مرّرتُ|ضغطتُ|سحبتُ|حُفظت لقطةُ|فتحتُ)\s/u,
  /^تمّ? تنفيذ\s+(?:desk|open|page|tabs|shot|find|look|tap|scroll|run|read|edit|write)\b/u,
])
const RECEIPT_PREFIX_CHARS = 24

const isCommandLine = (line: string): boolean => /^\s*(?:نفّ?ذ|run|\$)\s*[:：]?\s/u.test(line)

/** بصمةُ السطر: فراغاتٌ مطويّة وحالةٌ موحَّدة — السطرُ كلُّه، لا بادئتُه. */
const lineDigest = (line: string): string => line.replace(/\s+/gu, " ").trim().toLowerCase()
const TRUNCATION = /(?:…|\.\.\.)$/u

/**
 * سطورُ نصّ النموذج التي تشبه خرجَ أمرٍ ولا يقابلها إيصال (حتى ثلاثة، بلا تكرار).
 * التغطية ببصمة السطر كاملاً (09-16): بادئةُ ٨٠ حرفاً كانت تمرّر سطراً مختلَقاً يشارك إيصالاً
 * حقيقيّاً بادئتَه ويخالفه في ذيله. الاستثناءُ الوحيد إيصالٌ مقصوصٌ بعلامة قصّ: بادئتُه تغطّي.
 */
export function fabricatedOutputSignals(modelText: string, receiptOutputs: readonly string[]): string[] {
  const covered = new Set<string>()
  const truncatedPrefixes: string[] = []
  const receiptText = receiptOutputs.map((o) => lineDigest(o)).join("\n")
  for (const output of receiptOutputs) {
    for (const raw of output.split(/\r?\n/u)) {
      const digest = lineDigest(raw)
      if (digest.length === 0) continue
      covered.add(digest)
      if (TRUNCATION.test(digest)) truncatedPrefixes.push(digest.replace(TRUNCATION, "").trim())
    }
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of modelText.split(/\r?\n/u)) {
    const line = raw.trim()
    if (line.length === 0 || isCommandLine(line) || seen.has(line)) continue
    const receiptSentence = RECEIPT_SENTENCES.some((shape) => shape.test(line))
    if (!receiptSentence && !OUTPUT_SHAPES.some((shape) => shape.test(line))) continue
    const digest = lineDigest(line)
    if (covered.has(digest)) continue
    if (truncatedPrefixes.some((prefix) => prefix.length >= 20 && digest.startsWith(prefix))) continue
    // أشكالُ الخرج تُغطّى بالسطر كاملاً (مسمارُ ٨٠ حرفاً السابق)؛ جملُ الإيصالات وحدها تُغطّى ببدايتها داخل إيصالٍ حقيقيّ.
    if (receiptSentence && digest.length >= RECEIPT_PREFIX_CHARS && receiptText.includes(digest.slice(0, RECEIPT_PREFIX_CHARS))) continue
    seen.add(line)
    out.push(line.slice(0, 120))
    if (out.length >= 3) break
  }
  return out
}

/** سطرُ الحدث للمشغّل + التصحيحُ الذي يُحقن في النداء التالي. */
export function fabricationNoticeLine(lines: readonly string[]): string {
  return `النموذجُ سرد خرجَ أمرٍ لم تُنفّذه أداة: ${lines.map((l) => `«${l}»`).join(" · ")} — لا يُقبل خرجٌ بلا إيصال.`
}

export function fabricationCorrection(lines: readonly string[]): string {
  return `[تصحيحٌ من النظام] ردُّك السابق حمل سطوراً بشكل خرج أمرٍ لم تُنفَّذ (${lines.map((l) => `«${l.slice(0, 60)}»`).join("، ")}). لا تكتب خرجاً بنفسك؛ اطلب الأداة بسطر «نفّذ:» وانتظر إيصالها، ثمّ ابنِ على الإيصال وحده.`
}
