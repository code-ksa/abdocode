/**
 * الدفعُ يُمسح قبل أن يقع — كما يفعل المشرفُ بيده.
 *
 * **أمر المالك 2026-09-21**: «أصلح طريقته في الدفع، خلّها مثلك عند بحثك عن الفروع
 * وخلافه». قبل هذا لم تكن في المحرّك أداةُ دفعٍ أصلاً: الوكيلُ يكتب `git push` في
 * الصدفة، بلا جلبٍ ولا حسابِ تأخّرٍ ولا نظرةٍ إلى بقيّة الفروع ولا إذن.
 *
 * العاداتُ المدفوعُ ثمنُها والمشفَّرةُ هنا:
 *
 * 1. **اجلب قبل أن تحكم**: `ahead/behind` بلا `fetch` رقمٌ قديم — ومقيسٌ عندنا أنّ
 *    «غيرُ مدفوع» كذبت بعد دفعٍ بالرابط ترك `origin/*` قديمة.
 * 2. **متأخّرٌ لا يُدفع**: خلفَ البعيد = اسحب أوّلاً، وإلّا نشرتَ نسخةً متأخّرة.
 * 3. **لا تنسَ فرعاً**: فروعٌ محلّيّةٌ أخرى تحمل عملاً لا يوجد في أيّ بعيد تُسمّى
 *    بالاسم — «تأكّد أنّ كلّ تطويراتنا رُفعت بدون نسيان أيّ فرع» (أمرُ المالك).
 * 4. **الشجرةُ المتّسخة لا تُنشر**: ما لم يُودَع لا يُدفع — يُقال صراحةً لا يُفترض.
 * 5. **علاماتُ تعارضٍ = وقف**.
 * 6. **الدفعُ إلى الفرع الافتراضيّ نشرٌ للإنتاج** حيث يراقبه نشرٌ تلقائيّ.
 * 7. **لا دفعَ بمبادرةٍ من الوكيل**: ما لم يطلب المالكُ الدفعَ في هذا الدور، فالمسحُ
 *    يُعرض ولا يقع شيء.
 */

export interface PushSurvey {
  readonly isRepo: boolean
  readonly branch?: string
  readonly upstream?: string
  readonly ahead: number
  readonly behind: number
  readonly dirty: number
  readonly fetched: boolean
  readonly conflicts: readonly string[]
  /** فروعٌ محلّيّةٌ أخرى تحمل كوميتاتٍ ليست في أيّ بعيد. */
  readonly strandedBranches: readonly { readonly name: string; readonly commits: number }[]
  readonly remotes: readonly string[]
  readonly defaultBranch: boolean
}

export type PushDecision = "refuse" | "ask" | "ready" | "nothing"

export interface PushVerdict {
  readonly decision: PushDecision
  readonly why: string
  readonly command?: string
}

const DEFAULT_BRANCHES = new Set(["main", "master"])

/**
 * كلماتُ المالك التي تعني «ادفع» — بلا واحدةٍ منها لا يقع دفعٌ أبداً.
 *
 * **قيس حيّاً 09-21**: كتبتُ للوكيل «… وبعدين اعمل مسح الدفع **وادفع** الجاهز»، فرفض
 * الدفعَ بحجّة أنّ المالكَ لم يطلبه: النمطُ كان يشترط «ادفع» مجرّدةً، والواوُ لاصقةٌ
 * بالفعل في العربيّة. حارسٌ عربيٌّ بلا تطبيعٍ ثغرةٌ في الاتجاهين — يمنع المأذون
 * ويوهم أنّه يحرس. فالطيُّ أوّلاً (تشكيل، تطويل، همزات)، ثمّ بادئةُ عطفٍ اختياريّة.
 *
 * والاتجاهُ المعاكس مقيسٌ أيضاً: **الأسماءُ المجرّدة لا تأذن** — «بوّابة الدفع» و«نشر
 * المقال» و«رفع الصورة» أعمالٌ يوميّةٌ عندنا، ولو أذنت بالدفع لصار كلُّ دورٍ ناشراً.
 */
const foldArabic = (text: string): string => text
  .replace(/[ً-ْٰـ]/gu, "")
  .replace(/[أإآٱ]/gu, "ا")
  .replace(/ى/gu, "ي")
  .replace(/ة/gu, "ه")

/** أفعالُ الأمر وحدَها (مع واوِ العطف أو فائه وضميرِ المفعول)، لا الأسماء. */
const PUSH_VERB_AR = /(?:^|\s)(?:ثم\s+)?[وف]?(?:ادفع|ارفع|انشر)(?:ه|ها|هم|هن|هما)?(?:\s|$|[.،!؟])/u
const PUSH_VERB_EN = /\b(?:push|publish|deploy)\b/iu

export function taskAsksPush(taskText: string | undefined): boolean {
  if (taskText === undefined || taskText.trim().length === 0) return false
  const folded = foldArabic(taskText)
  return PUSH_VERB_AR.test(folded) || PUSH_VERB_EN.test(folded)
}

export interface SurveyDeps {
  /** يشغّل git ويعيد الخرج؛ `ok=false` لأيّ خروجٍ غير صفريّ. */
  readonly git: (args: readonly string[]) => { readonly ok: boolean; readonly out: string }
}

const lines = (out: string): string[] => out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0)

export function surveyPush(deps: SurveyDeps): PushSurvey {
  const inside = deps.git(["rev-parse", "--is-inside-work-tree"])
  if (!inside.ok || inside.out.trim() !== "true") {
    return { isRepo: false, ahead: 0, behind: 0, dirty: 0, fetched: false, conflicts: [], strandedBranches: [], remotes: [], defaultBranch: false }
  }
  const head = deps.git(["rev-parse", "--abbrev-ref", "HEAD"])
  const branch = head.ok && head.out.trim() !== "HEAD" ? head.out.trim() : undefined
  const remotes = deps.git(["remote"]).ok ? lines(deps.git(["remote"]).out) : []
  // الجلبُ أوّلاً: الحكمُ على أرقامٍ لم تُجلب حكمٌ على الأمس.
  const fetched = remotes.length > 0 && deps.git(["fetch", "--quiet", "--no-tags", "--all"]).ok
  const upstreamRun = deps.git(["rev-parse", "--abbrev-ref", "@{upstream}"])
  const upstream = upstreamRun.ok ? upstreamRun.out.trim() : undefined
  let ahead = 0, behind = 0
  if (upstream !== undefined) {
    const counts = deps.git(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"])
    if (counts.ok) {
      const [b, a] = counts.out.trim().split(/\s+/u)
      behind = Number(b) || 0
      ahead = Number(a) || 0
    }
  }
  const dirty = deps.git(["status", "--porcelain"]).ok ? lines(deps.git(["status", "--porcelain"]).out).length : 0
  const conflictRun = deps.git(["grep", "-l", "-E", "^(<{7}|={7}|>{7}) "])
  const conflicts = conflictRun.ok ? lines(conflictRun.out) : []

  // فروعٌ أخرى تحمل عملاً ليس في أيّ بعيد — تُعدّ لكلّ فرعٍ على حدة.
  const stranded: { name: string; commits: number }[] = []
  const branchList = deps.git(["for-each-ref", "--format=%(refname:short)", "refs/heads"])
  for (const name of branchList.ok ? lines(branchList.out) : []) {
    if (name === branch) continue
    const count = deps.git(["rev-list", "--count", name, "--not", "--remotes"])
    const n = count.ok ? Number(count.out.trim()) || 0 : 0
    if (n > 0) stranded.push({ name, commits: n })
  }

  return {
    isRepo: true,
    ...(branch === undefined ? {} : { branch }),
    ...(upstream === undefined ? {} : { upstream }),
    ahead, behind, dirty, fetched,
    conflicts,
    strandedBranches: stranded,
    remotes,
    defaultBranch: branch !== undefined && DEFAULT_BRANCHES.has(branch),
  }
}

/**
 * وسائطُ «push go» كما يكتبها النموذجُ فعلاً — لا كما افترضنا.
 *
 * **قيس حيّاً 09-21**: صيغةُ الأداة `push go [remote]`، فكتب الوكيلُ `push go main`
 * (اسمَ الفرع، وهو القراءةُ الطبيعيّة)، فبُني `git push main main` وفشل. الأداةُ
 * التي تفهم صيغةً واحدةً تعاقب من قرأها قراءةً معقولة.
 *
 * الحكم: ما طابق بعيداً فهو بعيد، وما طابق الفرعَ الحاليَّ يُتجاهل، وغيرُهما يُسمّى.
 */
export function resolvePushTarget(args: readonly string[], survey: PushSurvey): { readonly remote?: string; readonly problem?: string } {
  const rest = args.filter((a) => a.length > 0)
  let remote: string | undefined
  for (const arg of rest) {
    if (survey.remotes.includes(arg)) { remote = arg; continue }
    if (survey.branch !== undefined && arg === survey.branch) continue
    return { problem: `«${arg}» ليس بعيداً مضبوطاً (${survey.remotes.join("، ") || "لا بعيد"}) ولا الفرعَ الحاليّ (${survey.branch ?? "—"}). الصيغة: push go [remote] [branch].` }
  }
  return remote === undefined ? {} : { remote }
}

/** الحكم: يُرفض، أو يُستأذن، أو جاهز، أو لا شيء يُدفع. */
export function pushVerdict(survey: PushSurvey, input: { readonly ownerAsked: boolean; readonly remote?: string }): PushVerdict {
  if (!survey.isRepo) return { decision: "refuse", why: "ليس مستودع git — لا شيء يُدفع." }
  if (survey.conflicts.length > 0) {
    return { decision: "refuse", why: `علاماتُ تعارضِ دمجٍ في: ${survey.conflicts.slice(0, 5).join("، ")} — تُحسم قبل أيّ دفع.` }
  }
  if (survey.branch === undefined) return { decision: "refuse", why: "رأسٌ منفصل (detached HEAD) — اختر فرعاً أوّلاً." }
  if (survey.remotes.length === 0) return { decision: "refuse", why: "لا بعيدَ مضبوطٌ لهذا المستودع — أضف remote أوّلاً، أو هذا مستودعٌ محلّيّ بقصد." }
  if (!survey.fetched) return { decision: "refuse", why: "تعذّر الجلبُ من البعيد، فالأرقامُ غيرُ مقيسة — لا يُحكم على «متقدّم/متأخّر» بلا جلب." }
  if (survey.behind > 0) {
    return { decision: "refuse", why: `الفرعُ متأخّرٌ ${survey.behind} كوميتاً عن ${survey.upstream} — اسحب وادمج أوّلاً، ولا تدفع نسخةً متأخّرة.` }
  }
  const remote = input.remote ?? survey.remotes[0]!
  if (survey.upstream === undefined) {
    return {
      decision: input.ownerAsked ? "ask" : "ask",
      why: `لا upstream لهذا الفرع — الدفعُ الأوّل ينشئه. يُستأذن صراحةً قبله.`,
      command: `git push -u ${remote} ${survey.branch}`,
    }
  }
  if (survey.ahead === 0) {
    return { decision: "nothing", why: `لا كوميتَ غيرَ مدفوع على ${survey.branch} — البعيدُ محدَّث.` }
  }
  if (!input.ownerAsked) {
    return {
      decision: "ask",
      why: `${survey.ahead} كوميتاً جاهزةٌ على ${survey.branch}، ولم يطلب المالكُ الدفعَ في هذا الدور — الغيابُ رفضٌ لا إذن. اعرض ما سيُنشر واستأذن.`,
      command: `git push ${remote} ${survey.branch}`,
    }
  }
  if (survey.defaultBranch) {
    return {
      decision: "ready",
      why: `${survey.ahead} كوميتاً إلى ${survey.branch} — ⚠ الفرعُ الافتراضيّ: حيث يراقبه نشرٌ تلقائيّ فهذا **نشرٌ للإنتاج**.`,
      command: `git push ${remote} ${survey.branch}`,
    }
  }
  return { decision: "ready", why: `${survey.ahead} كوميتاً إلى ${survey.branch} على ${remote}.`, command: `git push ${remote} ${survey.branch}` }
}

/** التقريرُ الذي يقرؤه النموذجُ — الأرقامُ ثمّ ما يجب فعلُه. */
export function renderSurvey(survey: PushSurvey, verdict: PushVerdict): string {
  if (!survey.isRepo) return verdict.why
  const out: string[] = []
  out.push(`الفرع: ${survey.branch ?? "رأسٌ منفصل"}${survey.upstream ? ` → ${survey.upstream}` : " (بلا upstream)"}`)
  out.push(`متقدّم ${survey.ahead} · متأخّر ${survey.behind} · جُلب: ${survey.fetched ? "نعم" : "لا"}`)
  if (survey.dirty > 0) out.push(`⚠ ${survey.dirty} تغييراً غيرَ مودع — لا يُنشر منها شيء. أودِع ما تريد نشرَه (ملفّاتك أنت وحدها، لا git add -A).`)
  if (survey.strandedBranches.length > 0) {
    const named = survey.strandedBranches.slice(0, 6).map((b) => `${b.name} (${b.commits})`).join("، ")
    out.push(`⚠ فروعٌ محلّيّةٌ تحمل عملاً ليس في أيّ بعيد: ${named} — لا تنسَ فرعاً.`)
  }
  if (survey.conflicts.length > 0) out.push(`🔴 علاماتُ تعارض: ${survey.conflicts.slice(0, 5).join("، ")}`)
  out.push(`الحكم: ${verdict.decision} — ${verdict.why}`)
  if (verdict.command !== undefined) out.push(`الأمر: ${verdict.command}`)
  return out.join("\n")
}
