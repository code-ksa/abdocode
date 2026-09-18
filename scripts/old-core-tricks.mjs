#!/usr/bin/env node
/**
 * ما تعلّمناه من خداع النواة القديمة — مكتوباً كفحصٍ لا كنصيحة.
 *
 * كل بندٍ هنا حيلةٌ **وقعنا فيها فعلاً** أثناء الفصل وإعادة البناء
 * (2026-08-25/26). النصيحة تُنسى والفحص لا يُنسى؛ ودرسٌ لا يستطيع أن يفشل
 * ليس درساً، فكلٌّ من هذه يسقط بصوتٍ عالٍ ويسمّي الملفّ والسطر.
 *
 * يُشغَّل: node scripts/old-core-tricks.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join, relative, sep } from "node:path"

const ROOT = process.cwd()
const findings = []
const note = (rule, where, why) => findings.push({ rule, where, why })

/** كل ملفّات المصدر المتعقَّبة، بلا المُولَّد ولا المبنيّ. */
function sources(dir = join(ROOT, "packages"), out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (["node_modules", "target", "dist", "out", ".next", "generated"].includes(name)) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) sources(full, out)
    else if (/\.(ts|tsx|mjs|js|json|txt|md|mdx)$/.test(name)) out.push(full)
  }
  return out
}

const files = sources()
const read = (f) => { try { return readFileSync(f, "utf8") } catch { return "" } }
const rel = (f) => relative(ROOT, f).split(sep).join("/")

// ───────────────────────────────────────────────────────────────────────────
// ١· النواة القديمة تدخل عبر الاستعمال الأتفه
//
// `contracts` — محورٌ تعتمده ١٩ حزمة — كان مربوطاً بـEffect كلّها من أجل
// `Schema.Literals`: قائمةُ نصوص. لا فكّ ترميز ولا تشفير. الميزة لم تُستعمل،
// والتبعيّة صارت شرطاً للبناء.
// ───────────────────────────────────────────────────────────────────────────
for (const f of files) {
  if (!/\.tsx?$/.test(f)) continue
  const s = read(f)
  if (/from "effect/.test(s)) note("old-core-import", rel(f), "يستورد النواة القديمة (effect)")
}

// ───────────────────────────────────────────────────────────────────────────
// ٢· البرميل يجرّ ما لم تطلبه
//
// `contracts/index.ts` يعيد تصدير كل وحداته. فمن يكتب
// `from "@abdo/contracts"` يجرّ الوحدات الملوّثة كلّها وإن لم يمسّ منها شيئاً.
// إعادةُ التصدير الشاملة تجعل النظافة معدومة الأثر: يكفي ملفٌّ واحد ملوّث
// ليُلوّث كل مستورد.
// ───────────────────────────────────────────────────────────────────────────
for (const f of files) {
  if (!/index\.tsx?$/.test(f)) continue
  const s = read(f)
  const stars = [...s.matchAll(/^export \* (?:as \w+ )?from "\.\/([\w./-]+)"/gm)].map((m) => m[1])
  for (const mod of stars) {
    for (const ext of [".ts", ".tsx"]) {
      const target = join(f, "..", mod + ext)
      if (existsSync(target) && /from "effect/.test(read(target))) {
        note("barrel-drags-old-core", `${rel(f)} → ./${mod}${ext}`,
          "برميلٌ يعيد تصدير وحدةً تستورد النواة القديمة، فيجرّها إلى كل مستورد")
      }
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// ٣· الإعلان بلا استعمال
//
// `web` أعلنت اعتماداً على المحرّك القديم ولا تستورده في سطرٍ واحد. إعلانٌ
// ميّت يجرّ طبقةً كاملة إلى شجرة التثبيت، ولا يظهر في أيّ بحثٍ عن الاستيراد.
// ───────────────────────────────────────────────────────────────────────────
const OLD_ENGINE = ["abdo-code-engine", "effect", "@effect/platform-node", "@effect/opentelemetry"]
for (const f of files) {
  if (!/packages\/[^/]+\/package\.json$/.test(rel(f))) continue
  let pkg
  try { pkg = JSON.parse(read(f)) } catch { continue }
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
  const dir = join(f, "..")
  const body = sources(dir).filter((x) => /\.tsx?$/.test(x)).map(read).join("\n")
  for (const d of OLD_ENGINE) {
    if (!(d in deps)) continue
    const used = new RegExp(`from "${d.replace(/[/@]/g, "\\$&")}`).test(body)
    if (!used) note("declared-not-used", `${rel(f)} → ${d}`,
      "يُعلن اعتماداً على النواة القديمة ولا يستورده — إعلانٌ ميّت يجرّ طبقةً كاملة")
  }
}

// ───────────────────────────────────────────────────────────────────────────
// ٤· الاستيراد بلا إعلان
//
// `ui` تستورد `@abdo/script` ولا تعلنه. عمل صدفةً لأن الجذر يرفع كل شيء —
// وينكسر لحظةَ نقلِ الحزمة وحدها. الاعتماد المخفيّ لا يظهر إلّا عند العزل.
// ───────────────────────────────────────────────────────────────────────────
for (const f of files) {
  if (!/packages\/[^/]+\/package\.json$/.test(rel(f))) continue
  let pkg
  try { pkg = JSON.parse(read(f)) } catch { continue }
  const deps = new Set(Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }))
  const dir = join(f, "..")
  for (const src of sources(dir).filter((x) => /\.tsx?$/.test(x))) {
    for (const m of read(src).matchAll(/from "(@abdo\/[\w-]+)/g)) {
      if (m[1] !== pkg.name && !deps.has(m[1])) {
        note("used-not-declared", `${rel(src)} → ${m[1]}`,
          "يستورد حزمةً لا يعلنها — يعمل بالرفع وينكسر عند العزل")
      }
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// ٥· النائب الذي يُنفَّذ
//
// `abdo.invalid` لم يكن نصّاً خاملاً: كان في **مطالبات** تأمر النموذج بجلبه،
// وفي **مهارةٍ مشحونة** تعلّم المستخدم لصقه، وفي `curl … | bash` على صفحة
// التنزيل. نطاقٌ محجوز في شيءٍ يُنفَّذ أسوأ من لا شيء.
// ───────────────────────────────────────────────────────────────────────────
const EXECUTABLE = /\.(ts|tsx|mjs|js|txt|md)$/
for (const f of files) {
  if (!EXECUTABLE.test(f)) continue
  if (/brand\/urls|old-core-tricks/.test(rel(f))) continue
  const s = read(f)
  if (/abdo\.invalid/.test(s)) note("dead-placeholder", rel(f),
    "نطاقٌ محجوز لا يُحلّ، في ملفٍّ يُنفَّذ أو يُشحن")
}

// ───────────────────────────────────────────────────────────────────────────
// ٦· مضيفات الأعلى — بالشكل لا بالاسم
//
// «إعادة التسمية ليست فصلاً»: عشرون رابطاً حيّاً نجت من بوّابةٍ تبحث عن
// العلامة، لأن أيّاً منها لم يكن يحمل اسمها. الصيد بشكل المضيف.
// ───────────────────────────────────────────────────────────────────────────
const BRAND = ["open", "code"].join("")
const HOSTS = new RegExp(`${BRAND}\\.ai|opncd|sst\\.dev|anoma\\.ly|models\\.dev`, "i")
for (const f of files) {
  const r = rel(f)
  // ⚠️ الاستثناء بالمسار هشّ: نقلتُ الحارس من `core/security/egress` إلى
  // حزمته الخاصّة فانكسر الاستثناء وارتفعت الإصابات — أي أنّ إصلاحاً صحيحاً
  // بدا انحداراً. الاستثناء الآن **بالدور لا بالمكان**: ملفٌّ يعلن قائمة منعٍ
  // يجب أن يسمّي ما يمنعه، أينما سكن.
  const s0 = read(f)
  // ويشمل الدورُ اختبارَ الحارس: اختبارٌ يثبت أنّ المنع يعمل **يجب** أن يذكر
  // ما يُمنع، وإلّا صار اختباراً لا يستطيع الفشل.
  const DECLARES_DENYLIST =
    /forbidden:\s*\[|قائمة المنع|deny-list|EgressPolicy|EgressDeniedError|decide\(/.test(s0)
  // وتوثيقُ ما أُزيل دورٌ مشروع أيضاً: تعليقٌ يقول «هذا كان عنوانهم وأُزيل»
  // هو ذاكرةُ الإصلاح. حذفه يمحو سبب الإصلاح ويُغري بإعادته.
  const DOCUMENTS_REMOVAL = /This read `|كان يقرأ|— the upstream|أُزيل|was removed/.test(s0)
  if (DOCUMENTS_REMOVAL && !/https?:\/\/[^\s"'`]*(?:sst\.dev|opncd|anoma\.ly)/.test(s0)) continue
  if (DECLARES_DENYLIST || /old-core-tricks|independence-gate|REBUILD-ON-RUST/.test(r)) continue
  if (HOSTS.test(s0)) note("upstream-host", r, "يذكر مضيفاً من الأعلى خارج قائمة المنع")
}

// ───────────────────────────────────────────────────────────────────────────
// ٧· الحزمة الفارغة تجتاز كل فحص
//
// `providers` و`registry` دخلتا قائمة «النظيفة» وهما مجلّدان فارغان: صفر
// استيراد لأن صفر ملفّات. **شرطٌ يتحقّق بالعدم ليس شرطاً.**
// ───────────────────────────────────────────────────────────────────────────
const pkgsDir = join(ROOT, "packages")
if (existsSync(pkgsDir)) {
  for (const name of readdirSync(pkgsDir)) {
    const dir = join(pkgsDir, name)
    if (!statSync(dir).isDirectory()) continue
    if (!existsSync(join(dir, "package.json"))) {
      note("empty-package", `packages/${name}`, "مجلّد حزمةٍ بلا package.json — يجتاز الفحوص بالعدم")
      continue
    }
    const n = sources(dir).filter((x) => /\.(ts|tsx|rs)$/.test(x)).length
    if (n === 0) note("empty-package", `packages/${name}`, "حزمةٌ بلا ملفّ مصدرٍ واحد — نظافتها بلا معنى")
  }
}

// ───────────────────────────────────────────────────────────────────────────
const RULES = [
  ["old-core-import", "استيراد النواة القديمة"],
  ["barrel-drags-old-core", "برميل يجرّ النواة القديمة"],
  ["declared-not-used", "إعلانٌ بلا استعمال"],
  ["used-not-declared", "استيرادٌ بلا إعلان"],
  ["dead-placeholder", "نائبٌ ميّت في شيءٍ يُنفَّذ"],
  ["upstream-host", "مضيفٌ من الأعلى"],
  ["empty-package", "حزمةٌ فارغة تجتاز بالعدم"],
]

let failed = 0
for (const [rule, label] of RULES) {
  const hits = findings.filter((f) => f.rule === rule)
  if (hits.length === 0) { console.log(`PASS  ${label}`); continue }
  failed += hits.length
  console.log(`FAIL  ${label} — ${hits.length}`)
  for (const h of hits.slice(0, 8)) console.log(`        ${h.where}\n          ${h.why}`)
  if (hits.length > 8) console.log(`        …و${hits.length - 8} أخرى`)
}

console.log(`\nRESULT: ${failed === 0 ? "clean" : failed + " finding(s)"} over ${files.length} files`)
process.exit(failed === 0 ? 0 : 1)
