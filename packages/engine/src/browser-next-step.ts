/**
 * 09-29 — فكرةُ OpenJev على المتصفّح: نموذجُ قرارٍ يختار الخطوةَ التالية من **قائمة مرشّحين مسمّاة** لا من نصٍّ حرّ.
 * الصفحةُ تُقرأ شجرةً بمراجع ثابتة (page)، فتُستخرج العناصرُ القابلة للفعل مرشّحين مرقّمين، ويُسأل نموذجُ القرار
 * (decisionModel أو نموذجُ الدور) عن **رقمٍ واحد** وفعلٍ واحد: `tap <n>` أو `fill <n> :: <نصّ>` أو `scroll` أو `done :: لماذا`
 * أو `blocked :: لماذا`. ردٌّ لا يُقرأ = «غير محكّم» يُعاد مع المرشّحين للنموذج الكبير. الوحدة نقيّة: لا متصفّح ولا شبكة.
 */

import { normalizeArabic } from "./front-gate"

export interface PageNodeLike {
  readonly ref: string
  readonly role: string
  readonly name: string
  readonly sensitive?: boolean
  readonly children?: readonly PageNodeLike[]
}

export interface Candidate {
  readonly n: number
  readonly ref: string
  readonly role: string
  readonly name: string
  readonly fillable: boolean
}

const ACTIONABLE = new Set(["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "menuitem", "tab", "switch", "option", "textarea", "input", "select", "a", "listbox", "spinbutton", "slider"])
const FILLABLE = new Set(["textbox", "searchbox", "combobox", "textarea", "input", "spinbutton"])
export const CANDIDATE_MAX = 30

/** المرشّحون: العناصرُ القابلة للفعل بترتيب الشجرة، مرقّمين من ١؛ حقولُ الاعتماد لا تُرشَّح للكتابة. */
export function candidatesFrom(nodes: readonly PageNodeLike[], max = CANDIDATE_MAX): Candidate[] {
  const out: Candidate[] = []
  const walk = (list: readonly PageNodeLike[]) => {
    for (const node of list) {
      if (out.length >= max) return
      const role = node.role.toLowerCase()
      if (ACTIONABLE.has(role) && node.sensitive !== true) {
        out.push({ n: out.length + 1, ref: node.ref, role, name: node.name.replace(/\s+/gu, " ").trim().slice(0, 80), fillable: FILLABLE.has(role) })
      }
      if (node.children !== undefined) walk(node.children)
    }
  }
  walk(nodes)
  return out
}

export function buildNextStepPrompt(goal: string, page: { readonly url?: string; readonly title?: string; readonly text?: string }, candidates: readonly Candidate[]): string {
  const list = candidates.map((c) => `${c.n}) ${c.fillable ? "fill" : "tap"} — ${c.role}${c.name ? ` «${c.name}»` : ""} [${c.ref}]`).join("\n")
  const text = (page.text ?? "").replace(/\s+/gu, " ").trim().slice(0, 1500)
  return [
    "أنت نموذجُ قرارٍ لوكيل متصفّح. لا تشرح ولا تكتب إلا سطراً واحداً بإحدى الصيغ التالية حرفاً:",
    "tap <رقم المرشّح>",
    "fill <رقم المرشّح> :: <النصّ الذي يُكتب>",
    "scroll",
    "done :: <لماذا اكتمل الهدف على هذه الصفحة>",
    "blocked :: <ما الذي يمنع التقدّم>",
    "",
    `الهدف: ${goal.trim().slice(0, 400)}`,
    `الصفحة: ${page.title ?? ""}${page.url ? ` — ${page.url}` : ""}`,
    text.length > 0 ? `نصُّ الصفحة (مقتطف): ${text}` : "نصُّ الصفحة: (لم يُقرأ)",
    "",
    candidates.length === 0 ? "لا مرشّحين قابلين للفعل على الصفحة." : `المرشّحون:\n${list}`,
    "",
    "السطرُ الواحد:",
  ].join("\n")
}

export type NextStep =
  | { readonly kind: "tap"; readonly candidate: Candidate }
  | { readonly kind: "fill"; readonly candidate: Candidate; readonly text: string }
  | { readonly kind: "scroll" }
  | { readonly kind: "done"; readonly why: string }
  | { readonly kind: "blocked"; readonly why: string }

/** يقرأ سطرَ القرار بصرامة؛ `undefined` = غيرُ محكّم (لا يُخمَّن). */
export function parseNextStep(reply: string, candidates: readonly Candidate[]): NextStep | undefined {
  const line = reply.split(/\r?\n/u).map((l) => l.trim()).find((l) => l.length > 0 && !l.startsWith("```")) ?? ""
  const clean = line.replace(/^[`*_>\s]+|[`*_\s]+$/gu, "")
  let m: RegExpExecArray | null
  if ((m = /^tap\s+(\d+)\s*$/iu.exec(clean)) !== null) {
    const c = candidates[Number(m[1]) - 1]
    return c === undefined ? undefined : { kind: "tap", candidate: c }
  }
  if ((m = /^fill\s+(\d+)\s*::\s*(.+)$/iu.exec(clean)) !== null) {
    const c = candidates[Number(m[1]) - 1]
    if (c === undefined || !c.fillable) return undefined
    const text = m[2]!.trim()
    return text.length === 0 ? undefined : { kind: "fill", candidate: c, text: text.slice(0, 500) }
  }
  if (/^scroll$/iu.test(clean)) return { kind: "scroll" }
  if ((m = /^done\s*::\s*(.+)$/iu.exec(clean)) !== null) return { kind: "done", why: m[1]!.trim().slice(0, 300) }
  if ((m = /^blocked\s*::\s*(.+)$/iu.exec(clean)) !== null) return { kind: "blocked", why: m[1]!.trim().slice(0, 300) }
  return undefined
}

/** الأمرُ الذي ينفّذه المحرّك للقرار (بالسياسة نفسِها) — لا شيءَ لـdone/blocked. */
export function commandFor(step: NextStep): string | undefined {
  if (step.kind === "tap") return `tap ${step.candidate.ref}`
  if (step.kind === "fill") return `fill ${step.candidate.ref} ${step.text}`
  if (step.kind === "scroll") return "scroll down"
  return undefined
}

const TAPPABLE = new Set(["link", "a", "button", "tab", "menuitem", "option"])
const NAV_VERB = /^(?:افتح|اذهب|انتقل|ادخل|اضغط|انقر|روح|open|go\s+to|navigate\s+to|click|tap)(?=\s)/u
const norm = (s: string): string => normalizeArabic(s).toLowerCase().replace(/[«»"'`]/gu, " ").replace(/\s+/gu, " ").trim()
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
/** الاسمُ عبارةٌ كاملة في الهدف و«ال» اختياريّةٌ في الطرفين: «النماذج» تطابق «نماذج» وبالعكس؛ ولا «Chat» في «chatroom». */
const phraseIn = (goal: string, name: string): boolean => {
  const core = name.replace(/^ال(?=\p{L}{2})/u, "")
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:ال)?${escapeRe(core)}(?![\\p{L}\\p{N}])`, "u").test(goal)
}

/**
 * 09-30 — السلّمُ قبل النموذج: قيس على المثبَّت 4.0.95 أنّ نموذجَ القرار (nano) اختار «لوحة التحكم» لهدف «افتح صفحة Playground»
 * والرابطُ «Playground» مرشّحٌ ظاهر. هدفُ تنقّلٍ قصير (فعلٌ + اسم) يطابق اسمَ مرشّحٍ واحدٍ قابلٍ للنقر لا يحتاج نموذجاً.
 * يُطلق فقط حين: الهدفُ يبدأ بفعل تنقّل، وثماني كلماتٍ فأقلّ، ولا «ثمّ/then»، ويطابق اسماً واحداً (أو أطولَ اسمٍ تحوي بقيّةُ المطابقات).
 * وإن كان عنوانٌ في الصفحة يحمل الاسمَ نفسَه فالصفحةُ مفتوحة ⇦ done لا نقرٌ يعيد تحميلها بلا نهاية. غيرُ ذلك `undefined` ⇦ نموذجُ القرار.
 */
export function deterministicNextStep(goal: string, candidates: readonly Candidate[], headings: readonly string[] = []): NextStep | undefined {
  const g = norm(goal)
  if (!NAV_VERB.test(g) || g.split(" ").length > 8 || /(?:^|\s)(?:ثم|then|وبعدين)(?:\s|$)/u.test(g)) return undefined
  const matched = candidates.filter((c) => TAPPABLE.has(c.role) && norm(c.name).length >= 2 && phraseIn(g, norm(c.name)))
  if (matched.length === 0) return undefined
  const names = [...new Set(matched.map((c) => norm(c.name)))].sort((a, b) => b.length - a.length)
  const target = names[0]!
  if (!names.every((n) => target.includes(n))) return undefined
  if (headings.some((h) => norm(h) === target)) return { kind: "done", why: `عنوانُ الصفحة «${target}» — الصفحةُ المطلوبة مفتوحة` }
  return { kind: "tap", candidate: matched.find((c) => norm(c.name) === target)! }
}

export function renderNextStep(step: NextStep | undefined, candidates: readonly Candidate[], judge: string, reply: string, source?: string): string {
  const head = `🧠 الخطوةُ التالية (${source ?? `نموذج القرار ${judge}`})`
  if (step === undefined) {
    const list = candidates.slice(0, 12).map((c) => `${c.n}) ${c.fillable ? "fill" : "tap"} ${c.role}${c.name ? ` «${c.name}»` : ""} [${c.ref}]`).join("\n")
    return `${head}: غيرُ محكّم — ردٌّ لا يُقرأ («${reply.replace(/\s+/gu, " ").slice(0, 80)}»). اختر بنفسك من المرشّحين:\n${list || "(لا مرشّحين)"}`
  }
  switch (step.kind) {
    case "tap": return `${head}: tap ${step.candidate.ref} — ${step.candidate.role}${step.candidate.name ? ` «${step.candidate.name}»` : ""}`
    case "fill": return `${head}: fill ${step.candidate.ref} «${step.text}» — ${step.candidate.role}${step.candidate.name ? ` «${step.candidate.name}»` : ""}`
    case "scroll": return `${head}: scroll down — لا مرشّحَ مناسباً ظاهراً`
    case "done": return `${head}: done — ${step.why}`
    case "blocked": return `${head}: blocked — ${step.why}`
  }
}
