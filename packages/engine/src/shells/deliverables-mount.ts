/**
 * IDEA 9 × IDEA 6 — صفُّ المسلَّمات كـ**مساهمةٍ** في مِرساة لوحة النشاط.
 *
 * كان الصفُّ يستولي على قسم «المخرجات» العامّ: يبدّل عنوانه ويكتب في قائمته.
 * فالإطفاء يعني عنواناً مبدَّلاً بلا كاتب، ولا سبيل إلى ردّ الحال. هنا يبني
 * قسمَه هو، ويُخفي القسم العامّ ما دام مركَّباً، ويردّه عند الفكّ — والمنظور
 * للمشغّل واحدٌ في الحالتين: قسمٌ واحدٌ في موضعه.
 *
 * والمُخفِّض الخالص (`./deliverables`) لم يُمسّ؛ يُعاد تصديره من هنا.
 */

import type { SlotContribution, SlotDocument, SlotElement } from "./slot-host"

export { Deliverables } from "./deliverables"

export const ROW_ID = "deliverables:row"

export interface RowDeps {
  readonly document: SlotDocument
  /** قسمُ «المخرجات» العامّ — يُخفى ما دام الصفُّ مركَّباً، ويُردّ عند الفكّ. */
  readonly generalSection: SlotElement | null
  /** تُبلَّغ القشرةُ بقائمة الصفوف عند التركيب، وبـ`null` عند الفكّ. */
  readonly attach: (rows: SlotElement | null) => void
}

const make = (document: SlotDocument, tag: string, className?: string): SlotElement => {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  return node
}

export const row = (deps: RowDeps): SlotContribution => ({
  id: ROW_ID,
  anchor: "activity.section",
  feature: "deliverables",
  order: 10,
  mount: (host) => {
    const section = make(deps.document, "div", "act-sect")
    const head = make(deps.document, "h4")
    head.textContent = "المسلَّمات"
    const list = make(deps.document, "div", "act-list")
    list.id = "delivrows"
    const blank = make(deps.document, "span", "act-empty")
    blank.textContent = "لا مسلَّمات بعد"
    list.appendChild(blank)
    section.appendChild(head)
    section.appendChild(list)
    host.appendChild(section)
    // ما لُمس خارج الغلاف يُقاس قبل لمسه ويُردّ إلى المقيس — لا إلى قيمةٍ
    // مكتوبةٍ بيد. «يُردّ إلى `false`» كان يكشف قسماً وجدته الميزةُ مخفيّاً.
    const wasHidden = deps.generalSection === null ? undefined : deps.generalSection.hidden
    if (deps.generalSection !== null) deps.generalSection.hidden = true
    deps.attach(list)
    return () => {
      if (deps.generalSection !== null) deps.generalSection.hidden = wasHidden
      deps.attach(null)
    }
  },
})

export * as DeliverablesMount from "./deliverables-mount"
