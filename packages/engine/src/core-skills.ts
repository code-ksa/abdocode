/**
 * 10-09 — مهاراتُ التشغيل الأساسيّة: حزمةُ `abdo-ops` المضمَّنة (خوادم أوبونتو، Node 24، الحزم، النشر، الإيداع، الدفع، الاختبار،
 * التحقّق قبل التسليم) يراها الوكيلُ في كلّ دورٍ ويحمّل ما يناسب المهمّة بنفسه — كما يعرف كلود مهاراتِه بأسمائها ووصفها ويحمّلها حين
 * تناسب. الحزمُ المضمَّنة الأخرى تبقى «مراجعة ⇦ تثبيت ⇦ تفعيل» من الإعدادات؛ هذه وحدها أساسيّة لأنّها انضباطُ العمل نفسُه لا محتوًى
 * اختياريّ، ومفتاحُها `plugins.opsSkills`. المصدرُ هو الحزمةُ على القرص بجوار المحرّك — لا نسخةَ ثانية من النصّ هنا.
 */
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { listBundledExtensions } from "./bundled-extensions"
import { secretish, type SkillListing } from "./local-extensions"

export const CORE_SKILL_PACKAGES: readonly string[] = Object.freeze(["abdo-ops"])

/** المهاراتُ الأساسيّة كما على القرص — حزمةٌ غائبة أو مشوَّهة ⇦ قائمةٌ فارغة لا استثناء. */
export function coreSkillsCatalogue(root: string | undefined): SkillListing[] {
  return listBundledExtensions(root).entries
    .filter((entry) => CORE_SKILL_PACKAGES.includes(entry.id))
    .flatMap((entry) => entry.skills.map((skill) => ({ ref: `${entry.id}/${skill.id}`, description: skill.description, pkg: entry.name })))
}

/**
 * جسدُ مهارةٍ أساسيّة بمرجعها، أو `undefined` إن لم يكن المرجعُ أساسيّاً (فيُجرَّب المسارُ المحلّيّ كما كان).
 * الملفُّ يُحدَّد من مانيفست الحزمة لا من الاسم، وحارسُ الاعتمادات نفسُه الذي يطبّقه المسارُ المحلّيّ يسري هنا.
 */
export function coreSkillBody(root: string | undefined, ref: string): string | undefined {
  const [pkg, skill] = ref.split("/")
  if (pkg === undefined || skill === undefined || !CORE_SKILL_PACKAGES.includes(pkg)) return undefined
  const entry = listBundledExtensions(root).entries.find((e) => e.id === pkg)
  if (entry === undefined || !entry.skills.some((s) => s.id === skill)) return undefined
  const manifest = JSON.parse(readFileSync(join(entry.path, "abdocode-extension.json"), "utf8")) as { skills?: unknown }
  const rels = Array.isArray(manifest.skills) ? manifest.skills.filter((s): s is string => typeof s === "string") : []
  for (const rel of rels) {
    const file = join(entry.path, rel, "SKILL.md")
    if (!existsSync(file) || statSync(file).size > 64 * 1024) continue
    const text = readFileSync(file, "utf8")
    if (new RegExp(`^---\\r?\\n[\\s\\S]*?^name:\\s*${skill}\\s*$`, "mu").test(text)) {
      if (secretish.test(text)) throw Error("Selected skill contains credential-like data.")
      return text
    }
  }
  return undefined
}

/** سطرُ الإعلان في نظام الوكيل: الأسماءُ والأوصافُ المقصوصة وحدها — الأجسادُ تُحمَّل بالأداة حين تُطلب. */
export function coreSkillsBrief(skills: readonly SkillListing[]): string {
  if (skills.length === 0) return ""
  const lines = skills.map((s) => `- ${s.ref} — ${s.description.replace(/\s+/g, " ").slice(0, 110)}`)
  return `\nمهاراتُ التشغيل (تعليماتٌ لا صلاحيات — قبل أن تبدأ مهمّةَ خادمٍ أو نشرٍ أو حزمٍ أو إيداعٍ أو دفعٍ أو اختبار، حمّل المناسبةَ بـ«نفّذ: skill <المرجع>»، وحمّل verify-delivery قبل أن تعلن الإنجاز):\n${lines.join("\n")}\n`
}
