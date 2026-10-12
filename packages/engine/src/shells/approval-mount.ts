/**
 * IDEA 7 × IDEA 6 — مقعدُ الموافقة كـ**مساهمةٍ** في مِرساة شريط المؤلِّف.
 *
 * كانت شجرةُ المقعد مكتوبةً ثابتةً في `index.html` — تُشحن مع كلّ نسخةٍ سواءٌ
 * أكان المفتاح مشتعلاً أم مطفأً، ولا سبيل إلى نزعها. هنا تُبنى عند التسجيل
 * وتُهدَم عند الفكّ: كلُّ عقدةٍ تحت غلاف المساهمة (فحذفُه يسحبها)، وكلُّ
 * مستمعٍ عبر `bind` (فالفكّ ينزعه)، وما لمسته الميزةُ **خارج** غلافها — صنفُ
 * `approving` على المؤلِّف — يُردّ في مفكِّكها نفسه.
 *
 * والمُخفِّض الخالص (`./approval`) لم يُمسّ: يُعاد تصديره من هنا فتصل القشرةَ
 * الوحدتان باستيرادٍ واحدٍ خلف حارس المفتاح.
 */

import type { SlotContribution, SlotDocument, SlotElement } from "./slot-host"

export { Approval } from "./approval"

export const SEAT_ID = "approvalTakeover:seat"

export interface SeatDeps {
  readonly document: SlotDocument
  /** نقرةُ ✓/✕ — الطيّ والإرسال تملكهما القشرة، لا هذه الشجرة. `scope` = «اسمح لهذه الأداة في الجلسة» (منحٌ قائم). */
  readonly act: (choice: "approve" | "deny", scope?: "tool") => void
  /** نقرةُ «المعاينة» — القشرة تعرف أين كتلةُ الفرق في المحادثة. */
  readonly reveal: () => void
  /** عقدةُ المؤلِّف: صنفُ الاستيلاء يُنزع عنها عند الفكّ. */
  readonly composer: { classList: { remove(name: string): void } }
  /** تُبلَّغ القشرةُ بالمقعد عند التركيب، وبـ`null` عند الفكّ. */
  readonly attach: (seat: SlotElement | null) => void
}

const make = (document: SlotDocument, tag: string, className?: string): SlotElement => {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  return node
}

export const seat = (deps: SeatDeps): SlotContribution => ({
  id: SEAT_ID,
  anchor: "composer.bar",
  feature: "approvalTakeover",
  order: 10,
  mount: (host, bind) => {
    const node = make(deps.document, "div")
    node.id = "approvalseat"
    node.hidden = true
    const strip = make(deps.document, "div", "apv-strip")
    const scroll = make(deps.document, "div", "apv-scroll")
    scroll.setAttribute("role", "group")
    scroll.setAttribute("tabindex", "0")
    const row = make(deps.document, "div", "apv-row")
    const approve = make(deps.document, "button", "apv")
    approve.type = "button"
    approve.textContent = "✓ اسمح"
    // 10-09 — «اسمح لهذه الأداة في الجلسة»: يظهر فقط حين يعلن المحرّكُ نطاقَ «tool» (مفتاح standingGrants)؛ المنحُ في الذاكرة،
    // يُعلَن عند كلّ استعمال ويُنقض من «الصلاحيات». كان المحرّكُ يقبله والمقعدُ لا يعرضه — فكلُّ نقرةِ متصفّحٍ أو مكتبٍ تُسأل.
    const session = make(deps.document, "button", "apv-session")
    session.type = "button"
    session.hidden = true
    session.textContent = "✓ اسمح لهذه الأداة في الجلسة"
    const deny = make(deps.document, "button", "dny")
    deny.type = "button"
    deny.textContent = "✕ ارفض"
    const preview = make(deps.document, "button", "apv-preview")
    preview.type = "button"
    preview.hidden = true
    preview.textContent = "المعاينة ▲"
    const state = make(deps.document, "span", "apv-state")
    bind(approve, "click", () => deps.act("approve"))
    bind(session, "click", () => deps.act("approve", "tool"))
    bind(deny, "click", () => deps.act("deny"))
    bind(preview, "click", () => deps.reveal())
    row.appendChild(approve)
    row.appendChild(session)
    row.appendChild(deny)
    row.appendChild(preview)
    row.appendChild(state)
    node.appendChild(strip)
    node.appendChild(scroll)
    node.appendChild(row)
    host.appendChild(node)
    deps.attach(node)
    // الأثر الوحيد خارج الغلاف يُردّ باليد: صنفٌ وُضع على المؤلِّف.
    return () => {
      deps.composer.classList.remove("approving")
      deps.attach(null)
    }
  },
})

export * as ApprovalMount from "./approval-mount"
