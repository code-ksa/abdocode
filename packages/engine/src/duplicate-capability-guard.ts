/** S3 — حارس التكرار: نسخة واحدة لكل قدرة.
 *
 * أغلى صنف عيبٍ عندنا (٣ نسخ db في ليلة؛ ١٩ قدرة في ٣٥ تنفيذاً تاريخياً).
 * قبل كتابة وحدةٍ جديدة يُسأل القرص: أتوجد قدرة مكافئة بالاسم المجرّد؟
 * التطابق يرُدّ الكتابة بسببٍ يدلّ على الموجود بدل خلق نسخةٍ ثانية.
 *
 * حارس انحدار ضيّق: لا يمنع تعديل ملفٍ قائم ولا ملفاً بمسارٍ جديد لقدرةٍ
 * جديدة — يمنع فقط اسماً مجرّداً موجوداً في مكانٍ آخر.
 */
import { existsSync, readdirSync, statSync } from "node:fs"
import { basename, dirname } from "node:path"

/** أسماء بنيوية شائعة يتكرر ظهورها بحقٍّ في مجلداتٍ مختلفة — لا تُعدّ تكراراً. */
const STRUCTURAL = new Set(["index", "route", "page", "layout", "types", "utils", "config", "constants", "middleware", "loading", "error", "not-found"])

const bare = (file: string) => basename(file).replace(/\.[cm]?[jt]sx?$/iu, "")

/** يمسح مجلدات المصدر ويعيد خريطة الاسم المجرد → مساراته. */
function capabilityIndex(projectDir: string): Map<string, string[]> {
  const index = new Map<string, string[]>()
  const pending = ["app", "src", "lib", "server", "components"].filter((d) => existsSync(`${projectDir}/${d}`))
  let visited = 0
  try {
    while (pending.length > 0) {
      const rel = pending.pop()!
      for (const entry of readdirSync(`${projectDir}/${rel}`, { withFileTypes: true })) {
        if (++visited > 3_000) return index
        const target = `${rel}/${entry.name}`
        if (entry.isDirectory()) {
          if (!entry.name.startsWith(".") && entry.name !== "node_modules") pending.push(target)
        } else if (/\.[cm]?[jt]sx?$/iu.test(entry.name)) {
          const name = entry.name.replace(/\.[cm]?[jt]sx?$/iu, "")
          if (STRUCTURAL.has(name.toLowerCase())) continue
          const list = index.get(name) ?? []
          list.push(target)
          index.set(name, list)
        }
      }
    }
  } catch { /* مسح ناقص خيرٌ من انهيار الحارس */ }
  return index
}

/**
 * يُستدعى قبل كتابة ملفٍ جديد. `undefined` = مسموح.
 * يُرَدّ فقط إذا كان اسم القدرة المجرّد موجوداً في مسارٍ آخر (نسخة ثانية).
 */
export function duplicateCapabilityViolation(input: { normalizedTarget: string; existsAlready: boolean }, projectDir: string): string | undefined {
  const { normalizedTarget: target, existsAlready } = input
  if (existsAlready) return undefined // تعديل ملفٍ قائم لا خلق نسخة
  if (!/\.[cm]?[jt]sx?$/iu.test(target)) return undefined
  const name = bare(target)
  if (STRUCTURAL.has(name.toLowerCase())) return undefined
  const index = capabilityIndex(projectDir)
  const existing = (index.get(name) ?? []).filter((p) => p.replace(/\\/g, "/") !== target.replace(/\\/g, "/") && dirname(p) !== dirname(target))
  if (existing.length > 0) {
    return `رُفض خلق نسخة ثانية للقدرة «${name}»: موجودة فعلاً في ${existing.join("، ")}. عدّل الموجود أو استورده — لا تنشئ ملفاً ثانياً بنفس الاسم في مسارٍ آخر (أغلى صنف عيبٍ عندنا).`
  }
  return undefined
}
