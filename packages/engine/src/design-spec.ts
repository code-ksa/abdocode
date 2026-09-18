/**
 * ألوان، خطوط، تباعد، مكوّنات، أصول)، ومن المواصفة إلى HTML/CSS واحدٍ مكتفٍ بذاته، ثمّ **قياسُ** قرب الرندر من الهدف
 * بالبكسل مع أكثرِ المناطق اختلافاً — فيكرّر النموذجُ حتى يطابق. أرقامٌ لا انطباع.
 *
 * المصدر (أ): شجرةُ الصناديق التي يعطيها ماشي المواصفة في الصفحة الحيّة (`SPEC_WALKER` في @abdo/browser — النصُّ نفسُه
 *   في إضافة المتصفّح 0.6.5) — `extractSpec` تحوّلها إلى المواصفة.
 * المصدر (ب): لقطةٌ فقط بلا DOM — `extractSpecFromScreenshot` يسأل نموذجَ الرؤية المضبوط بمخطّط JSON صارم ويُطبّع الجواب؛
 *   لا اختبارَ يعتمد عليه (النموذجُ يُحقن).
 * المقارنة: فكُّ PNG خالص (zlib من node، بلا اعتمادٍ جديد) ⇦ تصغيرٌ إلى ≤ 480px ⇦ نسبةُ البكسلات المتطابقة ضمن تسامح
 *   + أعلى ٥ مناطق اختلافاً بصناديقها في إحداثيّات الهدف.
 * الرندر حتميّ: المواصفةُ نفسُها ⇦ النصُّ نفسُه بايتاً؛ الترتيبُ بالموضع، لا وقتَ ولا عشوائيّة.
 */
import { deflateSync, inflateSync } from "node:zlib"

// ═══ شكلُ ما يعطيه الماشي (المصدر أ) ═══

export interface SpecDumpNode {
  readonly i: number
  readonly p: number
  readonly d: number
  readonly t: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly n: number
  readonly s: Readonly<Record<string, string>>
  readonly tx?: string
  readonly c?: string
  readonly r?: string
  readonly ref?: string
  readonly img?: { readonly src: string; readonly nw: number; readonly nh: number; readonly alt: string }
  readonly f?: { readonly type: string; readonly placeholder: string }
  readonly href?: string
}

export interface SpecDump {
  readonly url?: string
  readonly title?: string
  readonly dir?: string
  readonly lang?: string
  readonly viewport?: { readonly w?: number; readonly h?: number; readonly docW?: number; readonly docH?: number }
  readonly body?: { readonly background?: string; readonly color?: string; readonly font?: string; readonly fontSize?: string }
  readonly fonts?: readonly string[]
  readonly capped?: boolean
  readonly nodes: readonly SpecDumpNode[]
}

// ═══ المواصفة ═══

export interface Box { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
export type PaletteRole = "background" | "text" | "border"
export interface PaletteEntry { readonly color: string; readonly roles: readonly PaletteRole[]; readonly uses: number; readonly area: number }
export type TypographyRole = "heading" | "body" | "button" | "nav" | "caption"
export interface TypographyEntry { readonly role: TypographyRole; readonly family: string; readonly size: number; readonly weight: number; readonly lineHeight?: number; readonly uses: number; readonly sample: string }
export interface SectionItem { readonly tag: string; readonly box: Box; readonly text: string; readonly ref?: string }
export interface SectionLayout { readonly display: string; readonly direction?: "row" | "column"; readonly columns?: number; readonly gap?: number; readonly justify?: string; readonly align?: string }
export interface Section {
  readonly id: string
  readonly tag: string
  readonly ref?: string
  readonly className?: string
  readonly box: Box
  readonly background?: string
  readonly padding: readonly [number, number, number, number]
  readonly radius?: number
  readonly layout: SectionLayout
  readonly children: number
  readonly summary: string
  readonly items: readonly SectionItem[]
}
export type ComponentKind = "nav" | "heading" | "button" | "input" | "card" | "image" | "icon" | "link"
export interface ComponentFont { readonly family: string; readonly size: number; readonly weight: number }
export interface Component {
  readonly id: string
  readonly kind: ComponentKind
  readonly tag: string
  readonly ref?: string
  readonly box: Box
  readonly text: string
  readonly color?: string
  readonly background?: string
  readonly radius: number
  readonly shadow?: string
  readonly border?: { readonly width: number; readonly color: string }
  readonly font: ComponentFont
  readonly textAlign?: string
  readonly placeholder?: string
  readonly src?: string
  readonly level?: number
}
export interface Asset { readonly kind: "image" | "background"; readonly src: string; readonly alt: string; readonly box: { readonly w: number; readonly h: number }; readonly natural?: { readonly w: number; readonly h: number } }
export interface DesignSpec {
  readonly version: 1
  readonly source: { readonly kind: "dom" | "screenshot"; readonly url?: string; readonly title?: string; readonly capped?: boolean }
  readonly viewport: { readonly width: number; readonly height: number; readonly documentHeight: number; readonly direction: "ltr" | "rtl"; readonly lang?: string }
  readonly body: { readonly background?: string; readonly color?: string; readonly font: string; readonly fontSize: number }
  readonly palette: readonly PaletteEntry[]
  readonly typography: readonly TypographyEntry[]
  readonly sections: readonly Section[]
  readonly components: readonly Component[]
  readonly spacing: readonly number[]
  readonly assets: readonly Asset[]
}

// ═══ مساعدات القيم ═══

/** لونٌ محسوب ⇦ hex صغير الحروف (`rgb(51, 85, 255)` ⇦ `#3355ff`)؛ الشفّافُ لا شيء؛ ما ليس rgb يُعاد كما هو مقصوصاً. */
export function normalizeColor(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined
  const v = String(value).trim().toLowerCase()
  if (v.length === 0 || v === "transparent" || v === "none" || v === "rgba(0, 0, 0, 0)" || v === "initial" || v === "inherit") return undefined
  const hex2 = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")
  const legacy = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/u.exec(v)
  const modern = legacy === null ? /^rgba?\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+)(%?)\s*)?\)$/u.exec(v) : null
  const m = legacy ?? modern
  if (m !== null) {
    let alpha = m[4] === undefined ? 1 : Number(m[4])
    if (modern !== null && modern[5] === "%") alpha /= 100
    if (!(alpha > 0)) return undefined
    const hex = `#${hex2(Number(m[1]))}${hex2(Number(m[2]))}${hex2(Number(m[3]))}`
    return alpha >= 1 ? hex : `${hex}${hex2(alpha * 255)}`
  }
  if (/^#[0-9a-f]{3}$/u.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`
  if (/^#[0-9a-f]{4}$/u.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}${v[4]}${v[4]}`
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/u.test(v)) return v
  return v.slice(0, 200)
}

/** `12px` ⇦ 12؛ غيرُ ذلك لا شيء. */
export const pxNumber = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined
  const m = /^(-?\d+(?:\.\d+)?)px$/u.exec(value.trim())
  return m === null ? undefined : Math.round(Number(m[1]) * 100) / 100
}

const firstFamily = (family: string | undefined): string => (family ?? "").split(",")[0]!.replace(/["']/gu, "").trim().slice(0, 60)
const weightNumber = (w: string | undefined): number => { const n = Number.parseInt(w ?? "", 10); return Number.isFinite(n) ? n : w === "bold" ? 700 : 400 }
const boxOf = (n: SpecDumpNode): Box => ({ x: n.x, y: n.y, w: n.w, h: n.h })
const area = (b: Box): number => Math.max(0, b.w) * Math.max(0, b.h)
const byPosition = <T extends { readonly box: Box; readonly id: string }>(a: T, b: T): number => a.box.y - b.box.y || a.box.x - b.box.x || a.id.localeCompare(b.id)
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// ═══ المصدر أ — من شجرة الصناديق إلى المواصفة ═══

/** يبني المواصفةَ من شجرة الماشي (نصّ JSON أو كائن). شجرةٌ بلا `nodes` تُرفض بالاسم. */
export function extractSpec(input: SpecDump | string): DesignSpec {
  let dump: SpecDump
  if (typeof input === "string") {
    const text = input.trim()
    const start = text.indexOf("{")
    if (start < 0) throw new Error("ليست شجرةَ مواصفة: لا JSON في النصّ")
    try { dump = JSON.parse(text.slice(start)) as SpecDump } catch { throw new Error("ليست شجرةَ مواصفة: JSON غير صالح") }
  } else dump = input
  if (dump === null || typeof dump !== "object" || !Array.isArray(dump.nodes)) throw new Error("ليست شجرةَ مواصفة: تنقصها قائمةُ nodes")
  const nodes = dump.nodes.filter((n) => n !== null && typeof n === "object" && Number.isFinite(n.w) && Number.isFinite(n.h) && Number.isFinite(n.i))
  const vw = Math.max(1, Math.round(dump.viewport?.w ?? Math.max(1, ...nodes.map((n) => n.x + n.w))))
  const vh = Math.max(1, Math.round(dump.viewport?.h ?? Math.max(1, ...nodes.map((n) => n.y + n.h))))
  const docH = Math.max(vh, Math.round(dump.viewport?.docH ?? 0), ...nodes.map((n) => n.y + n.h))
  const direction: "ltr" | "rtl" = dump.dir === "rtl" ? "rtl" : "ltr"
  const byIndex = new Map<number, SpecDumpNode>()
  const kids = new Map<number, SpecDumpNode[]>()
  for (const n of nodes) { byIndex.set(n.i, n); const list = kids.get(n.p) ?? []; list.push(n); kids.set(n.p, list) }
  const childrenOf = (n: SpecDumpNode): SpecDumpNode[] => (kids.get(n.i) ?? []).slice().sort((a, b) => a.y - b.y || a.x - b.x || a.i - b.i)
  const textOf = (n: SpecDumpNode, limit = 80): string => {
    if (n.tx !== undefined && n.tx.length > 0) return clip(n.tx, limit)
    const parts: string[] = []
    const queue = childrenOf(n)
    let total = 0
    while (queue.length > 0 && total < limit) {
      const c = queue.shift()!
      if (c.tx !== undefined && c.tx.length > 0) { parts.push(c.tx); total += c.tx.length + 1 }
      queue.push(...childrenOf(c))
    }
    return clip(parts.join(" ").replace(/\s+/gu, " ").trim(), limit)
  }
  const ancestorTag = (n: SpecDumpNode, tag: string): boolean => {
    let cur = byIndex.get(n.p)
    for (let guard = 0; cur !== undefined && guard < 64; guard += 1) { if (cur.t === tag || cur.r === "navigation") return true; cur = byIndex.get(cur.p) }
    return false
  }

  // — الألوان: بالمساحة والاستعمال، مكرّرةً مرّةً واحدة عبر الأدوار
  const palette = new Map<string, { roles: Set<PaletteRole>; uses: number; area: number }>()
  const tally = (color: string | undefined, role: PaletteRole, weight: number): void => {
    if (color === undefined || !color.startsWith("#")) return
    const entry = palette.get(color) ?? { roles: new Set<PaletteRole>(), uses: 0, area: 0 }
    entry.roles.add(role); entry.uses += 1; entry.area += weight
    palette.set(color, entry)
  }
  tally(normalizeColor(dump.body?.background), "background", vw * vh)
  for (const n of nodes) {
    const a = area(boxOf(n))
    tally(normalizeColor(n.s.backgroundColor), "background", a)
    if (n.tx !== undefined && n.tx.length > 0) tally(normalizeColor(n.s.color), "text", Math.min(a, n.tx.length * 200))
    if ((pxNumber(n.s.borderTopWidth) ?? 0) > 0) tally(normalizeColor(n.s.borderTopColor), "border", Math.max(1, Math.round(a / 8)))
  }
  const paletteOut: PaletteEntry[] = [...palette].map(([color, e]) => ({ color, roles: [...e.roles].sort(), uses: e.uses, area: Math.round(e.area) }))
    .sort((a, b) => b.area - a.area || b.uses - a.uses || a.color.localeCompare(b.color)).slice(0, 16)

  // — الخطوط: بحسب الدور (عنوان/زرّ/تنقّل/تعليق/متن) مجمّعةً بالعائلة والحجم والوزن
  const isButton = (n: SpecDumpNode): boolean => n.t === "button" || n.r === "button" || (n.t === "a" && /\b(?:btn|button)/iu.test(n.c ?? "")) || (n.t === "input" && /^(?:submit|button|reset)$/u.test(n.f?.type ?? ""))
  const typo = new Map<string, { role: TypographyRole; family: string; size: number; weight: number; lineHeight?: number; uses: number; sample: string }>()
  for (const n of nodes) {
    if (n.tx === undefined || n.tx.length === 0) continue
    const family = firstFamily(n.s.fontFamily ?? dump.body?.font), size = pxNumber(n.s.fontSize) ?? pxNumber(dump.body?.fontSize) ?? 16, weight = weightNumber(n.s.fontWeight)
    const parent = byIndex.get(n.p)
    const buttonish = isButton(n) || (parent !== undefined && isButton(parent))
    const role: TypographyRole = /^h[1-6]$/u.test(n.t) ? "heading" : buttonish ? "button" : ancestorTag(n, "nav") ? "nav" : n.t === "small" || n.t === "figcaption" || size < 13 ? "caption" : "body"
    const key = `${role}|${family}|${size}|${weight}`
    const entry = typo.get(key) ?? { role, family, size, weight, lineHeight: pxNumber(n.s.lineHeight), uses: 0, sample: clip(n.tx, 40) }
    entry.uses += 1
    typo.set(key, entry)
  }
  const roleRank: Record<TypographyRole, number> = { heading: 0, nav: 1, button: 2, body: 3, caption: 4 }
  const typographyOut: TypographyEntry[] = [...typo.values()].sort((a, b) => b.uses - a.uses || roleRank[a.role] - roleRank[b.role] || b.size - a.size)
    .slice(0, 12).map((e) => (e.lineHeight === undefined ? { role: e.role, family: e.family, size: e.size, weight: e.weight, uses: e.uses, sample: e.sample } : { role: e.role, family: e.family, size: e.size, weight: e.weight, lineHeight: e.lineHeight, uses: e.uses, sample: e.sample }))

  // — الأقسام: نزولٌ عبر الأغلفة ذات الابن الواحد حتى الحاوية التي تتفرّع، فأبناؤها الكتلُ العليا
  const root = nodes.find((n) => n.p === -1) ?? nodes[0]
  const sectionsOut: Section[] = []
  if (root !== undefined) {
    let container = root
    for (let guard = 0; guard < 8; guard += 1) {
      const c = childrenOf(container).filter((k) => area(boxOf(k)) > 0)
      if (c.length === 1 && area(boxOf(c[0]!)) >= area(boxOf(container)) * 0.6) container = c[0]!
      else break
    }
    const minArea = Math.max(64, (vw * vh) * 0.005)
    let blocks = childrenOf(container).filter((k) => area(boxOf(k)) >= minArea || k.h >= 40)
    if (blocks.length === 0) blocks = [container]
    blocks = blocks.slice(0, 24)
    const layoutOf = (n: SpecDumpNode): SectionLayout => {
      const display = (n.s.display ?? "block").split(" ")[0]!
      const out: { display: string; direction?: "row" | "column"; columns?: number; gap?: number; justify?: string; align?: string } = { display }
      if (display.includes("flex")) out.direction = (n.s.flexDirection ?? "row").startsWith("column") ? "column" : "row"
      if (display.includes("grid") && n.s.gridTemplateColumns !== undefined) { const tracks = n.s.gridTemplateColumns.trim().split(/\s+/u).filter((t) => t.length > 0); if (tracks.length > 0) out.columns = tracks.length }
      const gap = pxNumber((n.s.gap ?? "").split(" ")[0])
      if (gap !== undefined && gap > 0) out.gap = gap
      if (n.s.justifyContent !== undefined && n.s.justifyContent !== "normal" && n.s.justifyContent !== "flex-start") out.justify = n.s.justifyContent.slice(0, 24)
      if (n.s.alignItems !== undefined && n.s.alignItems !== "normal" && n.s.alignItems !== "stretch") out.align = n.s.alignItems.slice(0, 24)
      return out
    }
    blocks.forEach((b, index) => {
      const items: SectionItem[] = childrenOf(b).filter((k) => area(boxOf(k)) > 0).slice(0, 8).map((k) => (k.ref === undefined ? { tag: k.t, box: boxOf(k), text: textOf(k, 60) } : { tag: k.t, box: boxOf(k), text: textOf(k, 60), ref: k.ref }))
      const background = normalizeColor(n_background(b))
      const radius = pxNumber((b.s.borderRadius ?? "").split(" ")[0])
      const section: Section = {
        id: `s${index + 1}`,
        tag: b.t,
        ...(b.ref === undefined ? {} : { ref: b.ref }),
        ...(b.c === undefined ? {} : { className: b.c }),
        box: boxOf(b),
        ...(background === undefined ? {} : { background }),
        padding: [pxNumber(b.s.paddingTop) ?? 0, pxNumber(b.s.paddingRight) ?? 0, pxNumber(b.s.paddingBottom) ?? 0, pxNumber(b.s.paddingLeft) ?? 0],
        ...(radius === undefined || radius === 0 ? {} : { radius }),
        layout: layoutOf(b),
        children: b.n,
        summary: textOf(b, 120),
        items,
      }
      sectionsOut.push(section)
    })
  }

  // — المكوّنات: أزرارٌ وحقولٌ وتنقّلٌ وعناوينُ وبطاقاتٌ وصورٌ وأيقوناتٌ وروابط
  const kindOf = (n: SpecDumpNode): ComponentKind | undefined => {
    if (isButton(n)) return "button"
    if (n.t === "input" || n.t === "textarea" || n.t === "select") return "input"
    if (n.t === "nav" || n.r === "navigation") return "nav"
    if (/^h[1-6]$/u.test(n.t)) return "heading"
    if (n.t === "img") return "image"
    if (n.t === "svg" && n.w <= 96 && n.h <= 96) return "icon"
    const radius = pxNumber((n.s.borderRadius ?? "").split(" ")[0]) ?? 0
    const framed = n.s.boxShadow !== undefined || (pxNumber(n.s.borderTopWidth) ?? 0) > 0
    if (radius > 0 && framed && n.w >= 80 && n.h >= 60 && n.n >= 1) return "card"
    if (n.t === "a" && n.tx !== undefined && n.tx.length > 0) return "link"
    return undefined
  }
  const kindRank: Record<ComponentKind, number> = { nav: 0, heading: 1, button: 2, input: 3, card: 4, image: 5, icon: 6, link: 7 }
  const componentsRaw: (Omit<Component, "id"> & { readonly order: number })[] = []
  for (const n of nodes) {
    const kind = kindOf(n)
    if (kind === undefined) continue
    const borderWidth = pxNumber(n.s.borderTopWidth) ?? 0
    const borderColor = normalizeColor(n.s.borderTopColor)
    const color = normalizeColor(n.s.color), background = normalizeColor(n_background(n))
    const component: Omit<Component, "id"> & { readonly order: number } = {
      order: n.i,
      kind, tag: n.t,
      ...(n.ref === undefined ? {} : { ref: n.ref }),
      box: boxOf(n),
      text: kind === "image" ? (n.img?.alt ?? "") : kind === "input" ? "" : textOf(n, 80),
      ...(color === undefined ? {} : { color }),
      ...(background === undefined ? {} : { background }),
      radius: pxNumber((n.s.borderRadius ?? "").split(" ")[0]) ?? 0,
      ...(n.s.boxShadow === undefined ? {} : { shadow: n.s.boxShadow.slice(0, 120) }),
      ...(borderWidth > 0 && borderColor !== undefined ? { border: { width: borderWidth, color: borderColor } } : {}),
      font: { family: firstFamily(n.s.fontFamily ?? dump.body?.font), size: pxNumber(n.s.fontSize) ?? pxNumber(dump.body?.fontSize) ?? 16, weight: weightNumber(n.s.fontWeight) },
      ...(n.s.textAlign === undefined ? {} : { textAlign: n.s.textAlign.slice(0, 12) }),
      ...(n.f?.placeholder !== undefined && n.f.placeholder.length > 0 ? { placeholder: n.f.placeholder } : {}),
      ...(n.img?.src !== undefined && n.img.src.length > 0 ? { src: n.img.src } : {}),
      ...(/^h[1-6]$/u.test(n.t) ? { level: Number(n.t[1]) } : {}),
    }
    componentsRaw.push(component)
  }
  componentsRaw.sort((a, b) => kindRank[a.kind] - kindRank[b.kind] || a.box.y - b.box.y || a.box.x - b.box.x || a.order - b.order)
  const componentsOut: Component[] = componentsRaw.slice(0, 60).map(({ order: _order, ...c }, index) => ({ id: `c${index + 1}`, ...c }))

  // — مقياسُ التباعد: قيمُ الحشو والهامش والفجوة الأكثر تكراراً
  const spacingCount = new Map<number, number>()
  for (const n of nodes) {
    for (const key of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "marginTop", "marginBottom"]) { const v = pxNumber(n.s[key]); if (v !== undefined && v > 0) spacingCount.set(v, (spacingCount.get(v) ?? 0) + 1) }
    for (const part of (n.s.gap ?? "").split(" ")) { const v = pxNumber(part); if (v !== undefined && v > 0) spacingCount.set(v, (spacingCount.get(v) ?? 0) + 1) }
  }
  const spacingRanked = [...spacingCount].sort((a, b) => b[1] - a[1] || a[0] - b[0])
  const repeated = spacingRanked.filter(([, count]) => count >= 2)
  const spacingOut = (repeated.length > 0 ? repeated : spacingRanked).slice(0, 12).map(([v]) => v).sort((a, b) => a - b)

  // — الأصول: صورٌ بأبعادها الطبيعيّة والمعروضة، وخلفيّاتٌ بصورة
  const assetsOut: Asset[] = []
  const seenAssets = new Set<string>()
  for (const n of nodes) {
    if (assetsOut.length >= 24) break
    if (n.t === "img" && n.img !== undefined && n.img.src.length > 0 && !seenAssets.has(n.img.src)) {
      seenAssets.add(n.img.src)
      assetsOut.push({ kind: "image", src: n.img.src, alt: n.img.alt, box: { w: n.w, h: n.h }, natural: { w: n.img.nw, h: n.img.nh } })
      continue
    }
    const bg = n.s.backgroundImage
    if (bg !== undefined && bg.startsWith("url(")) {
      const src = bg.slice(4, bg.lastIndexOf(")")).replace(/^["']|["']$/gu, "").slice(0, 300)
      if (src.length > 0 && !seenAssets.has(src)) { seenAssets.add(src); assetsOut.push({ kind: "background", src, alt: "", box: { w: n.w, h: n.h } }) }
    }
  }

  const bodyBackground = normalizeColor(dump.body?.background), bodyColor = normalizeColor(dump.body?.color)
  return {
    version: 1,
    source: { kind: "dom", ...(dump.url === undefined ? {} : { url: String(dump.url).slice(0, 300) }), ...(dump.title === undefined ? {} : { title: String(dump.title).slice(0, 120) }), ...(dump.capped === true ? { capped: true } : {}) },
    viewport: { width: vw, height: vh, documentHeight: docH, direction, ...(dump.lang !== undefined && dump.lang.length > 0 ? { lang: String(dump.lang).slice(0, 12) } : {}) },
    body: { ...(bodyBackground === undefined ? {} : { background: bodyBackground }), ...(bodyColor === undefined ? {} : { color: bodyColor }), font: firstFamily(dump.body?.font) || "sans-serif", fontSize: pxNumber(dump.body?.fontSize) ?? 16 },
    palette: paletteOut,
    typography: typographyOut,
    sections: sectionsOut.sort(byPosition),
    components: componentsOut,
    spacing: spacingOut,
    assets: assetsOut,
  }
}

/** خلفيّةُ عنصرٍ: لونٌ صريح، وإلا تدرّجٌ إن كان. */
const n_background = (n: SpecDumpNode): string | undefined => {
  const color = normalizeColor(n.s.backgroundColor)
  if (color !== undefined) return color
  const image = n.s.backgroundImage
  return image !== undefined && image.includes("gradient") ? image : undefined
}

// ═══ تطبيعُ مواصفةٍ من مصدرٍ غير موثوق (ملفٌّ محرَّر يدويّاً، أو جوابُ نموذج الرؤية) ═══

const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : typeof v === "string" && /^-?\d+(?:\.\d+)?(?:px)?$/u.test(v.trim()) ? Math.round(Number.parseFloat(v) * 100) / 100 : fallback)
const str = (v: unknown, max = 200): string => (typeof v === "string" ? v.slice(0, max) : "")
const boxFrom = (v: unknown): Box => { const o = (v ?? {}) as Record<string, unknown>; return { x: num(o.x), y: num(o.y), w: Math.max(0, num(o.w)), h: Math.max(0, num(o.h)) } }
const colorFrom = (v: unknown): string | undefined => (typeof v === "string" ? normalizeColor(v) : undefined)
const list = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : [])
const KINDS: readonly ComponentKind[] = ["nav", "heading", "button", "input", "card", "image", "icon", "link"]
const TYPO_ROLES: readonly TypographyRole[] = ["heading", "body", "button", "nav", "caption"]
const PALETTE_ROLES: readonly PaletteRole[] = ["background", "text", "border"]

/** يقبل أيَّ JSON ويُخرج مواصفةً صحيحةَ الشكل: الأرقامُ أرقامٌ، والألوانُ مطبَّعة، والأنواعُ من القوائم المغلقة، والفائضُ يُسقط. */
export function normalizeSpec(raw: unknown, frame?: { width: number; height: number; direction?: "ltr" | "rtl" }): DesignSpec {
  const o = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const vp = (o.viewport ?? {}) as Record<string, unknown>
  const width = Math.max(1, Math.round(num(vp.width, frame?.width ?? 1280))), height = Math.max(1, Math.round(num(vp.height, frame?.height ?? 720)))
  const direction: "ltr" | "rtl" = vp.direction === "rtl" || (vp.direction === undefined && frame?.direction === "rtl") ? "rtl" : "ltr"
  const body = (o.body ?? {}) as Record<string, unknown>
  const source = (o.source ?? {}) as Record<string, unknown>
  const font = (v: unknown): ComponentFont => { const f = (v ?? {}) as Record<string, unknown>; return { family: str(f.family, 60) || str(body.font, 60) || "sans-serif", size: Math.max(1, num(f.size, 16)), weight: Math.max(100, Math.min(900, num(f.weight, 400))) } }
  const sections: Section[] = list(o.sections).slice(0, 24).map((s, i) => {
    const e = (s ?? {}) as Record<string, unknown>
    const layoutRaw = (e.layout ?? {}) as Record<string, unknown>
    const pad = list(e.padding).map((p) => Math.max(0, num(p)))
    const background = colorFrom(e.background) ?? (typeof e.background === "string" && e.background.includes("gradient") ? e.background.slice(0, 200) : undefined)
    const radius = num(e.radius)
    const layout: SectionLayout = {
      display: str(layoutRaw.display, 12) || "block",
      ...(layoutRaw.direction === "column" ? { direction: "column" as const } : layoutRaw.direction === "row" ? { direction: "row" as const } : {}),
      ...(num(layoutRaw.columns) > 0 ? { columns: Math.round(num(layoutRaw.columns)) } : {}),
      ...(num(layoutRaw.gap) > 0 ? { gap: num(layoutRaw.gap) } : {}),
      ...(str(layoutRaw.justify, 24).length > 0 ? { justify: str(layoutRaw.justify, 24) } : {}),
      ...(str(layoutRaw.align, 24).length > 0 ? { align: str(layoutRaw.align, 24) } : {}),
    }
    return {
      id: str(e.id, 12) || `s${i + 1}`,
      tag: /^[a-z][a-z0-9-]{0,20}$/u.test(str(e.tag, 21)) ? str(e.tag, 21) : "section",
      ...(str(e.ref, 12).length > 0 ? { ref: str(e.ref, 12) } : {}),
      ...(str(e.className, 80).length > 0 ? { className: str(e.className, 80) } : {}),
      box: boxFrom(e.box),
      ...(background === undefined ? {} : { background }),
      padding: [pad[0] ?? 0, pad[1] ?? pad[0] ?? 0, pad[2] ?? pad[0] ?? 0, pad[3] ?? pad[1] ?? pad[0] ?? 0],
      ...(radius > 0 ? { radius } : {}),
      layout,
      children: Math.max(0, Math.round(num(e.children))),
      summary: str(e.summary, 120),
      items: list(e.items).slice(0, 8).map((it) => { const x = (it ?? {}) as Record<string, unknown>; return { tag: /^[a-z][a-z0-9-]{0,20}$/u.test(str(x.tag, 21)) ? str(x.tag, 21) : "div", box: boxFrom(x.box), text: str(x.text, 60), ...(str(x.ref, 12).length > 0 ? { ref: str(x.ref, 12) } : {}) } }),
    }
  })
  const components: Component[] = list(o.components).slice(0, 60).map((c, i) => {
    const e = (c ?? {}) as Record<string, unknown>
    const kind = KINDS.includes(e.kind as ComponentKind) ? (e.kind as ComponentKind) : "card"
    const color = colorFrom(e.color), background = colorFrom(e.background) ?? (typeof e.background === "string" && e.background.includes("gradient") ? e.background.slice(0, 200) : undefined)
    const borderRaw = (e.border ?? undefined) as Record<string, unknown> | undefined
    const borderColor = borderRaw === undefined ? undefined : colorFrom(borderRaw.color)
    const src = str(e.src, 300)
    const level = Math.round(num(e.level))
    return {
      id: str(e.id, 12) || `c${i + 1}`,
      kind,
      tag: /^[a-z][a-z0-9-]{0,20}$/u.test(str(e.tag, 21)) ? str(e.tag, 21) : kind === "heading" ? "h2" : kind === "button" ? "button" : kind === "input" ? "input" : kind === "image" ? "img" : kind === "link" ? "a" : kind === "nav" ? "nav" : "div",
      ...(str(e.ref, 12).length > 0 ? { ref: str(e.ref, 12) } : {}),
      box: boxFrom(e.box),
      text: str(e.text, 80),
      ...(color === undefined ? {} : { color }),
      ...(background === undefined ? {} : { background }),
      radius: Math.max(0, num(e.radius)),
      ...(str(e.shadow, 120).length > 0 ? { shadow: str(e.shadow, 120) } : {}),
      ...(borderRaw !== undefined && num(borderRaw.width) > 0 && borderColor !== undefined ? { border: { width: num(borderRaw.width), color: borderColor } } : {}),
      font: font(e.font),
      ...(str(e.textAlign, 12).length > 0 ? { textAlign: str(e.textAlign, 12) } : {}),
      ...(str(e.placeholder, 60).length > 0 ? { placeholder: str(e.placeholder, 60) } : {}),
      ...(src.length > 0 ? { src } : {}),
      ...(level >= 1 && level <= 6 ? { level } : {}),
    }
  })
  const docHeight = Math.max(height, Math.round(num(vp.documentHeight, height)), ...sections.map((s) => s.box.y + s.box.h), ...components.map((c) => c.box.y + c.box.h))
  const bodyBackground = colorFrom(body.background), bodyColor = colorFrom(body.color)
  return {
    version: 1,
    source: { kind: source.kind === "screenshot" ? "screenshot" : "dom", ...(str(source.url, 300).length > 0 ? { url: str(source.url, 300) } : {}), ...(str(source.title, 120).length > 0 ? { title: str(source.title, 120) } : {}), ...(source.capped === true ? { capped: true } : {}) },
    viewport: { width, height, documentHeight: docHeight, direction, ...(str(vp.lang, 12).length > 0 ? { lang: str(vp.lang, 12) } : {}) },
    body: { ...(bodyBackground === undefined ? {} : { background: bodyBackground }), ...(bodyColor === undefined ? {} : { color: bodyColor }), font: str(body.font, 60) || "sans-serif", fontSize: Math.max(1, num(body.fontSize, 16)) },
    palette: list(o.palette).slice(0, 16).flatMap((p) => { const e = (p ?? {}) as Record<string, unknown>; const color = colorFrom(e.color); if (color === undefined) return []; const roles = list(e.roles).filter((r): r is PaletteRole => PALETTE_ROLES.includes(r as PaletteRole)); return [{ color, roles: roles.length > 0 ? [...new Set(roles)].sort() : ["background" as const], uses: Math.max(1, Math.round(num(e.uses, 1))), area: Math.max(0, Math.round(num(e.area))) }] }),
    typography: list(o.typography).slice(0, 12).map((t) => { const e = (t ?? {}) as Record<string, unknown>; const f = font(e); const lh = num(e.lineHeight); return { role: TYPO_ROLES.includes(e.role as TypographyRole) ? (e.role as TypographyRole) : "body", family: f.family, size: f.size, weight: f.weight, ...(lh > 0 ? { lineHeight: lh } : {}), uses: Math.max(1, Math.round(num(e.uses, 1))), sample: str(e.sample, 40) } }),
    sections,
    components,
    spacing: [...new Set(list(o.spacing).map((v) => num(v)).filter((v) => v > 0))].sort((a, b) => a - b).slice(0, 12),
    assets: list(o.assets).slice(0, 24).flatMap((a) => { const e = (a ?? {}) as Record<string, unknown>; const src = str(e.src, 300); const b = (e.box ?? {}) as Record<string, unknown>; const nat = e.natural as Record<string, unknown> | undefined; return [{ kind: e.kind === "background" ? "background" as const : "image" as const, src, alt: str(e.alt, 80), box: { w: Math.max(0, num(b.w)), h: Math.max(0, num(b.h)) }, ...(nat !== undefined && num(nat.w) > 0 ? { natural: { w: num(nat.w), h: num(nat.h) } } : {}) }] }),
  }
}

// ═══ الرندر — HTML واحدٌ مكتفٍ بذاته، حتميّ ═══

const escapeHtml = (s: string): string => s.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;")
/** قيمةُ CSS من مصدرٍ غير موثوق: تُنزع أحرفُ الكسر (أقواسُ الكتل، الفاصلةُ المنقوطة، الزوايا، الاقتباس). */
const cssValue = (s: string): string => s.replace(/[{};<>"\\]/gu, "").trim()
const safeUrl = (u: string): string | undefined => (/^(?:https?:\/\/|data:image\/)/iu.test(u) && !/[\s"'<>\\]/u.test(u) ? u : undefined)
const safeBackground = (v: string | undefined): string | undefined => {
  if (v === undefined) return undefined
  if (v.startsWith("#")) return v
  if (v.startsWith("url(")) { const u = safeUrl(v.slice(4, v.lastIndexOf(")")).replace(/^["']|["']$/gu, "")); return u === undefined ? undefined : `url("${u}") center/cover no-repeat` }
  if (/gradient\(/u.test(v) && !/url\(/iu.test(v)) return cssValue(v)
  return undefined
}
const px = (n: number): string => `${Math.round(n)}px`
const fontCss = (f: ComponentFont): string => `font:${f.weight} ${px(f.size)}/1.2 ${cssValue(f.family).replace(/^(.*\s.*)$/u, '"$1"')},sans-serif`

/** المواصفةُ ⇦ HTML واحد: كلُّ قسمٍ ومكوّنٍ صندوقٌ مطلقٌ بأرقامه (البكسلُ نفسُه)، والأقسامُ تعلن تخطيطَها (flex/grid وفجوته وحشوه). */
export function renderSpec(input: DesignSpec): string {
  const spec = normalizeSpec(input)
  const dir = spec.viewport.direction
  const W = spec.viewport.width
  const sections = [...spec.sections].sort(byPosition)
  const components = [...spec.components].sort(byPosition)
  const H = Math.max(spec.viewport.documentHeight, ...sections.map((s) => s.box.y + s.box.h), ...components.map((c) => c.box.y + c.box.h))
  const lang = spec.viewport.lang ?? (dir === "rtl" ? "ar" : "en")
  const title = spec.source.title ?? "design"
  const vars = spec.palette.map((p, i) => `--c${i + 1}:${p.color}`).join(";")
  const bodyBg = spec.body.background ?? "#ffffff", bodyColor = spec.body.color ?? "#111111"
  const out: string[] = [
    "<!doctype html>",
    `<html lang="${escapeHtml(lang)}" dir="${dir}">`,
    "<head>",
    '<meta charset="utf-8">',
    `<meta name="viewport" content="width=${W}">`,
    `<title>${escapeHtml(title)}</title>`,
    "<style>",
    `:root{${vars}}`,
    "*{box-sizing:border-box;margin:0;padding:0}",
    `html,body{background:${bodyBg};color:${bodyColor};font:${px(spec.body.fontSize)}/1.4 ${cssValue(spec.body.font).replace(/^(.*\s.*)$/u, '"$1"')},sans-serif;direction:${dir}}`,
    `.page{position:relative;width:${px(W)};min-height:${px(H)};margin:0 auto;overflow:hidden;direction:${dir}}`,
    ".sec{position:absolute;overflow:hidden}",
    ".sec>.it{position:absolute;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}",
    ".cmp{position:absolute;display:flex;align-items:center;justify-content:center;overflow:hidden;white-space:nowrap;text-decoration:none;border:0;outline:0;background:transparent;text-align:start}",
    ".cmp.input{justify-content:flex-start;padding-inline:12px}",
    ".cmp.image,.cmp.icon{display:block}",
    ".ph{background:repeating-linear-gradient(45deg,#e5e7eb 0 8px,#f3f4f6 8px 16px)}",
    "img.cmp{object-fit:cover}",
    "</style>",
    "</head>",
    "<body>",
    `<div class="page">`,
  ]
  for (const s of sections) {
    const style: string[] = [`left:${px(s.box.x)}`, `top:${px(s.box.y)}`, `width:${px(s.box.w)}`, `height:${px(s.box.h)}`]
    const bg = safeBackground(s.background)
    if (bg !== undefined) style.push(`background:${bg}`)
    style.push(`padding:${s.padding.map(px).join(" ")}`)
    if (s.radius !== undefined) style.push(`border-radius:${px(s.radius)}`)
    const display = cssValue(s.layout.display)
    if (display.length > 0 && display !== "block") style.push(`display:${display}`)
    if (s.layout.direction !== undefined) style.push(`flex-direction:${s.layout.direction}`)
    if (s.layout.columns !== undefined) style.push(`grid-template-columns:repeat(${s.layout.columns},1fr)`)
    if (s.layout.gap !== undefined) style.push(`gap:${px(s.layout.gap)}`)
    if (s.layout.justify !== undefined) style.push(`justify-content:${cssValue(s.layout.justify)}`)
    if (s.layout.align !== undefined) style.push(`align-items:${cssValue(s.layout.align)}`)
    const tag = s.tag === "body" || s.tag === "html" ? "div" : s.tag
    out.push(`<${tag} class="sec" id="${escapeHtml(s.id)}" style="${style.join(";")}">`)
    for (const it of s.items) {
      if (it.text.length === 0) continue
      const itStyle = [`left:${px(it.box.x - s.box.x)}`, `top:${px(it.box.y - s.box.y)}`, `width:${px(it.box.w)}`, `height:${px(it.box.h)}`]
      out.push(`<div class="it" style="${itStyle.join(";")}">${escapeHtml(it.text)}</div>`)
    }
    out.push(`</${tag}>`)
  }
  for (const c of components) {
    const style: string[] = [`left:${px(c.box.x)}`, `top:${px(c.box.y)}`, `width:${px(c.box.w)}`, `height:${px(c.box.h)}`, fontCss(c.font)]
    if (c.color !== undefined) style.push(`color:${c.color}`)
    const bg = safeBackground(c.background)
    if (bg !== undefined) style.push(`background:${bg}`)
    if (c.radius > 0) style.push(`border-radius:${px(c.radius)}`)
    if (c.shadow !== undefined) style.push(`box-shadow:${cssValue(c.shadow)}`)
    if (c.border !== undefined) style.push(`border:${px(c.border.width)} solid ${c.border.color}`)
    if (c.textAlign !== undefined) style.push(`text-align:${cssValue(c.textAlign)}`)
    const attrs = `class="cmp ${c.kind}" id="${escapeHtml(c.id)}" style="${style.join(";")}"`
    switch (c.kind) {
      case "image": {
        const src = c.src === undefined ? undefined : safeUrl(c.src)
        out.push(src === undefined ? `<div ${attrs.replace('class="cmp image"', 'class="cmp image ph"')} title="${escapeHtml(c.text)}"></div>` : `<img ${attrs} src="${escapeHtml(src)}" alt="${escapeHtml(c.text)}">`)
        break
      }
      case "icon": out.push(`<div ${attrs.replace('class="cmp icon"', 'class="cmp icon ph"')}></div>`); break
      case "input": out.push(`<input ${attrs} type="text" placeholder="${escapeHtml(c.placeholder ?? c.text)}">`); break
      case "button": out.push(`<button ${attrs} type="button">${escapeHtml(c.text)}</button>`); break
      case "heading": { const h = `h${c.level ?? 2}`; out.push(`<${h} ${attrs}>${escapeHtml(c.text)}</${h}>`); break }
      case "link": out.push(`<a ${attrs} href="#">${escapeHtml(c.text)}</a>`); break
      case "nav": out.push(`<nav ${attrs}>${escapeHtml(c.text)}</nav>`); break
      default: out.push(`<div ${attrs}>${escapeHtml(c.text)}</div>`)
    }
  }
  out.push("</div>", "</body>", "</html>", "")
  return out.join("\n")
}

// ═══ PNG — فكٌّ وتشفيرٌ خالصان (zlib من node) ═══

export interface DecodedImage { readonly width: number; readonly height: number; readonly rgba: Uint8Array }

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
let crcTable: Uint32Array | undefined
const crc32 = (buf: Buffer): number => {
  if (crcTable === undefined) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0 }
  }
  let crc = 0xffffffff
  for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** يفكّ PNG غيرَ متشابك بعمق ٨ أو ١٦ بت (رماديّ/RGB/لوحة/رماديّ+ألفا/RGBA) إلى RGBA. ما عداه يُرفض بالاسم لا بصمت. */
export function decodePng(bytes: Uint8Array): DecodedImage {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (b.length < 8 || !b.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("ليس ملفَّ PNG (التوقيعُ مختلف)")
  let off = 8, width = 0, height = 0, depth = 0, colorType = 0, interlace = 0
  const idat: Buffer[] = []
  let plte: Buffer | undefined, trns: Buffer | undefined
  while (off + 8 <= b.length) {
    const len = b.readUInt32BE(off)
    const type = b.toString("ascii", off + 4, off + 8)
    const data = b.subarray(off + 8, Math.min(b.length, off + 8 + len))
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]!; colorType = data[9]!; interlace = data[12]! }
    else if (type === "PLTE") plte = data
    else if (type === "tRNS") trns = data
    else if (type === "IDAT") idat.push(data)
    else if (type === "IEND") break
    off += 12 + len
  }
  if (width === 0 || height === 0) throw new Error("PNG بلا IHDR صالح")
  if (interlace !== 0) throw new Error("PNG متشابك (Adam7) غير مدعوم")
  if (depth !== 8 && depth !== 16) throw new Error(`عمقُ بت ${depth} غير مدعوم (المدعوم 8 و16)`)
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number | undefined>)[colorType]
  if (channels === undefined) throw new Error(`نوعُ لون PNG ${colorType} غير مدعوم`)
  if (colorType === 3 && plte === undefined) throw new Error("PNG بلوحةٍ بلا PLTE")
  const bpp = channels * (depth / 8), stride = width * bpp
  const raw = inflateSync(Buffer.concat(idat))
  if (raw.length < (stride + 1) * height) throw new Error("بيانات PNG ناقصة")
  const pixels = Buffer.alloc(stride * height)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const cur = pixels.subarray(y * stride, (y + 1) * stride)
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? cur[i - bpp]! : 0, up = prev[i]!, c = i >= bpp ? prev[i - bpp]! : 0, x = line[i]!
      let v: number
      if (filter === 0) v = x
      else if (filter === 1) v = x + a
      else if (filter === 2) v = x + up
      else if (filter === 3) v = x + Math.floor((a + up) / 2)
      else if (filter === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c) }
      else throw new Error(`مرشِّحُ PNG ${filter} غير معروف`)
      cur[i] = v & 255
    }
    prev = cur
  }
  const rgba = new Uint8Array(width * height * 4)
  const step = depth / 8
  for (let p = 0; p < width * height; p += 1) {
    const base = p * bpp
    const sample = (ch: number): number => pixels[base + ch * step]!
    const o = p * 4
    if (colorType === 0) { const g = sample(0); rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = 255 }
    else if (colorType === 2) { rgba[o] = sample(0); rgba[o + 1] = sample(1); rgba[o + 2] = sample(2); rgba[o + 3] = 255 }
    else if (colorType === 3) { const idx = sample(0); rgba[o] = plte![idx * 3] ?? 0; rgba[o + 1] = plte![idx * 3 + 1] ?? 0; rgba[o + 2] = plte![idx * 3 + 2] ?? 0; rgba[o + 3] = trns !== undefined && idx < trns.length ? trns[idx]! : 255 }
    else if (colorType === 4) { const g = sample(0); rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = sample(1) }
    else { rgba[o] = sample(0); rgba[o + 1] = sample(1); rgba[o + 2] = sample(2); rgba[o + 3] = sample(3) }
  }
  return { width, height, rgba }
}

/** يشفّر RGBA إلى PNG (٨ بت، بلا مرشِّح) — للاختبارات ولصور الفرق. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  if (rgba.length !== width * height * 4) throw new Error("حجمُ RGBA لا يطابق الأبعاد")
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) { raw[y * (width * 4 + 1)] = 0; raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1) }
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(4); head.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, "ascii"), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0)
    return Buffer.concat([head, body, crc])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))])
}

/** تصغيرٌ بمتوسّط المساحة إلى أبعادٍ مستهدفة، مع دمج الشفافيّة على الأبيض (لقطاتُ الصفحات معتمة أصلاً). */
export function resampleImage(img: DecodedImage, dw: number, dh: number): DecodedImage {
  const out = new Uint8Array(dw * dh * 4)
  for (let dy = 0; dy < dh; dy += 1) {
    const sy0 = Math.floor((dy * img.height) / dh), sy1 = Math.max(sy0 + 1, Math.floor(((dy + 1) * img.height) / dh))
    for (let dx = 0; dx < dw; dx += 1) {
      const sx0 = Math.floor((dx * img.width) / dw), sx1 = Math.max(sx0 + 1, Math.floor(((dx + 1) * img.width) / dw))
      let r = 0, g = 0, b = 0, count = 0
      for (let y = sy0; y < sy1 && y < img.height; y += 1) for (let x = sx0; x < sx1 && x < img.width; x += 1) {
        const o = (y * img.width + x) * 4, a = img.rgba[o + 3]! / 255
        r += img.rgba[o]! * a + 255 * (1 - a); g += img.rgba[o + 1]! * a + 255 * (1 - a); b += img.rgba[o + 2]! * a + 255 * (1 - a); count += 1
      }
      const o = (dy * dw + dx) * 4
      out[o] = count === 0 ? 255 : Math.round(r / count); out[o + 1] = count === 0 ? 255 : Math.round(g / count); out[o + 2] = count === 0 ? 255 : Math.round(b / count); out[o + 3] = 255
    }
  }
  return { width: dw, height: dh, rgba: out }
}

// ═══ المقارنة ═══

export interface DiffRegion { readonly box: Box; readonly diff: number; readonly target: string; readonly candidate: string }
export interface CompareReport {
  /** نسبةُ البكسلات المتطابقة ضمن التسامح (٠–١٠٠) بعد التصغير إلى الإطار المشترك. */
  readonly similarity: number
  /** متوسّطُ الفرق المطلق لكلّ قناة (٠–٢٥٥). */
  readonly meanDelta: number
  readonly target: { readonly width: number; readonly height: number }
  readonly candidate: { readonly width: number; readonly height: number }
  readonly compared: { readonly width: number; readonly height: number }
  readonly sizeMismatch: boolean
  /** أعلى ٥ مناطق اختلافاً — صناديقُها بإحداثيّات الهدف الأصليّة، ولونُ كلّ طرفٍ فيها. */
  readonly regions: readonly DiffRegion[]
  readonly verdict: string
}

const hexOf = (r: number, g: number, b: number): string => `#${[r, g, b].map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")).join("")}`

/** يقارن لقطتين PNG على الإطار نفسه (يُصغَّران إلى ≤ maxWidth) ويعيد التشابهَ وأكثرَ المناطق اختلافاً كي يعرف النموذجُ أين يصلح. */
export function compareRendering(targetPng: Uint8Array, candidatePng: Uint8Array, options: { readonly maxWidth?: number; readonly tolerance?: number; readonly grid?: number } = {}): CompareReport {
  const t = decodePng(targetPng), c = decodePng(candidatePng)
  const maxWidth = Math.max(16, Math.floor(options.maxWidth ?? 480))
  const tolerance = Math.max(0, Math.min(255, options.tolerance ?? 24))
  const cw = Math.min(maxWidth, t.width), ch = Math.max(1, Math.round((t.height * cw) / t.width))
  const ta = resampleImage(t, cw, ch), ca = resampleImage(c, cw, ch)
  const cols = Math.max(1, Math.min(32, Math.floor(options.grid ?? 8))), rows = Math.max(1, Math.min(32, Math.round((cols * ch) / cw)))
  const cellW = cw / cols, cellH = ch / rows
  const cells = Array.from({ length: cols * rows }, () => ({ mismatched: 0, pixels: 0, tr: 0, tg: 0, tb: 0, cr: 0, cg: 0, cb: 0 }))
  let mismatched = 0, sumDelta = 0
  for (let y = 0; y < ch; y += 1) for (let x = 0; x < cw; x += 1) {
    const o = (y * cw + x) * 4
    const dr = Math.abs(ta.rgba[o]! - ca.rgba[o]!), dg = Math.abs(ta.rgba[o + 1]! - ca.rgba[o + 1]!), db = Math.abs(ta.rgba[o + 2]! - ca.rgba[o + 2]!)
    const cell = cells[Math.min(rows - 1, Math.floor(y / cellH)) * cols + Math.min(cols - 1, Math.floor(x / cellW))]!
    cell.pixels += 1; cell.tr += ta.rgba[o]!; cell.tg += ta.rgba[o + 1]!; cell.tb += ta.rgba[o + 2]!; cell.cr += ca.rgba[o]!; cell.cg += ca.rgba[o + 1]!; cell.cb += ca.rgba[o + 2]!
    sumDelta += (dr + dg + db) / 3
    if (Math.max(dr, dg, db) > tolerance) { mismatched += 1; cell.mismatched += 1 }
  }
  const total = cw * ch
  const similarity = Math.round((1 - mismatched / total) * 1000) / 10
  const meanDelta = Math.round((sumDelta / total) * 10) / 10
  const scaleX = t.width / cw, scaleY = t.height / ch
  const regions: DiffRegion[] = cells.map((cell, index) => ({ cell, index })).filter(({ cell }) => cell.mismatched > 0)
    .sort((a, b) => b.cell.mismatched / b.cell.pixels - a.cell.mismatched / a.cell.pixels || a.index - b.index).slice(0, 5)
    .map(({ cell, index }) => {
      const col = index % cols, row = Math.floor(index / cols)
      return {
        box: { x: Math.round(col * cellW * scaleX), y: Math.round(row * cellH * scaleY), w: Math.round(cellW * scaleX), h: Math.round(cellH * scaleY) },
        diff: Math.round((cell.mismatched / cell.pixels) * 1000) / 10,
        target: hexOf(cell.tr / cell.pixels, cell.tg / cell.pixels, cell.tb / cell.pixels),
        candidate: hexOf(cell.cr / cell.pixels, cell.cg / cell.pixels, cell.cb / cell.pixels),
      }
    })
  const sizeMismatch = t.width !== c.width || t.height !== c.height
  const verdict = similarity >= 99.5
    ? `مطابقٌ (${similarity}%)`
    : `التشابه ${similarity}% (متوسّطُ الفرق ${meanDelta}/255)${sizeMismatch ? ` — أبعادٌ مختلفة: الهدف ${t.width}×${t.height} والمرشَّح ${c.width}×${c.height}` : ""}${regions.length > 0 ? `؛ أكبرُ اختلافٍ عند (${regions[0]!.box.x},${regions[0]!.box.y}) ${regions[0]!.box.w}×${regions[0]!.box.h}: الهدف ${regions[0]!.target} والمرشَّح ${regions[0]!.candidate}` : ""}`
  return { similarity, meanDelta, target: { width: t.width, height: t.height }, candidate: { width: c.width, height: c.height }, compared: { width: cw, height: ch }, sizeMismatch, regions, verdict }
}

// ═══ المصدر ب — لقطةٌ فقط: نموذجُ الرؤية بمخطّطٍ صارم (خُطّافٌ مسمّى؛ لا اختبارَ يعتمد على نموذج) ═══

export type VisionAsk = (system: string, body: string, image: { readonly mime: "image/png"; readonly data: string }) => Promise<string>

export const SPEC_VISION_SYSTEM = [
  "You extract a machine-readable design specification from ONE screenshot of a web page. Reply with JSON only: no prose, no markdown fences, no comments.",
  "Schema (every key required; use null where a value is unknown):",
  '{"viewport":{"width":INT,"height":INT,"direction":"ltr"|"rtl"},',
  '"body":{"background":"#rrggbb","color":"#rrggbb","font":"family name","fontSize":INT},',
  '"palette":[{"color":"#rrggbb","roles":["background"|"text"|"border"],"uses":INT}],',
  '"typography":[{"role":"heading"|"body"|"button"|"nav"|"caption","family":"family name","size":INT,"weight":INT,"uses":INT,"sample":"text"}],',
  '"sections":[{"id":"s1","tag":"header"|"nav"|"main"|"section"|"aside"|"footer","box":{"x":INT,"y":INT,"w":INT,"h":INT},"background":"#rrggbb"|null,"padding":[INT,INT,INT,INT],"layout":{"display":"flex"|"grid"|"block","direction":"row"|"column"|null,"columns":INT|null,"gap":INT|null},"summary":"<=80 chars","items":[{"tag":"div","box":{"x":INT,"y":INT,"w":INT,"h":INT},"text":"<=60 chars"}]}],',
  '"components":[{"id":"c1","kind":"nav"|"heading"|"button"|"input"|"card"|"image"|"icon"|"link","box":{"x":INT,"y":INT,"w":INT,"h":INT},"text":"visible text","color":"#rrggbb"|null,"background":"#rrggbb"|null,"radius":INT,"shadow":"css"|null,"font":{"family":"family name","size":INT,"weight":INT},"level":INT|null}],',
  '"spacing":[INT],"assets":[{"kind":"image","src":"","alt":"what it shows","box":{"w":INT,"h":INT}}]}',
  "All coordinates are pixels in the screenshot's own frame (origin top-left). Measure from the pixels: sizes from the boxes you see, colors from the actual pixel colors, font sizes from cap height. Do not invent elements that are not visible.",
].join("\n")

export const specVisionBody = (width: number, height: number): string => `The screenshot is ${width}x${height} pixels. Return the JSON specification now.`

/** يقتطع أوّل كائن JSON من جواب النموذج ويطبّعه مواصفةً؛ الفشلُ مسمّى. */
export function parseSpecReply(text: string, frame: { width: number; height: number; direction?: "ltr" | "rtl" }): { readonly ok: true; readonly spec: DesignSpec } | { readonly ok: false; readonly why: string } {
  const start = text.indexOf("{"), end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return { ok: false, why: "جوابُ نموذج الرؤية بلا كائن JSON" }
  let raw: unknown
  try { raw = JSON.parse(text.slice(start, end + 1)) } catch { return { ok: false, why: "جوابُ نموذج الرؤية ليس JSON صالحاً" } }
  const spec = normalizeSpec({ ...(raw as Record<string, unknown>), source: { kind: "screenshot" } }, frame)
  if (spec.sections.length === 0 && spec.components.length === 0) return { ok: false, why: "نموذجُ الرؤية أعاد مواصفةً بلا أقسامٍ ولا مكوّنات" }
  return { ok: true, spec }
}

/** المصدر ب: لقطةُ PNG ⇦ نموذجُ الرؤية المحقون ⇦ مواصفة. الأبعادُ من ملفّ PNG نفسِه لا من النموذج. */
export async function extractSpecFromScreenshot(png: Uint8Array, ask: VisionAsk, direction: "ltr" | "rtl" = "ltr"): Promise<{ readonly ok: true; readonly spec: DesignSpec } | { readonly ok: false; readonly why: string }> {
  let decoded: DecodedImage
  try { decoded = decodePng(png) } catch (error) { return { ok: false, why: String(error instanceof Error ? error.message : error) } }
  let reply: string
  try { reply = await ask(SPEC_VISION_SYSTEM, specVisionBody(decoded.width, decoded.height), { mime: "image/png", data: Buffer.from(png).toString("base64") }) }
  catch (error) { return { ok: false, why: `نموذجُ الرؤية لم يُجب: ${String(error instanceof Error ? error.message : error).slice(0, 120)}` } }
  return parseSpecReply(reply, { width: decoded.width, height: decoded.height, direction })
}

// ═══ أمرُ المشغّل ═══

export const DESIGN_USAGE = "الصيغة: design spec <page | rN | رابط | ملف.png | ملف.json> [ملف الإخراج.json] | design render <spec.json> <out.html> | design compare <target.png> <candidate.png> | design shot <اسم>"

export type DesignCommand =
  | { readonly verb: "spec"; readonly target: string; readonly out?: string }
  | { readonly verb: "render"; readonly spec: string; readonly out: string }
  | { readonly verb: "compare"; readonly target: string; readonly candidate: string }
  | { readonly verb: "shot"; readonly label: string }
  | { readonly verb: "usage"; readonly why: string }

export function parseDesignCommand(rest: string): DesignCommand {
  const words = rest.trim().split(/\s+/u).filter((w) => w.length > 0)
  const [verb, a, b] = words
  if (verb === "spec") return a === undefined ? { verb: "usage", why: DESIGN_USAGE } : b === undefined ? { verb: "spec", target: a } : { verb: "spec", target: a, out: b }
  if (verb === "render") return a === undefined || b === undefined ? { verb: "usage", why: "الصيغة: design render <spec.json> <out.html>" } : { verb: "render", spec: a, out: b }
  if (verb === "compare") return a === undefined || b === undefined ? { verb: "usage", why: "الصيغة: design compare <target.png> <candidate.png>" } : { verb: "compare", target: a, candidate: b }
  if (verb === "shot") return { verb: "shot", label: (a ?? "candidate").replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 40) || "candidate" }
  return { verb: "usage", why: DESIGN_USAGE }
}

/** إيصالٌ مضغوط للمشغّل والنموذج: ما في المواصفة بالأرقام، لا الملفُّ كلُّه. */
export function summarizeSpec(spec: DesignSpec): string {
  const lines: string[] = []
  lines.push(`مواصفةُ التصميم${spec.source.title === undefined ? "" : ` — «${spec.source.title}»`}${spec.source.url === undefined ? "" : ` (${spec.source.url})`}${spec.source.kind === "screenshot" ? " [من لقطة — نموذجُ الرؤية]" : ""}${spec.source.capped === true ? " [الشجرةُ مقصوصة عند السقف]" : ""}`)
  lines.push(`المنفذ ${spec.viewport.width}×${spec.viewport.height}، الوثيقة ${spec.viewport.documentHeight}px، الاتجاه ${spec.viewport.direction}، الخطُّ الأساس ${spec.body.font} ${spec.body.fontSize}px، الخلفيّة ${spec.body.background ?? "—"}، النصّ ${spec.body.color ?? "—"}`)
  lines.push(`الألوان (${spec.palette.length}): ${spec.palette.slice(0, 10).map((p) => `${p.color} (${p.roles.map((r) => (r === "background" ? "خلفيّة" : r === "text" ? "نصّ" : "حدّ")).join("/")} ×${p.uses})`).join(" · ") || "—"}`)
  lines.push(`الخطوط (${spec.typography.length}): ${spec.typography.slice(0, 8).map((t) => `${t.role} ${t.family} ${t.size}px/${t.weight} ×${t.uses}`).join(" · ") || "—"}`)
  lines.push(`الأقسام (${spec.sections.length}):`)
  for (const s of spec.sections.slice(0, 16)) lines.push(`  ${s.id} <${s.tag}${s.ref === undefined ? "" : ` ${s.ref}`}> ${s.box.x},${s.box.y} ${s.box.w}×${s.box.h}${s.background === undefined ? "" : ` خلفيّة ${s.background.slice(0, 24)}`} [${s.layout.display}${s.layout.direction === undefined ? "" : ` ${s.layout.direction}`}${s.layout.columns === undefined ? "" : ` ${s.layout.columns} أعمدة`}${s.layout.gap === undefined ? "" : ` فجوة ${s.layout.gap}`}] حشو ${s.padding.join("/")} أبناء ${s.children}${s.summary.length === 0 ? "" : ` «${clip(s.summary, 60)}»`}`)
  const kinds = new Map<ComponentKind, number>()
  for (const c of spec.components) kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1)
  const kindName: Record<ComponentKind, string> = { nav: "تنقّل", heading: "عنوان", button: "زرّ", input: "حقل", card: "بطاقة", image: "صورة", icon: "أيقونة", link: "رابط" }
  lines.push(`المكوّنات (${spec.components.length}): ${[...kinds].map(([k, n]) => `${kindName[k]} ×${n}`).join("، ") || "—"}`)
  for (const c of spec.components.slice(0, 20)) lines.push(`  ${c.id} ${kindName[c.kind]} <${c.tag}${c.ref === undefined ? "" : ` ${c.ref}`}> ${c.box.x},${c.box.y} ${c.box.w}×${c.box.h}${c.background === undefined ? "" : ` خلفيّة ${c.background.slice(0, 24)}`}${c.color === undefined ? "" : ` لون ${c.color}`}${c.radius > 0 ? ` زوايا ${c.radius}` : ""} ${c.font.family} ${c.font.size}px/${c.font.weight}${c.text.length === 0 ? "" : ` «${clip(c.text, 40)}»`}`)
  if (spec.components.length > 20) lines.push(`  … و${spec.components.length - 20} غيرها في الملفّ`)
  lines.push(`مقياسُ التباعد: ${spec.spacing.join(" ") || "—"}`)
  lines.push(`الأصول (${spec.assets.length}): ${spec.assets.slice(0, 8).map((a) => `${a.kind === "image" ? "صورة" : "خلفيّة"} ${a.box.w}×${a.box.h}${a.natural === undefined ? "" : ` (أصليّة ${a.natural.w}×${a.natural.h})`} ${clip(a.src, 60)}`).join(" · ") || "—"}`)
  return lines.join("\n")
}
