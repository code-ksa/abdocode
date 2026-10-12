/**
 * 10-08 (مقيس في المهمّة الكاملة على مشروعٍ قائم): لإصلاح `npm audit` نفّذ النموذجُ `npm install next@16.4.0 tailwindcss@4.3.3` فوق next 14
 * وtailwind 3 — ترقيتان كبريان معاً — فانكسر البناء ودار دوراً كاملاً في هجرة Tailwind 4 بدل السبرنت. ترقيةٌ تعبر الإصدارَ الكبير لاعتماديّةٍ
 * قائمة تُرفض أوّلاً بالبديل الآمن (npm audit fix بلا --force، أو أحدثُ نسخةٍ داخل الإصدار الكبير الحاليّ)؛ والمقصودةُ تمرّ بتعليلٍ في
 * ذيل الأمر `# major-upgrade: <السبب>` (تعليقٌ لا يغيّر التنفيذ في PowerShell ولا sh).
 */
const INSTALL = /(?:^|[;&|]\s*)(?:npm\s+(?:i|install|add)|pnpm\s+(?:add|install|i)|yarn\s+add|bun\s+(?:add|install|i))\s+([^;&|#]*)/iu

const majorOf = (range: string): number | undefined => {
  const m = /(\d+)(?:\.\d+)*/u.exec(range.replace(/^(?:workspace:|npm:[^@]+@)/u, ""))
  return m === null ? undefined : Number(m[1])
}

/** `pkgJson` = نصُّ package.json في المشروع. `undefined` = نظيف (أو مُعلَّل). */
export function majorUpgradeViolation(cmd: string, pkgJson: string | undefined): string | undefined {
  if (pkgJson === undefined || /#\s*major-upgrade\s*:\s*\S/iu.test(cmd)) return undefined
  const m = INSTALL.exec(cmd)
  if (m === null) return undefined
  let declared: Record<string, string> = {}
  try {
    const pkg = JSON.parse(pkgJson) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    declared = { ...pkg.devDependencies, ...pkg.dependencies }
  } catch { return undefined }
  const jumps: string[] = []
  for (const arg of m[1]!.trim().split(/\s+/u)) {
    if (arg.startsWith("-")) continue
    const at = arg.lastIndexOf("@")
    if (at <= 0) continue
    const name = arg.slice(0, at), wanted = arg.slice(at + 1)
    const current = declared[name]
    if (current === undefined) continue
    const from = majorOf(current), to = majorOf(wanted)
    if (from !== undefined && to !== undefined && to > from) jumps.push(`${name} ${from} ⇦ ${to}`)
  }
  if (jumps.length === 0) return undefined
  return `رُفض: ترقيةٌ كبرى لاعتماديّةٍ قائمة (${jumps.join("، ")}) — تكسر الواجهات وتفتح هجرةً كاملة (مقيس: next 16 + tailwind 4 معاً كسرا البناء دوراً كاملاً). ` +
    `لإصلاح npm audit ابدأ بـ «npm audit fix» (بلا --force)، أو بأحدث نسخةٍ داخل الإصدار الكبير الحاليّ (مثل ${jumps[0]!.split(" ")[0]}@${jumps[0]!.split(" ")[1]}). ` +
    `إن كانت الترقيةُ مقصودة فأعد الأمرَ بتعليلٍ في ذيله: «# major-upgrade: <السبب>».`
}
