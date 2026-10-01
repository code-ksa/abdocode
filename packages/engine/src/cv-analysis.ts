/**
 * `cv` — تحليلُ السِّيَر الذاتيّة ومطابقتُها بوصفٍ وظيفيّ، حتميّاً قبل النموذج (سلّمُ الأدوات: الكودُ أوّلاً).
 * النصُّ يأتي من القارئ نفسِه (PDF عبر pdftotext، وDOCX عبر docx-read، وTXT/MD كما هي)؛ هنا يُقاس فقط:
 *  - الأقسام (الملخّص، الخبرة، التعليم، المهارات، المشاريع، الشهادات، اللغات) بالعربيّة والإنجليزيّة.
 *  - وسائلُ التواصل **حضوراً لا قيمة**: التقريرُ لا يطبع بريداً ولا هاتفاً ولا اسماً.
 *  - سنواتُ الخبرة من نطاقات التواريخ داخل قسم الخبرة (تُدمج المتداخلةُ فلا تُعدّ مرّتين).
 *  - النقاطُ: كم منها بأرقامٍ قابلةٍ للقياس، وكم يبدأ بفعل إنجاز، وعباراتُ الواجب الضعيفة («مسؤول عن»).
 *  - ما يقرؤه نظامُ ATS: نصٌّ قابلٌ للاستخراج، الطول، والبياناتُ الشخصيّة الزائدة (تاريخ الميلاد، الحالة الاجتماعيّة…).
 *  - المطابقةُ بالوصف: الكلماتُ المفتاحيّة للوصف (تكرارٌ + قائمةُ مهاراتٍ مركّبة) ⇦ الموجودُ والناقص بالترتيب.
 * المطابقةُ كلُّها على نصٍّ مُطبَّع (normalizeArabic + أحرفٌ صغيرة) — الحارسُ العربيّ بلا تطبيعٍ ثغرة.
 */
import { normalizeArabic } from "./front-gate"

export type CvSectionKey = "summary" | "experience" | "education" | "skills" | "projects" | "certifications" | "languages"
export const CV_SECTION_KEYS: readonly CvSectionKey[] = ["summary", "experience", "education", "skills", "projects", "certifications", "languages"]

/** نصُّ مطابقة: تطبيعٌ عربيّ ثمّ أحرفٌ صغيرة. لا يمسّ ما يُعرض. */
export const cvNorm = (text: string): string => normalizeArabic(text).toLowerCase()

/** مجموعةٌ مُطبَّعة: كلُّ كلمةٍ تمرّ بـcvNorm كي تطابق نصّاً مُطبَّعاً. */
const normSet = (words: readonly string[]): ReadonlySet<string> => new Set(words.map(cvNorm))

/** «ال» التعريف تُنزع من الكلمة العربيّة كي تطابق «الخبرات» «خبرات». */
const bareWord = (w: string): string => w.replace(/^ال(?=[؀-ۿ]{3})/u, "")

/** كلماتُ العناوين مُطبَّعةً بلا «ال» (ة⇦ه، أ⇦ا، ى⇦ي). */
const SECTION_TERMS_RAW: Readonly<Record<CvSectionKey, readonly string[]>> = {
  summary: ["summary", "profile", "objective", "about me", "about", "overview", "ملخص", "نبذه", "نبذه عني", "عني", "هدف", "ملف شخصي"],
  experience: ["experience", "employment", "work history", "career history", "employment history", "professional background", "خبره", "خبرات", "سجل وظيفي", "مسيره مهنيه", "تاريخ وظيفي"],
  education: ["education", "academic background", "qualifications", "qualification", "academics", "تعليم", "مؤهلات", "مؤهل", "مؤهل علمي", "مؤهلات علميه", "تحصيل علمي", "دراسه"],
  skills: ["skills", "competencies", "technologies", "tech stack", "expertise", "tools", "مهارات", "كفاءات", "تقنيات"],
  projects: ["projects", "portfolio", "مشاريع", "اعمال"],
  certifications: ["certifications", "certification", "certificates", "licenses", "courses", "training", "شهادات", "دورات", "رخص"],
  languages: ["languages", "لغات"],
}
/** المصطلحاتُ مُطبَّعةً بالدالّة نفسِها التي تُطبِّع السطر — «مؤهلات» تصير «موهلات» في الطرفين. */
const SECTION_TERMS = Object.fromEntries(CV_SECTION_KEYS.map((k) => [k, SECTION_TERMS_RAW[k].map((t) => t.split(" ").map((w) => bareWord(cvNorm(w))).join(" "))])) as unknown as Readonly<Record<CvSectionKey, readonly string[]>>

/** ما يجوز أن يرافق كلمةَ القسم في عنوانه — وإلا فالسطرُ نصٌّ («Customer Service Training» ليس عنوانَ شهادات). */
const QUALIFIERS = normSet([
  "professional", "work", "technical", "core", "key", "academic", "relevant", "additional", "personal", "selected", "other", "soft", "hard", "my",
  "and", "&", "/", "و", "عمليه", "مهنيه", "تقنيه", "علميه", "شخصيه", "تدريبيه", "اساسيه", "اخري", "وظيفي", "وظيفيه", "اكاديميه",
])

/** عنوانُ قسم؟ سطرٌ قصير كلماتُه كلمةُ قسمٍ ومرافقاتٌ مسموحة فقط. pdftotext -layout يضمّ العنوانَ وعموداً مجاوراً في سطرٍ واحد
 * («Skills      Kafka, Spark» — مقيس على PDF حفظه Word)، فالعمودُ الأوّل قبل ثلاث مسافاتٍ يُسأل وحده أيضاً. */
export function sectionOf(line: string): CvSectionKey | undefined {
  const firstColumn = line.trim().split(/\s{3,}/u)[0] ?? ""
  return headingOf(line) ?? (firstColumn.length < line.trim().length ? headingOf(firstColumn) : undefined)
}

function headingOf(line: string): CvSectionKey | undefined {
  const bare = cvNorm(line).replace(/^[\s#*\-•●▪◦|=_]+|[\s:：*\-|=_]+$/gu, "").trim()
  if (bare.length === 0 || bare.length > 40 || /[@]|https?:|\d/u.test(bare)) return undefined
  const words = bare.split(/\s+/u).map(bareWord)
  if (words.length > 5) return undefined
  for (const key of CV_SECTION_KEYS) {
    for (const term of [...SECTION_TERMS[key]].sort((a, b) => b.length - a.length)) {
      const t = term.split(" ")
      const at = words.findIndex((_, i) => t.every((w, j) => words[i + j] === w))
      if (at < 0) continue
      const left = [...words.slice(0, at), ...words.slice(at + t.length)]
      if (left.every((w) => QUALIFIERS.has(w))) return key
    }
  }
  return undefined
}

const MONTHS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^(?:jan(?:uary)?|يناير|كانون الثاني)$/u, 1], [/^(?:feb(?:ruary)?|فبراير|شباط)$/u, 2], [/^(?:mar(?:ch)?|مارس|اذار)$/u, 3],
  [/^(?:apr(?:il)?|ابريل|نيسان)$/u, 4], [/^(?:may|مايو|ايار)$/u, 5], [/^(?:jun(?:e)?|يونيو|يونيه|حزيران)$/u, 6],
  [/^(?:jul(?:y)?|يوليو|يوليه|تموز)$/u, 7], [/^(?:aug(?:ust)?|اغسطس|اب)$/u, 8], [/^(?:sep(?:t(?:ember)?)?|سبتمبر|ايلول)$/u, 9],
  [/^(?:oct(?:ober)?|اكتوبر|تشرين الاول)$/u, 10], [/^(?:nov(?:ember)?|نوفمبر|تشرين الثاني)$/u, 11], [/^(?:dec(?:ember)?|ديسمبر|كانون الاول)$/u, 12],
]
const monthOf = (word: string | undefined): number | undefined => {
  if (word === undefined) return undefined
  const w = word.replace(/\.$/u, "").trim()
  if (/^\d{1,2}$/u.test(w)) { const n = Number(w); return n >= 1 && n <= 12 ? n : undefined }
  return MONTHS.find(([re]) => re.test(w))?.[1]
}

const MONTH_WORD = "(?:[a-z]{3,9}\\.?|[\\u0600-\\u06ff]{3,7}(?: [\\u0600-\\u06ff]{4,6})?|\\d{1,2})"
const PRESENT = "present|current|now|today|ongoing|date|الان|حاليا|الحالي|حتي الان|حتي تاريخه|مستمر"
/** «Jan 2020 – Present» و«03/2019 - 2021» و«2018 إلى الآن» على نصٍّ مُطبَّع. */
const RANGE = new RegExp(
  `(?:(${MONTH_WORD})[\\s/.-]+)?((?:19|20)\\d\\d)\\s*(?:-|–|—|to|until|till|الي|حتي|ـ)\\s*(?:(${MONTH_WORD})[\\s/.-]+)?((?:19|20)\\d\\d|${PRESENT})`,
  "gu",
)

export interface MonthSpan { readonly from: number; readonly to: number }

/** نطاقاتُ التواريخ في نصٍّ مُطبَّع، بالأشهر منذ السنة 0. «حتى الآن» = now. */
export function dateSpans(normText: string, now: Date): MonthSpan[] {
  const nowMonth = now.getUTCFullYear() * 12 + now.getUTCMonth()
  const spans: MonthSpan[] = []
  for (const m of normText.matchAll(RANGE)) {
    const startYear = Number(m[2])
    const from = startYear * 12 + ((monthOf(m[1]) ?? 1) - 1)
    const endYear = /^\d{4}$/u.test(m[4]!) ? Number(m[4]) : undefined
    // سنةٌ بلا شهر في النهاية = حتى آخرها؛ «حتى الآن» = الشهرُ الجاري.
    const to = endYear === undefined ? nowMonth : endYear * 12 + ((monthOf(m[3]) ?? 12) - 1)
    if (to >= from && to <= nowMonth + 1 && startYear >= 1960) spans.push({ from, to: to + 1 })
  }
  return spans
}

/** مجموعُ الأشهر بعد دمج المتداخل — وظيفتان متوازيتان لا تُحسبان سنتين. */
export function mergedMonths(spans: readonly MonthSpan[]): number {
  const sorted = [...spans].sort((a, b) => a.from - b.from)
  let total = 0
  let cur: { from: number; to: number } | undefined
  for (const s of sorted) {
    if (cur === undefined || s.from > cur.to) { if (cur !== undefined) total += cur.to - cur.from; cur = { ...s } }
    else cur.to = Math.max(cur.to, s.to)
  }
  if (cur !== undefined) total += cur.to - cur.from
  return total
}

const ACTION_VERBS = normSet([
  "led", "built", "designed", "developed", "delivered", "improved", "increased", "reduced", "launched", "managed", "created",
  "implemented", "automated", "migrated", "optimized", "optimised", "architected", "owned", "drove", "scaled", "shipped", "mentored",
  "established", "negotiated", "achieved", "grew", "cut", "saved", "streamlined", "introduced", "spearheaded", "coordinated", "trained",
  // بالرسم الطبيعيّ (همزات وشدّات) — normSet يطبّعها كما يُطبَّع النصّ.
  "قُدتُ", "طوّرتُ", "بنيتُ", "صمّمتُ", "أطلقتُ", "حسّنتُ", "زدتُ", "خفّضتُ", "أدرتُ", "أنشأتُ", "نفّذتُ", "أشرفتُ", "أسّستُ", "حقّقتُ", "رفعتُ", "قلّلتُ", "وفّرتُ", "أعددتُ", "درّبتُ", "نقلتُ",
])
const WEAK_PHRASES = /\b(?:responsible for|duties included|tasked with|worked on|helped with)\b|(?:^|\s)(?:مسوول عن|مسؤول عن|مسووليات|مهامي|كنت مسوول)/u
const PERSONAL = ([
  ["تاريخ الميلاد / date of birth", /\b(?:date of birth|d\.o\.b|dob|birth date)\b|تاريخ الميلاد|مواليد/u],
  ["الحالة الاجتماعيّة / marital status", /\bmarital status\b|الحاله الاجتماعيه|متزوج|اعزب/u],
  ["الديانة / religion", /\breligion\b|الديانه/u],
  ["الجنس / gender", /\bgender\b|(?:^|\s)الجنس(?:\s|:|$)/u],
  ["العمر / age", /(?:^|\s)age\s*[:：]|(?:^|\s)العمر\s*[:：]/u],
] as const)

const BULLET = /^\s*(?:[-–•●▪◦*]|\d{1,2}[.)])\s+(.+)$/u

export interface CvFinding { readonly severity: "error" | "warn" | "info"; readonly check: string; readonly detail: string }

export interface CvAnalysis {
  readonly label: string
  readonly words: number
  readonly sections: Readonly<Record<CvSectionKey, boolean>>
  readonly contact: { readonly email: boolean; readonly phone: boolean; readonly linkedin: boolean; readonly github: boolean; readonly website: boolean }
  /** بالسنوات مقرّبةً لنصف سنة؛ undefined = لا نطاقَ تواريخ. */
  readonly experienceYears: number | undefined
  /** النطاقاتُ حُسبت من قسم الخبرة وحده، أم من النصّ كلّه لغيابه. */
  readonly experienceScope: "section" | "whole-text"
  readonly bullets: number
  readonly quantified: number
  readonly actionLed: number
  readonly findings: readonly CvFinding[]
  readonly score: number
  /** نصٌّ مُطبَّع للمطابقة — لا يُطبع. */
  readonly norm: string
}

/** سيرةٌ واحدة ⇦ قياساتٌ ونتائج. `now` للاختبار (تاريخُ «حتى الآن»). */
export function analyzeCv(label: string, text: string, now: Date = new Date()): CvAnalysis {
  const lines = text.split(/\r?\n/u)
  const norm = cvNorm(text)
  const words = norm.split(/\s+/u).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
  const sections = Object.fromEntries(CV_SECTION_KEYS.map((k) => [k, false])) as Record<CvSectionKey, boolean>
  // أسطرُ قسم الخبرة: من عنوانه حتى العنوان التالي.
  const experienceLines: string[] = []
  let current: CvSectionKey | undefined
  for (const line of lines) {
    const heading = sectionOf(line)
    if (heading !== undefined) { sections[heading] = true; current = heading; continue }
    if (current === "experience") experienceLines.push(line)
  }
  const contact = {
    email: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/u.test(norm),
    phone: /(?:\+|00)?\d[\d\s().-]{7,}\d/u.test(norm.replace(/(?:19|20)\d\d\s*[-–—]\s*(?:(?:19|20)\d\d)/gu, "")),
    linkedin: /linkedin\.com\/(?:in|pub)\//u.test(norm),
    github: /github\.com\/[\w-]+/u.test(norm),
    website: /https?:\/\/(?!(?:www\.)?(?:linkedin|github)\.com)[\w.-]+\.[a-z]{2,}/u.test(norm),
  }
  const scope: CvAnalysis["experienceScope"] = sections.experience && experienceLines.length > 0 ? "section" : "whole-text"
  const spans = dateSpans(scope === "section" ? cvNorm(experienceLines.join("\n")) : norm, now)
  const experienceYears = spans.length === 0 ? undefined : Math.round(mergedMonths(spans) / 6) / 2

  let bullets = 0, quantified = 0, actionLed = 0, weak = 0
  for (const line of lines) {
    const m = BULLET.exec(line)
    if (m === null) continue
    bullets++
    const body = cvNorm(m[1]!)
    if (/\d/u.test(body) || /%|٪/u.test(m[1]!)) quantified++
    const first = body.replace(/^[^\p{L}]+/u, "").split(/\s+/u)[0] ?? ""
    if (ACTION_VERBS.has(first) || ACTION_VERBS.has(first.replace(/^و/u, ""))) actionLed++
    if (WEAK_PHRASES.test(body)) weak++
  }

  const findings: CvFinding[] = []
  if (words < 40) findings.push({ severity: "error", check: "no-text", detail: `${words} كلمةً فقط قابلةً للاستخراج — غالباً صورةٌ ممسوحة؛ نظامُ ATS لا يقرأ منها شيئاً. أعد تصديرها نصّاً (PDF من المحرّر لا من الماسح).` })
  for (const key of ["experience", "education", "skills"] as const) {
    if (!sections[key]) findings.push({ severity: "warn", check: `section:${key}`, detail: `لا عنوانَ لقسم ${SECTION_LABEL[key]} — أنظمةُ ATS تبحث عنه بالاسم الشائع.` })
  }
  if (!contact.email) findings.push({ severity: "error", check: "contact:email", detail: "لا بريدَ إلكترونيّ في النصّ المستخرج (أو هو داخل صورة/رأس صفحةٍ لا يُقرأ)." })
  if (!contact.phone) findings.push({ severity: "warn", check: "contact:phone", detail: "لا رقمَ هاتف في النصّ المستخرج." })
  if (!contact.linkedin) findings.push({ severity: "info", check: "contact:linkedin", detail: "لا رابطَ LinkedIn." })
  if (words >= 40 && words < 180) findings.push({ severity: "warn", check: "length", detail: `${words} كلمةً — أقصرُ من أن تُظهر خبرةً قابلةً للتقييم.` })
  if (words > 1200) findings.push({ severity: "warn", check: "length", detail: `${words} كلمةً (~${Math.ceil(words / 550)} صفحات) — صفحتان حدٌّ عمليّ لأغلب الوظائف.` })
  if (bullets >= 4 && quantified / bullets < 0.3) findings.push({ severity: "warn", check: "quantified", detail: `${quantified}/${bullets} نقطةً فيها رقمٌ قابلٌ للقياس — الإنجازُ بلا رقمٍ وصفُ مهمّة.` })
  if (bullets >= 4 && actionLed / bullets < 0.4) findings.push({ severity: "info", check: "action-verbs", detail: `${actionLed}/${bullets} نقطةً تبدأ بفعل إنجاز (led/built/طوّرتُ…).` })
  if (weak > 0) findings.push({ severity: "info", check: "weak-phrases", detail: `${weak} نقطةً بصيغة واجب («responsible for»/«مسؤول عن») لا نتيجة.` })
  if (bullets === 0 && words >= 180) findings.push({ severity: "warn", check: "bullets", detail: "لا نقاطَ — فقراتٌ طويلةٌ يتخطّاها القارئ ونظامُ ATS معاً." })
  const personal = PERSONAL.filter(([, re]) => re.test(norm)).map(([name]) => name)
  if (personal.length > 0) findings.push({ severity: "info", check: "personal-data", detail: `بياناتٌ شخصيّة فوق التواصل: ${personal.join("، ")} — تُطلب في بعض الأسواق وتُنصح بحذفها في أخرى؛ قرّر حسب السوق المستهدف.` })
  if (experienceYears === undefined && sections.experience) findings.push({ severity: "warn", check: "dates", detail: "قسمُ الخبرة بلا نطاقات تواريخ (مثل «Jan 2020 – Present») — المدّةُ لا تُحسب." })

  const score = Math.max(0, 100 - 25 * findings.filter((f) => f.severity === "error").length - 8 * findings.filter((f) => f.severity === "warn").length)
  return { label, words, sections, contact, experienceYears, experienceScope: scope, bullets, quantified, actionLed, findings, score, norm }
}

const SECTION_LABEL: Readonly<Record<CvSectionKey, string>> = {
  summary: "الملخّص (Summary)", experience: "الخبرة (Experience)", education: "التعليم (Education)", skills: "المهارات (Skills)",
  projects: "المشاريع (Projects)", certifications: "الشهادات (Certifications)", languages: "اللغات (Languages)",
}

const STOPWORDS = normSet([
  "the", "and", "or", "a", "an", "to", "of", "in", "on", "for", "with", "as", "at", "by", "from", "is", "are", "be", "will", "you", "your", "we", "our",
  "this", "that", "these", "those", "it", "its", "their", "they", "who", "what", "which", "have", "has", "had", "can", "able", "must", "should", "would",
  "into", "about", "across", "within", "including", "such", "other", "more", "than", "also", "etc", "e.g", "i.e", "all", "any", "both", "each", "per",
  "work", "working", "team", "teams", "role", "job", "position", "candidate", "candidates", "experience", "years", "year", "strong", "good", "excellent",
  "knowledge", "understanding", "ability", "skills", "skill", "required", "requirements", "preferred", "plus", "nice", "responsibilities", "including",
  "senior", "junior", "mid", "level", "using", "use", "new", "well", "highly", "great", "least", "minimum", "related", "relevant", "field", "degree", "join", "looking", "help", "make",
  "في", "من", "الي", "علي", "عن", "مع", "او", "و", "ان", "هذا", "هذه", "ذلك", "التي", "الذي", "الذين", "كل", "بعض", "عند", "لدي", "لدى", "ما", "لا",
  "هو", "هي", "نحن", "انت", "يجب", "يكون", "تكون", "قدره", "خبره", "سنوات", "سنه", "مهارات", "مهاره", "معرفه", "جيده", "ممتازه", "قويه", "المرشح",
  "الوظيفه", "العمل", "فريق", "المتطلبات", "المسووليات", "مطلوب", "يفضل", "الحد", "الادني", "مجال", "ذات", "صله", "شهاده",
])

/** مهاراتٌ مركّبة تُعدّ كلمةً واحدة (وإلا تفكّكت «machine learning» إلى كلمتين عامّتين). */
const PHRASES = [
  "machine learning", "deep learning", "data analysis", "data science", "project management", "product management", "unit testing",
  "rest api", "rest apis", "ci/cd", "next.js", "node.js", "react native", "google cloud", "microsoft excel", "power bi", "customer service",
  "user research", "ux design", "ui design", "system design", "sql server", "supply chain", "digital marketing", "content writing",
  "ادارة المشاريع", "تحليل البيانات", "خدمة العملاء", "التسويق الرقمي", "الذكاء الاصطناعي", "تعلم الالة", "ادارة المنتجات", "امن المعلومات",
].map(cvNorm)

const stem = (w: string): string => {
  let s = w.replace(/^(?:وال|بال|لل|كال|فال|ال)(?=\p{L}{3})/u, "")
  if (/^[a-z]{4,}s$/u.test(s) && !s.endsWith("ss")) s = s.slice(0, -1)
  return s
}
const tokens = (norm: string): string[] =>
  [...norm.matchAll(/[\p{L}\p{N}][\p{L}\p{N}+#./-]*/gu)].map((m) => m[0].replace(/[./-]+$/u, "")).filter((t) => t.length >= 2 || /^[cr]$/u.test(t))

/** كلماتُ الوصف المفتاحيّة بالترتيب: المركّباتُ أوّلاً ثمّ الأكثرُ تكراراً (والتعادلُ بأوّل ظهور). */
export function jobKeywords(jobText: string, limit = 30): string[] {
  const norm = cvNorm(jobText)
  const phrases = PHRASES.filter((p) => norm.includes(p))
  let rest = norm
  for (const p of phrases) rest = rest.split(p).join(" ")
  const counts = new Map<string, { n: number; first: number }>()
  tokens(rest).forEach((t, i) => {
    if (STOPWORDS.has(t) || STOPWORDS.has(stem(t)) || /^\d+$/u.test(t)) return
    const key = stem(t)
    const c = counts.get(key)
    if (c === undefined) counts.set(key, { n: 1, first: i })
    else c.n++
  })
  const singles = [...counts.entries()].sort((a, b) => b[1].n - a[1].n || a[1].first - b[1].first).map(([k]) => k)
  return [...phrases, ...singles].slice(0, limit)
}

export interface JobMatch { readonly matched: readonly string[]; readonly missing: readonly string[]; readonly percent: number }

/** كم من كلمات الوصف في السيرة — المركّبةُ بالاحتواء، والمفردةُ بالجذع. */
export function matchJob(cv: Pick<CvAnalysis, "norm">, keywords: readonly string[]): JobMatch {
  const have = new Set(tokens(cv.norm).map(stem))
  const matched: string[] = [], missing: string[] = []
  for (const k of keywords) (k.includes(" ") || k.includes("/") ? cv.norm.includes(k) : have.has(k)) ? matched.push(k) : missing.push(k)
  return { matched, missing, percent: keywords.length === 0 ? 0 : Math.round((100 * matched.length) / keywords.length) }
}

const mark = (b: boolean): string => (b ? "✓" : "✗")

/** التقرير: سيرةٌ واحدة بتفصيلها، أو عدّةُ سِيَرٍ بجدول ترتيبٍ ثمّ تفصيلٍ مختصر. لا قيمةَ تواصلٍ ولا اسمَ في الخرج. */
export function renderCvReport(cvs: readonly CvAnalysis[], keywords?: readonly string[]): string {
  const out: string[] = []
  const matches = keywords === undefined ? undefined : cvs.map((cv) => matchJob(cv, keywords))
  if (cvs.length > 1) {
    const order = cvs.map((cv, i) => i).sort((a, b) => (matches?.[b]?.percent ?? 0) - (matches?.[a]?.percent ?? 0) || cvs[b]!.score - cvs[a]!.score)
    out.push(`cv: ${cvs.length} سِيَر${keywords !== undefined ? ` — مرتّبةٌ بالمطابقة مع الوصف (${keywords.length} كلمةً مفتاحيّة)` : " — مرتّبةٌ بالجاهزيّة"}`)
    out.push("| # | الملفّ | المطابقة | الجاهزيّة | الخبرة | ناقصٌ مهمّ |", "|---|---|---|---|---|---|")
    order.forEach((i, rank) => {
      const cv = cvs[i]!
      out.push(`| ${rank + 1} | ${cv.label} | ${matches === undefined ? "—" : `${matches[i]!.percent}%`} | ${cv.score}/100 | ${cv.experienceYears === undefined ? "—" : `${cv.experienceYears} سنة`} | ${matches?.[i]?.missing.slice(0, 5).join("، ") || "—"} |`)
    })
    out.push("")
  }
  cvs.forEach((cv, i) => {
    const errors = cv.findings.filter((f) => f.severity === "error").length
    out.push(`${cvs.length > 1 ? "## " : "cv: "}${cv.label} — الجاهزيّة ${cv.score}/100${errors > 0 ? ` (${errors} خطأ)` : ""}`)
    out.push(`- الأقسام: ${CV_SECTION_KEYS.map((k) => `${k} ${mark(cv.sections[k])}`).join(" · ")}`)
    out.push(`- التواصل (حضورٌ لا قيمة): email ${mark(cv.contact.email)} · phone ${mark(cv.contact.phone)} · linkedin ${mark(cv.contact.linkedin)} · github ${mark(cv.contact.github)} · website ${mark(cv.contact.website)}`)
    out.push(`- الخبرة: ${cv.experienceYears === undefined ? "لا نطاقَ تواريخ" : `~${cv.experienceYears} سنة (${cv.experienceScope === "section" ? "من قسم الخبرة، المتداخلُ مدموج" : "من النصّ كلّه — لا قسمَ خبرة، فقد يشمل الدراسة"})`}`)
    out.push(`- ${cv.words} كلمة · ${cv.bullets} نقطة · بأرقام ${cv.quantified} · بفعل إنجاز ${cv.actionLed}`)
    const m = matches?.[i]
    if (m !== undefined) {
      out.push(`- المطابقة مع الوصف: ${m.percent}% (${m.matched.length}/${keywords!.length})`)
      if (m.missing.length > 0) out.push(`  - ناقص: ${m.missing.join("، ")}`)
      if (m.matched.length > 0) out.push(`  - موجود: ${m.matched.join("، ")}`)
    }
    for (const f of cv.findings) out.push(`- ${f.severity}: ${f.check} — ${f.detail}`)
    out.push("")
  })
  out.push("الأرقامُ مقيسةٌ من النصّ المستخرج؛ الحكمُ على الملاءمة وصياغةُ التحسين قرارُك — والكلمةُ الناقصة تُضاف فقط إن كانت صادقةً في الخبرة.")
  return out.join("\n").trim()
}

export interface CvCommand { readonly files: readonly string[]; readonly jobFile?: string; readonly jobText?: string }

/** `cv <سيرة...> [--job <ملفّ>] [--job-text <نصّ حتى نهاية السطر>]` */
export function parseCvCommand(rest: string): CvCommand {
  const usage = "الصيغة: cv <سيرة.pdf|.docx|.txt|.md> [سيرٌ أخرى…] [--job <وصف.md|.txt|.pdf|.docx>] [--job-text <نصُّ الوصف>]"
  const textAt = rest.search(/(?:^|\s)--job-text(?:\s|$)/u)
  const head = textAt < 0 ? rest : rest.slice(0, textAt)
  // النموذجُ يحيط النصَّ بعلامتي تنصيص (مقيس حيّاً) — تُنزعان كي لا تلتصقا بأوّل كلمةٍ وآخرها.
  const jobText = textAt < 0 ? undefined : rest.slice(textAt).replace(/^\s*--job-text\s*/u, "").trim().replace(/^(["'«“])([\s\S]*)(["'»”])$/u, "$2").trim()
  if (jobText !== undefined && jobText.length === 0) throw new Error(`--job-text بلا نصّ — ${usage}`)
  const tokens = head.trim().split(/\s+/u).filter((t) => t.length > 0)
  const jobAt = tokens.indexOf("--job")
  const jobFile = jobAt >= 0 ? tokens[jobAt + 1] : undefined
  if (jobAt >= 0 && (jobFile === undefined || jobFile.startsWith("--"))) throw new Error(`--job بلا ملفّ — ${usage}`)
  const files = tokens.filter((t, i) => !t.startsWith("--") && !(jobAt >= 0 && i === jobAt + 1))
  const unknown = tokens.filter((t) => t.startsWith("--") && t !== "--job")
  if (unknown.length > 0) throw new Error(`خيارٌ غير معروف: ${unknown.join(" ")} — ${usage}`)
  if (files.length === 0) throw new Error(usage)
  const bad = files.filter((f) => !/\.(?:pdf|docx|txt|md|markdown)$/iu.test(f))
  if (bad.length > 0) throw new Error(`صيغةٌ غير مدعومة: ${bad.join("، ")} — pdf أو docx أو txt أو md (.doc القديم: احفظه .docx)`)
  if (files.length > 50) throw new Error("خمسون سيرةً حدٌّ للدور الواحد")
  if (jobFile !== undefined && jobText !== undefined) throw new Error("--job أو --job-text، لا الاثنان")
  return { files, ...(jobFile !== undefined ? { jobFile } : {}), ...(jobText !== undefined ? { jobText } : {}) }
}
