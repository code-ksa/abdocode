/**
 * م11 — كاشفُ الخرج المختلَق: النموذجُ الضعيف يسرد في نصّه سطوراً بشكل خرج أمرٍ («drwxr-xr-x 5 abdelrahman staff … Oct 15»،
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
])

const isCommandLine = (line: string): boolean => /^\s*(?:نفّ?ذ|run|\$)\s*[:：]?\s/u.test(line)

/** سطورُ نصّ النموذج التي تشبه خرجَ أمرٍ ولا يقابلها إيصال (حتى ثلاثة، بلا تكرار). */
export function fabricatedOutputSignals(modelText: string, receiptOutputs: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of modelText.split(/\r?\n/u)) {
    const line = raw.trim()
    if (line.length === 0 || isCommandLine(line) || seen.has(line)) continue
    if (!OUTPUT_SHAPES.some((shape) => shape.test(line))) continue
    const probe = line.slice(0, 80)
    if (receiptOutputs.some((output) => output.includes(probe))) continue
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
