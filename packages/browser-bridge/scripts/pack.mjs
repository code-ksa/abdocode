// تعبئةُ إضافة عبدو كود للمتاجر ولِلتحميل اليدويّ — بلا اعتمادات: يقرأ `extension/` ويخرج في `dist/`:
//   dist/unpacked/chrome-edge/   ← «تحميل غير معبّأ» في كروم وإيدج (chrome://extensions ← وضع المطوّر)
//   dist/unpacked/safari/        ← يُحوَّل على ماك بـ `xcrun safari-web-extension-converter`
//   dist/abdo-code-bridge-chrome-<v>.zip / -edge-<v>.zip / -safari-<v>.zip
// سفاري لا يملك واجهة `debugger` للإضافات فتُنزَع من الصلاحيات (والإضافةُ تعمل بالمسار الاصطناعيّ المعلَن).
// الضغطُ على ويندوز بـbsdtar المدمج (C:\Windows\System32\tar.exe) لأنّ Compress-Archive في PowerShell 5.1
// يكتب المسارات بشرطةٍ خلفية فترفضها المتاجر؛ وعلى غيره بـ`zip`.
//   node scripts/pack.mjs [--deliver <مجلّد>] [--check]
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "..")
const source = join(root, "extension")
const dist = join(root, "dist")
const args = process.argv.slice(2)
const deliverAt = args.includes("--deliver") ? args[args.indexOf("--deliver") + 1] : undefined
const checkOnly = args.includes("--check")

const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"))
const version = String(manifest.version)

/** فحصُ الجاهزية للمتجر — كلُّ عيبٍ سطرٌ، والقائمةُ الفارغة جاهزية. */
function storeReadiness() {
  const issues = []
  const locales = join(source, "_locales")
  const msg = (locale) => JSON.parse(readFileSync(join(locales, locale, "messages.json"), "utf8"))
  if (manifest.manifest_version !== 3) issues.push("manifest_version يجب أن يكون 3")
  if (!manifest.default_locale) issues.push("default_locale غائب رغم __MSG__")
  for (const locale of readdirSync(locales)) {
    const m = msg(locale)
    const desc = [...String(m.appDesc?.message ?? "")].length
    if (desc === 0 || desc > 132) issues.push(`وصفُ ${locale} ${desc} حرفاً — الحدّ 132`)
    const name = [...String(m.appName?.message ?? "")].length
    if (name === 0 || name > 75) issues.push(`اسمُ ${locale} ${name} حرفاً — الحدّ 75`)
  }
  for (const size of ["16", "32", "48", "128"]) {
    const file = manifest.icons?.[size]
    if (!file || !existsSync(join(source, file))) issues.push(`أيقونة ${size} غائبة`)
  }
  for (const file of ["background.js", "popup.html", "popup.js"]) if (!existsSync(join(source, file))) issues.push(`${file} غائب`)
  const bg = readFileSync(join(source, "background.js"), "utf8")
  if (/https?:\/\/(?!127\.0\.0\.1)/.test(bg.replace(/\/\/.*$/gm, "").replace(/\/\^https\?:\\\/\\\//g, ""))) issues.push("background.js يحمل وجهةً غير محلّية")
  if (/eval\(|new Function\(/.test(bg)) issues.push("background.js يستعمل eval — ممنوعٌ في MV3")
  if (!/^\d+\.\d+\.\d+$/.test(version)) issues.push(`الإصدار «${version}» ليس x.y.z`)
  return issues
}

function copyTree(target, transformManifest) {
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  cpSync(source, target, { recursive: true })
  const m = transformManifest(structuredClone(manifest))
  writeFileSync(join(target, "manifest.json"), JSON.stringify(m, null, 2) + "\n")
  return m
}

function zipDir(dir, out) {
  rmSync(out, { force: true })
  const entries = readdirSync(dir)
  const bsdtar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:/Windows", "System32", "tar.exe") : "tar"
  const run = process.platform === "win32"
    ? spawnSync(bsdtar, ["-a", "-cf", out, "-C", dir, ...entries], { stdio: "inherit" })
    : spawnSync("zip", ["-r", "-q", out, ...entries], { cwd: dir, stdio: "inherit" })
  if (run.status !== 0) throw new Error(`فشل الضغط إلى ${out}`)
  return statSync(out).size
}

const issues = storeReadiness()
if (issues.length > 0) { console.error("غير جاهز للمتجر:\n- " + issues.join("\n- ")); process.exit(2) }
console.log(`جاهزٌ للمتجر — Abdo Code Bridge ${version}`)
if (checkOnly) process.exit(0)

mkdirSync(dist, { recursive: true })
const targets = [
  { id: "chrome", dir: "chrome-edge", transform: (m) => m },
  { id: "edge", dir: "chrome-edge", transform: (m) => m },
  { id: "safari", dir: "safari", transform: (m) => { m.permissions = m.permissions.filter((p) => p !== "debugger"); delete m.minimum_chrome_version; return m } },
  // فايرفوكس: MV3 بصفحة أحداثٍ (`background.scripts`) لا عاملَ خدمة، ومعرّفٌ صريح في `browser_specific_settings`
  // (يرفض AMO الحزمةَ بلا معرّف)، وبلا `debugger` — لا توجد الواجهةُ أصلاً في فايرفوكس، فيهبط الإدخالُ إلى
  // الأحداث الاصطناعيّة ويُعلنها الردُّ بـ`mode: "synthetic"` كما في سفاري.
  { id: "firefox", dir: "firefox", transform: (m) => {
    m.permissions = m.permissions.filter((p) => p !== "debugger")
    delete m.minimum_chrome_version
    m.background = { scripts: ["background.js"] }
    // `data_collection_permissions` شرطٌ يفرضه AMO على كلّ حزمة (ردَّ التحقّق حرفياً: "property is missing").
    // وإضافتُنا لا تجمع شيئاً — لا تُرسل إلا إلى 127.0.0.1 ولا تخزّن محتوى صفحات — فتُعلَن `none` صراحةً لا صمتاً.
    // المعرّفُ من نطاق المنتج نفسِه (`io.abdocode.desktop` مقلوباً) لا من نطاق الشركة: حارسُ الخطّين
    // يرفض معرّفَ منتجٍ آخر لنا داخل خطّ النواة، والإضافةُ جزءٌ من عبدو كود لا من مِلكيّةٍ ثانية.
    m.browser_specific_settings = { gecko: { id: "abdo-code-bridge@abdocode.io", strict_min_version: "128.0", data_collection_permissions: { required: ["none"] } } }
    return m
  } },
]
const made = []
for (const t of targets) {
  const unpacked = join(dist, "unpacked", t.dir)
  if (!made.some((m) => m.dir === t.dir)) copyTree(unpacked, t.transform)
  const zip = join(dist, `abdo-code-bridge-${t.id}-${version}.zip`)
  const size = zipDir(unpacked, zip)
  made.push({ id: t.id, dir: t.dir, zip, size })
  console.log(`${t.id.padEnd(7)} ${zip} (${size} بايت)`)
}
if (deliverAt) {
  mkdirSync(deliverAt, { recursive: true })
  for (const m of made) cpSync(m.zip, join(deliverAt, m.zip.slice(dist.length + 1)))
  cpSync(join(dist, "unpacked"), join(deliverAt, "unpacked"), { recursive: true })
  for (const doc of ["README-STORES.md", "PRIVACY.md"]) if (existsSync(join(root, doc))) cpSync(join(root, doc), join(deliverAt, doc))
  console.log(`سُلِّم إلى ${deliverAt}`)
}
