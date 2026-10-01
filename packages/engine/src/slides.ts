/**
 * 10-01 — عرضٌ تقديميّ يُصدَّر PowerPoint وPDF (ويستورده Google Slides).
 *
 * أداةُ `slides`: عرضٌ مكتوبٌ بماركداون (شريحةٌ لكلّ قسمٍ بين `---`) ⇦ ثلاثةُ مخرجات من مصدرٍ واحد:
 * - PPTX: OOXML مكتوبٌ هنا وحزمةُ ZIP مكتوبةٌ هنا — لا مكتبةَ خارجيّة (المحرّكُ بلا تبعيّات تشغيلٍ من الخارج). يفتحه PowerPoint
 *   ويستورده Google Slides كما هو (Drive ▸ رفع ⇦ فتحٌ بـGoogle Slides).
 * - HTML: عرضٌ مستقلٌّ بنسبة 16:9 (الصورُ مضمَّنة) — هو نفسُه مصدرُ PDF بطباعة المتصفّح (Page.printToPDF).
 * العربيّةُ تُكتشف فتصير الفقراتُ rtl والمحاذاةُ يميناً في المخرجات الثلاثة.
 */
import { deflateRawSync } from "node:zlib"

export interface DeckRun { readonly text: string; readonly bold: boolean }
/** `number` للقوائم المرقّمة (1. 2. 3.) — يُحفظ الرقمُ كما كُتب؛ وفي PPTX ترقيمٌ آليّ (buAutoNum) يبدأ منه. */
export interface DeckBullet { readonly runs: readonly DeckRun[]; readonly level: number; readonly number?: number }
export interface DeckImage { readonly alt: string; readonly path: string }
export interface DeckSlide {
  readonly kind: "title" | "content"
  readonly title: string
  readonly subtitle: string
  readonly bullets: readonly DeckBullet[]
  readonly paragraphs: readonly (readonly DeckRun[])[]
  readonly images: readonly DeckImage[]
  readonly notes: readonly string[]
}
export interface Deck { readonly title: string; readonly rtl: boolean; readonly slides: readonly DeckSlide[] }

export interface DeckTheme { readonly bg: string; readonly fg: string; readonly accent: string; readonly muted: string }
export const DECK_THEMES: Readonly<Record<"dark" | "light", DeckTheme>> = Object.freeze({
  dark: Object.freeze({ bg: "0A0D14", fg: "F1F5F9", accent: "60A5FA", muted: "94A3B8" }),
  light: Object.freeze({ bg: "FFFFFF", fg: "1E293B", accent: "2563EB", muted: "64748B" }),
})

const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/u

/** `**عريض**` ⇦ مقاطع؛ وما سواه من علامات الماركداون السطريّة يُنزع نصّاً (`code` ⇦ code، [نصّ](رابط) ⇦ نصّ). */
export function parseRuns(line: string): DeckRun[] {
  const plain = line.replace(/!\[[^\]]*\]\([^)]*\)/gu, "").replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1").replace(/\x60([^\x60]+)\x60/gu, "$1").replace(/(?<!\*)\*(?!\*)([^*]+)\*(?!\*)/gu, "$1")
  const runs: DeckRun[] = []
  const re = /\*\*([^*]+)\*\*/gu
  let at = 0
  for (const m of plain.matchAll(re)) {
    if (m.index! > at) runs.push({ text: plain.slice(at, m.index!), bold: false })
    runs.push({ text: m[1]!, bold: true })
    at = m.index! + m[0].length
  }
  if (at < plain.length) runs.push({ text: plain.slice(at), bold: false })
  return runs.filter((r) => r.text.length > 0)
}

const runsText = (runs: readonly DeckRun[]): string => runs.map((r) => r.text).join("")

/** ماركداون ⇦ عرض. الشريحةُ الأولى بعنوانٍ `#` وحده (وسطرٍ تحته) شريحةُ غلاف. `Note:` أو `ملاحظات:` يبدأ ملاحظاتِ المتحدّث. */
export function parseDeck(markdown: string): Deck {
  const chunks = markdown.replace(/\r\n?/gu, "\n").split(/^\s*---+\s*$/mu).map((c) => c.trim()).filter((c) => c.length > 0)
  const slides: DeckSlide[] = []
  for (const chunk of chunks) {
    let title = ""
    let subtitle = ""
    let headingLevel = 0
    const bullets: DeckBullet[] = []
    const paragraphs: DeckRun[][] = []
    const images: DeckImage[] = []
    const notes: string[] = []
    let inNotes = false
    for (const raw of chunk.split("\n")) {
      const line = raw.replace(/\s+$/u, "")
      if (line.trim() === "") continue
      if (/^\s*(?:note|notes|ملاحظات|ملاحظة)\s*:/iu.test(line)) { inNotes = true; const first = line.replace(/^\s*[^:]+:\s*/u, ""); if (first) notes.push(first); continue }
      if (inNotes) { notes.push(line.trim()); continue }
      const heading = /^(#{1,3})\s+(.+)$/u.exec(line)
      if (heading !== null) {
        if (title === "") { title = runsText(parseRuns(heading[2]!)); headingLevel = heading[1]!.length }
        else if (subtitle === "") subtitle = runsText(parseRuns(heading[2]!))
        continue
      }
      for (const img of line.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/gu)) images.push({ alt: img[1]!, path: img[2]! })
      const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.+)$/u.exec(line)
      if (bullet !== null) {
        const level = bullet[1]!.replace(/\t/gu, "  ").length >= 2 ? 1 : 0
        const number = /^\d/u.test(bullet[2]!) ? Number.parseInt(bullet[2]!, 10) : undefined
        bullets.push({ runs: parseRuns(bullet[3]!), level, ...(number !== undefined ? { number } : {}) })
        continue
      }
      const runs = parseRuns(line.trim())
      if (runs.length > 0) paragraphs.push(runs)
    }
    const isTitle = slides.length === 0 && headingLevel === 1 && bullets.length === 0 && images.length === 0 && paragraphs.length <= 1
    if (isTitle && subtitle === "" && paragraphs.length === 1) { subtitle = runsText(paragraphs[0]!); paragraphs.length = 0 }
    slides.push({ kind: isTitle ? "title" : "content", title, subtitle, bullets, paragraphs, images, notes })
  }
  const deckTitle = slides[0]?.title ?? ""
  return { title: deckTitle, rtl: ARABIC.test(markdown.replace(/^\s*(?:note|notes|ملاحظات|ملاحظة)\s*:.*$/gimu, "")), slides }
}

// ——— صور: الأبعادُ من البايتات (PNG IHDR، JPEG SOF) كي تُحفظ النسبة ———
export function imageSize(bytes: Uint8Array): { readonly width: number; readonly height: number; readonly kind: "png" | "jpeg" } | undefined {
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return { width: v.getUint32(16), height: v.getUint32(20), kind: "png" }
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i += 1; continue }
      const marker = bytes[i + 1]!
      const len = (bytes[i + 2]! << 8) | bytes[i + 3]!
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: (bytes[i + 5]! << 8) | bytes[i + 6]!, width: (bytes[i + 7]! << 8) | bytes[i + 8]!, kind: "jpeg" }
      }
      i += 2 + len
    }
  }
  return undefined
}

/** يُدخل الصورة في صندوقٍ بنسبتها — {x, y, w, h} بالوحدة نفسِها. */
export function fitInto(box: { x: number; y: number; w: number; h: number }, width: number, height: number): { x: number; y: number; w: number; h: number } {
  const scale = Math.min(box.w / width, box.h / height)
  const w = Math.round(width * scale)
  const h = Math.round(height * scale)
  return { x: Math.round(box.x + (box.w - w) / 2), y: Math.round(box.y + (box.h - h) / 2), w, h }
}

// ——— ZIP (طريقةُ deflate، بلا تشفير) ———
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  return t
})()
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i += 1) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export function zip(entries: readonly { readonly name: string; readonly data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const e of entries) {
    const name = enc.encode(e.name)
    const deflated = new Uint8Array(deflateRawSync(e.data))
    const useDeflate = deflated.length < e.data.length
    const body = useDeflate ? deflated : e.data
    const crc = crc32(e.data)
    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, useDeflate ? 8 : 0, true)
    lv.setUint16(10, 0, true); lv.setUint16(12, 0x21, true); lv.setUint32(14, crc, true); lv.setUint32(18, body.length, true); lv.setUint32(22, e.data.length, true)
    lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true); local.set(name, 30)
    const cen = new Uint8Array(46 + name.length)
    const cv = new DataView(cen.buffer)
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, useDeflate ? 8 : 0, true)
    cv.setUint16(12, 0, true); cv.setUint16(14, 0x21, true); cv.setUint32(16, crc, true); cv.setUint32(20, body.length, true); cv.setUint32(24, e.data.length, true)
    cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true); cen.set(name, 46)
    parts.push(local, body); central.push(cen)
    offset += local.length + body.length
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true); ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true)
  const all = [...parts, ...central, end]
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of all) { out.set(p, at); at += p.length }
  return out
}

// ——— PPTX ———
const EMU = 914400
const SLIDE_W = 12192000
const SLIDE_H = 6858000
const esc = (s: string): string => s.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, "")
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const FONT = "Segoe UI"

const runXml = (r: DeckRun, size: number, color: string, rtl: boolean): string =>
  `<a:r><a:rPr lang="${rtl ? "ar-SA" : "en-US"}" sz="${size * 100}" b="${r.bold ? 1 : 0}" dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${FONT}"/><a:cs typeface="${FONT}"/></a:rPr><a:t>${esc(r.text)}</a:t></a:r>`

const textBox = (id: number, name: string, x: number, y: number, w: number, h: number, paragraphs: string, anchor: "t" | "ctr" = "t"): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>`
  + `<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`

const para = (runs: readonly DeckRun[], size: number, color: string, rtl: boolean, algn: "l" | "r" | "ctr", extra = ""): string =>
  `<a:p><a:pPr algn="${algn}" rtl="${rtl ? 1 : 0}"${extra}><a:spcAft><a:spcPts val="${size * 40}"/></a:spcAft>${extra.includes("buChar") ? "" : "<a:buNone/>"}</a:pPr>${runs.map((r) => runXml(r, size, color, rtl)).join("")}<a:endParaRPr lang="${rtl ? "ar-SA" : "en-US"}" sz="${size * 100}" dirty="0"/></a:p>`

const bulletPara = (b: DeckBullet, size: number, theme: DeckTheme, rtl: boolean): string => {
  const marL = b.level === 0 ? 342900 : 742950
  const sz = b.level === 0 ? size : Math.max(12, size - 4)
  // مقيس 10-01 في PowerPoint: «1. 2. 3.» خرجت نقاطاً فضاع الترقيم — المرقّمةُ بترقيمٍ آليّ يبدأ من رقمها.
  const marker = b.number !== undefined
    ? `<a:buFont typeface="${FONT}"/><a:buAutoNum type="arabicPeriod"${b.number > 1 ? ` startAt="${b.number}"` : ""}/>`
    : `<a:buFont typeface="Arial"/><a:buChar char="${b.level === 0 ? "•" : "–"}"/>`
  return `<a:p><a:pPr marL="${marL}" indent="-342900" lvl="${b.level}" algn="${rtl ? "r" : "l"}" rtl="${rtl ? 1 : 0}"><a:spcAft><a:spcPts val="${sz * 40}"/></a:spcAft><a:buClr><a:srgbClr val="${theme.accent}"/></a:buClr>${marker}</a:pPr>`
    + `${b.runs.map((r) => runXml(r, sz, theme.fg, rtl)).join("")}<a:endParaRPr lang="${rtl ? "ar-SA" : "en-US"}" sz="${sz * 100}" dirty="0"/></a:p>`
}

export interface DeckAsset { readonly path: string; readonly bytes: Uint8Array }

/** حجمُ خطّ النقاط بحسب كثافة الشريحة — كي لا يفيض النصّ (لا يعيد PowerPoint ضبطَ الحجم عند الفتح). */
export function bodySize(slide: DeckSlide, withImage: boolean): number {
  const lines = slide.bullets.length + slide.paragraphs.length
  const chars = [...slide.bullets.map((b) => runsText(b.runs)), ...slide.paragraphs.map(runsText)].join("").length
  const budget = withImage ? 0.55 : 1
  if (lines <= 5 && chars <= 320 * budget) return 24
  if (lines <= 7 && chars <= 520 * budget) return 20
  if (lines <= 10 && chars <= 760 * budget) return 18
  return 14
}

function slideXml(s: DeckSlide, index: number, total: number, deck: Deck, theme: DeckTheme, pictures: readonly { rid: string; w: number; h: number; alt: string }[]): string {
  const rtl = deck.rtl
  const algn = rtl ? "r" : "l"
  const shapes: string[] = []
  let id = 2
  const m = Math.round(0.6 * EMU)
  const contentW = SLIDE_W - 2 * m
  if (s.kind === "title") {
    shapes.push(textBox(id++, "Title", m, Math.round(2.2 * EMU), contentW, Math.round(1.5 * EMU), para([{ text: s.title, bold: true }], 44, theme.fg, rtl, "ctr"), "ctr"))
    shapes.push(`<p:sp><p:nvSpPr><p:cNvPr id="${id++}" name="Accent"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${Math.round(SLIDE_W / 2 - 0.6 * EMU)}" y="${Math.round(3.8 * EMU)}"/><a:ext cx="${Math.round(1.2 * EMU)}" cy="${Math.round(0.06 * EMU)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${theme.accent}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>`)
    if (s.subtitle !== "") shapes.push(textBox(id++, "Subtitle", m, Math.round(4.05 * EMU), contentW, Math.round(1.0 * EMU), para([{ text: s.subtitle, bold: false }], 22, theme.muted, rtl, "ctr")))
  } else {
    shapes.push(textBox(id++, "Title", m, Math.round(0.45 * EMU), contentW, Math.round(0.95 * EMU), para([{ text: s.title, bold: true }], 32, theme.fg, rtl, algn), "ctr"))
    const barX = rtl ? SLIDE_W - m - Math.round(0.9 * EMU) : m
    shapes.push(`<p:sp><p:nvSpPr><p:cNvPr id="${id++}" name="Accent"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${barX}" y="${Math.round(1.45 * EMU)}"/><a:ext cx="${Math.round(0.9 * EMU)}" cy="${Math.round(0.05 * EMU)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${theme.accent}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>`)
    const hasText = s.bullets.length + s.paragraphs.length > 0
    const top = Math.round(1.75 * EMU)
    const bodyH = SLIDE_H - top - Math.round(0.8 * EMU)
    const gap = Math.round(0.3 * EMU)
    const textW = pictures.length > 0 && hasText ? Math.round(contentW * 0.55) : contentW
    if (hasText) {
      const size = bodySize(s, pictures.length > 0)
      const ps = [...s.paragraphs.map((p) => para(p, size, theme.fg, rtl, algn)), ...s.bullets.map((b) => bulletPara(b, size, theme, rtl))].join("")
      const textX = rtl ? SLIDE_W - m - textW : m
      shapes.push(textBox(id++, "Body", textX, top, textW, bodyH, ps))
    }
    if (pictures.length > 0) {
      const boxW = hasText ? contentW - textW - gap : contentW
      const boxX = hasText ? (rtl ? m : m + textW + gap) : m
      const each = Math.round((bodyH - gap * (pictures.length - 1)) / pictures.length)
      pictures.forEach((pic, i) => {
        const f = fitInto({ x: boxX, y: top + i * (each + gap), w: boxW, h: each }, pic.w, pic.h)
        shapes.push(`<p:pic><p:nvPicPr><p:cNvPr id="${id++}" name="Picture ${i + 1}" descr="${esc(pic.alt)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${pic.rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${f.x}" y="${f.y}"/><a:ext cx="${f.w}" cy="${f.h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`)
      })
    }
  }
  const footer = para([{ text: `${index + 1} / ${total}`, bold: false }], 11, theme.muted, false, rtl ? "l" : "r")
  shapes.push(textBox(id++, "Slide Number", m, SLIDE_H - Math.round(0.55 * EMU), contentW, Math.round(0.3 * EMU), footer))
  return `${XML}<p:sld ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${theme.bg}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
}

const THEME_XML = (t: DeckTheme): string => `${XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="AbdoCode"><a:themeElements>`
  + `<a:clrScheme name="AbdoCode"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1E293B"/></a:dk2><a:lt2><a:srgbClr val="F1F5F9"/></a:lt2>`
  + `<a:accent1><a:srgbClr val="${t.accent}"/></a:accent1><a:accent2><a:srgbClr val="16A34A"/></a:accent2><a:accent3><a:srgbClr val="F59E0B"/></a:accent3><a:accent4><a:srgbClr val="DC2626"/></a:accent4><a:accent5><a:srgbClr val="7DD3FC"/></a:accent5><a:accent6><a:srgbClr val="94A3B8"/></a:accent6>`
  + `<a:hlink><a:srgbClr val="${t.accent}"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme>`
  + `<a:fontScheme name="AbdoCode"><a:majorFont><a:latin typeface="${FONT}"/><a:ea typeface=""/><a:cs typeface="${FONT}"/></a:majorFont><a:minorFont><a:latin typeface="${FONT}"/><a:ea typeface=""/><a:cs typeface="${FONT}"/></a:minorFont></a:fontScheme>`
  + `<a:fmtScheme name="AbdoCode"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>`
  + `<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>`
  + `<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>`
  + `<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>`
  + `</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`

const EMPTY_TREE = '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>'
const REL = (id: string, type: string, target: string): string => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`
const RELS = (inner: string): string => `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${inner}</Relationships>`

/** العرضُ ⇦ ملفّ .pptx (بايتات). `assets` صورُ المشروع بمساراتها كما في الماركداون؛ صورةٌ غائبةٌ أو غيرُ PNG/JPEG تُسقط وتُسمّى في `skipped`. */
export function deckPptx(deck: Deck, theme: DeckTheme, assets: readonly DeckAsset[], when = new Date()): { readonly bytes: Uint8Array; readonly skipped: readonly string[] } {
  const enc = new TextEncoder()
  const files: { name: string; data: Uint8Array }[] = []
  const add = (name: string, text: string): void => { files.push({ name, data: enc.encode(text) }) }
  const skipped: string[] = []
  const media: { name: string; kind: "png" | "jpeg" }[] = []
  const slidesXml: string[] = []
  const slideRels: string[] = []
  deck.slides.forEach((s, i) => {
    const pics: { rid: string; w: number; h: number; alt: string }[] = []
    let rels = REL("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml")
    for (const img of s.images.slice(0, 2)) {
      const asset = assets.find((a) => a.path === img.path)
      const size = asset !== undefined ? imageSize(asset.bytes) : undefined
      if (asset === undefined || size === undefined) { skipped.push(img.path); continue }
      const name = `image${media.length + 1}.${size.kind === "png" ? "png" : "jpeg"}`
      media.push({ name, kind: size.kind })
      files.push({ name: `ppt/media/${name}`, data: asset.bytes })
      const rid = `rId${pics.length + 2}`
      rels += REL(rid, "image", `../media/${name}`)
      pics.push({ rid, w: size.width, h: size.height, alt: img.alt })
    }
    slidesXml.push(slideXml(s, i, deck.slides.length, deck, theme, pics))
    slideRels.push(RELS(rels))
  })
  const n = deck.slides.length
  add("[Content_Types].xml", `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>`
    + `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`
    + Array.from({ length: n }, (_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("")
    + `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`)
  add("_rels/.rels", RELS(REL("rId1", "officeDocument", "ppt/presentation.xml") + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' + REL("rId3", "extended-properties", "docProps/app.xml")))
  add("docProps/core.xml", `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(deck.title)}</dc:title><dc:creator>AbdoCode</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${when.toISOString().replace(/\.\d+Z$/u, "Z")}</dcterms:created></cp:coreProperties>`)
  add("docProps/app.xml", `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>AbdoCode</Application><Slides>${n}</Slides></Properties>`)
  add("ppt/presentation.xml", `${XML}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${Array.from({ length: n }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 3}"/>`).join("")}</p:sldIdLst><p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`)
  add("ppt/_rels/presentation.xml.rels", RELS(REL("rId1", "slideMaster", "slideMasters/slideMaster1.xml") + REL("rId2", "theme", "theme/theme1.xml") + Array.from({ length: n }, (_, i) => REL(`rId${i + 3}`, "slide", `slides/slide${i + 1}.xml`)).join("")))
  add("ppt/slideMasters/slideMaster1.xml", `${XML}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${theme.bg}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>${EMPTY_TREE}</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="3200"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2000"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`)
  add("ppt/slideMasters/_rels/slideMaster1.xml.rels", RELS(REL("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml") + REL("rId2", "theme", "../theme/theme1.xml")))
  add("ppt/slideLayouts/slideLayout1.xml", `${XML}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank">${EMPTY_TREE}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`)
  add("ppt/slideLayouts/_rels/slideLayout1.xml.rels", RELS(REL("rId1", "slideMaster", "../slideMasters/slideMaster1.xml")))
  add("ppt/theme/theme1.xml", THEME_XML(theme))
  slidesXml.forEach((x, i) => { add(`ppt/slides/slide${i + 1}.xml`, x); add(`ppt/slides/_rels/slide${i + 1}.xml.rels`, slideRels[i]!) })
  // [Content_Types].xml أوّلاً — كما تكتبه أدواتُ Office.
  files.sort((a, b) => (a.name === "[Content_Types].xml" ? -1 : b.name === "[Content_Types].xml" ? 1 : 0))
  return { bytes: zip(files), skipped }
}

// ——— HTML (ومنه PDF) ———
const hesc = (s: string): string => s.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;")
const runsHtml = (runs: readonly DeckRun[]): string => runs.map((r) => (r.bold ? `<strong>${hesc(r.text)}</strong>` : hesc(r.text))).join("")

/** العرضُ ⇦ صفحةُ HTML مستقلّة (صفحةٌ لكلّ شريحة 13.333×7.5 بوصة) — الصورُ مضمَّنة data: كي تُطبع بلا وجهة. */
export function deckHtml(deck: Deck, theme: DeckTheme, assets: readonly DeckAsset[]): string {
  const dir = deck.rtl ? "rtl" : "ltr"
  const dataUri = (path: string): string | undefined => {
    const a = assets.find((x) => x.path === path)
    const size = a !== undefined ? imageSize(a.bytes) : undefined
    return a !== undefined && size !== undefined ? `data:image/${size.kind};base64,${Buffer.from(a.bytes).toString("base64")}` : undefined
  }
  const sections = deck.slides.map((s, i) => {
    const imgs = s.images.slice(0, 2).map((img) => { const src = dataUri(img.path); return src === undefined ? "" : `<img src="${src}" alt="${hesc(img.alt)}">` }).join("")
    const body = s.kind === "title"
      ? `<div class="cover"><h1>${hesc(s.title)}</h1><div class="bar"></div>${s.subtitle ? `<p class="sub">${hesc(s.subtitle)}</p>` : ""}</div>`
      : `<h2>${hesc(s.title)}</h2><div class="bar"></div><div class="body${imgs ? " with-img" : ""}" style="font-size:${bodySize(s, imgs !== "")}pt"><div class="text">${s.paragraphs.map((p) => `<p>${runsHtml(p)}</p>`).join("")}${s.bullets.length ? `<ul>${s.bullets.map((b) => `<li class="l${b.level}"${b.number !== undefined ? ` data-n="${b.number}."` : ""}>${runsHtml(b.runs)}</li>`).join("")}</ul>` : ""}</div>${imgs ? `<div class="media">${imgs}</div>` : ""}</div>`
    const notes = s.notes.length > 0 ? `<aside class="notes">${s.notes.map(hesc).join("<br>")}</aside>` : ""
    return `<section class="slide">${body}<footer dir="ltr">${i + 1} / ${deck.slides.length}</footer>${notes}</section>`
  }).join("\n")
  return `<!doctype html><html lang="${deck.rtl ? "ar" : "en"}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${hesc(deck.title)}</title><style>
@page{size:13.333in 7.5in;margin:0}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#${theme.bg};color:#${theme.fg};font-family:"Segoe UI",Tahoma,system-ui,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.slide{position:relative;width:13.333in;height:7.5in;padding:.45in .6in .8in;overflow:hidden;page-break-after:always;break-after:page;background:#${theme.bg}}
.slide:last-of-type{page-break-after:auto;break-after:auto}
h2{font-size:32pt;line-height:1.15;height:.95in;display:flex;align-items:center}
.bar{width:.9in;height:.05in;background:#${theme.accent};margin:.05in 0 .25in}
.body{display:flex;gap:.3in;height:calc(7.5in - .45in - .8in - 1.3in);line-height:1.35}
.body .text{flex:1;min-width:0}.body.with-img .text{flex:0 0 55%}
.body p{margin-bottom:.4em}.body ul{list-style:none}
.body li{position:relative;padding-inline-start:.38in;margin-bottom:.4em}
.body li::before{content:"•";color:#${theme.accent};position:absolute;inset-inline-start:.08in}
.body li.l1{padding-inline-start:.8in;font-size:.82em}.body li.l1::before{content:"–";inset-inline-start:.5in}
.body li[data-n]::before{content:attr(data-n);font-weight:600}
.media{flex:1;display:flex;flex-direction:column;gap:.3in;align-items:center;justify-content:center;min-width:0}
.media img{max-width:100%;max-height:100%;object-fit:contain}
.cover{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
.cover h1{font-size:44pt;line-height:1.15}.cover .bar{width:1.2in;height:.06in;margin:.3in auto}.cover .sub{font-size:22pt;color:#${theme.muted}}
footer{position:absolute;bottom:.3in;inset-inline-end:.6in;font-size:11pt;color:#${theme.muted}}
.notes{display:none}
@media screen{body{display:flex;flex-direction:column;align-items:center;gap:24px;padding:24px 0;background:#0b0b0b}.slide{box-shadow:0 8px 30px rgb(0 0 0/.4)}}
</style></head><body>
${sections}
</body></html>`
}

export interface SlidesCommand {
  readonly source: string
  readonly out?: string
  readonly theme: "dark" | "light"
  readonly accent?: string
  readonly formats: readonly ("pptx" | "pdf" | "html")[]
}

/** `slides <deck.md> [--out اسم] [--theme dark|light] [--accent #2563eb] [--formats pptx,pdf,html]` — الافتراض: الصيغُ الثلاث، داكن. */
export function parseSlidesCommand(rest: string): SlidesCommand {
  const tokens = rest.trim().split(/\s+/u).filter((t) => t.length > 0)
  const flag = (name: string): string | undefined => { const i = tokens.indexOf(`--${name}`); return i >= 0 ? tokens[i + 1] : undefined }
  const source = tokens.find((t, i) => !t.startsWith("--") && (i === 0 || !tokens[i - 1]!.startsWith("--")))
  if (source === undefined || !/\.(?:md|markdown)$/iu.test(source)) throw new Error("الصيغة: slides <ملفّ.md> [--out اسم] [--theme dark|light] [--accent #hex] [--formats pptx,pdf,html]")
  const theme = flag("theme") ?? "dark"
  if (theme !== "dark" && theme !== "light") throw new Error("--theme dark أو light")
  const accent = flag("accent")
  if (accent !== undefined && !/^#?[0-9a-f]{6}$/iu.test(accent)) throw new Error("--accent لونٌ سداسيّ مثل #2563eb")
  const formats = (flag("formats") ?? "pptx,pdf,html").split(",").map((f) => f.trim().toLowerCase()).filter((f) => f.length > 0)
  const bad = formats.filter((f) => f !== "pptx" && f !== "pdf" && f !== "html")
  if (bad.length > 0 || formats.length === 0) throw new Error(`صيغةٌ غير معروفة: ${bad.join(", ") || "(فارغة)"} — pptx أو pdf أو html`)
  const out = flag("out")
  if (out !== undefined && (/[\\/:*?"<>|]/u.test(out) || out.startsWith("."))) throw new Error("--out اسمٌ بلا مسار ولا امتداد")
  return { source, theme, formats: [...new Set(formats)] as SlidesCommand["formats"], ...(out !== undefined ? { out } : {}), ...(accent !== undefined ? { accent: accent.replace(/^#/u, "").toUpperCase() } : {}) }
}
