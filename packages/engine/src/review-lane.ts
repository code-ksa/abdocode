/**
 * م9ح — حارةُ المراجعة (فكرةُ Kilo «وضع Review»، مكتوبةٌ هنا): كلمةُ «راجع تغييراتي» تُشغّل المراجعةَ العدائيّة التي
 * فعلناها يدويّاً في 4.0.6 — لكن على **فرق الدور** لا على دعوى الاكتمال: ثلاثُ عدساتٍ مستقلّة (الصحّة، الأمان، عضُّ
 * الاختبارات) كلٌّ تقرأ الفرقَ نفسَه وتجيب بعقدٍ صارم: عيبٌ في سطرٍ بموضعٍ وسيناريو فشلٍ مسمّى، أو «لا عيب».
 *
 * القاعدةُ الموروثة من التفنيد: **عيبٌ بلا سيناريو فشلٍ ليس عيباً** — يُعرض «ملاحظةً» ولا يُحتسب في الحكم، كي لا يصير
 * مراجعٌ متشائمٌ بابَ توقّفٍ دائم. الوحدة نقيّة: لا شبكة ولا قرص ولا ساعة — تبني الفرقَ والنصوصَ وتقرأ الأحكام.
 */

export interface ReviewLens { readonly key: string; readonly label: string; readonly question: string }

export const REVIEW_LENSES: readonly ReviewLens[] = Object.freeze([
  Object.freeze({
    key: "correctness",
    label: "الصحّة",
    question: "اقرأ الفرقَ سطراً سطراً واسأل: أيُّ مدخلٍ أو حالةٍ (قيمةٌ فارغة، مسارٌ بعلامةٍ خلفيّة، ترتيبُ خطوات، تزامن) يجعل هذا التغييرَ يُنتج خرجاً خاطئاً أو ينهار؟ الإخفاقُ المنطقيّ لا الأسلوبيّ.",
  }),
  Object.freeze({
    key: "safety",
    label: "الأمان",
    question: "ابحث عن سرٍّ مكتوبٍ نصّاً، أو مدخلٍ يصل أمراً/استعلاماً/مساراً بلا تطهير، أو صلاحيّةٍ تُمنح بلا فحص، أو أثرٍ لا يُسترجع بلا تأكيد. سمِّ السطرَ والمدخلَ الذي يستغلّه.",
  }),
  Object.freeze({
    key: "tests",
    label: "عضُّ الاختبارات",
    question: "هل يحمل الفرقُ اختباراً يحمرّ لو عُطّل التغييرُ عمداً؟ اختبارٌ يمرّ فارغاً، أو يستبدل الوحدةَ بوهم، أو يفحص عائدَ الدالّة لا الأثرَ على القرص — عيبٌ. وإن لم يكن اختبارٌ أصلاً فقل ذلك بالاسم.",
  }),
])

export type ReviewSeverity = "high" | "medium" | "low"

export interface ReviewFinding {
  readonly lens: string
  readonly severity: ReviewSeverity
  readonly where: string
  readonly claim: string
  /** سيناريو الفشل المسمّى — الفارغُ يجعل السطرَ «ملاحظةً» لا عيباً. */
  readonly scenario: string
}

/** نصُّ نظام المراجع: بلا أدوات، بسياقٍ منفصل، وبعقدِ سطرٍ لكلّ عيب. */
export const REVIEW_SYSTEM =
  "أنت مراجعُ كودٍ مستقلّ. لا أدواتِ لك ولا سياقَ سابق: أمامك هدفُ الدور وفرقُ الملفّات فقط.\n" +
  "مهمّتك أن تجد ما يكسر هذا التغييرَ لا أن تجامله، ولا تتّهم بالظنّ: كلُّ عيبٍ يحتاج موضعاً وسيناريو فشلٍ مسمّى.\n" +
  "أجب بسطرٍ لكلّ عيب، حرفاً بهذه الصيغة (بالعربية):\n" +
  "- [حرج|متوسط|منخفض] الملفّ:السطر — العيبُ في جملة — كيف يفشل: مدخلٌ أو حالةٌ محدّدة\n" +
  "وإن لم تجد عيباً في عدستك فسطرٌ واحد: لا عيب\n" +
  "لا نثرَ قبل الأسطر ولا بعدها، ولا تعليقاتِ أسلوبٍ بلا إخفاق.\n"

export interface ReviewChange {
  readonly path: string
  /** فرقٌ جاهز (من git) — إن وُجد يُعرض كما هو بدل بناءِ فرقٍ من النسختين. */
  readonly patch?: string
  readonly before?: string
  readonly after?: string
}

/** فرقٌ سطريّ بسيط (النمطُ نفسُه الذي يراه المشغّل في إطار diff): أوّلُ N سطرِ فرقٍ ثمّ علامةُ القصّ. */
export function changeDiff(change: ReviewChange, maxLines = 120): string {
  if (change.patch !== undefined) return change.patch
  const a = (change.before ?? "").split("\n"), b = (change.after ?? "").split("\n")
  const out: string[] = [`--- ${change.path}${change.before === undefined ? " (لم يكن موجوداً)" : ""}`, `+++ ${change.path}${change.after === undefined ? " (حُذف)" : ""}`]
  const max = Math.max(a.length, b.length)
  let shown = 0
  for (let i = 0; i < max && shown < maxLines; i += 1) {
    if (a[i] === b[i]) continue
    if (change.before !== undefined && a[i] !== undefined) { out.push(`- ${a[i]}`); shown += 1 }
    if (change.after !== undefined && b[i] !== undefined) { out.push(`+ ${b[i]}`); shown += 1 }
  }
  if (shown === 0) out.push("(لا فرق)")
  else if (shown >= maxLines) out.push(`⋯ (أوّل ${maxLines} سطر فرق)`)
  return out.join("\n")
}

export interface ReviewDiff { readonly text: string; readonly files: number; readonly lines: number; readonly truncated: boolean }

/** يجمع فروقَ الملفّات في نصٍّ واحد مسقوف — والعدُّ يُقال للمشغّل قبل الإنفاق. */
export function reviewDiffText(changes: readonly ReviewChange[], capChars = 40_000): ReviewDiff {
  const parts: string[] = []
  let lines = 0, used = 0, truncated = false
  for (const change of changes) {
    const diff = changeDiff(change)
    lines += diff.split("\n").filter((l) => /^[+-](?![+-]{2} )/u.test(l)).length
    if (used + diff.length > capChars) { truncated = true; parts.push(`⋯ ${change.path} (قُصّ: تجاوز السقف)`); continue }
    parts.push(diff); used += diff.length
  }
  return Object.freeze({ text: parts.join("\n\n"), files: changes.length, lines, truncated })
}

/** مدخلُ المراجع: الهدفُ مسقوفاً، ثمّ الفرق، ثمّ سؤالُ عدسته. */
export const buildReviewPrompt = (goal: string, diff: string, lens: ReviewLens): string =>
  `هدفُ الدور:\n${(goal || "غير مسمّى").slice(0, 600)}\n\n` +
  `فرقُ الملفّات:\n${diff}\n\n` +
  `عدستُك: ${lens.label}\n${lens.question}\n`

const SEVERITY: Record<string, ReviewSeverity> = { "حرج": "high", "high": "high", "متوسط": "medium", "medium": "medium", "منخفض": "low", "low": "low" }
const CAP = 300

/**
 * يقرأ أسطرَ العيوب من نصّ النموذج. سطرٌ بلا موضعٍ أو بلا سيناريو يُحفظ بسيناريو فارغ (ملاحظة). «لا عيب» أو نثرٌ بلا
 * أسطرٍ بالعقد = لا عيوب — الصمتُ لا يُخترع منه عيب.
 */
export function parseReviewFindings(lens: string, text: string): ReviewFinding[] {
  const out: ReviewFinding[] = []
  for (const raw of text.split(/\r?\n/u)) {
    const m = /^\s*[-•*]\s*\[?\s*(حرج|متوسط|منخفض|high|medium|low)\s*\]?\s*:?\s*(.+)$/iu.exec(raw)
    if (m === null) continue
    const parts = m[2]!.split(/\s+(?:—|–|\|)\s+/u).map((p) => p.trim()).filter((p) => p.length > 0)
    if (parts.length < 2) continue
    const [where, claim, ...rest] = parts
    const scenario = rest.join(" — ").replace(/^كيف يفشل\s*[:：]\s*/u, "").trim().slice(0, CAP)
    out.push(Object.freeze({ lens, severity: SEVERITY[m[1]!.toLowerCase()] ?? "low", where: where!.slice(0, 160), claim: claim!.slice(0, CAP), scenario }))
  }
  return out
}

export interface ReviewOutcome {
  readonly verdict: "clean" | "notes" | "fix"
  readonly line: string
  readonly counted: readonly ReviewFinding[]
  readonly notes: readonly ReviewFinding[]
}

/**
 * الحكمُ الجامع: عيبٌ حرجٌ واحد بسيناريو، أو متوسّطان، يعني «يحتاج إصلاحاً». ما بلا سيناريو ملاحظاتٌ تُعرض ولا تُحتسب.
 * والعدُّ يُكتب كما هو عدسةً عدسة.
 */
export function judgeReview(findings: readonly ReviewFinding[], lenses: readonly ReviewLens[] = REVIEW_LENSES): ReviewOutcome {
  const counted = findings.filter((f) => f.scenario.length > 0)
  const notes = findings.filter((f) => f.scenario.length === 0)
  const high = counted.filter((f) => f.severity === "high").length
  const medium = counted.filter((f) => f.severity === "medium").length
  const verdict = high >= 1 || medium >= 2 ? "fix" : counted.length + notes.length > 0 ? "notes" : "clean"
  const perLens = lenses.map((l) => `${l.label}: ${counted.filter((f) => f.lens === l.key).length}`).join(" · ")
  const label = verdict === "fix" ? "يحتاج إصلاحاً" : verdict === "notes" ? "يمرّ مع ملاحظات" : "نظيف"
  return Object.freeze({ verdict, counted, notes, line: `🔍 حكمُ المراجعة: ${label} — ${counted.length} عيباً بسيناريو (${perLens})${notes.length > 0 ? ` · ${notes.length} ملاحظة بلا سيناريو` : ""}` })
}

const severityWord = (s: ReviewSeverity): string => s === "high" ? "حرج" : s === "medium" ? "متوسط" : "منخفض"

/** التقريرُ للمشغّل: الحكمُ أوّلاً، ثمّ العيوبُ مرتّبةً بالخطورة، ثمّ الملاحظات — بلا ادّعاءِ إصلاح. */
export function renderReviewReport(outcome: ReviewOutcome, diff: ReviewDiff, lenses: readonly ReviewLens[] = REVIEW_LENSES): string {
  const rank: Record<ReviewSeverity, number> = { high: 0, medium: 1, low: 2 }
  const byLens = new Map(lenses.map((l) => [l.key, l.label]))
  const rows = [...outcome.counted].sort((a, b) => rank[a.severity] - rank[b.severity])
    .map((f) => `• [${severityWord(f.severity)} · ${byLens.get(f.lens) ?? f.lens}] ${f.where} — ${f.claim}\n  كيف يفشل: ${f.scenario}`)
  const notes = outcome.notes.map((f) => `◦ [${byLens.get(f.lens) ?? f.lens}] ${f.where} — ${f.claim}`)
  const head = `${outcome.line}\nالمراجَع: ${diff.files} ملفّاً، ${diff.lines} سطر فرق${diff.truncated ? " (قُصّ بعضُه)" : ""} — ثلاثُ عدساتٍ بلا أدوات.`
  const body = rows.length > 0 ? `\n\nالعيوب:\n${rows.join("\n")}` : ""
  const tail = notes.length > 0 ? `\n\nملاحظاتٌ بلا سيناريو فشل (لا تُحتسب):\n${notes.join("\n")}` : ""
  return `${head}${body}${tail}${outcome.verdict === "fix" ? "\n\nلم يُصلَح شيءٌ تلقائيّاً — قل «أصلح عيوب المراجعة» أو اختر ما تريد." : ""}`
}
