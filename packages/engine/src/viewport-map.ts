/**
 * فتصحّ إحداثيّاتُ الماوس والكيبورد **بلا رؤية**. دوالُّ صرفةٌ تحوّل نقطةً من فضاء اللقطة إلى فضاء النقر وبالعكس.
 *
 * ثلاثةُ فضاءاتٍ للإحداثيّات:
 * - `window`: بكسلاتٌ فعليّة من زاوية النافذة العليا اليسرى — فضاءُ `desk click` ولقطةِ `desk shot` للنافذة.
 * - `screen`: بكسلاتٌ فعليّة على الشاشة الافتراضيّة — فضاءُ `desk shot screen` (أصلُها قد يكون سالباً).
 * - `css`: بكسلاتُ CSS داخل منفذ المتصفّح — فضاءُ لقطة `shot` من CDP وشجرةِ `page`.
 *
 * الأوضاعُ الأربعة: ملءُ الشاشة (النافذةُ تغطّي شاشتَها، لا إطارَ ولا إزاحة)، نافذةٌ (إطارٌ وشريطُ عنوانٍ وأدوات ⇦ إزاحةُ
 * منطقة العميل)، لوحةٌ («normal»: متصفّحُ الوكيل المملوك داخل لوحة القشرة — المنفذُ هو منطقةُ العميل كلُّها)،
 * ومحاكاةُ جوّال (375×812 CSS داخل صندوقِ حروفٍ مركزيّ داخل منطقة العميل، تصغيرٌ للملاءمة عند الحاجة).
 *
 * المقياسُ (DPI) يُضرب في كلّ تحويلٍ من CSS إلى الفعليّ: شاشةُ 125٪ تجعل زرّاً عند CSS (100,200) يقع فعليّاً عند (125,250)
 * زائدَ إزاحةِ العميل — وهذا بالضبط ما كان ينقر النموذجُ خطأً حين يقرأ الإحداثيّاتِ من لقطة CSS ويرسلها إلى desk click.
 */

export type ViewMode = "fullscreen" | "windowed" | "normal" | "mobile-emulation"
export interface Rect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface Point { readonly x: number; readonly y: number }
export type ShotSpace = "window" | "screen" | "css"

/** محاكاةُ الجوّال الافتراضيّة (iPhone-class 375×812 CSS). */
export const MOBILE_EMULATION: { readonly width: number; readonly height: number } = Object.freeze({ width: 375, height: 812 })

export interface ViewportFrame {
  readonly mode: ViewMode
  /** مستطيلُ النافذة على الشاشة (بكسلاتٌ فعليّة؛ الأصلُ قد يكون سالباً على شاشةٍ يسار الرئيسة). */
  readonly window: Rect
  /** منطقةُ العميل (المنفذُ المرسوم) بكسلاتٍ فعليّة **من زاوية النافذة** — (0,0,w,h) في ملء الشاشة. */
  readonly client: Rect
  /** مقياسُ DPI: بكسلاتٌ فعليّة لكلّ بكسل CSS (1، 1.25، 1.5، 2…). */
  readonly scale: number
  /** في محاكاة الجوّال: حجمُ الجهاز المحاكى بـCSS، يُصغَّر ليتّسع ويُوسَّط في منطقة العميل. */
  readonly emulation?: { readonly width: number; readonly height: number }
}

const round = (n: number): number => Math.round(n * 1000) / 1000

/** معاملُ الملاءمة في محاكاة الجوّال: الجهازُ بكامل حجمه إن اتّسع، وإلّا يُصغَّر ليتّسع (نسبةٌ ≤ 1). */
export const fitFactor = (frame: ViewportFrame): number => {
  if (frame.mode !== "mobile-emulation") return 1
  const em = frame.emulation ?? MOBILE_EMULATION
  const dw = em.width * frame.scale, dh = em.height * frame.scale
  if (dw <= 0 || dh <= 0) return 1
  return Math.min(1, frame.client.width / dw, frame.client.height / dh)
}

/** بكسلاتٌ فعليّة لكلّ بكسل CSS **كما يُرسم** (المقياسُ × الملاءمة). */
export const cssScale = (frame: ViewportFrame): number => frame.scale * fitFactor(frame)

/** المستطيلُ الذي يشغله منفذُ CSS فعليّاً من زاوية النافذة: منطقةُ العميل، أو صندوقُ الجهاز المحاكى موسَّطاً فيها. */
export function viewportBox(frame: ViewportFrame): Rect {
  if (frame.mode !== "mobile-emulation") return frame.client
  const em = frame.emulation ?? MOBILE_EMULATION
  const k = cssScale(frame)
  const width = em.width * k, height = em.height * k
  return { x: round(frame.client.x + (frame.client.width - width) / 2), y: round(frame.client.y + (frame.client.height - height) / 2), width: round(width), height: round(height) }
}

/** حجمُ منفذ CSS المنطقيّ (ما تراه الصفحة كـinnerWidth/innerHeight). */
export function cssViewport(frame: ViewportFrame): { readonly width: number; readonly height: number } {
  if (frame.mode === "mobile-emulation") return frame.emulation ?? MOBILE_EMULATION
  return { width: round(frame.client.width / frame.scale), height: round(frame.client.height / frame.scale) }
}

export const cssToWindow = (frame: ViewportFrame, p: Point): Point => { const box = viewportBox(frame), k = cssScale(frame); return { x: round(box.x + p.x * k), y: round(box.y + p.y * k) } }
export const windowToCss = (frame: ViewportFrame, p: Point): Point => { const box = viewportBox(frame), k = cssScale(frame); return { x: round((p.x - box.x) / k), y: round((p.y - box.y) / k) } }
export const windowToScreen = (frame: ViewportFrame, p: Point): Point => ({ x: p.x + frame.window.x, y: p.y + frame.window.y })
export const screenToWindow = (frame: ViewportFrame, p: Point): Point => ({ x: p.x - frame.window.x, y: p.y - frame.window.y })
export const cssToScreen = (frame: ViewportFrame, p: Point): Point => windowToScreen(frame, cssToWindow(frame, p))

export interface Mapped extends Point { /** داخلُ النافذة (فضاءُ desk click يرفض ما خرج). */ readonly inside: boolean }

/**
 * من نقطةٍ قرأها النموذجُ في لقطةٍ إلى نقطةِ النقر (فضاءُ النافذة الذي يأخذه `desk click`).
 * لقطةُ النافذة: هي هي. لقطةُ الشاشة: يُطرح أصلُ الشاشة الافتراضيّة ثمّ أصلُ النافذة. لقطةُ CSS: عبر صندوق المنفذ والمقياس.
 */
export function shotToClick(frame: ViewportFrame, p: Point, space: ShotSpace, shotOrigin: Point = { x: 0, y: 0 }): Mapped {
  const w = space === "window" ? p : space === "screen" ? screenToWindow(frame, { x: p.x + shotOrigin.x, y: p.y + shotOrigin.y }) : cssToWindow(frame, p)
  const inside = w.x >= 0 && w.y >= 0 && w.x < frame.window.width && w.y < frame.window.height
  return { x: w.x, y: w.y, inside }
}

/** العكس: من نقطةِ نقرٍ (فضاءُ النافذة) إلى إحداثيّاتها في لقطةٍ من الفضاء المطلوب. */
export function clickToShot(frame: ViewportFrame, p: Point, space: ShotSpace, shotOrigin: Point = { x: 0, y: 0 }): Point {
  if (space === "window") return p
  if (space === "screen") { const s = windowToScreen(frame, p); return { x: s.x - shotOrigin.x, y: s.y - shotOrigin.y } }
  return windowToCss(frame, p)
}

/** مستطيلٌ كاملٌ من CSS إلى فضاء النافذة (لصناديق العناصر من شجرة الصفحة). */
export function cssBoxToWindow(frame: ViewportFrame, box: Rect): Rect {
  const a = cssToWindow(frame, { x: box.x, y: box.y }), k = cssScale(frame)
  return { x: a.x, y: a.y, width: round(box.width * k), height: round(box.height * k) }
}

/** ملءُ الشاشة إن غطّت النافذةُ شاشتَها كلَّها (بتسامح بكسلين)، وإلّا نافذة — المكبَّرةُ نافذةٌ لها إطار. */
export function classifyWindowMode(window: Rect, monitor: Rect | undefined): "fullscreen" | "windowed" {
  if (monitor === undefined) return "windowed"
  const near = (a: number, b: number) => Math.abs(a - b) <= 2
  return near(window.x, monitor.x) && near(window.y, monitor.y) && near(window.width, monitor.width) && near(window.height, monitor.height) ? "fullscreen" : "windowed"
}

/** إطارٌ من قياس نافذةٍ على ويندوز (كما يُخرجه سكربتُ desk): الأصلُ والعميلُ والمقياسُ والشاشة. */
export function frameFromWindow(m: { readonly left: number; readonly top: number; readonly width: number; readonly height: number; readonly clientLeft?: number; readonly clientTop?: number; readonly clientWidth?: number; readonly clientHeight?: number; readonly scale?: number; readonly monitor?: Rect }): ViewportFrame {
  const window: Rect = { x: m.left, y: m.top, width: m.width, height: m.height }
  const client: Rect = { x: m.clientLeft ?? 0, y: m.clientTop ?? 0, width: m.clientWidth ?? m.width, height: m.clientHeight ?? m.height }
  const scale = typeof m.scale === "number" && m.scale > 0 ? m.scale : 1
  return { mode: classifyWindowMode(window, m.monitor), window, client, scale }
}

/** إطارُ لوحة المتصفّح المملوك: المنفذُ (CSS) هو منطقةُ العميل كلُّها؛ بلا قياسِ نافذةٍ يكون أصلُها (0,0). */
export function frameFromPane(m: { readonly viewportWidth: number; readonly viewportHeight: number; readonly scale: number; readonly emulation?: { readonly width: number; readonly height: number }; readonly window?: Rect; readonly client?: Rect }): ViewportFrame {
  const scale = m.scale > 0 ? m.scale : 1
  const client: Rect = m.client ?? { x: 0, y: 0, width: round(m.viewportWidth * scale), height: round(m.viewportHeight * scale) }
  const window: Rect = m.window ?? { x: 0, y: 0, width: client.x + client.width, height: client.y + client.height }
  return m.emulation === undefined ? { mode: "normal", window, client, scale } : { mode: "mobile-emulation", window, client, scale, emulation: m.emulation }
}

export const MODE_LABEL: Readonly<Record<ViewMode, string>> = Object.freeze({ fullscreen: "ملء الشاشة", windowed: "نافذة", normal: "لوحة", "mobile-emulation": "محاكاة جوّال" })

/** سطرُ الإيصال: «الوضع: نافذة، الإطار 1176×1530 @ (0,0)، المقياس 1.25» — وفي المحاكاة حجمُ الجهاز وصندوقُه. */
export function frameLine(frame: ViewportFrame): string {
  const w = frame.window
  const scale = Number.isInteger(frame.scale) ? String(frame.scale) : frame.scale.toFixed(2).replace(/0$/u, "")
  const client = frame.client.x !== 0 || frame.client.y !== 0 || frame.client.width !== w.width || frame.client.height !== w.height ? `، العميل ${frame.client.width}×${frame.client.height} @ (${frame.client.x},${frame.client.y})` : ""
  const em = frame.mode === "mobile-emulation" ? (() => { const e = frame.emulation ?? MOBILE_EMULATION, box = viewportBox(frame); return ` ${e.width}×${e.height} في صندوق ${Math.round(box.width)}×${Math.round(box.height)} @ (${Math.round(box.x)},${Math.round(box.y)})` })() : ""
  return `الوضع: ${MODE_LABEL[frame.mode]}${em}، الإطار ${w.width}×${w.height} @ (${w.x},${w.y})${client}، المقياس ${scale}`
}
