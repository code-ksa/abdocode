/**
 * 10-10 . كان الشاتُ يغيّر
 * خلفيّةَ المتصفّح والمشروعَ وحدهما. هنا أداةُ `settings` للوكيل: عرضُ الإعدادات، وتغييرُ مفتاحٍ واحد، وتشغيلُ إضافةٍ أو إطفاؤها.
 *
 * هذا الملفّ يحوّل نصَّ الأمر إلى رقعةٍ مُنمَّطة فقط — والحكمُ على القيمة لمدقّق الإعدادات نفسِه (`validateSettingsPatch`) الذي يمرّ به
 * «حفظ وتطبيق»، فلا قاعدةَ ثانية تفترق عن الأولى. ومفاتيحُ الأمان لا تُغيَّر من الشات أبداً: نموذجٌ يرفع صلاحيّته بنفسه أو يفتح التحكّمَ
 * بالجهاز أو يبدّل المزوّد والمفاتيح ليس «تنفيذَ أمر المستخدم» بل بابٌ حول الموافقة — تُقال بالاسم ويُدَلّ على الإعدادات.
 */

/** مفاتيحُ لا تُغيَّر من المحادثة — والسببُ يُعرض كما هو. */
export const CHAT_SETTINGS_FORBIDDEN: Readonly<Record<string, string>> = Object.freeze({
  mode: "نمطُ الصلاحيّات (قراءة فقط/تلقائي/كاملة) لا يرفعه الوكيلُ بنفسه — غيّره من شريحة النمط أو الإعدادات",
  computerUseEnabled: "التحكّمُ بالحاسوب صلاحيّةٌ يمنحها المستخدمُ من الإعدادات وحدها",
  desktopControlEnabled: "التحكّمُ بسطح المكتب صلاحيّةٌ يمنحها المستخدمُ من الإعدادات وحدها",
  remoteControlEnabled: "التحكّمُ عن بُعد يفتح باباً شبكيّاً — من الإعدادات وحدها",
  sensitiveMemoryEnabled: "الذاكرةُ الحسّاسة اختيارُ خصوصيّة — من الإعدادات وحدها",
  customProviders: "المزوّدون وعناوينُهم ومفاتيحُهم من الإعدادات ← المزوّدين",
  mcpServers: "خوادمُ MCP تُضاف من الإعدادات أو بربط الموصّلات",
  projectRoots: "جذورُ المشاريع حدُّ أمان — من الإعدادات",
  projectInstructions: "تعليماتُ المشروع تُكتب في ملفّ AGENTS.md أو من الإعدادات",
  approvalTimeoutSeconds: "مهلةُ الموافقة جزءٌ من بوّابة الموافقة نفسها — من الإعدادات",
  project: "المشروعُ يُفتح بالأداة project-open (بموافقة)",
  plugins: "الإضافاتُ تُبدَّل واحدةً واحدة: settings plugin <الاسم> on|off",
  panelDocks: "تخطيطُ اللوحات من الواجهة",
  priceTable: "جدولُ الأسعار من الإعدادات",
  sellPlan: "خطّةُ البيع من الإعدادات",
  superAbdo: "Super Abdo يُضبط من الإعدادات (كائنٌ مركّب)",
  modelLadder: "سلّمُ النماذج يُضبط من الإعدادات (قائمةٌ مركّبة)",
})

const TRUE_WORDS = /^(?:on|true|yes|1|enable|enabled|تشغيل|شغّل|شغل|فعّل|فعل|تفعيل|مفعّل|نعم)$/iu
const FALSE_WORDS = /^(?:off|false|no|0|disable|disabled|إيقاف|أوقف|اوقف|عطّل|عطل|تعطيل|معطّل|لا)$/iu

export type ChatSettingsCommand =
  | { readonly kind: "show"; readonly key?: string }
  | { readonly kind: "set"; readonly patch: Record<string, unknown>; readonly describe: string }
  | { readonly kind: "error"; readonly why: string }

export const CHAT_SETTINGS_USAGE = "settings [show [المفتاح]] | settings set <المفتاح> <القيمة> | settings plugin <الاسم> on|off"

/** Pure. A typed value from the command text: booleans and integers by shape, anything else stays text for the validator to judge. */
export const typedSettingValue = (raw: string): unknown => {
  const value = raw.trim().replace(/^"(.*)"$/u, "$1")
  if (TRUE_WORDS.test(value)) return true
  if (FALSE_WORDS.test(value)) return false
  if (/^-?\d{1,15}$/u.test(value.replace(/[_,]/gu, ""))) return Number(value.replace(/[_,]/gu, ""))
  return value
}

/**
 * Pure. `settings …` text → a command. `knownKeys` are the settings file's keys (SETTINGS_KEYS), `pluginNames` the registry's,
 * `currentPlugins` the saved plugin map (a plugin toggle keeps every other plugin as saved).
 */
export function parseChatSettingsCommand(rest: string, knownKeys: ReadonlySet<string>, pluginNames: ReadonlySet<string>, currentPlugins: Record<string, unknown> | undefined): ChatSettingsCommand {
  const words = rest.trim().split(/\s+/u).filter((w) => w.length > 0)
  const verb = (words[0] ?? "show").toLowerCase()
  if (verb === "show" || verb === "list" || verb === "status" || verb === "اعرض") return { kind: "show", ...(words[1] !== undefined ? { key: words[1] } : {}) }
  if (verb === "plugin" || verb === "plugins" || verb === "إضافة") {
    const name = words[1]
    if (name === undefined || words[2] === undefined) return { kind: "error", why: `الصيغة: ${CHAT_SETTINGS_USAGE}` }
    if (!pluginNames.has(name)) return { kind: "error", why: `إضافةٌ غير معروفة «${name}» — اعرض الأسماء بـ settings show plugins` }
    const on = typedSettingValue(words[2])
    if (typeof on !== "boolean") return { kind: "error", why: `حالةُ الإضافة on أو off، لا «${words[2]}»` }
    return { kind: "set", patch: { plugins: { ...(currentPlugins ?? {}), [name]: on } }, describe: `الإضافة ${name} ⇦ ${on ? "مفعّلة" : "معطّلة"}` }
  }
  if (verb !== "set") return { kind: "error", why: `الصيغة: ${CHAT_SETTINGS_USAGE}` }
  const key = words[1]
  const raw = words.slice(2).join(" ")
  if (key === undefined || raw.length === 0) return { kind: "error", why: `الصيغة: ${CHAT_SETTINGS_USAGE}` }
  const forbidden = CHAT_SETTINGS_FORBIDDEN[key]
  if (forbidden !== undefined) return { kind: "error", why: `لا يُغيَّر «${key}» من المحادثة: ${forbidden}.` }
  if (!knownKeys.has(key)) return { kind: "error", why: `مفتاحٌ غير معروف «${key}» — اعرض المفاتيح بـ settings show` }
  const value = typedSettingValue(raw)
  return { kind: "set", patch: { [key]: value }, describe: `${key} ⇦ ${typeof value === "string" ? value : JSON.stringify(value)}` }
}

/** موجزٌ يُلحق حين تكون عائلةُ الإعدادات مفتوحة (الطلبُ عن إعدادات عبدو كود نفسِه) — فارغٌ وإلّا. */
export function chatSettingsBrief(families: ReadonlySet<string>): string {
  if (!families.has("settings")) return ""
  return "\n[ABDO_SETTINGS]\nإن طلب المستخدمُ تغييرَ إعدادات عبدو كود نفسِه (نموذج، لغة، سقف، ذاكرة، إشعارات، متصفّح، إضافة): استعمل الأداة settings — " +
    "`settings show` (أو `settings show plugins`) لترى المفاتيحَ وقيمَها، ثمّ `settings set <المفتاح> <القيمة>` أو `settings plugin <الاسم> on|off`. " +
    "لا تعدّل ملفَّ الإعدادات بـwrite/edit، ولا تقل «غيّرتُ» قبل إيصال الأداة «✓ حُفظ». نمطُ الصلاحيّات والتحكّمُ بالجهاز والمزوّدون تُرفض من هنا بالاسم — قل للمستخدم أين يغيّرها.\n"
}

/** Pure. The current settings a chat may change, one per line (no provider data, no secrets — those keys are not listed at all). */
export function renderChatSettings(settings: Record<string, unknown>, knownKeys: ReadonlySet<string>, plugins: readonly { name: string; on: boolean; label: string }[], only?: string): string {
  if (only === "plugins") return ["الإضافات (settings plugin <الاسم> on|off):", ...plugins.map((p) => `${p.on ? "●" : "○"} ${p.name} — ${p.label}`)].join("\n")
  const keys = [...knownKeys].filter((k) => CHAT_SETTINGS_FORBIDDEN[k] === undefined && (only === undefined || k === only)).sort()
  if (keys.length === 0) return only !== undefined && CHAT_SETTINGS_FORBIDDEN[only] !== undefined ? `«${only}» لا يُعرض ولا يُغيَّر من المحادثة: ${CHAT_SETTINGS_FORBIDDEN[only]}.` : `مفتاحٌ غير معروف «${only ?? ""}»`
  const show = (v: unknown) => v === undefined ? "(الافتراض)" : typeof v === "string" ? v : JSON.stringify(v)
  return [
    "إعداداتُ عبدو كود القابلةُ للتغيير من المحادثة (settings set <المفتاح> <القيمة>):",
    ...keys.map((k) => `• ${k} = ${show(settings[k])}`),
    `الإضافات: ${plugins.filter((p) => p.on).length} مفعّلة من ${plugins.length} — settings show plugins`,
    `لا تُغيَّر من المحادثة: ${Object.keys(CHAT_SETTINGS_FORBIDDEN).filter((k) => k !== "plugins").join("، ")}`,
  ].join("\n")
}

const CHANGE_VERB = /(?:غيّ?ر|بدّ?ل|فعّ?ل|عطّ?ل|أوقف|اوقف|أطفئ|اطفئ|شغّ?ل|اجعل|خلّ?ي|حوّ?ل|ارفع|اخفض|زوّ?د|قلّ?ل|ضع|حطّ?|استعمل|استخدم|\b(?:set|change|switch|enable|disable|turn\s+(?:on|off)|use|raise|lower|increase|decrease|make)\b)/iu

/**
 * 10-10 (مقيس في مهمّة n8n): رسالةٌ ذكرت «Settings» (اسمَ شاشةٍ في الموقع المرجع) و«الإصدار 4.0.125» ففتحت عائلةَ الإعدادات، فاخترع النموذجُ
 * طلباً وبدّل نموذجَه العامل إلى «deepseek-v4.1-flash» وقال «تمّ تنفيذ طلبك». الأداةُ تنفّذ أمرَ المستخدم لا رغبةَ النموذج: القيمةُ النصّيّة أو
 * الرقميّة يجب أن تظهر في رسالة المستخدم نفسِها، والتشغيلُ/الإطفاء يحتاج فعلَ تغييرٍ فيها. Pure — يعيد سببَ الرفض أو لا شيء.
 */
/**
 * 10-10 — الاسمُ يُطلب كما
 * يُنطق: الأرقامُ كلُّها في الرسالة، وأجزاءُ الاسم بالإنجليزيّة أو بنطقها العربيّ الشائع. ورسالةٌ فيها «Settings» و«الإصدار 4.0.125» وحدهما لا تطابق.
 */
const SPOKEN: Readonly<Record<string, readonly string[]>> = {
  deepseek: ["ديبسيك", "ديب سيك", "ديبسك", "دييب سيك"], flash: ["فلاش"], pro: ["برو"], qwen: ["كوين", "كيوين"], gpt: ["جي بي تي", "جيبيتي"],
  claude: ["كلود"], gemini: ["جيميناي", "جيميني", "جمناي", "جيمناي"], mini: ["ميني"], nano: ["نانو"], turbo: ["تيربو", "توربو"], opus: ["أوبس", "اوبس"],
  sonnet: ["سونيت"], haiku: ["هايكو"], llama: ["لاما"], mistral: ["ميسترال"], grok: ["جروك", "غروك"], plus: ["بلس"], max: ["ماكس"], coder: ["كودر"],
  nemotron: ["نيموترون"], kimi: ["كيمي"], glm: ["جي ال ام"], minimax: ["ميني ماكس"],
}
const spokenAsked = (text: string, wanted: string): boolean => {
  const tokens = wanted.split(/[/:_\s-]+/u).map((t) => t.replace(/^v(?=\d)/u, "")).filter((t) => t.length > 0)
  const numbers = [...new Set(tokens.filter((t) => /^\d+(?:\.\d+)*$/u.test(t)))]
  const words = [...new Set(tokens.filter((t) => /[a-z]/u.test(t) && !/^\d/u.test(t)))]
  if (numbers.length === 0 && words.length === 0) return false
  const hasNumber = (n: string) => new RegExp(`(?<![\\d.])${n.replace(/\./gu, "\\.")}(?![\\d])`, "u").test(text)
  const hasWord = (w: string) => text.includes(w) || (SPOKEN[w] ?? []).some((spoken) => text.includes(spoken))
  if (!numbers.every(hasNumber)) return false
  const named = words.filter(hasWord).length
  return words.length === 0 ? numbers.length > 0 : named >= Math.ceil(words.length / 2)
}

export function settingsChangeUnasked(userText: string, patch: Record<string, unknown>, isPlugin: boolean): string | undefined {
  const text = String(userText ?? "").normalize("NFKC").toLowerCase()
  if (text.trim().length === 0) return "لا رسالةَ مستخدمٍ في هذا الدور تطلب تغييرَ الإعدادات"
  const entries = Object.entries(patch)
  for (const [key, value] of entries) {
    if (isPlugin || typeof value === "boolean") {
      if (!CHANGE_VERB.test(text)) return `المستخدمُ لم يطلب تغييرَ «${key}» في رسالته — لا تغيّر الإعدادات من تلقاء نفسك`
      continue
    }
    const shown = typeof value === "string" ? value : JSON.stringify(value)
    const wanted = shown.normalize("NFKC").toLowerCase()
    const tail = wanted.includes("/") ? wanted.slice(wanted.lastIndexOf("/") + 1) : wanted
    if (!text.includes(wanted) && !text.includes(tail) && !spokenAsked(text, wanted)) return `القيمةُ «${shown.slice(0, 60)}» لم ترد في رسالة المستخدم — لا تغيّر «${key}» إلا إلى قيمةٍ طلبها المستخدمُ بنصّها`
  }
  return undefined
}
