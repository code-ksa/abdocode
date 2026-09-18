/**
 * عمليّاتُ التشغيل — الطبقةُ الثالثة (ب): «المراد من قول الكلمة» على البنية لا على الملفّات.
 *
 * الكوميت أو النشر أو الإصلاح أو الريستارت أو الباكاب على جوجل درايف». طلباتُ التشغيل خمسَ عشرةَ عمليّةً لا أكثر، وكلُّ
 * لهجةٍ تقولها بكلماتها: «ارفع» و«ادفع» و«بوش» كلُّها دفعٌ؛ «ريستارت» و«شغّله تاني» و«أعد التشغيل» كلُّها إعادةُ تشغيل؛
 * «باكاب» و«نسخة احتياطية» و«خزّن على الدرايف» كلُّها نسخٌ احتياطيّ.
 *
 * المطابقةُ على جذوع الكلمات بعد الطيّ (كما في intent.ts): «والباكاب» تحوي «باكاب»، و«ارفعه» صورةٌ مستقلّة لا مطابقةً
 * جزئيّة. وأوّلُ عمليّةٍ في الجملة تحكم؛ والغموضُ يُعلَن: جملةٌ بلا فعلِ تشغيلٍ تخرج `none`.
 *
 * وفوق العمليّة الأولى أربعةُ أبعادٍ تُقرأ حتمياً (سبرنت S4):
 * - **التسلسل**: الجملةُ تُقطَّع عند الروابط («ثم»، «وبعدين»، «بعدها»، «و» المنفصلة أو الملتصقة بفعلِ تشغيل، then،
 *   and، الفاصلة) إلى خطوات؛ أوّلُ عمليّةٍ في كلّ خطوةٍ تدخل `sequence` بترتيب القول، و`action` هي الأولى منها. الكلمةُ
 *   الثانية في الخطوة الواحدة («نشر التحديث») مفعولٌ لا خطوةٌ — فلا تدخل التسلسل وإن كانت من صور عمليّة.
 * - **الهدف**: ما العمليّةُ عليه — بالترتيب: مقتبَسٌ بين علامتين، ثم اسمٌ معروفٌ (جدولُ الأهدافِ العامّ + ما يمرّره
 *   المستدعي)، ثم ما بعد حرف جرٍّ («على/في/لـ/for/on/to»)، ثم المفعولُ بعد فعلٍ مفرد، ثم موضوعُ السؤال قبل الفعل.
 *   الاسمُ المعروف قبل حرف الجرّ عمداً: في «انشر X على الانتاج» العمليّةُ على X والانتاجُ مكانُها.
 * - **النفي**: «متعملش push»، «لا تدفع»، «don't deploy» — العمليّةُ مسمّاةٌ ومنفيّة؛ الحكمُ على العمليّة الأولى في خطوتها.
 * - **السؤال**: «الباكاب شغّال؟»، «هل اندفع؟» — سؤالٌ عن الحال لا أمرٌ؛ وسؤالُ الصحّة يبقى `health` وما قبله موضوعُه.
 *
 * النواةُ لا تعرف منتَجاً: جدولُ الأهداف هنا بنيةٌ عامّة (خادم، مستودع، قاعدة، موقع، درايف، خدمة…)، وأسماءُ مواقعِ
 * النكهة ومشاريعِها تُمرَّر في `knownTargets` من طبقةٍ تعرفها.
 *
 * هذه الطبقةُ تقول **ماذا** يريد المستخدم لا **كيف**: الكيفُ عند مزوّدي الأدوات (دليلُ العمليّة في أداةٍ باسم `*_intent`
 * يوصلها مزوّدُ أدواتٍ موصول) — المحرّكُ يسمّي العمليّة ويشير إلى الدليل، ولا يخترع سكربتاً.
 */
import { TARGET_STOPS } from "./intent"
import { bare, fold, rawTokens, stems } from "./normalize"

export type OpsAction =
  | "push" | "commit" | "publish" | "fix" | "restart" | "backup" | "restore" | "health"
  | "build" | "install" | "test" | "sync" | "cleanup" | "secrets" | "logs" | "site" | "none"

/** هدفٌ معروفٌ باسمٍ ثابت وصورِه عبر اللهجات. */
export interface KnownTarget { readonly id: string; readonly forms: readonly string[] }

export interface OpsOptions {
  /** أهدافٌ معروفةٌ يمرّرها من يعرف المنتَج (مواقعُه ومشاريعُه) — تُفحص مع الجدول العامّ؛ الأسبقُ في الجملة يحكم. */
  readonly knownTargets?: readonly KnownTarget[]
}

export interface OpsIntent {
  /** العمليّةُ الأولى في الجملة (أو `health` لسؤالِ صحّة). */
  readonly action: OpsAction
  /** العمليّاتُ بترتيب القول — خطوةٌ لكلّ رابط؛ فارغةٌ حين `none`. */
  readonly sequence: readonly OpsAction[]
  /** ما العمليّةُ عليه كما كُتب (بلا أداةٍ ملتصقة). */
  readonly target?: string
  /** جذوعُ الهدف المطويّة — لمطابقة أسماء المواقع والمشاريع عبر الأدوات الملتصقة. */
  readonly targetStems: readonly string[]
  /** معرّفُ الهدف حين يطابق جدولَ الأهداف المعروفة (`server`، `repo`، أو ما مرّره المستدعي). */
  readonly targetId?: string
  /** العمليّةُ مسمّاةٌ ومنفيّة («لا تدفع»). */
  readonly negated: boolean
  /** سؤالٌ عن الحال لا أمرٌ («هل اندفع؟»). */
  readonly question: boolean
  readonly confidence: number
  readonly evidence: readonly string[]
}

const set = (forms: readonly string[]): ReadonlySet<string> => new Set(forms.map((f) => fold(f)))

/** العمليّاتُ عبر اللهجات — الترتيبُ لا يحكم؛ الموضعُ في الجملة يحكم. */
const OPS: ReadonlyArray<{ readonly action: OpsAction; readonly forms: ReadonlySet<string> }> = [
  { action: "push", forms: set(["ادفع", "ادفعه", "ادفعها", "ادفعلي", "ندفع", "دفع", "الدفع", "ارفع", "ارفعه", "ارفعها", "ارفعلي", "ارفعلى", "نرفع", "رفع", "الرفع", "بوش", "push", "pushed", "git push", "ارفع الكود", "ارفع التغييرات", "ابعت للريبو", "ادفع للريبو", "اندفع", "اتدفع", "اترفع", "انرفع", "edfa3", "erfa3", "df3"]) },
  { action: "commit", forms: set(["كوميت", "كومت", "اعمل كوميت", "اعمللي كوميت", "commit", "git commit", "اودع", "أودع", "ايداع", "إيداع", "احفظ التغييرات", "احفظ الشغل", "سجل التغييرات", "خزن الشغل"]) },
  { action: "publish", forms: set(["انشر", "انشره", "انشرها", "انشرلي", "ننشر", "نشر", "النشر", "ديبلوي", "deploy", "deployed", "publish", "published", "release", "طلع نسخة", "طلّع نسخة", "اطلق", "أطلق", "انزل النسخة", "حط على الانتاج", "حطه على السيرفر", "ارفع على السيرفر", "شغله على الانتاج", "go live", "اتنشر", "enshor", "nashr"]) },
  { action: "fix", forms: set(["اصلح", "أصلح", "اصلحه", "اصلحها", "اصلحلي", "صلح", "صلّح", "صلحه", "صلحلي", "نصلح", "فيكس", "fix", "repair", "عالج", "عالجه", "حل المشكلة", "حل المشكله", "مش شغال", "ما يشتغل", "مايشتغل", "بايظ", "خربان", "بيطلع خطأ", "sala7", "sallah", "bayez", "bayza"]) },
  { action: "restart", forms: set(["ريستارت", "ريستار", "restart", "reboot", "ريبوت", "اعد التشغيل", "أعد التشغيل", "اعد تشغيل", "أعد تشغيل", "اعادة تشغيل", "إعادة تشغيل", "شغله تاني", "شغلها تاني", "شغله من جديد", "اقفله وافتحه", "طفي وشغل"]) },
  { action: "backup", forms: set(["باكاب", "باك اب", "backup", "نسخة احتياطية", "نسخه احتياطيه", "نسخة احتياطي", "خزن نسخة", "اعمل نسخة", "احفظ نسخة", "خد باكاب", "خذ باكاب", "احتياطي", "درايف", "جوجل درايف", "google drive", "gdrive", "rclone"]) },
  { action: "restore", forms: set(["استرجع", "إسترجع", "استرجاع", "رجع النسخة", "رجّع النسخة", "رجع الباكاب", "restore", "recover", "استعد", "استعادة", "ارجع لنسخة", "رجعلي"]) },
  { action: "health", forms: set(["شغال", "شغّال", "شغالة", "شغال ولا لا", "الحالة", "status", "health", "افحص", "إفحص", "افحصلي", "فحص", "اتأكد", "تأكد", "اطمن", "طمني", "شوف السيرفر", "السيرفر شغال", "الموقع شغال", "الموقع واقع", "واقع", "واقعة", "is up", "is down", "server up", "server down", "site up", "site down", "running", "is running", "still running", "is working", "it working", "healthy", "alive", "online", "offline", "sha8al", "shaghal", "shagal"]) },
  { action: "build", forms: set(["ابني", "إبني", "ابنيه", "ابنيها", "ابنيلي", "نبني", "بناء", "بيلد", "build", "اعمل بيلد", "كومبايل", "compile", "ابني النسخة", "ابني المثبت", "اعمل المثبت"]) },
  { action: "install", forms: set(["ثبت", "ثبّت", "ثبتلي", "ثبته", "ثبتها", "نثبت", "تثبيت", "install", "انستول", "سطب", "سطبه", "سطبلي", "نزل النسخة", "نزّل النسخة", "ركب النسخة", "ركّب", "ركبه"]) },
  { action: "test", forms: set(["اختبر", "إختبر", "اختبره", "اختبرها", "اختبرلي", "نختبر", "اختبار", "تست", "test", "tests", "قيس", "قِس", "قيسه", "قيسها", "قياس", "measure", "جرب", "جرّب", "جربه", "جربها", "جربلي", "شغل الاختبارات", "run tests", "run the tests", "بوابات", "gates", "garrab", "jarrab"]) },
  { action: "sync", forms: set(["حدث", "حدّث", "حدثه", "حدثلي", "نحدث", "تحديث", "اسحب", "إسحب", "اسحبلي", "نسحب", "سحب", "pull", "sync", "زامن", "مزامنة", "fetch", "هات اخر نسخة", "هات آخر نسخة", "اعمل ابديت", "ابديت", "update"]) },
  { action: "cleanup", forms: set(["نظف", "نظّف", "نظفلي", "تنظيف", "cleanup", "امسح القديم", "شيل القديم", "فضي مساحة", "فضّي مساحة", "احذف القديم", "المساحة", "الديسك", "disk"]) },
  { action: "secrets", forms: set(["مفتاح", "المفتاح", "api key", "apikey", "توكن", "token", "باسورد", "كلمة السر", "كلمة المرور", "الاسرار", "الأسرار", "secret", "secrets", "credentials", "الخزنة", "vault"]) },
  // مقيس 2026-09-17: «افتح داشبورد منصّةُ المواقع» كان فعلَ ملفّاتٍ (open) لا عمليّةً، فلم يُوجَّه النموذجُ إلى دليل الواجهات وخمّن رابطاً.
  { action: "site", forms: set(["داشبورد", "الداشبورد", "دashboard", "dashboard", "لوحة التحكم", "لوحة تحكم", "لوحة الادارة", "لوحة الإدارة", "الادمن", "الأدمن", "admin panel", "افتح الموقع", "افتح موقع", "افتح لوحة", "ادخل على الداشبورد", "ادخل الداشبورد", "افتح الادمن", "افتح الأدمن", "افتح منصّةُ المواقع", "افتح غرفةُ الأخبار", "افتح غرفةُ الأخبار", "افتح السوق", "افتح اوبن عبد", "افتح أوبن عبد", "افتح المدونة", "افتح المدونه"]) },
  { action: "logs", forms: set(["لوج", "اللوج", "لوجات", "logs", "log", "السجل", "السجلات", "شوف الخطأ", "ورني الخطأ", "ايه الخطأ", "الايرور", "stderr"]) },
]

/**
 * الأهدافُ المعروفة في النواة — بنيةٌ عامّة لا منتَج: كلُّ من يشغّل شيئاً له خادمٌ ومستودعٌ وقاعدةٌ وموقع.
 * أسماءُ مواقعِ النكهة ومشاريعِها تُمرَّر في `OpsOptions.knownTargets`.
 */
export const KNOWN_TARGETS: readonly KnownTarget[] = Object.freeze([
  { id: "server", forms: ["السيرفر", "سيرفر", "السيرفرات", "الخادم", "خادم", "server", "vps", "الانتاج", "الإنتاج", "انتاج", "production", "prod", "الاستضافة", "استضافة", "hosting"] },
  { id: "repo", forms: ["الريبو", "ريبو", "المستودع", "مستودع", "repo", "repository", "جيت", "git", "جيت هب", "جيتهب", "github", "gitlab", "الفرع", "branch"] },
  { id: "database", forms: ["الداتابيز", "داتابيز", "الداتا بيز", "قاعدة البيانات", "قاعدة بيانات", "القاعدة", "database", "db", "postgres", "بوستجرس", "mysql", "redis", "الجداول"] },
  { id: "site", forms: ["الموقع", "موقع", "المواقع", "الويب سايت", "الويبسايت", "site", "website", "الدومين", "دومين", "domain", "النطاق"] },
  { id: "drive", forms: ["الدرايف", "درايف", "جوجل درايف", "google drive", "gdrive", "drive", "السحابة", "cloud", "الكلاود"] },
  { id: "service", forms: ["الخدمة", "خدمة", "الخدمات", "service", "pm2", "nginx", "docker", "دوكر", "الكونتينر", "container", "الحاوية", "systemd", "البروسس", "process"] },
  { id: "app", forms: ["التطبيق", "تطبيق", "app", "البرنامج", "برنامج", "الاضافة", "الإضافة", "اضافة", "extension", "الاكستنشن", "plugin", "البلجن", "المثبت", "installer"] },
  { id: "api", forms: ["api", "الباك اند", "الباكند", "backend", "الفرونت", "الفرونت اند", "frontend", "الواجهة", "endpoint", "الاندبوينت"] },
  { id: "machine", forms: ["ويندوز", "windows", "لينكس", "linux", "wsl", "الجهاز", "جهازي", "اللابتوب", "laptop", "الماك", "mac", "localhost"] },
  { id: "dns", forms: ["dns", "كلاودفلير", "cloudflare"] },
  { id: "mail", forms: ["الايميل", "الإيميل", "ايميل", "email", "mail", "mail server", "البريد", "smtp"] },
])

/** روابطُ الخطوات — الرابطُ نفسُه لا يدخل خطوة. */
const CONNECTORS = set(["ثم", "وثم", "بعدين", "وبعدين", "بعدها", "وبعدها", "بعده", "وبعده", "و", "then", "and", "next", "afterwards", "بس", "لكن", "ولكن", "but", "ba3den", "wba3den", "w", "thumma"])
const CONNECTOR_PAIRS = set(["and then", "after that", "بعد كده", "بعد كدا", "بعد ذلك", "بعد هيك", "وبعد كده", "وبعد ذلك"])
/** حروفُ الجرّ المنفصلة التي يتبعها الهدف. */
const PREPS = set(["على", "في", "ل", "الى", "إلى", "ع", "بتاع", "بتاعة", "بتاعت", "حق", "حقت", "مال", "تبع", "من", "for", "on", "to", "of", "at", "from", "into", "onto", "in", "3ala", "3la", "lel", "lil", "fel", "fil", "fi", "men", "min"])
/** النفيُ: أداةٌ مفردة أو ثنائيّة تسبق الفعل. */
const NEG = set(["لا", "ما", "مش", "مو", "موب", "مب", "بلاش", "لأ", "لاء", "ممنوع", "بدون", "اياك", "إياك", "don't", "dont", "don’t", "never", "not", "stop", "avoid", "skip", "without", "la", "mesh", "mish", "msh", "balash", "mamnou3"])
const NEG_PAIRS = set(["لا داعي", "من غير", "ما في", "مافي داعي", "مفيش داعي", "مش لازم", "مو لازم", "ما ابغى", "ما ابي", "ما بدي", "مش عايز", "مش عاوز", "لا اريد", "لا تقم", "do not", "no need"])
/** «ما» بعد هذه ظرفٌ لا نفي: «بعد ما تخلص»، «قبل ما تنشر». */
const BEFORE_MA = set(["قبل", "بعد", "زي", "كل", "اول", "أول", "عشان", "علشان", "لحد", "لغاية", "حتى", "بمجرد", "طالما", "وقت", "ساعة", "لما", "يوم", "مثل", "حسب", "بدل", "غير", "من"])
/** ما يقلب النفي أمراً: «لا تنسى تعمل باكاب». */
const UNNEG = set(["تنسى", "تنسي", "تنساش", "تنسوا", "forget"])
/** صورٌ يمسكها نمطُ الطوق («متـ…ش») وليست نفياً. */
const NOT_NEG = set(["معلش", "معليش", "مفيش"])
/** ما يجعل الجملةَ طلباً مهذّباً لا سؤالاً وإن انتهت بعلامة استفهام. */
const POLITE = set(["ممكن", "تقدر", "تقدري", "تقدروا", "يمكنك", "سمحت", "فضلك", "please", "can you", "could you", "would you", "mind", "momken", "mumkin"])
const Q_LEAD = set(["هل", "is", "are", "does", "did", "has", "have", "was", "were", "will", "hal"])
const Q_TAIL = set(["ولا لا", "ولا لأ", "ولا لاء", "or not", "wala la", "walla la", "ولا ايه", "ولا إيه"])
/** حشوٌ يقطع الهدف فوق قائمة الملفّات: تكرارٌ وزمنٌ وحالٌ وضمائرُ وأفعالُ حالٍ في الأسئلة. */
const EXTRA_STOPS = set(["كلها", "كله", "كلهم", "كلو", "تاني", "ثاني", "مرة", "مره", "حالا", "فورا", "محليا", "الليلة", "بكرة", "بكره", "بكرا", "اليوم", "امبارح", "أمس", "امس", "البارحة", "الاول", "الأول", "اولا", "أولا", "آخر", "اخر", "أحدث", "احدث", "today", "tonight", "tomorrow", "yesterday", "now", "again", "asap", "quickly", "first", "latest", "last", "locally", "remotely", "بسرعة", "بسرعه", "عاجل", "ضروري", "هل", "ممكن", "please", "it", "them", "him", "her", "its", "run", "ran", "work", "works", "worked", "finish", "finished", "done", "ok", "okay", "fine", "succeed", "succeeded", "fail", "failed", "complete", "completed", "ready", "اتعمل", "اتعملت", "تم", "تمت", "خلص", "خلصت", "نجح", "نجحت", "فشل", "فشلت", "اشتغل", "اشتغلت", "باشا", "يا", "فين", "فينه", "وين", "وينه", "أين", "اين", "منين", "كيف", "ازاي", "إزاي", "ليه", "ليش", "ايش", "إيش", "وش", "شو", "ايه", "إيه", "شنو", "where", "why", "how", "what", "which", "when"])
const ARTICLES = set(["the", "a", "an", "my", "our", "your", "this", "that", "el", "al"])

const QUOTED = /[«"“'‘`]([^»"”'’`]{1,120})[»"”'’`]/u
const LEAD_PUNCT = /^[«"“'‘`(\[]+/u
const TRAIL_PUNCT = /[،,.؟?!:;؛»"”'’`)\]]+$/u
const ENDS_CLAUSE = /[،,;؛.]+["”»)]*$/u
const ENDS_QUESTION = /[؟?]+["”»)]*$/u
/** طوقُ النفي الملتصق: «متعملش»، «ماتدفعش»، «مانشرش» — وبالحرف اللاتينيّ «mat3melsh». */
const CIRCUMFIX_AR = /^(?:ما|م)([تين]?)(\p{Script=Arabic}{2,})ش$/u
const CIRCUMFIX_LAT = /^ma?t?([a-z0-9']{2,})sh$/u
const IMPERFECT = new Set(["ت", "ي", "ن"])

interface Word {
  readonly raw: string
  readonly folded: string
  readonly stems: readonly string[]
  readonly endsClause: boolean
  readonly endsQuestion: boolean
  /** الكلمةُ نفسُها نفيٌ ملتصق («متعملش»). */
  readonly circumfix: boolean
}

/**
 * جذوعُ كلمةٍ للعمليّات: جذوعُ التطبيع، ثم صورُ المضارع بلا حرفه («تدفع» ⇦ «دفع»/«ادفع» كي يُفهم «لا تدفع»)،
 * ثم ما داخلَ طوقِ النفي («ماتدفعش» ⇦ «دفع»).
 */
function opsStems(folded: string): { readonly stems: string[]; readonly circumfix: boolean } {
  const out = [...stems(folded)]
  const seen = new Set(out)
  const push = (s: string) => { if (s.length >= 3 && !seen.has(s)) { seen.add(s); out.push(s) } }
  for (const s of [...out]) if (s.length >= 4 && IMPERFECT.has(s[0]!)) { push(s.slice(1)); push(`ا${s.slice(1)}`) }
  let circumfix = false
  if (!NOT_NEG.has(folded)) {
    const ar = CIRCUMFIX_AR.exec(folded)
    if (ar !== null) { circumfix = true; push(ar[2]!); push(`ا${ar[2]!}`); if (ar[1] !== "") push(`${ar[1]}${ar[2]}`) }
    const lat = CIRCUMFIX_LAT.exec(folded)
    if (lat !== null) { circumfix = true; push(lat[1]!) }
  }
  return { stems: out, circumfix }
}

const toWords = (text: string): Word[] => rawTokens(text).map((raw) => {
  const clean = raw.replace(LEAD_PUNCT, "").replace(TRAIL_PUNCT, "")
  const folded = fold(clean)
  const { stems: st, circumfix } = folded.length > 0 ? opsStems(folded) : { stems: [], circumfix: false }
  return { raw: clean, folded, stems: st, endsClause: ENDS_CLAUSE.test(raw), endsQuestion: ENDS_QUESTION.test(raw), circumfix }
})

interface Hit { readonly action: OpsAction; readonly index: number; readonly span: number; readonly text: string }

/** كلُّ ما يقع في المجموعة داخل المدى — ثلاثيّةً فثنائيّةً فمفردةً بجذوعها — بموضعه ومداه. */
function hitsIn(ws: readonly Word[], forms: ReadonlySet<string>, from: number, to: number): Hit[] {
  const out: Hit[] = []
  for (let i = from; i < to; i++) {
    const w = ws[i]!
    const two = i + 1 < to ? `${w.folded} ${ws[i + 1]!.folded}` : undefined
    const three = i + 2 < to ? `${two} ${ws[i + 2]!.folded}` : undefined
    if (three !== undefined && forms.has(three)) { out.push({ action: "none", index: i, span: 3, text: three }); continue }
    if (two !== undefined && forms.has(two)) { out.push({ action: "none", index: i, span: 2, text: two }); continue }
    for (const s of w.stems) if (forms.has(s)) { out.push({ action: "none", index: i, span: 1, text: w.folded }); break }
  }
  return out
}

/** عمليّاتُ مدىً واحد: الأسبقُ ثم الأطول، وما يتداخل مع مقبولٍ يسقط («السيرفر شغال» تبتلع «شغال»). */
function opsHits(ws: readonly Word[], from: number, to: number): Hit[] {
  const all: Hit[] = []
  for (const op of OPS) for (const h of hitsIn(ws, op.forms, from, to)) all.push({ ...h, action: op.action })
  all.sort((a, b) => a.index - b.index || b.span - a.span || b.text.length - a.text.length)
  const kept: Hit[] = []
  let end = -1
  for (const h of all) { if (h.index < end) continue; kept.push(h); end = h.index + h.span }
  return kept
}

const isOpWord = (w: Word): boolean => OPS.some((op) => w.stems.some((s) => op.forms.has(s)))
const isConnector = (ws: readonly Word[], i: number): number => {
  const w = ws[i]!
  const pair = i + 1 < ws.length ? `${w.folded} ${ws[i + 1]!.folded}` : undefined
  if (pair !== undefined && CONNECTOR_PAIRS.has(pair)) return 2
  if (CONNECTORS.has(w.folded)) return 1
  return 0
}
/** «وانشر»: واوُ عطفٍ ملتصقةٌ بفعلِ تشغيلٍ — حدُّ خطوةٍ قبلها. */
const attachedAnd = (w: Word): boolean => w.folded.length > 2 && w.folded.startsWith("و") && !isFormItself(w.folded) && w.stems.some((s) => s !== w.folded && OPS.some((op) => op.forms.has(s)))
const isFormItself = (folded: string): boolean => OPS.some((op) => op.forms.has(folded))

interface Clause { readonly from: number; readonly to: number }

/** تقطيعُ الجملة خطواتٍ عند الروابط وعلامات الفصل وواو العطف الملتصقة. */
function clauses(ws: readonly Word[]): Clause[] {
  const out: Clause[] = []
  let from = 0
  const close = (to: number) => { if (to > from) out.push({ from, to }) }
  for (let i = 0; i < ws.length; i++) {
    const c = isConnector(ws, i)
    if (c > 0) { close(i); i += c - 1; from = i + 1; continue }
    if (i > from && attachedAnd(ws[i]!)) { close(i); from = i }
    if (ws[i]!.endsClause) { close(i + 1); from = i + 1 }
  }
  close(ws.length)
  return out
}

const isStop = (w: Word): boolean => w.folded.length <= 1 || TARGET_STOPS.has(w.folded) || EXTRA_STOPS.has(w.folded) || w.stems.some((s) => TARGET_STOPS.has(s)) || NEG.has(w.folded) || Q_LEAD.has(w.folded) || CONNECTORS.has(w.folded)

/** سطحُ الجذع في الكلمة كما كُتبت مع أداةِ التعريف إن كانت: «للخدمة» بجذع «خدمه» ⇦ «الخدمة»، و«لمنصّةُ المواقع» ⇦ «منصّةُ المواقع». */
function surfaceOf(w: Word, stem: string): string {
  const b = bare(w.raw)
  const p = w.folded.indexOf(stem)
  if (p < 0) return stem
  const prefix = w.folded.slice(0, p)
  const article = prefix.endsWith("ال") || prefix.endsWith("لل") ? "ال" : ""
  return `${article}${b.length === w.folded.length ? b.slice(p, p + stem.length) : stem}`
}

interface Found { readonly text: string; readonly id?: string; readonly by: string }

export function parseOpsIntent(text: string, options: OpsOptions = {}): OpsIntent {
  const ws = toWords(text)
  const evidence: string[] = []
  const known: readonly KnownTarget[] = [...(options.knownTargets ?? []), ...KNOWN_TARGETS]
  const knownForms = known.map((k) => ({ id: k.id, forms: set(k.forms) }))

  // ١) الخطواتُ وعمليّاتُها.
  const steps = clauses(ws)
  const perStep = steps.map((c) => ({ ...c, hits: opsHits(ws, c.from, c.to) }))

  // ٢) السؤال: علامةٌ في الآخر، أو أداةُ استفهامٍ في الأوّل، أو ذيلُ «ولا لا» — والطلبُ المهذّب ليس سؤالاً.
  const polite = ws.some((w, i) => POLITE.has(w.folded) || (i + 1 < ws.length && POLITE.has(`${w.folded} ${ws[i + 1]!.folded}`)))
  const qMark = ws.length > 0 && ws[ws.length - 1]!.endsQuestion
  const qLead = ws.length > 0 && Q_LEAD.has(ws[0]!.folded)
  const qTail = ws.some((w, i) => i + 1 < ws.length && Q_TAIL.has(`${w.folded} ${ws[i + 1]!.folded}`))
  const question = !polite && (qMark || qLead || qTail)
  if (question) evidence.push(`سؤال: ${qMark ? "علامةُ استفهام" : qLead ? `«${ws[0]!.raw}»` : "«ولا لا»"}`)
  else if (polite && (qMark || qLead)) evidence.push("طلبٌ مهذّب لا سؤال")

  // سؤالُ الصحّة: ما قبل «شغال؟» موضوعُه لا خطوةٌ قبله.
  let stepHits = perStep.map((s) => s.hits)
  if (question) {
    stepHits = stepHits.map((hits) => { const at = hits.findIndex((h) => h.action === "health"); return at > 0 ? hits.slice(at) : hits })
  }
  // ما تغطّيه عمليّةٌ لا يدخل هدفاً («نشر التحديث»: التحديثُ مفعولُ النشر لا هدفَ مزامنة).
  const covered = new Set<number>()
  for (const hits of stepHits) for (const h of hits) for (let i = 0; i < h.span; i++) covered.add(h.index + i)

  // ٣) التسلسل: أوّلُ عمليّةٍ في كلّ خطوة، بلا تكرارٍ متتالٍ.
  const sequence: OpsAction[] = []
  const firstHits: { readonly hit: Hit; readonly step: Clause }[] = []
  stepHits.forEach((hits, k) => {
    const h = hits[0]
    const step = perStep[k]!
    if (h === undefined) { if (perStep.length > 1) evidence.push(`خطوة بلا عمليّة: «${ws.slice(step.from, step.to).map((w) => w.raw).join(" ")}»`); return }
    firstHits.push({ hit: h, step })
    evidence.push(`عمليّة ${h.action}: «${h.text}»`)
    if (sequence[sequence.length - 1] !== h.action) sequence.push(h.action)
  })
  if (sequence.length > 1) evidence.push(`تسلسل: ${sequence.join(" ⇦ ")}`)
  const action: OpsAction = sequence[0] ?? "none"
  const first = firstHits[0]?.hit
  const firstStep = firstHits[0]?.step

  // ٤) النفي: أداةٌ قبل عمليّةِ الخطوة (حتى أربع كلمات)، أو طوقٌ ملتصقٌ بها — و«لا تنسى» يقلبه أمراً.
  //    الحكمُ `negated` للعمليّة الأولى؛ ونفيُ خطوةٍ لاحقة يُذكر في الدليل («اعمل كوميت بس متعملش push»).
  const negationOf = (hit: Hit, step: Clause): string | undefined => {
    if (ws[hit.index]!.circumfix) return ws[hit.index]!.raw
    for (let j = hit.index - 1; j >= Math.max(step.from, hit.index - 4); j--) {
      const w = ws[j]!
      const pair = `${w.folded} ${ws[j + 1]!.folded}`
      const lone = NEG.has(w.folded) && !(w.folded === "ما" && j > 0 && BEFORE_MA.has(ws[j - 1]!.folded)) && !(w.folded === "لا" && j > 0 && ws[j - 1]!.folded === "ولا")
      if (!(NEG_PAIRS.has(pair) || lone || w.circumfix)) continue
      if (ws.slice(j + 1, hit.index).some((x) => UNNEG.has(x.folded))) { evidence.push(`«${w.raw}» يليه ما يقلبه أمراً`); return undefined }
      return NEG_PAIRS.has(pair) ? pair : w.raw
    }
    return undefined
  }
  let negated = false
  firstHits.forEach(({ hit, step }, k) => {
    const marker = negationOf(hit, step)
    if (marker === undefined) return
    if (k === 0) negated = true
    evidence.push(k === 0 ? `نفي: «${marker}»` : `نفي في خطوةٍ لاحقة (${hit.action}): «${marker}»`)
  })

  // ٥) الهدف — بالترتيب: اقتباس ⇦ اسمٌ معروف ⇦ بعد حرف جرّ ⇦ مفعولٌ بعد فعلٍ مفرد ⇦ موضوعُ السؤال؛ خطوةُ العمليّة أوّلاً ثم الجملة.
  const take = (from: number, to: number, direction: 1 | -1, limit = 3): string[] => {
    const picked: string[] = []
    for (let i = from; i >= 0 && i < ws.length && i >= (direction === 1 ? from : to) && i < (direction === 1 ? to : from + 1); i += direction) {
      const w = ws[i]!
      if (w.raw.length === 0) continue
      if (covered.has(i) || PREPS.has(w.folded)) break
      if (isStop(w)) { if (picked.length > 0) break; if (direction === -1 && !ARTICLES.has(w.folded)) break; continue }
      if (direction === 1) picked.push(w.raw); else picked.unshift(w.raw)
      if (picked.length >= limit || (direction === 1 && (w.endsClause || w.endsQuestion))) break
    }
    return picked
  }
  const idOf = (t: string): string | undefined => {
    const st = new Set(fold(t).split(/[^\p{L}\p{N}]+/u).filter((x) => x.length > 0).flatMap((x) => stems(x)))
    const whole = fold(t)
    return knownForms.find((k) => k.forms.has(whole) || [...st].some((s) => k.forms.has(s)))?.id
  }
  const knownIn = (from: number, to: number): Found | undefined => {
    let best: { index: number; span: number; text: string; id: string } | undefined
    for (const k of knownForms) for (const h of hitsIn(ws, k.forms, from, to)) {
      if (best !== undefined && (h.index > best.index || (h.index === best.index && h.span <= best.span))) continue
      const w = ws[h.index]!
      const text = h.span === 1 ? (k.forms.has(w.folded) ? w.raw : surfaceOf(w, w.stems.find((s) => k.forms.has(s))!)) : ws.slice(h.index, h.index + h.span).map((x) => x.raw).join(" ")
      best = { index: h.index, span: h.span, text, id: k.id }
    }
    return best === undefined ? undefined : { text: best.text, id: best.id, by: `معروف: ${best.id}` }
  }
  const afterPrep = (from: number, to: number): Found | undefined => {
    for (let i = from; i < to; i++) {
      const w = ws[i]!
      if (covered.has(i)) continue
      if (PREPS.has(w.folded)) { const p = take(i + 1, to, 1); if (p.length > 0) return { text: p.join(" "), by: `بعد «${w.raw}»` }; continue }
      // حرفُ جرٍّ ملتصق: «للسيرفر» ⇦ «السيرفر»، «بالسيرفر» ⇦ «السيرفر».
      const f = w.folded
      const attached = f.startsWith("لل") && f.length >= 5 ? { head: "ال", rest: 2 } : (f.startsWith("بال") || f.startsWith("عال")) && f.length >= 6 ? { head: "ال", rest: 3 } : undefined
      if (attached === undefined || isOpWord(w) || isStop(w)) continue
      const b = bare(w.raw)
      const head = b.length === f.length ? `${attached.head}${b.slice(attached.rest)}` : `${attached.head}${f.slice(attached.rest)}`
      return { text: [head, ...take(i + 1, to, 1, 2)].join(" "), by: `أداةٌ ملتصقة «${w.raw}»` }
    }
    return undefined
  }
  const quoted = QUOTED.exec(text)
  let found: Found | undefined = quoted?.[1] === undefined ? undefined : { text: quoted[1].trim(), by: "اقتباس" }
  if (found === undefined && firstStep !== undefined) found = knownIn(firstStep.from, firstStep.to) ?? afterPrep(firstStep.from, firstStep.to)
  if (found === undefined && first !== undefined && firstStep !== undefined && first.span === 1) {
    const p = take(first.index + 1, firstStep.to, 1)
    if (p.length > 0) found = { text: p.join(" "), by: "مفعولٌ بعد الفعل" }
  }
  if (found === undefined && question && first !== undefined && firstStep !== undefined) {
    const p = take(first.index - 1, firstStep.from, -1)
    if (p.length > 0) found = { text: p.join(" "), by: "موضوعُ السؤال" }
  }
  if (found === undefined && perStep.length > 1) { const f = knownIn(0, ws.length) ?? afterPrep(0, ws.length); if (f !== undefined) found = { ...f, by: `${f.by} (من الجملة كلّها)` } }
  const target = found?.text
  const targetId = found === undefined ? undefined : found.id ?? idOf(found.text)
  if (found !== undefined) evidence.push(`هدف (${found.by}): «${found.text}»${targetId === undefined || found.id !== undefined ? "" : ` ⇦ ${targetId}`}`)
  const targetStems = target === undefined ? [] : [...new Set(fold(target).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0).flatMap((w) => stems(w)))]

  // الثقة: عمليّةٌ واحدةٌ في الجملة كلّها ⇦ 0.8؛ أكثرُ من عمليّةٍ مسمّاة ⇦ 0.6 — كما كانت.
  const distinct = new Set(perStep.flatMap((s) => s.hits.map((h) => h.action))).size
  const confidence = action === "none" ? 0 : distinct === 1 ? 0.8 : 0.6
  return Object.freeze({ action, sequence: Object.freeze(sequence), target, targetStems: Object.freeze(targetStems), targetId, negated, question, confidence, evidence: Object.freeze(evidence) })
}

/** كلُّ العمليّات المعروفة — للفحوص ولمن يبني دليلاً لكلٍّ منها. */
export const OPS_ACTIONS: readonly OpsAction[] = Object.freeze(OPS.map((o) => o.action))
