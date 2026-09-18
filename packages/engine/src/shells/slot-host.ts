/**
 * IDEA 6 — المُحوِّل الرقيق: من سجلّ نقاط التعليق الخالص إلى شجرة الشاشة.
 *
 * كلُّ الحكم في `slots.ts` (خالصٌ، بلا DOM). ما هنا رقيقٌ عمداً وحدُّه ثلاثة:
 *
 * 1. **غلافٌ لكل مساهمة**: المُحوِّل — لا الميزة — يصنع عقدةً واحدة
 *    (`[data-slot="<id>"]`) تحت المِرساة، وتبني الميزةُ داخلها. فالفكّ حذفُ
 *    عقدةٍ واحدة يسحب معها كلَّ ما تحتها حتماً، لا جردٌ يدويٌّ يُنسى منه شيء.
 * 2. **مستمعون مربوطون**: كلُّ مستمعٍ يُعلَّق عبر `bind` يُسجَّل ويُنزع عند
 *    الفكّ — بما فيه ما عُلِّق على عقدةٍ **خارج** الغلاف (لسانُ المسار كان
 *    يكتب `onclick` على لسان المحادثة الذي لا يملكه، فيبقى بعد «الإطفاء»).
 * 3. **ترتيبٌ من السجلّ لا من ترتيب النداء**: موضع الغلاف بين إخوته يؤخذ من
 *    `Slots.slot()`، فالمساهمة الأدنى رتبةً تسبق ولو سُجِّلت أخيراً.
 *
 * وما تعيده `mount` هو مفكِّك الميزة نفسها: يُنفَّذ **قبل** نزع المستمعين
 * وحذف الغلاف، ويُستعمل لردّ ما لمسته الميزةُ خارج غلافها (صنفٌ على المؤلِّف،
 * قسمٌ أُخفي في لوحة النشاط). فشلُه يُسمّى ولا يوقف الهدم.
 *
 * لا يستورد هذا الملفُّ DOM ولا يفترض `window`/`document` عامّين: العقد تصل
 * وسائطَ، والوثيقة تُقرأ من `ownerDocument` المِرساة. لذلك يُختبر بمِرساةٍ
 * بديلة بلا متصفّح.
 */

import { empty, mountedIds, register, slot, unregister, has, type SlotState } from "./slots"

export { ANCHORS, isAnchor, type AnchorName } from "./slots"

/** ما تُعلَّق به المستمعات — أضيقُ ما يلزم من `EventTarget`. */
export interface SlotEventTarget {
  addEventListener(type: string, handler: (event: never) => void): void
  removeEventListener(type: string, handler: (event: never) => void): void
}

export interface SlotDocument {
  createElement(tag: string): SlotElement
}

/** أضيقُ ما يلزم من `Element` — لئلّا يتسلّل اعتمادٌ على متصفّحٍ كامل. */
export interface SlotElement extends SlotEventTarget {
  id?: string
  className?: string
  hidden?: boolean
  textContent?: string | null
  type?: string
  value?: string
  readonly ownerDocument: SlotDocument | null
  /** DOM hosts expose this so layout moves can reject a descendant cycle. */
  contains?(node: SlotElement): boolean
  setAttribute(name: string, value: string): void
  appendChild(node: SlotElement): unknown
  insertBefore(node: SlotElement, before: SlotElement | null): unknown
  removeChild(node: SlotElement): unknown
}

export type Bind = (target: SlotEventTarget, type: string, handler: (event: never) => void) => void

export interface SlotContribution {
  /** مقبض الفكّ — فريدٌ عبر السجلّ كلّه. */
  readonly id: string
  readonly anchor: string
  /** المفتاح المالك: `unregisterFeature(feature)` يفكّ كلّ مساهماته. */
  readonly feature: string
  readonly order?: number
  /** يبني تحت `host`، ويعلّق كلَّ مستمعيه بـ`bind`، ويعيد مفكِّكه إن لزم. */
  readonly mount: (host: SlotElement, bind: Bind) => (() => void) | void
}

interface Live {
  readonly wrapper: SlotElement
  anchor: SlotElement
  readonly listeners: { target: SlotEventTarget; type: string; handler: (event: never) => void }[]
  /** يُنسى فور استدعائه: محاولةٌ ثانيةٌ بعد هدمٍ سقط لا تُشغّله مرّتين. */
  teardown: (() => void) | undefined
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export class SlotHost {
  private state: SlotState = empty()
  private readonly live = new Map<string, Live>()

  /**
   * @param anchorOf يعيد عقدة المِرساة المُعلَنة بالاسم، أو `null` إن غابت عن
   * هذه القشرة. غيابُ العقدة رفضٌ مسمّى لا تسجيلٌ في العدم.
   */
  constructor(private readonly anchorOf: (name: string) => SlotElement | null | undefined) {}

  /** يعيد رفضاً مسمّى، أو `undefined` عند التركيب. */
  register(contribution: SlotContribution): string | undefined {
    const folded = register(this.state, contribution)
    if (folded.refused !== undefined) return folded.refused
    const anchor = this.anchorOf(contribution.anchor) ?? null
    if (anchor === null) return `مرساة غير موجودة في القشرة: "${contribution.anchor}"`
    const document = anchor.ownerDocument
    if (document === null) return `مرساة بلا وثيقة: "${contribution.anchor}"`

    const wrapper = document.createElement("div")
    wrapper.setAttribute("data-slot", contribution.id)
    // الموضع من السجلّ: المساهمة الأدنى رتبةً تسبق ولو سُجِّلت أخيراً.
    const ordered = slot(folded.state, contribution.anchor)
    const index = ordered.findIndex((entry) => entry.id === contribution.id)
    // A logical peer may have been moved into a physical docking container.
    // insertBefore must only use a sibling still owned by this actual anchor.
    const after = ordered.slice(index + 1).find((entry) => this.live.get(entry.id)?.anchor === anchor)
    anchor.insertBefore(wrapper, after === undefined ? null : this.live.get(after.id)!.wrapper)

    const listeners: Live["listeners"] = []
    const bind: Bind = (target, type, handler) => {
      target.addEventListener(type, handler)
      listeners.push({ target, type, handler })
    }
    // السجلُّ يُكتب **قبل** التركيب. حين كان يُكتب بعده كانت الحالةُ المحسوبةُ
    // قبل `mount` تُكتب فوق كلّ ما سجّله التركيبُ من داخله: غلافٌ حيٌّ في
    // الشجرة لا تراه `mounted()`/`has()` ولا يفكّه `unregisterFeature` — أي
    // «فكٌّ ترك عقدةً خلفه» بعينه. والسقوط يُتراجَع عنه بمعرّفه وحده.
    const record: Live = { wrapper, anchor, listeners, teardown: undefined }
    this.state = folded.state
    this.live.set(contribution.id, record)
    try {
      record.teardown = contribution.mount(wrapper, bind) ?? undefined
    } catch (error) {
      // تركيبٌ سقط لا يترك شجرةً يتيمة: يُنزع ما عُلِّق ويُحذف الغلاف، ويخرج
      // من السجلّ — فإعادةُ المحاولة ممكنةٌ بالمعرّف نفسه. ويُنزع بمعرّفه لا
      // بإرجاع الحالة كلّها، لئلّا يُدهس ما سجّله تركيبٌ ناجحٌ من داخله.
      this.state = unregister(this.state, contribution.id).state
      this.live.delete(contribution.id)
      for (const entry of listeners) entry.target.removeEventListener(entry.type, entry.handler)
      record.anchor.removeChild(wrapper)
      return `تركيب "${contribution.id}" سقط: ${message(error)}`
    }
    return undefined
  }

  /**
   * Reparent an existing contribution without remounting it. Physical docking
   * does not change its logical anchor, feature ownership, listeners or state.
   * This cannot create or enable a feature; an unmounted id is refused.
   */
  relocate(id: string, target: SlotElement): string | undefined {
    const record = this.live.get(id)
    if (record === undefined || !has(this.state, id)) return `مساهمة غير مركّبة: "${id}"`
    if (target == null || typeof target.appendChild !== "function" || typeof target.removeChild !== "function") {
      return `وجهة نقل غير صالحة: "${id}"`
    }
    if (target.ownerDocument === null || target.ownerDocument !== record.wrapper.ownerDocument) {
      return `نقل بين وثيقتين مرفوض: "${id}"`
    }
    if (target === record.wrapper || record.wrapper.contains?.(target)) return `وجهة النقل داخل المساهمة نفسها: "${id}"`
    if (target === record.anchor) return undefined
    try {
      // appendChild moves an existing DOM node atomically. If the browser
      // rejects the target, the original parent remains its teardown owner.
      target.appendChild(record.wrapper)
      record.anchor = target
      return undefined
    } catch (error) { return `نقل "${id}" سقط: ${message(error)}` }
  }

  /**
   * الفكّ: مفكِّك الميزة، ثم نزع كلّ مستمعٍ رُبط، ثم حذف الغلاف بكلّ ما تحته.
   * صامدٌ للتكرار: معرّفٌ غير مركَّب لا يفعل شيئاً ولا يُخطئ. يعيد اسمَ عطل
   * مفكِّك الميزة إن سقط — والهدم البنيويّ يتمّ في الحالتين.
   */
  unregister(id: string): string | undefined {
    const record = this.live.get(id)
    this.state = unregister(this.state, id).state
    if (record === undefined) return undefined
    let failure: string | undefined
    const teardown = record.teardown
    record.teardown = undefined
    try {
      teardown?.()
    } catch (error) {
      failure = `مفكِّك "${id}" سقط: ${message(error)}`
    }
    for (const entry of record.listeners) entry.target.removeEventListener(entry.type, entry.handler)
    record.listeners.length = 0
    // الحذف البنيويّ **قبل** محو القيد: حذفٌ سقط (غلافٌ زُحزح من تحتنا) كان
    // يترك عقدةً بلا مقبضٍ يُعاد به الهدم — والقيدُ الباقي يجعل المحاولة
    // الثانية ممكنة، ومفكِّكُ الميزة لا يُشغَّل فيها مرّتين.
    record.anchor.removeChild(record.wrapper)
    this.live.delete(id)
    return failure
  }

  /** يفكّ كلّ ما سجّلته ميزةٌ — هذا ما يعنيه «المفتاح أُطفئ». */
  unregisterFeature(feature: string): string[] {
    const failures: string[] = []
    for (const id of mountedIds(this.state, feature)) {
      // عزلٌ لكلّ مساهمة: هدمٌ سقط في واحدةٍ كان يُجهض الحلقة فتبقى أخواتُها
      // مركَّبةً بلا مفتاح، ويقفز الاستثناءُ فوق تصفير القشرة لمتغيّراتها.
      // هنا يُسمّى العطل في المُرجَع — والبقيّة تُهدم.
      try {
        const failure = this.unregister(id)
        if (failure !== undefined) failures.push(failure)
      } catch (error) {
        failures.push(`هدم "${id}" سقط: ${message(error)}`)
      }
    }
    return failures
  }

  has(id: string): boolean {
    return has(this.state, id)
  }

  mounted(feature?: string): readonly string[] {
    return mountedIds(this.state, feature)
  }

  /** ترتيب مِرساةٍ كما يراه السجلّ — للقراءة والاختبار لا للتغيير. */
  order(anchor: string): readonly string[] {
    return Object.freeze(slot(this.state, anchor).map((entry) => entry.id))
  }

  /** عدد المستمعين الأحياء — قياسُ الفكّ لا ادّعاؤه. */
  liveListeners(): number {
    let count = 0
    for (const record of this.live.values()) count += record.listeners.length
    return count
  }
}
