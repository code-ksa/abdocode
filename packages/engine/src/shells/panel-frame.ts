/**
 * ترويسةُ اللوح — عقدةٌ واحدةٌ يشترك فيها كلُّ لوح.
 *
 * المواصفة تقول: «كلُّ لوحٍ يحمل الترويسةَ نفسها بالعقد نفسه». وهذا ليس
 * تجميلاً: ترويسةٌ يبنيها كلُّ لوحٍ بيده تعني أنّ زرّ الإغلاق يعني في لوحٍ
 * «فكٌّ» وفي آخر «إخفاء»، وأنّ لوحاً يُشحن بترويسةٍ ناقصةٍ فلا يجد المستخدم
 * طريقاً لإغلاقه. فالترويسةُ تُبنى هنا مرّةً، ويملأ اللوحُ جسمَه وحده.
 *
 * **العناصرُ الثابتة ثلاثة — والثالثُ شُحن بعد أن قِيس لا قبله:**
 *
 * المواصفة تطلب: نافذةٌ مستقلّة · توسيع · إغلاق. و«النافذة المستقلّة» كانت
 * موسومةً بأنها **تحتاج قياساً قبل الوعد**، وأنّ ما لا يُقاس «يُقال ولا
 * يُشحن زرٌّ لا يعمل». فبقيت الترويسةُ ثابتَين حتى أُخذ القياس.
 *
 * قِيس (2026-09-04) بمسبارٍ شُغِّل على التطبيق الحقيقيّ ثمّ نُزع: إنشاءُ
 * النافذة من أمرٍ **غيرِ متزامن** عاد في ٧٢ مللي ثانية، ونداءٌ تالٍ على
 * النافذة الرئيسية عاد أيضاً، ونافذةُ اللوح شغّلت شيفرتها. فالقفلُ الذي
 * سُجِّل في D22 خاصٌّ بالمسار المتزامن وحده. وعليه شُحن الزرُّ الثالث.
 *
 * لا DOM عامّ هنا: العقد تصل وسائطَ كما في `slot-host.ts`، فتُختبر بلا متصفّح.
 */

import type { Bind, SlotDocument, SlotElement } from "./slot-host"

/** فعلٌ خاصٌّ باللوح يجلس قبل الثابتَين (+ للطرفيّة، تحديثٌ للخوادم…). */
export interface PanelAction {
  readonly label: string
  readonly title: string
  readonly onClick: () => void
}

export interface PanelFrameDeps {
  readonly document: SlotDocument
  readonly title: string
  readonly action?: PanelAction
  /** يُنادى بالحالة المطلوبة — والمُنادي هو من يملك الحالة، لا الترويسة. */
  readonly onExpand: (next: boolean) => void
  /**
   * فتحُ اللوح في نافذةٍ مستقلّة. **اختياريّ**: مُنادٍ لا يملك هذا الطريق
   * (متصفّحٌ عاديّ، أو بيئةٌ بلا تاوري) لا يُشحن له زرٌّ لا يعمل — الغيابُ
   * يعني غيابَ الزرّ لا زرّاً صامتاً.
   */
  readonly onPopout?: () => void
  /** بدءُ سحبِ العمود. غيابُه = ترويسةٌ غيرُ قابلةٍ للسحب، لا مقبضٌ ميّت. */
  readonly onDragStart?: (event: unknown) => void
  readonly onDragEnd?: () => void
  readonly onClose: () => void
  /** الحالةُ الجارية، تُقرأ عند الرسم — لا نسخةٌ تُحفظ هنا فتفترق. */
  readonly expanded: boolean
}

export interface PanelFrame {
  readonly root: SlotElement
  /** يملؤه اللوحُ بمحتواه — الترويسةُ لا تعرف ما فيه ولا تريد. */
  readonly body: SlotElement
}

const make = (document: SlotDocument, tag: string, className?: string): SlotElement => {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  return node
}

const iconButton = (
  document: SlotDocument,
  bind: Bind,
  label: string,
  title: string,
  onClick: () => void,
): SlotElement => {
  const button = make(document, "button", "iconbtn")
  button.textContent = label
  button.setAttribute("title", title)
  // الاسمُ الكامل يبقى لقارئ الشاشة ولو كان الوجهُ رمزاً واحداً.
  button.setAttribute("aria-label", title)
  button.setAttribute("type", "button")
  bind(button, "click", () => onClick())
  return button
}

/**
 * يبني الترويسةَ والجسم تحت `host`. يعيد الجسمَ ليملأه اللوح.
 *
 * كلُّ مستمعٍ يمرّ بـ`bind` فيُنزع عند الفكّ — والفكُّ هنا ليس إخفاءً: أيقونةُ
 * اللوح في الشريط تعيد التركيب من الصفر.
 */
export const panelFrame = (deps: PanelFrameDeps, host: SlotElement, bind: Bind): PanelFrame => {
  const root = make(deps.document, "section", deps.expanded ? "panel expanded" : "panel")
  root.setAttribute("role", "region")
  root.setAttribute("aria-label", deps.title)

  const header = make(deps.document, "header", "panel-head")
  // المقبضُ هو الترويسةُ نفسها كما في المرجع — لا مقبضٌ صغيرٌ يُبحث عنه.
  if (deps.onDragStart !== undefined) {
    header.setAttribute("draggable", "true")
    bind(header, "dragstart", (event) => deps.onDragStart!(event))
    if (deps.onDragEnd !== undefined) bind(header, "dragend", () => deps.onDragEnd!())
  }
  const name = make(deps.document, "span", "panel-name")
  name.textContent = deps.title
  header.appendChild(name)

  const group = make(deps.document, "div", "panel-actions")
  if (deps.action !== undefined) {
    group.appendChild(iconButton(deps.document, bind, deps.action.label, deps.action.title, deps.action.onClick))
  }
  if (deps.onPopout !== undefined) {
    group.appendChild(iconButton(deps.document, bind, "⧉", "افتح اللوح في نافذةٍ مستقلّة", deps.onPopout))
  }
  group.appendChild(iconButton(
    deps.document,
    bind,
    deps.expanded ? "⤡" : "⤢",
    deps.expanded ? "أعِد اللوح إلى مرساته" : "وسّع اللوح",
    () => deps.onExpand(!deps.expanded),
  ))
  group.appendChild(iconButton(deps.document, bind, "✕", "أغلق اللوح", () => deps.onClose()))
  header.appendChild(group)

  const body = make(deps.document, "div", "panel-body")
  root.appendChild(header)
  root.appendChild(body)
  host.appendChild(root)
  return { root, body }
}
