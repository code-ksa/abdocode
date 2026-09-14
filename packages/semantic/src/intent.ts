/**
 * الفعلُ والهدف — الطبقةُ الثالثة: «المراد من قول الكلمة» على الملفّات.
 *
 * ما يريده المستخدم من نظام الملفّات سبعةُ أفعال لا أكثر: يجد، يفتح، يتابع (يستأنف مشروعاً)،
 * ينشئ، يعدّل، يحذف، يعرض. وكلُّ لهجةٍ تقولها بكلماتها: «فين المجلد» و«وين الفولدر» و«شو مكان الفلدر»
 * و«أين الدليل» كلُّها «جِد مجلّداً».
 *
 * المطابقةُ **على جذوع الكلمات** لا على نصّ الجملة: «هالمجلد» تحوي «مجلد»، و«افتحه»
 * تحوي «افتح»، و«بالملفات» تحوي «ملفات». وأفعالُ الرغبة («عايز»، «أبغى»، «بدي»،
 * «ودّي») **مساعدةٌ لا حاكمة**: «عاوز افتح المشروع» فعلُه «افتح»؛ فإن لم يتبعها فعلٌ فهي
 * إنشاءٌ مع «جديد» وفتحٌ مع شيءٍ قائم. وسؤالٌ عن المحتوى («ايش الملفات»، «وش فيه») عرضٌ.
 *
 * والهدفُ يُقتطع من الجملة بترتيبٍ ثابت: ما بين علامتي اقتباس، ثم ما بعد «اسمه/باسم/
 * named»، ثم معرّفٌ لاتينيّ فيه نقطةٌ أو مائل (`config.json`، `app/page.tsx`، `.env`)،
 * ثم الكلماتُ التالية لاسم النوع — وفي الإنجليزية السابقةُ له («the invoices folder»).
 * والحشوُ الزمنيّ واللهجيّ («دلوقتي»، «الحين»، «هلق»، «هسه»، «خالص») لا يدخل الهدف أبداً.
 *
 * الغموضُ يُعلَن لا يُحزَر: جملةٌ بلا فعلٍ معروف تخرج `action: "none"`، وهدفٌ لم يُقتطع
 * يخرج `undefined` — والطبقةُ الرابعة (النموذجُ بمفتاح المستخدم) تُكمل ما لا يُحسم حتمياً.
 */
import { fold, rawTokens, stems } from "./normalize"

export type FileAction = "find" | "open" | "resume" | "create" | "edit" | "delete" | "list" | "none"
export type TargetKind = "folder" | "file" | "project" | "unknown"

export interface FileIntent {
  readonly action: FileAction
  readonly kind: TargetKind
  /** الهدفُ كما كُتب (لا مطويّاً) كي يبقى المعرّفُ صالحاً للمسار. */
  readonly target?: string
  /** جذوعُ الهدف المطويّة — لمطابقة أسماء المجلّدات عبر الأدوات الملتصقة. */
  readonly targetStems: readonly string[]
  readonly confidence: number
  readonly evidence: readonly string[]
}

const set = (forms: readonly string[]): ReadonlySet<string> => new Set(forms.map((f) => fold(f)))

/** الأفعالُ عبر اللهجات. الصورُ تُطوى عند التجميع فتُكتب كما تُقال. */
const VERBS: ReadonlyArray<{ readonly action: FileAction; readonly forms: ReadonlySet<string> }> = [
  { action: "find", forms: set(["فين", "وين", "أين", "where", "find", "locate", "search", "دور", "دورلي", "دور لي", "ابحث", "ابحثلي", "ابحث لي", "لقي", "لقيلي", "لاقي", "لاقيلي", "الاقي", "ألاقي", "نلاقي", "تلاقي", "يلاقي", "نلقى", "تلقى", "يلقى", "القى", "ألقى", "شوف", "شوفلي", "شوف لي", "اشوف", "أشوف", "نشوف", "تشوف", "مكان", "وينه", "وينها", "فينه", "فينها", "منين", "كاين"]) },
  { action: "open", forms: set(["افتح", "إفتح", "افتحلي", "افتح لي", "فتح", "نفتح", "تفتح", "يفتح", "ادخل", "أدخل", "خش", "خشلي", "روح", "روحلي", "انتقل", "حل", "open", "go to", "goto", "cd", "enter"]) },
  // المتابعة: «كمل/استكمل/تابع/واصل + مشروع» — فُقدت من الإطار (مقيس 2026-09-06: action none) بينما
  // مسارُ الوكيل يعرفها في `@abdo/providers` (`PROJECT_INTENT` في routing.ts). التوأمان يُبقيان على
  // اتّساقهما بفحصٍ في المحرّك يقرأ ذلك التعبير ويمرّر كلَّ فعلٍ فيه من هنا — لا قائمتان تتباعدان بصمت.
  { action: "resume", forms: set(["كمل", "كمّل", "كملي", "كمللي", "كمل لي", "اكمل", "أكمل", "إكمل", "نكمل", "تكمل", "يكمل", "استكمل", "إستكمل", "استكمال", "نستكمل", "تستكمل", "تابع", "تابعي", "تابعلي", "تابع لي", "نتابع", "تتابع", "متابعة", "واصل", "واصلي", "نواصل", "تواصل", "مواصلة", "استأنف", "استانف", "إستأنف", "ارجع", "أرجع", "ارجعلي", "ارجع لي", "رجع", "رجعني", "نرجع", "continue", "resume", "finish", "pick up", "carry on", "keep going"]) },
  { action: "create", forms: set(["سوي", "سويلي", "سوي لي", "سولي", "اسوي", "نسوي", "اعمل", "أعمل", "اعملي", "اعمللي", "اعمل لي", "نعمل", "انشئ", "أنشئ", "انشا", "انشيلي", "ننشئ", "ابني", "ابنيلي", "ابني لي", "حط", "حطلي", "حط لي", "ضيف", "ضيفلي", "اضف", "أضف", "اضيف", "زود", "زودلي", "نصاوب", "صاوب", "create", "make", "add", "mkdir", "touch", "generate", "كريت", "جهز", "جهزلي", "جهز لي"]) },
  { action: "edit", forms: set(["عدل", "عدّل", "عدلي", "عدللي", "اعدل", "أعدل", "نعدل", "تعدل", "تعديل", "غير", "غيّر", "غيرلي", "صلح", "صلحلي", "اصلح", "أصلح", "حدث", "حدّث", "بدل", "ظبط", "زبط", "edit", "change", "modify", "update", "fix", "rename", "سمي", "سمّي"]) },
  { action: "delete", forms: set(["امسح", "أمسح", "امسحلي", "تمسح", "نمسح", "يمسح", "احذف", "أحذف", "احذفلي", "تحذف", "نحذف", "شيل", "شيلي", "شيلو", "شيله", "ازل", "أزل", "remove", "delete", "rm", "rmdir", "del"]) },
  { action: "list", forms: set(["وريني", "ورني", "ورّيني", "اعرض", "أعرض", "اعرضلي", "عرض", "هات", "هاتلي", "هات لي", "list", "show", "ls", "اطبع", "اسرد", "وش فيه", "وش في", "شو فيه", "شو في", "ايش فيه", "ايش في", "ايه في", "فيه ايه", "شنو فيه", "شنو في", "شكو بيه", "شكو"]) },
]

/** أفعالُ الرغبة: مساعدةٌ لا حاكمة. */
const DESIRE = set(["عايز", "عايزة", "عاوز", "عاوزة", "عايزين", "ابغى", "أبغى", "ابغا", "ابي", "أبي", "يبي", "يبغى", "نبي", "نبغى", "بدي", "بدك", "بدنا", "بغيت", "بغينا", "اريد", "أريد", "نريد", "اود", "أود", "محتاج", "محتاجة", "ودي", "ودّي", "نفسي", "want", "need", "i want", "i need"])
const NEW = set(["جديد", "جديدة", "جداد", "new"])
/** أدواتُ الاستفهام عن المحتوى: مع اسم نوعٍ بلا فعلٍ ⇦ عرض. */
const QUESTION = set(["ايش", "إيش", "وش", "شو", "ايه", "إيه", "شنو", "ما", "ماهي", "ماهو", "ما هي", "ما هو", "what", "which", "شكو"])

const KINDS: ReadonlyArray<{ readonly kind: TargetKind; readonly forms: ReadonlySet<string> }> = [
  { kind: "folder", forms: set(["مجلد", "مجلدا", "مجلدات", "فولدر", "فولدرا", "فلدر", "فولدير", "فولدرات", "folder", "folders", "dir", "directory", "directories", "ديركتوري", "مسار"]) },
  { kind: "file", forms: set(["ملف", "ملفا", "ملفات", "فايل", "فايلا", "فايلات", "file", "files", "سكربت", "script", "صفحة", "page"]) },
  { kind: "project", forms: set(["مشروع", "مشروعا", "مشاريع", "بروجكت", "project", "projects", "repo", "ريبو", "مستودع", "repository", "workspace"]) },
]

/** ما يقطع الهدف: حروفُ جرٍّ وظروفُ مكانٍ وعطفٌ وحشوٌ زمنيّ ولهجيّ. */
const STOPS = set(["في", "من", "على", "الى", "إلى", "عند", "جوه", "جوا", "داخل", "بره", "برا", "فوق", "تحت", "و", "او", "أو", "ثم", "بعدين", "عشان", "علشان", "لان", "لأن", "اللي", "الي", "ده", "دي", "هذا", "هذه", "هاد", "هاي", "ذا", "هال", "ال", "لو", "سمحت", "يا", "بس", "طيب", "تمام", "خالص", "دلوقتي", "دلوقت", "الحين", "هلق", "هلا", "هسه", "دابا", "زين", "بقى", "بقا", "كده", "كدا", "الان", "الآن", "شكو", "بيه", "in", "into", "at", "on", "under", "inside", "from", "to", "and", "then", "please", "now", "the", "a", "an", "my", "our", "your", "this", "that"])
const ARTICLES = set(["the", "a", "an", "my", "our", "your", "this", "that"])
const NAMED = set(["اسمه", "اسمها", "اسمو", "باسم", "بأسم", "بإسم", "سميته", "سميتو", "سميتها", "named", "called"])

const QUOTED = /[«"“'‘`]([^»"”'’`]{1,120})[»"”'’`]/u
const IDENTIFIER = /^(?=.*[\p{L}\p{N}])(?:\.?[\p{L}\p{N}_-]+(?:[./\\][\p{L}\p{N}_.-]+)+|\.[\p{L}\p{N}_-]+|[\p{L}\p{N}_-]+\.[\p{L}\p{N}]+)$/u
const TRAIL_PUNCT = /[،,.؟?!:;]+$/u
const LEAD_PUNCT = /^[«"“'‘`(\[]+/u
const LATIN = /\p{Script=Latin}/u

interface Word { readonly raw: string; readonly folded: string; readonly stems: readonly string[]; readonly endsSentence: boolean }

const toWords = (text: string): Word[] => rawTokens(text).map((raw) => {
  const clean = raw.replace(LEAD_PUNCT, "").replace(TRAIL_PUNCT, "")
  const folded = fold(clean)
  return { raw: clean, folded, stems: folded.length > 0 ? stems(folded) : [], endsSentence: /[.؟?!]$/u.test(raw) }
})

/** أوّلُ كلمةٍ (أو ثنائيّة) تقع في المجموعة — بموضعها. */
function firstIn(ws: readonly Word[], forms: ReadonlySet<string>): { readonly index: number; readonly text: string } | undefined {
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]!
    const bigram = i + 1 < ws.length ? `${w.folded} ${ws[i + 1]!.folded}` : undefined
    if (bigram !== undefined && forms.has(bigram)) return { index: i, text: bigram }
    for (const s of w.stems) if (forms.has(s)) return { index: i, text: w.raw }
  }
  return undefined
}

const isVerbWord = (w: Word): boolean => VERBS.some((v) => w.stems.some((s) => v.forms.has(s)))
const isStop = (w: Word): boolean => w.folded.length <= 1 || w.stems.some((s) => STOPS.has(s)) || STOPS.has(w.folded)

export function parseFileIntent(text: string): FileIntent {
  const ws = toWords(text)
  const evidence: string[] = []

  // ١) الأفعال: أوّلُ فعلٍ حقيقيّ يحكم؛ الرغبةُ مساعدة.
  let action: FileAction = "none"
  let actionAt = Number.POSITIVE_INFINITY
  for (const v of VERBS) {
    const h = firstIn(ws, v.forms)
    if (h === undefined) continue
    evidence.push(`فعل ${v.action}: «${h.text}»`)
    if (h.index < actionAt) { actionAt = h.index; action = v.action }
  }
  const desire = firstIn(ws, DESIRE)
  if (desire !== undefined) evidence.push(`رغبة: «${desire.text}»`)

  // ٢) النوع: أوّلُ اسمِ نوعٍ في الجملة.
  let kind: TargetKind = "unknown"
  let kindAt = Number.POSITIVE_INFINITY
  for (const k of KINDS) {
    const h = firstIn(ws, k.forms)
    if (h === undefined) continue
    evidence.push(`نوع ${k.kind}: «${h.text}»`)
    if (h.index < kindAt) { kindAt = h.index; kind = k.kind }
  }

  const wantsNew = firstIn(ws, NEW) !== undefined
  if (action === "none") {
    if (desire !== undefined && (kind !== "unknown" || wantsNew)) { action = wantsNew ? "create" : "open"; evidence.push(wantsNew ? "رغبةٌ + «جديد» ⇦ إنشاء" : "رغبةٌ في شيءٍ قائم ⇦ فتح") }
    else if (wantsNew && kind !== "unknown") { action = "create"; evidence.push("صفة «جديد» ⇦ إنشاء") }
    else if (kind !== "unknown" && firstIn(ws, QUESTION) !== undefined) { action = "list"; evidence.push("استفهامٌ عن المحتوى ⇦ عرض") }
  }

  // ٣) الهدف — بالترتيب: اقتباس ⇦ «اسمه» ⇦ معرّفٌ لاتينيّ ⇦ بعد اسم النوع ⇦ قبله (إنجليزية).
  let target: string | undefined
  const quoted = QUOTED.exec(text)
  if (quoted?.[1] !== undefined) { target = quoted[1].trim(); evidence.push("هدفٌ مقتبَس") }
  const take = (from: number, direction: 1 | -1, limit = 4): string[] => {
    const picked: string[] = []
    for (let i = from; i >= 0 && i < ws.length; i += direction) {
      const w = ws[i]!
      if (w.raw.length === 0) continue
      const stop = isStop(w) || (direction === 1 && NEW.has(w.folded))
      if (stop) { if (picked.length > 0) break; else { if (direction === -1 && ARTICLES.has(w.folded)) continue; if (direction === 1) continue; break } }
      if (isVerbWord(w) || DESIRE.has(w.folded) || NAMED.has(w.folded)) break
      if (direction === 1) picked.push(w.raw); else picked.unshift(w.raw)
      if (picked.length >= limit || (direction === 1 && w.endsSentence) || IDENTIFIER.test(w.raw)) break
    }
    return picked
  }
  if (target === undefined) {
    const namedAt = ws.findIndex((w) => NAMED.has(w.folded))
    if (namedAt >= 0) { const p = take(namedAt + 1, 1); if (p.length > 0) { target = p.join(" "); evidence.push("هدفٌ بعد «اسمه»") } }
  }
  if (target === undefined) {
    const identAt = ws.findIndex((w) => IDENTIFIER.test(w.raw))
    if (identAt >= 0) {
      target = ws[identAt]!.raw; evidence.push("معرّفٌ لاتينيّ")
      // اسمُ نوعٍ **بعد** المعرّف سياقٌ لا وصف («.env بتاع المشروع»: الهدفُ ملفٌّ والمشروعُ ظرفُه).
      if (kindAt > identAt) { kind = "unknown"; evidence.push("اسمُ النوع بعد المعرّف ⇦ سياقٌ يُهمَل") }
    }
  }
  if (target === undefined && kindAt !== Number.POSITIVE_INFINITY) {
    const after = take(kindAt + 1, 1)
    if (after.length > 0) { target = after.join(" "); evidence.push("هدفٌ بعد اسم النوع") }
    else if (LATIN.test(ws[kindAt]!.raw)) { const before = take(kindAt - 1, -1, 3); if (before.length > 0) { target = before.join(" "); evidence.push("هدفٌ قبل اسم النوع") } }
  }

  // ٤) النوعُ من شكل الهدف حين غاب اسمُه.
  if (kind === "unknown" && target !== undefined) {
    if (/^\.[\p{L}\p{N}_-]+$/u.test(target) || /(?:^|[\\/])[\p{L}\p{N}_-]+\.[\p{L}\p{N}]+$/u.test(target)) { kind = "file"; evidence.push("امتدادٌ ⇦ ملف") }
    else if (/[\\/]/u.test(target)) { kind = "folder"; evidence.push("مسارٌ بلا امتداد ⇦ مجلد") }
  }

  const targetStems = target === undefined ? [] : [...new Set(fold(target).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0).flatMap((w) => stems(w)))]
  const confidence = action === "none" ? 0 : (kind === "unknown" ? 0.45 : 0.7) + (target === undefined ? 0 : 0.25)
  return Object.freeze({ action, kind, target, targetStems: Object.freeze(targetStems), confidence: Number(Math.min(1, confidence).toFixed(2)), evidence: Object.freeze(evidence) })
}
