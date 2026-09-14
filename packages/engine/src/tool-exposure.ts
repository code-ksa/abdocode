/**
 * م9و — إظهارُ الأدوات بحسب النيّة (فكرةُ Pi «setActiveTools/التحميلُ المؤجَّل»، مكتوبةٌ هنا): النموذجُ يرى في كلّ نداءٍ
 * الأدواتِ الأساسيّةَ دائماً، أمّا عائلاتُ المتصفّح وسطح المكتب والتفويض فتُعرض فقط حين يسمّيها الهدفُ، أو حين استُعملت في الدور
 * (الاستعمالُ يوسّع الإظهار)، أو حين استُعملت في الدور السابق (الاستمرارُ «اكمل» لا يفقدها). الإظهارُ عن الواجهة فقط — المُوزِّع
 * ينفّذ أيَّ أداةٍ مسجَّلة سُمّيت باسمها، فلا تُحجب قدرةٌ، إنّما تُوفَّر التوكنات على ما لا يلزم.
 */
export const TOOL_FAMILIES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  browser: ["ui", "page", "open", "tap", "fill", "shot", "scroll", "hover", "key", "find", "dismiss", "network", "console", "look", "surface", "browser", "bridge"],
  desktop: ["desk"],
  delegation: ["team", "delegate", "handoff", "agents"],
})
const FAMILY_OF = new Map<string, string>()
for (const [family, names] of Object.entries(TOOL_FAMILIES)) for (const name of names) FAMILY_OF.set(name, family)

const BROWSER_WORDS = /متصفّ?ح|browser|إضافة المتصفّ?ح|الإضافة|extension|صفحة|page\b|موقع|site\b|website|url|https?:|localhost|تصميم|design|لقطة|screenshot|شاشة|افتح|\bopen\b|واجهة|ui\b|frontend|landing|hero|نافذة الموقع|تحقّ?ق بصرياً|visual/iu
const DESKTOP_WORDS = /سطح المكتب|desktop|computer use|نافذة|window\b|تطبيق سطح|\bapp\b.*(?:افتح|open)|اضغط على|click on the app|desk\b|الماوس|ماوس|الكيبورد|كيبورد|لوحة المفاتيح|\bmouse\b|\bkeyboard\b|فوتوشوب|photoshop|illustrator|premiere|برنامج سطح المكتب|املأ|ملء|عبّئ|تعبئة|نموذج|form\b|fill in|اكتب في|type into|المفكرة|notepad|excel|إكسل|word\b|وورد|تطبيق|application/iu
const DELEGATION_WORDS = /فريق|team\b|وكلاء|وكيل|agent|فوّ?ض|delegate|بالتوازي|parallel|handoff|سلّم المهمّة/iu

export function familyOf(toolName: string): string | undefined { return FAMILY_OF.get(toolName) }

/** عائلاتُ الدور من نصّ الهدف + ما يُورَّث من الدور السابق. */
export function familiesFor(goal: string, inherited: ReadonlySet<string> = new Set()): Set<string> {
  const out = new Set<string>(inherited)
  const text = goal ?? ""
  if (BROWSER_WORDS.test(text)) out.add("browser")
  if (DESKTOP_WORDS.test(text)) out.add("desktop")
  if (DELEGATION_WORDS.test(text)) out.add("delegation")
  return out
}

/** استعمالُ أداةٍ من عائلةٍ يفتح عائلتَها لبقيّة الدور. يعيد true إن تغيّر شيء. */
export function noteToolUse(toolName: string, families: Set<string>): boolean {
  const family = FAMILY_OF.get(toolName)
  if (family === undefined || families.has(family)) return false
  families.add(family)
  return true
}

/** أداةٌ بلا عائلة تُعرض دائماً؛ أداةُ عائلةٍ تُعرض حين تكون عائلتُها مفتوحة. */
export function exposedByIntent(toolName: string, families: ReadonlySet<string>): boolean {
  const family = FAMILY_OF.get(toolName)
  return family === undefined || families.has(family)
}

/** سطرٌ للسجلّ: كم أداةً تُعرض من كم، وأيُّ العائلات مفتوحة. */
export function exposureLine(exposed: number, total: number, families: ReadonlySet<string>): string {
  const open = [...families]
  return `🧰 أدوات معروضة: ${exposed}/${total}${open.length > 0 ? ` (+${open.join("، ")})` : " (الأساسيّة)"}`
}
