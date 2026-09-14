/**
 * حالةُ الألواح — ما **لا** يملكه سجلُّ نقاط التعليق، ولا بايتَ زيادة.
 *
 * القاعدةُ التي تحكم هذا الملفّ، وهي التي تجعله صغيراً: **المفتوح/المغلق ليس
 * هنا**. اللوحُ المفتوح هو مساهمةٌ مسجَّلة في `SlotHost`، والمغلقُ هو ما
 * أُلغي تسجيلُه — فتفكيكٌ كاملٌ بلا بقايا، لا `display:none`. فلو حملنا هنا
 * عَلَماً ثانياً باسم `open` لصار للسؤال الواحد مالكان، وأوّلُ اختلافٍ بينهما
 * أيقونةٌ تكذب على لوحها: مضيئةٌ ولا شجرة تحتها، أو مطفأةٌ وشجرتُها حيّة.
 * لذلك تُقرأ الإضاءةُ من `SlotHost.has(id)` وحدَه، ويملك هذا المُخفِّض ثلاثةَ
 * أشياءَ لا يعرفها السجلّ:
 *
 * 1. **المِرساة** (`dock`): أين يُرسى اللوح — يمين/يسار/أسفل. مناطقُ إرساءٍ
 *    مُعلَنة لا إحداثيّاتٌ حرّة: الحرُّ يبدو أسهل ويُنتج لوحاً ضائعاً خلف
 *    الحافّة لا يجد المستخدم طريقاً لإعادته.
 * 2. **التوسيع** (`expanded`): حالةٌ واحدةٌ لا ثلاث — موسَّعٌ أو على مرساته.
 * 3. **«جديدٌ لم تُره»** (`unseen`): النقطةُ الزرقاء.
 *
 * والنقطةُ **معنىً لا زينة**، وتُشتقّ من حدثٍ لا من مؤقّت: حدثٌ على لوحٍ
 * **مُغلق** يرفعها، وفتحُه يطفئها. حدثٌ على لوحٍ مفتوحٍ لا يرفع شيئاً — لأن
 * المستخدم يراه بالفعل، ونقطةٌ تُضاء على ما هو منظورٌ أمامك تُعلّم العينَ
 * تجاهلَها، فتموت كإشارة. ولهذا يأخذ `noticed` حالةَ الانفتاح وسيطاً: هي
 * تُقرأ من السجلّ عند النداء، فلا تُخزَّن هنا نسخةٌ ثانيةٌ منها.
 *
 * خالصةٌ: لا DOM ولا زمن ولا عشوائيّة — تُختبر بجدولٍ صريح بلا متصفّح،
 * كـ`slots.ts` تماماً.
 */

/** مناطقُ الإرساء المُعلَنة. اسمٌ خارجها رفضٌ مسمّى، لا إرساءٌ في العدم. */
export const DOCKS = Object.freeze(["inline-end", "inline-start", "block-end", "block-start"] as const)

export type Dock = (typeof DOCKS)[number]

export const isDock = (value: unknown): value is Dock =>
  typeof value === "string" && (DOCKS as readonly string[]).includes(value)

export interface PanelEntry {
  readonly id: string
  readonly dock: Dock
  readonly expanded: boolean
  readonly unseen: boolean
}

export interface PanelsState {
  readonly entries: readonly PanelEntry[]
}

export interface PanelsFold {
  readonly state: PanelsState
  /** رفضٌ مسمّى — لا صمت، ولا حالةٌ تُمسّ. */
  readonly refused?: string
}

const FROZEN: readonly PanelEntry[] = Object.freeze([] as readonly PanelEntry[])

export const empty = (): PanelsState => Object.freeze({ entries: FROZEN })

const asText = (value: unknown): string => (typeof value === "string" ? value : "")

const put = (state: PanelsState, entry: PanelEntry): PanelsState =>
  Object.freeze({
    entries: Object.freeze(
      state.entries.some((e) => e.id === entry.id)
        ? state.entries.map((e) => (e.id === entry.id ? entry : e))
        : [...state.entries, entry],
    ),
  })

export const entryOf = (state: PanelsState, id: unknown): PanelEntry | undefined =>
  state.entries.find((entry) => entry.id === asText(id))

/**
 * يُرسي لوحاً في منطقةٍ معلَنة. أوّلُ إرساءٍ يُنشئ القيدَ بحالةٍ افتراضيّة،
 * وما بعده ينقله. النقلُ **لا يمسّ** `unseen`: تحريكُ لوحٍ ليس رؤيةً لما فيه.
 */
export const dock = (state: PanelsState, id: unknown, next: unknown): PanelsFold => {
  const key = asText(id).trim()
  if (key.length === 0) return { state, refused: "لوحٌ بلا معرّف — لا يُرسى" }
  if (!isDock(next)) return { state, refused: `منطقةُ إرساءٍ غير معروفة: "${asText(next)}"` }
  const current = entryOf(state, key)
  return {
    state: put(state, Object.freeze({
      id: key,
      dock: next,
      expanded: current?.expanded ?? false,
      unseen: current?.unseen ?? false,
    })),
  }
}

/**
 * التوسيع حالةٌ واحدة: موسَّعٌ إلى منطقة العمل، أو عائدٌ إلى مرساته. والمرساةُ
 * تبقى محفوظةً أثناء التوسيع — فالعودةُ تعرف إلى أين، ولا تُلقي اللوحَ في
 * موضعٍ افتراضيٍّ ليس موضعَه.
 */
export const expand = (state: PanelsState, id: unknown, value: boolean): PanelsFold => {
  const key = asText(id).trim()
  const current = entryOf(state, key)
  if (current === undefined) return { state, refused: `لوحٌ غير مُرسىً: "${key}"` }
  return { state: put(state, Object.freeze({ ...current, expanded: value === true })) }
}

/**
 * حدثٌ على لوح. `isOpen` تُقرأ من سجلّ نقاط التعليق لحظةَ النداء — لا تُخزَّن
 * هنا، فلا يوجد عَلَمُ انفتاحٍ ثانٍ يفترق عن السجلّ.
 *
 * مفتوحٌ ⇒ لا شيء (المستخدم يراه). مغلقٌ ⇒ ترتفع النقطة.
 */
export const noticed = (state: PanelsState, id: unknown, isOpen: boolean): PanelsFold => {
  const key = asText(id).trim()
  if (key.length === 0) return { state, refused: "حدثٌ بلا لوح — يُهمَل" }
  if (isOpen) return { state }
  const current = entryOf(state, key)
  const base: PanelEntry = current ?? Object.freeze({ id: key, dock: "inline-end", expanded: false, unseen: false })
  return { state: put(state, Object.freeze({ ...base, unseen: true })) }
}

/** الفتحُ يطفئ النقطة — وهذا هو تعريفُ «رأيتَه». صامدٌ لِلوحٍ لا قيدَ له. */
export const seen = (state: PanelsState, id: unknown): PanelsFold => {
  const key = asText(id).trim()
  const current = entryOf(state, key)
  if (current === undefined || !current.unseen) return { state }
  return { state: put(state, Object.freeze({ ...current, unseen: false })) }
}

export const hasUnseen = (state: PanelsState, id: unknown): boolean =>
  entryOf(state, id)?.unseen === true

/** معرّفاتُ الألواح التي عليها نقطة — لعرضِ إشارةٍ جامعةٍ في الترويسة. */
export const unseenIds = (state: PanelsState): readonly string[] =>
  Object.freeze(state.entries.filter((entry) => entry.unseen).map((entry) => entry.id))

/** ما أُرسي في منطقةٍ بعينها، بترتيب الإرساء — مستقرٌّ لا يعتمد ترتيب القراءة. */
export const inDock = (state: PanelsState, area: unknown): readonly PanelEntry[] =>
  Object.freeze(state.entries.filter((entry) => entry.dock === area))

export * as Panels from "./panels"
