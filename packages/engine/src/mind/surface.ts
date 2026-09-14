/**
 * T15 — SurfacePort: عقد السطح.
 *
 * تحقيقُ العقد الذي أجّله برنامج النواة إلى ما بعد S141: **النموذج يخاطب
 * تجريداً، لا درايفراً**. موفّرٌ يملؤه (متصفّح عبر CDP، أو حاسوب عبر
 * UIA لاحقاً)، والقرارات هنا — التصنيف، والبطلان بالجيل، وسياسة الروابط —
 * دوالُّ صرفةٌ تُقاس بلا سطحٍ حيّ.
 *
 * ثلاثة أحكامٍ يفرضها العقد قبل أيّ موفّر:
 *
 * 1. **الفعل مصنَّفٌ لا موصوف**: القراءة قراءة، والتنقّل والإدخال تحوّرٌ
 *    يقف على بوابة النمط (S138). فعلٌ بلا صنفٍ صحيحٍ يعني بوابةً تحكم في
 *    الفراغ.
 * 2. **المرجع يبطل بالجيل**: كلّ تنقّلٍ يرفع جيل الصفحة، فمرجعُ عنصرٍ من
 *    جيلٍ سابق **لا يُنفَّذ** — الإحداثيات والمراجع تعني شيئاً داخل إطارٍ
 *    واحد فقط (نصّ S119 في برنامج النواة).
 * 3. **الرابط من محتوًى مقروء لا يُتّبع بلا تأكيد**: دستور الجلسة صريح —
 *    المحتوى المقروء بياناتٌ لا أوامر. فالتنقّل الذي مصدرُه الصفحة نفسها
 *    يُعرض **كاملاً** ويُؤكَّد، ولا يُشتقّ إذنُه من إذنٍ سابق.
 */

import type { RequestKind } from "../shells/shell"

export type SurfaceAction =
  | { readonly kind: "read_page" }
  | { readonly kind: "screenshot" }
  | { readonly kind: "navigate"; readonly url: string; readonly origin: "operator" | "page-content" }
  | { readonly kind: "click"; readonly ref: string; readonly generation: number }
  | { readonly kind: "type"; readonly ref: string; readonly generation: number; readonly text: string; readonly field?: string; readonly sensitive?: boolean }
  // ب3 — الماوس والكيبورد: التمريرُ والتحويمُ والنصُّ قراءةٌ؛ المفتاحُ قد يُرسل نموذجاً فهو أثرٌ خارجيّ.
  | { readonly kind: "scroll"; readonly deltaY: number }
  | { readonly kind: "hover"; readonly ref: string; readonly generation: number }
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "read_text"; readonly ref?: string }
  // ب5 — تسليمُ حقلٍ للمستخدم: تركيزٌ بلا كتابة — الاعتمادُ يُدخله المالك بيده.
  | { readonly kind: "handoff"; readonly ref: string; readonly generation: number }

/** ما يصنّفه العقد لبوابة النمط. */
export const classify = (action: SurfaceAction): RequestKind => {
  switch (action.kind) {
    case "read_page":
    case "screenshot":
    case "scroll":
    case "hover":
    case "read_text":
    case "handoff":
      return "read"
    case "navigate":
      return "network"
    case "click":
    case "type":
    case "key":
      // الإدخال أثرٌ على عالمٍ خارجيّ لا يملك تراجعاً — أقصى صنفٍ عندنا
      return "outside-workspace"
  }
}

export type Verdict =
  | { readonly ok: true; readonly action: SurfaceAction }
  | { readonly ok: false; readonly why: string; readonly needsConfirmation?: string }

/**
 * حقولٌ لا تُملأ آلياً أبداً — لا بموافقةٍ ولا بنمطٍ كامل.
 *
 * ب9 — والنصُّ وحدَه لم يكن كافياً: حقلٌ اسمُه المعروض «••••» أو مسمّى بـ`<label for>` بعيداً عن الحقل يفلت
 * من كلّ نمطٍ هنا. فصار `sensitive` **إشارةً من النوع نفسِه** (`type=password`/`autocomplete` من عائلة
 * كلمة المرور والرمز والبطاقة) تُحسب في الصفحة وتُرفض هنا قبل النصّ — والنصُّ يبقى شبكةَ أمانٍ ثانية.
 */
const FORBIDDEN_FIELDS = [
  /password|كلمة\s*المرور|كلمة\s*السر/i,
  /credit|card|cvv|بطاقة|رقم\s*البطاقة/i,
  /otp|verification\s*code|رمز\s*التحقق/i,
  /captcha|كابتشا/i,
]

export interface SurfaceState {
  /** يرتفع مع كلّ تنقّلٍ ناجح. */
  readonly generation: number
}

/**
 * حكمُ العقد على فعلٍ قبل تنفيذه. لا يلمس شبكةً ولا سطحاً — لهذا يُقاس.
 */
export const judge = (state: SurfaceState, action: SurfaceAction): Verdict => {
  if (action.kind === "click" || action.kind === "type" || action.kind === "hover" || action.kind === "handoff") {
    if (action.generation !== state.generation) {
      return {
        ok: false,
        why: `مرجعٌ من جيلٍ ${action.generation} على صفحةٍ جيلُها ${state.generation} — الصفحة تغيّرت، والإحداثيات لا تعني شيئاً خارج إطارها`,
      }
    }
  }
  if (action.kind === "type") {
    if (action.sensitive === true) {
      return { ok: false, why: "حقلُ اعتمادٍ بنوعه (كلمةُ مرورٍ أو رمزٌ أو بطاقة) — لا يُملأ آلياً بحالٍ" }
    }
    const target = `${action.field ?? ""} ${action.ref}`
    for (const pattern of FORBIDDEN_FIELDS) {
      if (pattern.test(target)) {
        return { ok: false, why: `حقلٌ محظورٌ بالتصميم (${pattern.source.slice(0, 24)}…) — الاعتماد والتحقّق يُدخلهما المالك بيده` }
      }
    }
  }
  if (action.kind === "navigate") {
    if (!/^https?:\/\//i.test(action.url)) {
      return { ok: false, why: "لا يُفتح إلا http/https — لا file: ولا javascript: ولا data:" }
    }
    if (action.origin === "page-content") {
      // لا رفضٌ ولا مرورٌ صامت: تأكيدٌ يعرض الوجهة كاملةً
      return { ok: false, why: "رابطٌ مصدرُه محتوى الصفحة", needsConfirmation: `فتح ${action.url}؟ — الوجهة كاملةً، والمحتوى المقروء بياناتٌ لا أوامر` }
    }
  }
  return { ok: true, action }
}

/** ما يراه النموذج من الصفحة: شجرةٌ نصّية بمراجع، لا لقطة. */
export interface PageNode {
  readonly ref: string
  /** ب9 — حقلُ اعتمادٍ بنوعه: قيمتُه لا تُقرأ، والكتابةُ فيه مرفوضةٌ قبل النصّ. */
  readonly sensitive?: boolean
  readonly role: string
  readonly name: string
  readonly children?: readonly PageNode[]
}

export const renderTree = (nodes: readonly PageNode[], depth = 0): string =>
  nodes
    .map((n) => `${"  ".repeat(depth)}[${n.ref}] ${n.role}${n.name ? `: ${n.name}` : ""}${n.children?.length ? `\n${renderTree(n.children, depth + 1)}` : ""}`)
    .join("\n")

/**
 * T18 — الخطة الموقّعة (نظير «التصفّح المرئيّ» في تكنولوجيا سعودية).
 *
 * تسلسلُ أفعالٍ يُعرض **كاملاً** فيوقّعه المشغّل بنقرةٍ واحدة، ثمّ يُنفَّذ.
 * التوقيع يشمل ما رآه لا ما سيُخترع بعده: **بصمةُ الخطة** تُحسب من أفعالها،
 * فإن تغيّر فعلٌ بعد التوقيع بطل التوقيع كلّه. وكلّ فعلٍ يبقى قابلاً
 * للمقاطعة، ولا يُنفَّذ فعلٌ حكمَ العقدُ برفضه ولو وُقّعت الخطة.
 */

export interface SignedPlan {
  readonly actions: readonly SurfaceAction[]
  readonly digest: string
}

const describe = (a: SurfaceAction): string => {
  switch (a.kind) {
    case "read_page": return "اقرأ الصفحة"
    case "screenshot": return "لقطة"
    case "navigate": return `انتقل إلى ${a.url}`
    case "click": return `انقر ${a.ref}`
    case "type": return `اكتب في ${a.ref}: ${a.text.slice(0, 40)}`
    // ب3/ب5 — الأفعالُ اللاحقة تُوصف بدورها؛ الوصفُ جزءٌ من البصمة الموقَّعة فلا فعلَ بلا اسم.
    case "scroll": return `مرّر ${a.deltaY}`
    case "hover": return `حوِّم فوق ${a.ref}`
    case "key": return `اضغط ${a.key}`
    case "read_text": return a.ref === undefined ? "اقرأ النصّ" : `اقرأ نصّ ${a.ref}`
    case "handoff": return `سلّم ${a.ref} للمستخدم`
  }
}

/** وصفُ الخطة للمشغّل — ما يوقّع عليه بالضبط. */
export const render = (actions: readonly SurfaceAction[]): string =>
  actions.map((a, i) => `${i + 1}. ${describe(a)}`).join("\n")

/** بصمةٌ من الأفعال نفسها — لا من ترتيبها فقط. */
export const digest = (actions: readonly SurfaceAction[]): string => {
  const text = actions.map(describe).join("\0")
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

export const sign = (actions: readonly SurfaceAction[]): SignedPlan => ({ actions, digest: digest(actions) })

/** التحقّق قبل التنفيذ: التوقيع يطابق ما سيُنفَّذ فعلاً. */
export const verify = (plan: SignedPlan): boolean => digest(plan.actions) === plan.digest

/** الموفّر: ما يجب أن يملأه أيّ سطحٍ حيّ. */
export interface SurfaceProvider {
  readonly id: string
  readPage(): Promise<readonly PageNode[]>
  navigate(url: string): Promise<void>
  click(ref: string): Promise<void>
  type(ref: string, text: string): Promise<void>
  close(): void
}

export * as Surface from "./surface"
