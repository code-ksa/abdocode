/**
 * IDEA 8 × IDEA 6 — لسانُ المسار كـ**مساهمتين** لميزةٍ واحدة.
 *
 * اللسان يسكن شريط الألسنة، والمنظر يسكن عقدة المحادثة: مِرساتان، ومساهمتان
 * تحملان اسم المفتاح نفسه — فإطفاؤه يفكّهما معاً بنداءٍ واحد
 * (`unregisterFeature("trajectory")`) لا بفرعين مكتوبين بيد.
 *
 * والمستمع الذي كان يتسرّب: اللسان كان يكتب `onclick` على **لسان المحادثة**
 * — عقدةٌ لا يملكها ولا تُحذف معه — فيبقى بعد «الإطفاء» يقلب المنظر إلى
 * قسمٍ لم يعد موجوداً. هنا يمرّ عبر `bind` فيُنزع حتماً عند الفكّ.
 *
 * والمُخفِّض الخالص (`./trajectory`) لم يُمسّ؛ يُعاد تصديره من هنا.
 */

import type { SlotContribution, SlotDocument, SlotElement } from "./slot-host"

export { Trajectory } from "./trajectory"

export const TAB_ID = "trajectory:tab"
export const VIEW_ID = "trajectory:view"

export interface TabDeps {
  readonly document: SlotDocument
  /** نقرةُ اللسان — القشرة تقرّر أيّ منظرٍ يُعرض. */
  readonly toggle: () => void
  /** لسانُ المحادثة: عقدةٌ لا تملكها الميزة، فمستمعها يُربط ليُنزع. */
  readonly chatTab: SlotElement
  readonly showChat: () => void
  readonly attach: (tab: SlotElement | null) => void
}

export interface ViewDeps {
  readonly document: SlotDocument
  /** تغيَّر الدور المختار في المنتقي. */
  readonly pick: (turnId: string) => void
  readonly attach: (view: SlotElement | null) => void
  /**
   * يردّ المحادثةَ إن فُكَّ المنظرُ وهو معروض — إلى حالتها **المقيسة قبل
   * التركيب** لا إلى قيمةٍ مكتوبةٍ بيد (فالقشرة هي التي تقيسها وتردّها).
   */
  readonly restoreChat: () => void
}

const make = (document: SlotDocument, tag: string, className?: string): SlotElement => {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  return node
}

export const tab = (deps: TabDeps): SlotContribution => ({
  id: TAB_ID,
  anchor: "tab.strip",
  feature: "trajectory",
  order: 10,
  mount: (host, bind) => {
    const node = make(deps.document, "button")
    node.id = "trajtab"
    node.textContent = "مسار"
    bind(node, "click", () => deps.toggle())
    // المستمع المتسرّب سابقاً — على عقدةٍ خارج الغلاف، ويُنزع مع الفكّ.
    bind(deps.chatTab, "click", () => deps.showChat())
    host.appendChild(node)
    deps.attach(node)
    return () => deps.attach(null)
  },
})

export const view = (deps: ViewDeps): SlotContribution => ({
  id: VIEW_ID,
  anchor: "transcript.node",
  feature: "trajectory",
  order: 10,
  mount: (host, bind) => {
    const node = make(deps.document, "section")
    node.id = "trajectory"
    node.hidden = true
    node.setAttribute("aria-label", "مسار الدور")
    const bar = make(deps.document, "div", "traj-bar")
    const label = make(deps.document, "label")
    label.setAttribute("for", "trajturn")
    label.textContent = "الدور"
    const picker = make(deps.document, "select")
    picker.id = "trajturn"
    bind(picker, "change", () => deps.pick(typeof picker.value === "string" ? picker.value : ""))
    const body = make(deps.document, "div")
    body.id = "trajbody"
    bar.appendChild(label)
    bar.appendChild(picker)
    node.appendChild(bar)
    node.appendChild(body)
    host.appendChild(node)
    deps.attach(node)
    // الفكّ لا يترك المحادثة مخفيّةً خلف منظرٍ حُذف — لكنّه لا يردّها إلّا إن
    // كان المنظرُ هو المعروضَ لحظةَ الفكّ. منظرٌ مخفيٌّ لم يُخفِ المحادثة،
    // فـ«ردُّها» منه كتابةٌ على حالةٍ لا تملكها الميزة.
    return () => {
      const showing = node.hidden !== true
      deps.attach(null)
      if (showing) deps.restoreChat()
    }
  },
})

export * as TrajectoryMount from "./trajectory-mount"
