/**
 * IDEA 6 — «نقاط تعليق للقشرة» (dsh slots)، مُختزَلةً إلى سجلٍّ خالص.
 *
 * قبل هذا كانت كلُّ ميزةٍ تُصلَّب في القشرة بيدها: عقدُها مكتوبةٌ ثابتةً في
 * `index.html`، وحارسُ مفتاحها مكتوبٌ مرّةً لها وحدها، ومستمعوها يُعلَّقون على
 * عقدٍ لا تملكها — و«التفكيك» قصّةٌ تُروى ولا تُنفَّذ (تفعيلٌ يبني، وإطفاءٌ لا
 * يهدم). فكلُّ ميزةٍ جديدة تُنبت فرعاً ثالثاً في القشرة، والمفتاح المطفأ يعني
 * «محمولٌ ومُهمَل» لا «غير مركَّب».
 *
 * هذا السجلّ يقلب القاعدة: **مِرساةٌ مسمّاة** تُعلن مرّةً، و«مساهمةٌ» تُسجَّل
 * فيها عند التفعيل وتُفكَّك عند الإطفاء — بآليةٍ واحدة لا بفرعٍ لكل ميزة.
 *
 * العقد المُعلَن (وكلُّ بندٍ منه مُختبَر):
 *
 * - **المراسي مغلقة بالاسم**: `ANCHORS` وحدها. اسمٌ خارجها ⇒ رفضٌ **مسمّى**
 *   يذكر الاسم، لا صمتٌ ولا تسجيلٌ في العدم. (الغياب رفضٌ لا إذن.)
 * - **المساهمة**: معرّفٌ فريد + مِرساة + الميزة المالكة + رتبة. المعرّف هو
 *   مقبض الفكّ، والميزة هي المفتاح الذي إطفاؤه يفكّ كلَّ مساهماتها.
 * - **الترتيب** حين تتشارك ميزتان مِرساةً: `order` تصاعدياً، وعند التساوي
 *   **تسلسلُ التسجيل** (مستقرّ). أي أن التسجيل الثاني لا يزحزح الأوّل، ولا
 *   يعتمد الترتيب على ترتيب القراءة من كائنٍ ما.
 * - **التكرار**: معرّفٌ مسجَّلٌ سلفاً ⇒ رفضٌ **مسمّى** والحالة **لا تُمسّ** —
 *   لا استبدالٌ صامت (استبدالٌ صامت = شجرةٌ يتيمةٌ بلا مفكِّك).
 * - **الفكّ يضمن**: خروجُ المساهمة من كلّ قراءة (`slot`/`mountedIds`/`has`)
 *   فوراً، وفكُّ معرّفٍ غير مسجَّل **لا شيء** — لا رفض ولا خطأ (الفكّ صامد
 *   للتكرار، لأنّ المُنادي كثيراً ما يفكّ ما فُكّ).
 *
 * خالصة: لا DOM ولا شبكة ولا زمن. المُحوِّل إلى الشاشة في `slot-host.ts`،
 * وهو رقيقٌ عمداً: كلُّ الحكم هنا حيث يُختبَر بلا متصفّح.
 */

/**
 * المراسي المُعلَنة. الأربع الأولى هي التي سمّاها الجرد؛ والخامسة
 * (`activity.section`) مقيسةٌ من موضع صفّ المسلَّمات الفعليّ — لوحةُ النشاط
 * في الجانب، لا المحادثة. تُسمّى ولا تُخبَّأ تحت مِرساةٍ لا تصفها.
 */
export const ANCHORS = Object.freeze([
  "composer.bar",
  "transcript.node",
  "tab.strip",
  "settings.section",
  "activity.section",
  // قشرةُ الألواح (2026-09-03): شريطُ التنقّل، وشريطُ أفعال الترويسة، وثلاثُ
  // مناطقِ إرساءٍ **مُعلَنة** — لا إحداثيّاتٌ حرّة. اللوحُ مساهمةٌ في هذه
  // المِراسي: فتحُه تسجيلٌ، وإغلاقُه إلغاءُ تسجيلٍ يفكّك شجرته بلا بقايا.
  "rail.icons",
  "header.actions",
  "dock.inline-end",
  "dock.inline-start",
  "dock.block-end",
  // اليمين ووضعها تحت أو فوق شاشة المحادثة»). وهي معلَنةٌ هنا لا في القشرة
  // وحدها: مِرساةٌ في البنية بلا إعلانٍ هنا تعني فكّاً من القديمة ورفضاً في
  // الجديدة — أي لوحٌ يختفي بلا سبب. قِيس حيّاً قبل الإعلان.
  "dock.block-start",
] as const)

export type AnchorName = (typeof ANCHORS)[number]

export const isAnchor = (name: unknown): name is AnchorName =>
  typeof name === "string" && (ANCHORS as readonly string[]).includes(name)

/** مساهمةٌ مسجَّلة — ما يعرفه السجلّ عنها، بلا أيّ عقدة شاشة. */
export interface SlotEntry {
  readonly id: string
  readonly anchor: AnchorName
  /** المفتاح المالك: إطفاؤه يفكّ كلّ مساهماته. */
  readonly feature: string
  readonly order: number
  /** تسلسل التسجيل — فاصلُ التعادل، ولا يُعاد استعماله بعد الفكّ. */
  readonly seq: number
}

export interface SlotState {
  readonly entries: readonly SlotEntry[]
  readonly seq: number
}

export interface SlotInput {
  readonly id: string
  readonly anchor: string
  readonly feature: string
  readonly order?: number
}

export interface SlotFold {
  readonly state: SlotState
  /** رفضٌ مسمّى — لا صمت، ولا حالةٌ تُمسّ. */
  readonly refused?: string
  readonly mounted?: string
  readonly torn?: string
}

const FROZEN: readonly SlotEntry[] = Object.freeze([] as readonly SlotEntry[])

export const empty = (): SlotState => Object.freeze({ entries: FROZEN, seq: 0 })

const asText = (value: unknown): string => (typeof value === "string" ? value : "")

export const register = (state: SlotState, input: SlotInput): SlotFold => {
  const id = asText(input.id).trim()
  if (id.length === 0) return { state, refused: "مساهمة بلا معرّف — لا تُسجَّل" }
  const feature = asText(input.feature).trim()
  if (feature.length === 0) return { state, refused: `مساهمة بلا ميزة مالكة: "${id}"` }
  const anchor = asText(input.anchor)
  // اسمٌ لا نعرفه يُرفض **باسمه**: مِرساةٌ أُسيء كتابتها كانت ستبتلع الميزة بصمت.
  if (!isAnchor(anchor)) return { state, refused: `مرساة غير معروفة: "${anchor}"` }
  if (state.entries.some((entry) => entry.id === id)) return { state, refused: `تسجيل مكرّر لنقطة التعليق: "${id}"` }
  const order = typeof input.order === "number" && Number.isFinite(input.order) ? input.order : 0
  const seq = state.seq + 1
  const entry: SlotEntry = Object.freeze({ id, anchor, feature, order, seq })
  return {
    state: Object.freeze({ entries: Object.freeze([...state.entries, entry]), seq }),
    mounted: id,
  }
}

/** الفكّ صامدٌ للتكرار: معرّفٌ غير مسجَّل لا يُرفض ولا يُغيّر شيئاً. */
export const unregister = (state: SlotState, id: unknown): SlotFold => {
  const key = asText(id)
  if (!state.entries.some((entry) => entry.id === key)) return { state }
  return {
    state: Object.freeze({ entries: Object.freeze(state.entries.filter((entry) => entry.id !== key)), seq: state.seq }),
    torn: key,
  }
}

/** ترتيب مِرساةٍ واحدة: `order` تصاعدياً، والتعادل بتسلسل التسجيل. */
export const slot = (state: SlotState, anchor: string): readonly SlotEntry[] =>
  Object.freeze(
    state.entries
      .filter((entry) => entry.anchor === anchor)
      .sort((a, b) => (a.order === b.order ? a.seq - b.seq : a.order - b.order)),
  )

export const has = (state: SlotState, id: unknown): boolean => state.entries.some((entry) => entry.id === asText(id))

export const entryOf = (state: SlotState, id: unknown): SlotEntry | undefined =>
  state.entries.find((entry) => entry.id === asText(id))

/** معرّفات المساهمات — كلّها، أو ما تملكه ميزةٌ بعينها (مقابض الفكّ). */
export const mountedIds = (state: SlotState, feature?: string): readonly string[] =>
  Object.freeze(
    state.entries.filter((entry) => feature === undefined || entry.feature === feature).map((entry) => entry.id),
  )

export * as Slots from "./slots"
