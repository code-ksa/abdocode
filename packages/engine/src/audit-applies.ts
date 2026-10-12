/**
 * 10-11 (مقيس على m7: مشروعٌ بلا dependencies ولا ملفّ قفل) — بوّابةُ `npm audit` طالبت بتدقيقِ ما لا يوجد: ENOLOCK، ثمّ أربعُ حقبٍ
 * من السرد والتصحيح بعد اكتمال العمل (حقبتان من ستّ كانتا العملَ كلَّه). لا اعتمادياتٍ معلنةً ولا قفلَ ⇦ لا شيءَ يُدقَّق.
 * يُقاس لحظةَ البوّابة لا عند بدء الدور: جولةٌ تضيف اعتماديّةً تعيد البوّابة.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]

export function projectHasDependencies(projectDir: string): boolean {
  if (LOCKFILES.some((name) => existsSync(join(projectDir, name)))) return true
  let pkg: Record<string, unknown>
  try { pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8")) as Record<string, unknown> } catch { return false }
  return ["dependencies", "devDependencies", "optionalDependencies"].some((key) => {
    const block = pkg[key]
    return typeof block === "object" && block !== null && Object.keys(block).length > 0
  })
}

/**
 * 10-11 (مقيس على CRM الثالث): تعديلُ سطر سكربتٍ في package.json («db:drift») عُدَّ «مسّاً للاعتماديات» فصار فشلُ التدقيق الموروث فشلاً
 * يُصلَح وصعد المحرّكُ إلى Pro. البصمةُ هي كتلُ الاعتماديات وملفُّ القفل وحدها — السكربتاتُ والحقولُ الأخرى لا تغيّر ما يُدقَّق.
 */
export function dependencyFingerprint(projectDir: string): string {
  let deps: unknown[] = []
  try {
    const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8")) as Record<string, unknown>
    deps = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides", "resolutions"].map((key) => pkg[key] ?? null)
  } catch { deps = ["unreadable"] }
  const locks = LOCKFILES.map((name) => { try { return Bun.hash(readFileSync(join(projectDir, name))).toString(36) } catch { return "" } })
  return JSON.stringify([deps, locks])
}

/**
 * 10-11 (مقيس على m11 بالمثبَّت 4.0.140): بوّابةُ البناء سقطت بـ«'vite' is not recognized» — الاعتمادياتُ لم تُثبَّت بعد — فعُدّ فشلاً مثبتاً
 * فصعد المحرّكُ إلى Pro وأنفق حقبةً (320 ث). اعتمادياتٌ معلنةٌ بلا node_modules وخرجٌ يقول «الأداةُ غير موجودة» = بيئةٌ لم تُجهَّز لا عيبٌ في الشيفرة:
 * أمرُ التثبيت بمدير الحزم الذي يدلّ عليه ملفُّ القفل. ما عدا ذلك (node_modules موجود، أو خطأٌ آخر) لا شيء.
 */
const MISSING_TOOL = /is not recognized as an internal or external command|:\s*(?:command\s+)?not found\b|Cannot find (?:module|package) ['"][^'"./][^'"]*['"]|ERR_MODULE_NOT_FOUND/iu
export function missingDepsInstall(projectDir: string, output: string): string | undefined {
  if (!MISSING_TOOL.test(output)) return undefined
  if (existsSync(join(projectDir, "node_modules"))) return undefined
  return installCommandFor(projectDir)
}

/** أمرُ تثبيت اعتمادياتٍ معلنةٍ لم تُثبَّت بعد (بمدير حزم المشروع من ملفّ قفله) — `undefined` = لا بيان، أو لا اعتماديات، أو مثبّتة. */
export function installCommandFor(projectDir: string): string | undefined {
  if (!existsSync(join(projectDir, "package.json")) || !projectHasDependencies(projectDir) || existsSync(join(projectDir, "node_modules"))) return undefined
  if (existsSync(join(projectDir, "pnpm-lock.yaml"))) return "pnpm install"
  if (existsSync(join(projectDir, "yarn.lock"))) return "yarn install"
  if (existsSync(join(projectDir, "bun.lock")) || existsSync(join(projectDir, "bun.lockb"))) return "bun install"
  return "npm install"
}
