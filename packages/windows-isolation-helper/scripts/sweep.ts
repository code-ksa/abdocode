/**
 * بوّابةُ هذه الحزمة تعمل **ملفاً ملفاً**، لا بسويتةٍ واحدة.
 *
 * قيس 2026-09-03 (كنس ما قبل الإطلاق): `bun test` على الأربعة والأربعين ملفاً
 * معاً يمضي ستّ عشرة دقيقة ثم **ينهار Bun نفسه** بذعرٍ داخلي
 * (`index out of bounds: index 0, len 0`)، وقبل انهياره تبدأ استدعاءاتُ المساعد
 * تعود بلا نتيجةٍ قابلة للقراءة — إحدى وعشرون حالةً في قسم حقن الانهيار، كلُّها
 * تقول «the helper produced no parseable result (exit 66)». وقياسان سابقان
 * انتهت مهلتهما (241 ثانية ثم 560) بلا أيّ حكم.
 *
 * والحقيقةُ أن الحزمة **ليست حمراء**: كلُّ ملفٍّ يمرّ وحده. ‏`appcontainer`
 * ‏26/0، و`recovery` — صاحبُ الإخفاقات نفسِه — ‏29/0، والمسح الكامل ملفاً ملفاً
 * ‏**44 ملفاً · صفر فشل · 541 اختباراً**. فالعيبُ في طريقة التشغيل: أربعة
 * وأربعون ملفاً تُطلق عملياتٍ حقيقية وتقتلها، معاً، تستنزف المضيف.
 *
 * فبقاءُ `bun test` أمرَ البوّابة يعني حزمةً بلا حكمٍ إلى الأبد — وهذا ما حدث.
 */
import { readdirSync } from "node:fs"
import { join } from "node:path"

const PACKAGE_DIR = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1")
const TEST_DIR = join(PACKAGE_DIR, "test")
/** مهلةُ الملفِّ الواحد: أبطأ ملفٍّ مقيس 110 ثوانٍ، فالضِّعفان سقفٌ كريم. */
const FILE_TIMEOUT_MS = 240_000
const COUNTS = /^\s*(\d+)\s+(pass|fail)\s*$/gmu

const files = readdirSync(TEST_DIR).filter((name) => name.endsWith(".test.ts")).sort()
if (files.length === 0) {
  console.error("لا ملفَّ اختبارٍ في test/ — بوّابةٌ بلا مادّةٍ ليست خضراء، هي فارغة")
  process.exit(2)
}

let filesOk = 0
let filesFailed = 0
let filesNoResult = 0
let passed = 0
let failed = 0

for (const name of files) {
  const started = Date.now()
  const child = Bun.spawnSync([process.execPath, "test", join("test", name)], {
    cwd: PACKAGE_DIR,
    stdout: "pipe",
    stderr: "pipe",
    timeout: FILE_TIMEOUT_MS,
  })
  const output = new TextDecoder().decode(child.stdout) + "\n" + new TextDecoder().decode(child.stderr)
  let filePass = 0
  let fileFail = 0
  let sawCounts = false
  for (const match of output.matchAll(COUNTS)) {
    sawCounts = true
    if (match[2] === "pass") filePass += Number(match[1])
    else fileFail += Number(match[1])
  }
  const elapsed = `${((Date.now() - started) / 1000).toFixed(1)}s`
  if (!sawCounts) {
    filesNoResult += 1
    // بلا نتيجةٍ ليست نجاحاً: تُسمّى، ويُطبع ذيلُ ما قاله الابن بدل رقمٍ أصمّ.
    console.log(`✗ ${name} — بلا نتيجةٍ قابلة للقراءة (${elapsed}) · ${output.trim().split("\n").slice(-2).join(" · ").slice(0, 200)}`)
    continue
  }
  passed += filePass
  failed += fileFail
  if (fileFail > 0) { filesFailed += 1; console.log(`✗ ${name} — ${filePass} نجح · ${fileFail} فشل (${elapsed})`) }
  else { filesOk += 1; console.log(`✓ ${name} — ${filePass} (${elapsed})`) }
}

const line = `العزل: ${filesOk}/${files.length} ملفاً أخضر · اختبارات ${passed} نجحت و${failed} فشلت · بلا نتيجة ${filesNoResult}`
console.log(line)
if (filesFailed > 0 || filesNoResult > 0) process.exit(1)
