/**
 * إغلاقُ الطبقات العائمة في متصفّح الوكيل — مقيس 2026-09-14 (ledger `turn-1-…`, 19:03): بحثُ Google فُتح في
 * المتصفّح ثمّ اعترضته نافذةُ «Looking for results in English?»، وأداةُ البحث المنظّم فشلت (لا مفتاح)، فتوقّف
 * النموذجُ وكتب مقارنةً «من المعرفة العامّة». المطلوبُ خطوةٌ واحدة يعرفها كلُّ نموذج: `dismiss` — تقرأ الصفحةَ،
 * تختار زرَّ الإغلاق الأسلمَ، وتنقره بالمسار الموثوق نفسِه الذي تنقر به `tap`.
 *
 * نقيّةٌ بلا متصفّح: تعمل على شجرة الصفحة (ref/role/name) أو على نصّها المرسوم (`[r12] link: …`) كما يصل من
 * الإضافة. الاختيارُ بالمعنى لا بالموضع: إبقاءُ اللغة الحاليّة ⇦ «لا شكراً/ليس الآن» ⇦ «رفض الكلّ» ⇦ إغلاق/فهمت ⇦
 * «قبول الكلّ» آخرَ الخيارات (يوافق على ملفّات تعريف الارتباط فلا يُختار إلا حين لا بديل). العربيّةُ تُطبَّع قبل
 * المطابقة (تشكيل، تطويل، همزات، تاء مربوطة) — قاعدةُ السلامة 7. ولا يُختار عنصرٌ خارج حوارٍ إلا حين لا حوارَ
 * أصلاً (شريطُ الكوكيز بلا role=dialog)، ولا يُختار حقلٌ ولا عنصرٌ اسمُه فارغ.
 */

export interface FlatNode {
  readonly ref: string
  readonly role: string
  readonly name: string
  /** داخل حوار/نافذة عائمة (dialog · alertdialog · region تحمل اسم cookie/consent). */
  readonly inDialog: boolean
}

export interface DismissChoice {
  readonly ref: string
  readonly role: string
  readonly name: string
  readonly group: DismissGroup
  readonly inDialog: boolean
}

export type DismissGroup = "keep-language" | "decline" | "reject" | "close" | "accept"

const CLICKABLE = new Set(["button", "link", "menuitem", "tab", "checkbox", "switch"])
const DIALOG_ROLES = new Set(["dialog", "alertdialog"])

/** تطبيعُ العربيّة والحالة والبياض: يكفي للمطابقة بالجذر لا بالحرف. */
export const normalizeLabel = (text: string): string =>
  text
    .normalize("NFKC")
    .replace(/[ً-ْٰـ]/gu, "") // تشكيل + تطويل
    .replace(/[أإآٱ]/gu, "ا")
    .replace(/ة/gu, "ه")
    .replace(/ى/gu, "ي")
    .replace(/[​-‏‪-‮⁦-⁩]/gu, "")
    .replace(/[^\p{L}\p{N}\s×✕✖]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase()

const GROUPS: readonly { readonly group: DismissGroup; readonly patterns: readonly RegExp[] }[] = [
  { group: "keep-language", patterns: [/^الاستمرار باللغه/u, /^متابعه باللغه/u, /^ابق(?:ي)? باللغه/u, /^(?:continue|stay|keep|remain) in \p{L}+$/u, /^continue in \p{L}+ ?\(?/u] },
  { group: "decline", patterns: [/^لا شكرا$/u, /^لا،? شكرا/u, /^ليس الان$/u, /^لاحقا$/u, /^ربما لاحقا$/u, /^تخطي$/u, /^تجاهل$/u, /^no,? thanks?$/u, /^not now$/u, /^maybe later$/u, /^later$/u, /^skip(?: for now)?$/u, /^no$/u] },
  { group: "reject", patterns: [/^رفض الكل$/u, /^رفض$/u, /^ارفض(?: الكل)?$/u, /^reject(?: all)?$/u, /^decline(?: all)?$/u, /^only (?:necessary|essential)(?: cookies)?$/u, /^(?:الضروري|الاساسيه) فقط$/u] },
  { group: "close", patterns: [/^(?:اغلاق|اغلق|فهمت|حسنا|موافق|تم)$/u, /^(?:close|dismiss|got it|ok|okay|done|x|×|✕|✖)$/u, /^close (?:dialog|window|banner|popup)$/u, /^اغلاق (?:النافذه|الحوار|الاشعار)$/u] },
  { group: "accept", patterns: [/^قبول الكل$/u, /^قبول$/u, /^اوافق$/u, /^موافق على الكل$/u, /^accept(?: all)?(?: cookies)?$/u, /^allow all$/u, /^i (?:agree|accept)$/u, /^agree$/u] },
]

const groupOf = (name: string): DismissGroup | undefined => {
  const n = normalizeLabel(name)
  if (n.length === 0 || n.length > 60) return undefined
  for (const { group, patterns } of GROUPS) if (patterns.some((p) => p.test(n))) return group
  return undefined
}

/** تسطيحُ شجرةٍ (ref/role/name/children) مع وسمِ ما يقع داخل حوار. */
export const flattenTree = (nodes: readonly { readonly ref: string; readonly role: string; readonly name: string; readonly children?: readonly unknown[] }[], inDialog = false): FlatNode[] => {
  const out: FlatNode[] = []
  for (const node of nodes) {
    const here = inDialog || DIALOG_ROLES.has(node.role) || (/^(?:region|complementary|banner)$/u.test(node.role) && /cookie|consent|ملفات تعريف|الخصوصي/iu.test(node.name))
    out.push({ ref: node.ref, role: node.role, name: node.name, inDialog: here })
    if (Array.isArray(node.children)) out.push(...flattenTree(node.children as readonly { readonly ref: string; readonly role: string; readonly name: string; readonly children?: readonly unknown[] }[], here))
  }
  return out
}

/** يقرأ النصَّ المرسوم `[r12] role: name` (بإزاحة السطر عمقاً) كما تعيده `page` من المتصفّح المملوك أو من الإضافة. */
export const parseRenderedTree = (text: string): FlatNode[] => {
  const out: FlatNode[] = []
  const dialogDepths: number[] = []
  for (const raw of text.split("\n")) {
    const m = /^(\s*)\[(r\d{1,6})\]\s+([a-z:-]+)(?::\s(.*))?$/u.exec(raw)
    if (m === null) continue
    const depth = Math.floor(m[1]!.length / 2)
    while (dialogDepths.length > 0 && dialogDepths[dialogDepths.length - 1]! >= depth) dialogDepths.pop()
    const role = m[3]!
    const name = (m[4] ?? "").trim()
    const inDialog = dialogDepths.length > 0
    out.push({ ref: m[2]!, role, name, inDialog })
    if (DIALOG_ROLES.has(role) || (/^(?:region|complementary|banner)$/u.test(role) && /cookie|consent|ملفات تعريف|الخصوصي/iu.test(name))) dialogDepths.push(depth)
  }
  return out
}

/** هل على الصفحة طبقةٌ عائمة تُغلَق؟ حوارٌ صريح، أو زرُّ إغلاقٍ معروف. */
export const overlayPresent = (nodes: readonly FlatNode[]): boolean =>
  nodes.some((n) => DIALOG_ROLES.has(n.role)) || pickDismissTarget(nodes) !== undefined

/**
 * الاختيارُ الأسلم: داخلَ الحوار قبل خارجه، وبترتيب المجموعات. خارجَ أيّ حوار لا تُختار «قبول الكلّ» ولا «موافق»
 * (قد يكون زرَّ إرسال نموذج) — فقط ما لا لبس فيه (إغلاق/رفض/لا شكراً/إبقاء اللغة).
 */
export const pickDismissTarget = (nodes: readonly FlatNode[]): DismissChoice | undefined => {
  const hasDialog = nodes.some((n) => n.inDialog)
  const rank: Record<DismissGroup, number> = { "keep-language": 0, decline: 1, reject: 2, close: 3, accept: 4 }
  let best: DismissChoice | undefined
  let bestScore = Number.POSITIVE_INFINITY
  for (const n of nodes) {
    if (!CLICKABLE.has(n.role.split(":")[0]!)) continue
    const group = groupOf(n.name)
    if (group === undefined) continue
    if (!n.inDialog && (group === "accept" || (hasDialog && group === "close"))) continue
    const score = rank[group] * 10 + (n.inDialog ? 0 : 5)
    if (score < bestScore) { best = { ref: n.ref, role: n.role, name: n.name, group, inDialog: n.inDialog }; bestScore = score }
  }
  return best
}

export const dismissReceipt = (choice: DismissChoice): string =>
  `أغلقتُ الطبقةَ العائمة بنقر «${choice.name}» (${choice.group}${choice.inDialog ? "، داخل حوار" : ""}) — أعد قراءةَ الصفحة بـpage.`
