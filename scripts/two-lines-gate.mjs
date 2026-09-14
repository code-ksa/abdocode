/**
 * حارسُ الخطّين: **النواةُ لا تعرف منتجاتِنا.**
 *
 * أمر المالك 2026-09-06: التطوير على خطّين — «عبدو كود الذكي المفتوح» نواةً،
 * و«عبدو كود: المنتج الشامل» فوقها؛ ومبرمج **إضافةٌ تُركَّب وتُزال** كأيّ ارتباط،
 * لا صاحبَ امتياز. فالنواةُ يجب أن تعمل كاملةً وكلُّ إضافاتنا محذوفة.
 *
 * قِيس يوم كتابة هذا الحارس أن `grep moparmeg|mubarmij` في `packages/` يعطي
 * **صفراً**: الفصلُ قائمٌ بالفعل. فهذا الحارس لا يُصلح عطباً، بل **يثبّت ثروةً**
 * قبل أن تأكلها أوّلُ ميزةٍ مستعجلة. وأرخصُ وقتٍ لتثبيت حدٍّ هو حين يكون سليماً.
 *
 * وهو أخو `brand-surface-gate.mjs` معكوساً: ذاك يمنع أسماءَ منتجاتٍ **أجنبية**
 * من الظهور للمستخدم، وهذا يمنع أسماءَ منتجاتِنا **نحن** من الدخول في النواة.
 *
 * ## طبقتان — عمداً، كي لا يحجب الحارسُ اللغةَ العربية نفسها
 *
 * - **الطبقة أ (قاطعة)**: معرّفاتٌ ونطاقاتٌ لا لبس فيها (`moparmeg`, `mubarmij`,
 *   `moyasar`, `technologyksa`, `mosaiden`). أيُّ ظهورٍ لها في `packages/` عطب.
 * - **الطبقة ب (سطحية)**: أسماءٌ عربيةٌ **هي كلماتٌ شائعة أيضاً** — «مبرمج»
 *   (اسمُ فاعلٍ من برمَج)، «ميسر» (اسمُ مفعولٍ من يسَّر)، «فوترة» (مصدرٌ عاديّ).
 *   منعُها في كلّ مكانٍ يجعل الحارسَ يحجب العربية، وقد كلّفتنا هذه الغلطةُ من قبل
 *   (`arabic-guard-regex-needs-normalization`: حارسٌ بلا تطبيعٍ ثغرة، وحارسٌ بلا
 *   قياسٍ للاتجاه المعاكس يحجب كلَّ شيء). فتُفحص **في الحقول المعروضة وحدها** —
 *   حيث يظهر الاسمُ التجاريّ فعلاً، ولا يظهر اسمُ الفاعل.
 *
 * ## توأمٌ إيجابي — لأن الأخضرَ قد يعني «لم يحدث شيء»
 *
 * الفحصُ السلبيُّ («لا اسمَ في النواة») يمرّ بطريقين: الحارسُ عمل، أو الحارسُ لا
 * يقرأ شيئاً أصلاً. فيُشغَّل الكاشفُ نفسه على **نصوصٍ مصطنعة** يجب أن يُمسك بها.
 * إن مرّ الاتجاهان معاً فالحارسُ يعضّ.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

let pass = 0
let fail = 0
const ok = (name, note = "") => { console.log(`PASS ${name}${note ? ` — ${note}` : ""}`); pass++ }
const bad = (name, note = "") => { console.log(`FAIL ${name}${note ? ` — ${note}` : ""}`); fail++ }

/** الطبقة أ — معرّفاتٌ لا تكون إلا اسمَ منتجٍ لنا. تُفحص في كلّ مصدرٍ تنفيذيّ. */
const OURS_HARD = ["moparmeg", "mubarmij", "moyasar", "technologyksa", "mosaiden"]

/**
 * الطبقة ب — الاسمُ التجاريُّ العربيُّ **في صيغةٍ لا تكون إلا منتجاً**.
 *
 * قِيس عند كتابة هذا الحارس أن مطابقةَ «مبرمج» وحدها **تحجب العربية**: فحصُ
 * الاتجاه المعاكس أحمرَّ على `description: "مبرمجٌ مسبقاً"` — وهي عربيةٌ سليمة
 * لا تخصّ منتجاً. و«ميسر» اسمُ مفعولٍ و«فوترة» مصدرٌ عاديّ، فحالُهما كذلك.
 * والتطبيعُ لا يحلّ هذا: الكلمةُ التجاريةُ **هي نفسُها** اسمُ الفاعل حرفاً بحرف.
 * فتُطابَق العبارةُ لا الكلمة — «على مبرمج» منتَجٌ، و«مبرمجٌ مسبقاً» لغة.
 * أمّا المعرّفُ اللاتينيّ (`mubarmij`) فتمسكه الطبقةُ أ في كلّ حال.
 */
const OURS_SURFACE = [
  "على مبرمج", "الى مبرمج", "إلى مبرمج", "في مبرمج", "منصة مبرمج", "منصّة مبرمج", "حساب مبرمج",
  "بوابة ميسر", "بوّابة ميسر", "عبر ميسر",
  "تكنولوجيا سعودية", "تكنولوجيا السعودية",
]

/** الحقولُ التي يراها المستخدم — نفسُ منطق `brand-surface-gate`. */
const SURFACE_FIELDS = ["label", "description", "summary", "usage", "title"]

const SKIP_DIRS = new Set([".git", "node_modules", "target", ".turbo", "dist", "extensions"])
const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".mjs"])

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (SOURCE_EXT.has(path.extname(name).toLowerCase())) out.push(full)
  }
  return out
}

/** قيمةُ حقلٍ نصّيّ: `label: "…"`. منقولٌ عن `brand-surface-gate` عمداً — عقدٌ واحد. */
const fieldValues = (source, field) => {
  const out = []
  const re = new RegExp(`(?:^|[\\s,{])${field}\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "gu")
  for (const match of source.matchAll(re)) out.push(match[1] ?? "")
  return out
}

/**
 * هل كلُّ ظهورٍ للاسم واقعٌ في تعليق؟ التعليقُ نَسَبٌ يفيد المهندس ولا يربط النواة
 * بشيء — و`brand-surface-gate` يقرّر المبدأ نفسه: «النَّسَبُ يسكن تعليقَ الشيفرة».
 * قِيس مثالُه الحيّ: `project-locator.ts` يشرح الهيكلَ الساكن بـ«mosaiden → msdn».
 * فيُبلَّغ عنه ملاحظةً تُرى، ولا يُوقف البناء.
 */
const onlyInComments = (source, name) => {
  const lines = source.split("\n").filter((line) => line.toLowerCase().includes(name))
  return lines.length > 0 && lines.every((line) => /^\s*(\/\/|\/\*|\*)/u.test(line))
}

/** الكاشفُ الحاكم — يُستدعى للنواة وللتوأم الإيجابي بالسواء. */
const hardHit = (source) => OURS_HARD.find((name) => source.toLowerCase().includes(name))
const surfaceHit = (source) => {
  for (const field of SURFACE_FIELDS) {
    for (const value of fieldValues(source, field)) {
      const name = OURS_SURFACE.find((brand) => value.includes(brand))
      if (name) return `${field}="${value.slice(0, 40)}" ⇐ ${name}`
    }
  }
  return undefined
}

// ————————————————————————————————————————————————— ١. النواة نقيّة (سلبيّ)

const files = walk("packages")

const hardHits = []
const commentNotes = []
const surfaceHits = []
for (const file of files) {
  // الاختباراتُ تُسمّي ما تختبره، والوثائقُ تشرح النَّسَب — كلاهما خارج النواة التنفيذية.
  if (file.includes(`${path.sep}test${path.sep}`) || file.endsWith(".test.ts")) continue
  const source = readFileSync(file, "utf8")
  const hard = hardHit(source)
  if (hard) (onlyInComments(source, hard) ? commentNotes : hardHits).push(`${file}:${hard}`)
  const surface = surfaceHit(source)
  if (surface) surfaceHits.push(`${file}: ${surface}`)
}

for (const note of commentNotes) console.log(`NOTE اسمُ منتجٍ لنا في تعليقٍ فقط — لا ارتباط: ${note}`)

hardHits.length === 0
  ? ok("لا معرّفَ منتجٍ لنا في النواة", `${files.length} ملفاً`)
  : bad("لا معرّفَ منتجٍ لنا في النواة", hardHits.slice(0, 8).join(", "))

surfaceHits.length === 0
  ? ok("لا اسمَ منتجٍ لنا في حقلٍ معروض", `${SURFACE_FIELDS.join("/")} في ${files.length} ملفاً`)
  : bad("لا اسمَ منتجٍ لنا في حقلٍ معروض", surfaceHits.slice(0, 8).join(", "))

// ————————————————————————————————————————————————— ٢. الكاشفُ يعضّ (إيجابيّ)

const HARD_FIXTURE = 'const door = "https://preview.MOPARMEG-ksa.com/api"'
const SURFACE_FIXTURE = 'export const card = { label: "اعرض على مبرمج", description: "ينشر مشروعك" }'
const CLEAN_FIXTURE = 'export const card = { label: "خادمُ جِت", description: "مبرمجٌ مسبقاً بلا شرط" }'

hardHit(HARD_FIXTURE)
  ? ok("التوأم الإيجابي: الطبقة أ تمسك المعرّف", "ولو بحالةِ أحرفٍ مختلطة")
  : bad("التوأم الإيجابي: الطبقة أ تمسك المعرّف", "مرّت نصّاً فيه اسمُ منتجٍ ⇒ الحارس لا يقرأ")

surfaceHit(SURFACE_FIXTURE)
  ? ok("التوأم الإيجابي: الطبقة ب تمسك الاسم المعروض")
  : bad("التوأم الإيجابي: الطبقة ب تمسك الاسم المعروض", "مرّت بطاقةٌ تقول «اعرض على مبرمج»")

// قاعدةُ التعليق نفسُها تُفحص في الاتجاهين، وإلّا صارت بابَ تهريب.
onlyInComments("/** الهيكلُ الساكن: mosaiden → msdn. */", "mosaiden") === true &&
onlyInComments(HARD_FIXTURE, "moparmeg") === false
  ? ok("قاعدةُ التعليق تفرّق الشرحَ عن الشيفرة", "تعليقٌ ملاحظة، وسطرُ كودٍ عطب")
  : bad("قاعدةُ التعليق تفرّق الشرحَ عن الشيفرة", "إمّا تبتلع الكودَ أو تعدّ التعليقَ عطباً")

// ————————————————————————————————————————————————— ٣. الاتجاه المعاكس

// حارسٌ يحجب كلَّ شيءٍ ليس حارساً: «مبرمجٌ مسبقاً» عربيةٌ سليمة ولا تخصّ منتجاً.
surfaceHit(CLEAN_FIXTURE) === undefined
  ? ok("الاتجاه المعاكس: العربيةُ الشائعة لا تُحجب", "«مبرمجٌ مسبقاً» تمرّ")
  : bad("الاتجاه المعاكس: العربيةُ الشائعة لا تُحجب", "الحارس يحجب اسمَ الفاعل ⇒ سيحجب اللغة")

console.log(`\n${fail === 0 ? "GATE PASS" : "GATE FAIL"} — ${pass} pass / ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
