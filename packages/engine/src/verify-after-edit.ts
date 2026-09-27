/**
 * ميزةُ ذكاءٍ مقيسة (2026-09-27): **التحقّقُ بعد التعديل** — ما يفعله كوديكس وكلود كود قبل أن يقولا «تمّ».
 *
 * مقيس قبلها على المحرّك الحقيقيّ: نموذجٌ يكسر `sum.js` في مشروعٍ له اختبارات ثمّ يقول «Done.» ⇦ الدورُ
 * `completed` بنداءَين، والاختباراتُ لم تُشغَّل، والشيفرةُ المكسورة على القرص. بوّابةُ الاختبارات القائمة
 * لا تُشعلها إلّا كلمةُ «test» في نصّ الطلب — وأغلبُ الطلبات («أصلح»، «أعد الهيكلة») لا تقولها.
 *
 * هنا يُسأل القرصُ لا النموذج: هل للمشروع أمرُ اختبارٍ معرَّف؟ وهل مُسّت شيفرةٌ (لا توثيقٌ) في هذا الدور؟
 * إن كان الجوابان نعم ولم تنجح الاختباراتُ **بعد آخر تعديل**، يشغّلها المضيفُ بنفسه عبر البوّابة نفسِها
 * (`pending`) ويعيد خرجَها إلى النموذج ليصلح — بحدٍّ مسمّى، ثمّ يتوقّف صادقاً بدل أن يعلن الإكمال.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

/** حدُّ مرّات التشغيل المفروض في الدور الواحد: فشلٌ قائمٌ قبلنا لا يحرق الدورَ حتى سقفه. */
export const VERIFY_AFTER_EDIT_RUNS = 3

const readText = (path: string): string => {
  try { return readFileSync(path, "utf8") } catch { return "" }
}

/**
 * أمرُ الاختبار الذي يعرّفه المشروعُ نفسُه، أو `undefined` (فلا يُفرض شيء — الغيابُ لا يُخترع له أمر).
 * سكربتُ npm الافتراضيّ («no test specified») ليس اختباراً. وgo غائبٌ عمداً: خرجُه بلا عدد، فلا يُعتمد له نجاح.
 */
export function projectTestCommand(dir: string): string | undefined {
  const pkgPath = join(dir, "package.json")
  if (existsSync(pkgPath)) {
    let script: unknown
    try { script = (JSON.parse(readText(pkgPath)) as { scripts?: Record<string, unknown> }).scripts?.test } catch { script = undefined }
    if (typeof script === "string" && script.trim().length > 0 && !/no test specified/iu.test(script)) {
      if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm test"
      if (existsSync(join(dir, "yarn.lock"))) return "yarn test"
      if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) return "bun run test"
      return "npm test"
    }
  }
  if (existsSync(join(dir, "pytest.ini")) || /\[tool\.pytest/u.test(readText(join(dir, "pyproject.toml"))) || /\[tool:pytest\]/u.test(readText(join(dir, "setup.cfg"))))
    return "python -m pytest -q"
  if (existsSync(join(dir, "Cargo.toml"))) return "cargo test"
  return undefined
}

/** أوامرُ الاختبار التي يُقرأ خرجُها حكماً (بصيغة الأداة `run …`). */
export const isProjectTestRun = (command: string): boolean =>
  /^run\s+(?:(?:npm|pnpm|yarn)\s+(?:run\s+)?test|bun\s+(?:run\s+)?test|node\s+--test|cargo\s+test|(?:python3?\s+-m\s+)?pytest)\b/iu.test(command)

/** هل يمسّ الأمرُ شيفرةً؟ التوثيقُ والصورُ لا تستدعي تشغيلَ الاختبارات؛ patch يُعدّ شيفرةً (لا يُعرف هدفُه من سطره). */
export function editsCode(command: string): boolean {
  if (/^patch\b/iu.test(command)) return true
  const target = /^(?:write|edit)\s+(\S+)/iu.exec(command)?.[1]
  if (target === undefined) return false
  return !/\.(?:md|mdx|txt|rst|adoc|png|jpe?g|gif|svg|webp|ico)$/iu.test(target)
}

export const verifyDemandLine = (command: string, ranBefore: boolean): string =>
  `↻ التحقّق بعد التعديل (plugins.verifyAfterEdit): عُدّلت شيفرةٌ في مشروعٍ له اختبارات، و${ranBefore ? "آخرُ تشغيلٍ لها فشل أو سبق التعديلَ الأخير" : "لم تُشغَّل بعد"} — يشغّل المضيفُ «${command}» الآن ويعيد خرجَها.`

export const verifyGaveUpLine = (command: string, runs: number): string =>
  `⚠ التحقّق بعد التعديل: «${command}» لم ينجح بعد آخر تعديل رغم ${runs} تشغيلات — لا يُعلَن الإكمال. أصلح الاختبارات أو أطفئ plugins.verifyAfterEdit إن كان فشلُها سابقاً للتعديل.`
