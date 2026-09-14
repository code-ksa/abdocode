/**
 * حارسُ السطح: **لا اسمَ منتَجٍ آخر في نصٍّ يراه المستخدم.**
 *
 * قِيس 2026-09-03: بطاقةُ إضافةٍ كانت تُسمّي نفسها «سرب العمال (Verdent-style)»
 * فظهرت في لوحة الإعدادات — نَسَبٌ صحيحٌ في مكانٍ خاطئ. النَّسَبُ يسكن تعليقَ
 * الشيفرة ووثيقةَ الجرد، حيث يفيد المهندس؛ أمّا اللوحةُ فتخصّ المستخدم، ومنتَجُنا
 * فيها اسمٌ واحد.
 *
 * ولذلك هذا الحارس **لا يمسح الملفّات كلَّها**: يمسح الحقول التي تُعرض وحدها —
 * عناوينَ البطاقات وأوصافَها، وملخّصاتِ الأدوات وصيغَها، ونصَّ المساعدة، والنصَّ
 * المرئيَّ في صفحة القشرة — فيبقى التعليقُ حرّاً والوثيقةُ صادقة.
 *
 * أُضيف بعد أن التقط المالكُ الاسمَ بعينه من لقطة شاشة. ما يُلتقط بالعين مرّةً
 * يعود؛ وما يُلتقط ببوّابةٍ لا يعود.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.cwd()

/** أسماءُ منتجاتٍ أخرى — نُسبت إليها أفكارٌ، ولا تُعرض على المستخدم. */
const FOREIGN = [
  "verdent", "mindshub", "anton", "deepseek-harness", "cordis",
  "openclaw", "open claw", "hermes", "claude code", "cursor.so", "windsurf", "copilot",
  "opencode", "omnicode", "aider", "cline", "roo code",
]

/** ملفٌّ ثمّ الحقولُ المعروضةُ فيه — لا الملفُّ كلُّه. */
const SURFACES = [
  { file: "packages/engine/src/plugin-registry.ts", fields: ["label", "description"] },
  { file: "packages/tools/src/catalogue.ts", fields: ["summary", "usage"] },
  { file: "packages/providers/src/catalog.ts", fields: ["label"] },
]

/** حقلٌ نصّيٌّ في مصدرٍ TypeScript: `label: "…"` أو `description: "…"`. */
const fieldValues = (source, field) => {
  const out = []
  const re = new RegExp(`(?:^|[\\s,{])${field}\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "gu")
  for (const match of source.matchAll(re)) out.push(match[1] ?? "")
  return out
}

/** النصُّ المرئيُّ في صفحةٍ واحدة: بلا وسومٍ ولا سكربتٍ ولا نمط. */
const visibleHtml = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<[^>]+>/gu, " ")

/** كتلةُ المساعدة في سطر الأوامر — نصٌّ يُطبع للمستخدم. */
const helpBlock = (source) => {
  const start = source.indexOf("const HELP =")
  if (start < 0) return ""
  const end = source.indexOf("\n`", start + 12)
  return end < 0 ? source.slice(start, start + 4000) : source.slice(start, end)
}

const findings = []
const hit = (where, text) => {
  const lowered = text.toLowerCase()
  for (const brand of FOREIGN) {
    if (lowered.includes(brand)) findings.push(`${where}: يذكر «${brand}» في نصٍّ يراه المستخدم`)
  }
}

let scanned = 0
for (const surface of SURFACES) {
  let source
  try { source = readFileSync(join(ROOT, surface.file), "utf8") } catch { continue }
  for (const field of surface.fields) {
    for (const value of fieldValues(source, field)) { scanned += 1; hit(`${surface.file} (${field})`, value) }
  }
}

try {
  const html = readFileSync(join(ROOT, "packages/desktop/ui/index.html"), "utf8")
  scanned += 1
  hit("packages/desktop/ui/index.html (النصّ المرئي)", visibleHtml(html))
} catch { /* لا قشرة، لا سطح */ }

try {
  const cli = readFileSync(join(ROOT, "packages/engine/src/cli.ts"), "utf8")
  scanned += 1
  hit("packages/engine/src/cli.ts (المساعدة)", helpBlock(cli))
} catch { /* لا محرّك، لا مساعدة */ }

if (scanned === 0) {
  console.error("BRAND_SURFACE_UNMEASURED: لم يُقرأ أيُّ سطح — بوّابةٌ بلا مادّةٍ ليست خضراء")
  process.exit(2)
}
if (findings.length > 0) {
  console.error(`BRAND_SURFACE_FAILED (${findings.length})\n${findings.join("\n")}`)
  process.exit(1)
}
console.log(`BRAND_SURFACE_OK strings=${scanned} foreign=0`)
