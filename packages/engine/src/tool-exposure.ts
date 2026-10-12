/**
 * م9و — إظهارُ الأدوات بحسب النيّة (فكرةُ Pi «setActiveTools/التحميلُ المؤجَّل»، مكتوبةٌ هنا): النموذجُ يرى في كلّ نداءٍ
 * الأدواتِ الأساسيّةَ دائماً، أمّا عائلاتُ المتصفّح وسطح المكتب والتفويض فتُعرض فقط حين يسمّيها الهدفُ، أو حين استُعملت في الدور
 * (الاستعمالُ يوسّع الإظهار)، أو حين استُعملت في الدور السابق (الاستمرارُ «اكمل» لا يفقدها). الإظهارُ عن الواجهة فقط — المُوزِّع
 * ينفّذ أيَّ أداةٍ مسجَّلة سُمّيت باسمها، فلا تُحجب قدرةٌ، إنّما تُوفَّر التوكنات على ما لا يلزم.
 */
import { requestedWorkers } from "./parallel-workers"

export const TOOL_FAMILIES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  browser: ["ui", "page", "open", "tap", "fill", "shot", "scroll", "hover", "key", "find", "dismiss", "wait", "network", "console", "look", "next", "surface", "browser", "bridge", "sessions", "history", "select", "upload", "drag", "tabs", "back", "forward", "design", "audit", "compare", "seo", "release-check"],
  desktop: ["desk", "ui-book"],
  delegation: ["team", "delegate", "handoff", "agents", "parallel", "merge"],
  // 10-01 — أدواتُ اليوم بلا عائلة كانت تُعرض في كلّ نداء (≈3 آلاف حرفٍ من الكتالوج): قيس بحمل context-window-live (نافذةٌ 22k
  // تجاوزت المدخلَ فأُسقط تبادل). audit وcompare وseo وrelease-check مع المتصفّح؛ والعروضُ والوضعيّةُ بعائلتين تفتحهما النيّة.
  documents: ["slides", "cv", "drive-upload"],
  connectors: ["connectors", "connect"],
  servers: ["server", "deploy", "secrets"],
  security: ["posture"],
  // 10-10 — مقيس حيّاً: «أوقف إشعارات نهاية الدور من إعداداتك» وأداةُ settings معروضة — فأجاب النموذجُ بلا أداة وحجب المراجعُ الاكتمال.
  // عائلةٌ بكلماتها تُلحق موجزاً يسمّي الأداة (chatSettingsBrief) حين يكون الطلبُ عن إعدادات عبدو كود نفسِه.
  settings: ["settings"],
})
const FAMILY_OF = new Map<string, string>()
for (const [family, names] of Object.entries(TOOL_FAMILIES)) for (const name of names) FAMILY_OF.set(name, family)

const BROWSER_WORDS = /متصفّ?ح|browser|إضافة المتصفّ?ح|الإضافة|extension|صفحة|page\b|موقع|site\b|website|url|https?:|localhost|تصميم|design|لقطة|screenshot|شاشة|افتح|\bopen\b|واجهة|ui\b|frontend|landing|hero|نافذة الموقع|تحقّ?ق بصرياً|visual/iu
// 10-12 (مقيس على المثبَّت 4.0.145: «ما مهاراتك في الكمبيوتر يوز تقدر تفتح انتي جرافيتي» ⇦ «أدوات معروضة 44/91 (الأساسيّة)» بلا desk — فلم يفتح شيئاً).
const DESKTOP_WORDS = /سطح المكتب|desktop|computer[\s-]?use|كمبيوتر\s*يو[زس]|الكمبيوتر\s*يو[زس]|(?:افتح|شغّ?ل|فتح)\s+(?:لي\s+)?(?:ال)?(?:برنامج|تطبيق)|open\s+(?:the\s+)?(?:program|app)\b|antigravity|ان?تي\s*جرافيتي|vs\s*code|vscode|\bcursor\b|كيرسر|كورسر|كورسير|الرسام|\bpaint\b|نافذة|window\b|تطبيق سطح|\bapp\b.*(?:افتح|open)|اضغط على|click on the app|desk\b|الماوس|ماوس|الكيبورد|كيبورد|لوحة المفاتيح|\bmouse\b|\bkeyboard\b|فوتوشوب|photoshop|illustrator|premiere|برنامج سطح المكتب|املأ|ملء|عبّئ|تعبئة|نموذج|form\b|fill in|اكتب في|type into|المفكرة|notepad|excel|إكسل|word\b|وورد|تطبيق|application/iu
const DELEGATION_WORDS = /فريق|team\b|وكلاء|وكيل|agent|فوّ?ض|delegate|بالتوازي|parallel|handoff|سلّم المهمّة/iu
const DOCUMENT_WORDS = /عرض(?:ٌ|ا)?\s*تقديم|بريزنتيشن|بريزنتيشين|برزنتيشن|presentation|slides?\b|شرائح|سلايد|pptx|power\s*point|باور\s*بوينت|باوربوينت|google\s*slides|جوجل\s*سلايد|google\s*(?:drive|docs|sheets)|(?:جوجل\s*)?درايف|مستند(?:ات)?\s*جوجل|جداول\s*جوجل|سير(?:ة|ه)?\s*(?:ال)?ذاتي|السير(?:ة|ه)|(?:^|\s)(?:لل|ال|بال)?سي\s*في(?:\s|$)|\bcv\b|\bcvs\b|resum[eé]|\bats\b|مرش(?:ّ)?ح|candidates?\b|توظيف|hiring|وصف\s*(?:ال)?وظيفي|job\s*description|\.docx\b/iu
// 10-02 — اسمُ خدمةٍ مربوطةٍ أو فعلُ ربطٍ يفتح عائلةَ الموصّلات (الكتالوجُ لا يُحمَّل بها في كلّ نداء).
const CONNECTOR_WORDS = /موص(?:ّ)?ل|تكامل|integration|connector|\bconnect\b|اربط|وص(?:ّ)?ل (?:سلاك|نوشن|جوجل)|slack|سلاك|notion|نوشن|نوتون|gmail|جيميل|google drive|درايف|github|جيت ?هب|asana|اسانا|أسانا|linear|jira|جيرا|confluence|atlassian|figma|فيجما|intercom|granola|gamma/iu
// 10-02 — خادمٌ أو نشرٌ يفتح عائلةَ الخوادم.
// 10-08 — والحاويةُ والخادمُ التجريبيّ طريقا نشرٍ أيضاً (موجزُ الطرق في deploy-routes.ts يُلحق بهذه العائلة).
const SERVER_WORDS = /سيرفر|خادمي|خادم الإنتاج|خادمِ? الاستضافة|\bvps\b|\bssh\b|\bdeploy|انشر المشروع|انشره|نشر المشروع|ارفع المشروع|ارفعه على|استضافة|\bhosting\b|hetzner|digitalocean|\bpm2\b|\bdocker\b|دوكر|حاوية|خادمٍ? تجريبي|سيرفر تجريبي|test server|\bstaging\b|ديبلوي|ديبلوى|خزنة|الأسرار|أسرار المشروع|\.env\b|\bsecrets?\b/iu
const SETTINGS_WORDS = /إعداد(?:ات|اتك|اتي)?|الإعدادات|settings?\b|\bconfig|تفضيل|فع(?:ّ)?ل (?:ال|إضاف|ميز)|عط(?:ّ)?ل (?:ال|إضاف|ميز)|أطفئ|اطفئ|شغ(?:ّ)?ل (?:الإضافة|الميزة)|الإضافة|إضافة \w+ (?:on|off)|plugin|الميزة|سقف (?:الأمان|السحابة|التوكن)|إشعارات|اللغة|\b(?:turnNotifications|cloudTokenCap|turnTokenCap|autoCompact|turnRenewals|memorySearchEnabled|semanticMemoryEnabled|inferredMemoryEnabled|updateCheckEnabled|browserBackend|railPolicy|routerGate|modelRole|chatModel|agentModel|visionModel|workMode)\b/iu
const SECURITY_WORDS = /posture|وضعي(?:ّ)?ة|أمان|الأمان|آمن|security|صلاحي(?:ّ)?ات|permissions?\b|تماسك/iu

export function familyOf(toolName: string): string | undefined { return FAMILY_OF.get(toolName) }

/** عائلاتُ الدور من نصّ الهدف + ما يُورَّث من الدور السابق. */
export function familiesFor(goal: string, inherited: ReadonlySet<string> = new Set()): Set<string> {
  const out = new Set<string>(inherited)
  const text = goal ?? ""
  if (BROWSER_WORDS.test(text)) out.add("browser")
  if (DESKTOP_WORDS.test(text)) out.add("desktop")
  // 10-11 — «بعاملين» / «3 workers» تسمّي عمّالاً ولا تحمل كلمةَ «parallel» أو «وكيل».
  if (DELEGATION_WORDS.test(text) || requestedWorkers(text) !== undefined) out.add("delegation")
  if (DOCUMENT_WORDS.test(text)) out.add("documents")
  if (SECURITY_WORDS.test(text)) out.add("security")
  if (CONNECTOR_WORDS.test(text)) out.add("connectors")
  if (SERVER_WORDS.test(text)) out.add("servers")
  if (SETTINGS_WORDS.test(text)) out.add("settings")
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

/**
 * 🔴 **النيّةُ قد تكون في ما يُقرأ لا في ما كُتب في الطلب.**
 *
 * قِيس حيّاً: مهمّةٌ نصُّها «اقرأ `TASK.md` ونفّذ المراحلَ الأربعَ فيه» — وفي الملفّ
 * مرحلةٌ تطلب لقطةً من موقعٍ مرجعيّ. ولا كلمةَ متصفّحٍ في الطلب، فبقيت عائلةُ المتصفّح
 * مغلقةً **طوال الدور**: لم يرَ النموذجُ أداةً واحدةً منها، ولم يحاول، وسقطت ثلاثةُ بنودٍ
 * في الحَكَم على لقطةٍ لم تُلتقط. والقدرةُ كانت حاضرةً — لكنّ **ما لا يُعرض لا يُطلَب**.
 *
 * فالمسحُ يمتدّ إلى **الملفّات الآمرة** وحدها (TASK/README/SPEC…) وإلى ما يُجلب من
 * الشبكة — لا إلى كلّ قراءة: كلماتٌ مثل «صفحة» و«تصميم» و`ui` تملأ الشيفرةَ العاديّة،
 * فمسحُها كلِّها يفتح كلَّ عائلةٍ دائماً ويُبطل توفيرَ التوكنات الذي وُضع الإظهارُ لأجله.
 */
// 09-30: ABDO-SPRINTS.md وABDO-HANDOFF.md (خطّةُ «اكمل» وتسليمُها) آمرةٌ كـPLAN/TASK — كانت لا تُطابق فبقي المتصفّحُ مغلقاً.
const INSTRUCTION_FILE = /(?:^|[\\/])(?:ABDO-(?:SPRINTS|HANDOFF)|TASK|README|SPEC|INSTRUCTIONS?|AGENTS|BRIEF|PLAN|SPRINTS?|HANDOFF)[^\\/]*\.(?:md|markdown|txt|rst)$/iu

/** سقفُ المسح: أوّلُ عشرين ألفَ محرفٍ — النيّةُ تُعلن في صدر الملفّ لا في ذيله. */
export const RESULT_SCAN_LIMIT = 20_000

/** هل نتيجةُ هذه الأداة **آمرةٌ** فتُمسح نيّتُها؟ */
export function resultCarriesIntent(toolName: string, body: string): boolean {
  if (toolName === "fetch") return true
  if (toolName !== "read") return false
  // **الجسمُ يصلُ والكلمةُ أمامَه**: المُوزِّعُ يمرّر `read TASK.md` لا `TASK.md` وحدها.
  // قِيس حيّاً بمسبارٍ يكتب في stderr: `word=read bodyHead=read TASK.md`. ومسمارٌ كُتب
  // على الشكل المُتخيَّل مرّ أخضرَ والدالّةُ لا تعمل — التوقيعُ يُقرأ من المصدر لا يُفترض.
  const tokens = String(body).trim().split(/\s+/u).filter((t) => t.length > 0)
  const path = tokens[0] === toolName ? tokens[1] : tokens[0]
  return INSTRUCTION_FILE.test(path ?? "")
}

/**
 * يوسّع العائلاتِ من نتيجةِ أداةٍ آمرة، ويعيد ما أُضيف (فارغٌ = لا جديد).
 * يعدّل `families` في مكانها كما يفعل `noteToolUse` — نقطةُ حقيقةٍ واحدة للعائلات.
 */
export function familiesFromResult(toolName: string, body: string, output: string, families: Set<string>): string[] {
  if (!resultCarriesIntent(toolName, body)) return []
  const added: string[] = []
  for (const family of familiesFor(String(output ?? "").slice(0, RESULT_SCAN_LIMIT))) {
    if (families.has(family)) continue
    families.add(family)
    added.push(family)
  }
  return added
}

/**
 * 10-12 (مقيس: «افتح برنامج Antigravity واكتب في مربّع محادثة Gemini … ثمّ أرسله» ⇦ الموجِّهُ قرأ مجلّداً فارغاً، ثمّ كتب النموذجُ «تقريرَ توجيه» من
 * عدّة نداءاتٍ في ردٍّ واحد (192 ث) فرُفض، ومضت المهلةُ بلا desk واحد). طلبُ تشغيل تطبيقٍ أو الكتابةِ في برنامجٍ آخر ليس مشروعاً برمجيّاً.
 */
const DESKTOP_DRIVE = /(?:افتح|شغّ?ل|فتح|open|launch|start)\s+(?:لي\s+|the\s+)?(?:ال)?(?:برنامج|تطبيق|program\b|app\b|antigravity|ان?تي\s*جرافيتي|cursor|كورسير|كيرسر|vs\s*code|vscode|notepad|المفكرة|word\b|excel\b|chrome\b|كروم)|كمبيوتر\s*يو[زس]|computer[\s-]?use|(?:اكتب|ارسل|أرسل|ابعث)\s+(?:في|ل|لـ|الى|إلى|to)?\s*(?:مربّع\s+)?(?:محادثة\s+)?(?:gemini|جيميناي|جيمناي|chatgpt|claude|كلود|codex|كوديكس)/iu
export const isDesktopDriveTask = (text: string): boolean => DESKTOP_DRIVE.test(text)

export const DESKTOP_DRIVE_BRIEF = "\n[طلبُ تحكّمٍ بالكمبيوتر — لا مشروعَ برمجيّاً هنا: لا تقرأ المجلّدَ ولا تكتب ملفّات. اعمل كما يعمل مشغّلُ الكمبيوتر، أداةً واحدةً في كلّ ردّ: «desk open <اسم التطبيق>» (يفتحه باسمه في قائمة ابدأ ويربط نافذتَه) ← «desk ui» (في رأسه سطرا «للكتابة» و«للإرسال»: مربّعُ الإدخال وزرُّ الإرسال بمراجعهما — إن ظهر المربّعُ فلا تضغط أزرارَ التبديل Toggle؛ نافذةُ Electron تُقرأ ثانيةً تلقائيّاً) ← انقر مربّعَ الإدخال بـ«desk click <x> <y>» في وسط عنصره ← «desk type <النصّ>» ← «desk press <مرجعُ زرّ الإرسال>» (أو «desk key enter») ← «desk ui» لتتحقّق أنّ الرسالةَ أُرسلت (المربّعُ فرغ وظهرت المحادثة). ثمّ قل ما فعلتَ بالإيصالات.]\n"
