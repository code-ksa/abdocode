/**
 * 10-01 — أداةُ slides. التحقّقُ الحاكم حيٌّ (PowerPoint فتح الملفّ وصدّره PDF، وEdge طبع HTML بنسبة 16:9 — مقيس في الجلسة)؛
 * وهذه تثبّت البنيةَ التي أثبتها ذلك القياس كي لا تنزلق: ZIP يُقرأ ويُفكّ بـCRC صحيح، وأجزاءُ OOXML متّسقةُ المراجع.
 */
import { describe, expect, test } from "bun:test"
import { inflateRawSync } from "node:zlib"
import { DECK_THEMES, bodySize, crc32, deckHtml, deckPptx, fitInto, imageSize, parseDeck, parseRuns, parseSlidesCommand, zip } from "../src/slides"

/** قارئُ ZIP للاختبار وحده: من الدليل المركزيّ ⇦ الترويسة المحلّيّة ⇦ الفكّ ⇦ CRC. */
function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = bytes.length - 22
  while (end >= 0 && v.getUint32(end, true) !== 0x06054b50) end -= 1
  if (end < 0) throw new Error("no end of central directory")
  const count = v.getUint16(end + 10, true)
  let at = v.getUint32(end + 16, true)
  const out = new Map<string, Uint8Array>()
  const dec = new TextDecoder()
  for (let i = 0; i < count; i += 1) {
    if (v.getUint32(at, true) !== 0x02014b50) throw new Error("bad central header")
    const method = v.getUint16(at + 10, true)
    const crc = v.getUint32(at + 16, true)
    const csize = v.getUint32(at + 20, true)
    const nameLen = v.getUint16(at + 28, true)
    const extra = v.getUint16(at + 30, true)
    const comment = v.getUint16(at + 32, true)
    const local = v.getUint32(at + 42, true)
    const name = dec.decode(bytes.slice(at + 46, at + 46 + nameLen))
    if (v.getUint32(local, true) !== 0x04034b50) throw new Error(`bad local header ${name}`)
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true)
    const raw = bytes.slice(start, start + csize)
    const data = method === 8 ? new Uint8Array(inflateRawSync(raw)) : raw
    if (crc32(data) !== crc) throw new Error(`crc mismatch ${name}`)
    out.set(name, data)
    at += 46 + nameLen + extra + comment
  }
  return out
}

// PNG 3×2 بلا بكسلات صالحة للعرض — يكفي لقراءة الأبعاد (IHDR).
const png = (w: number, h: number): Uint8Array => {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(b.buffer).setUint32(16, w); new DataView(b.buffer).setUint32(20, h)
  return b
}
const jpeg = (w: number, h: number): Uint8Array => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0, 0])

const AR = `# سوق النماذج
عرضٌ تجريبيّ

---

## لماذا؟
- أكثرُ من **300 نموذج**
  - مقارنةٌ بالسرعة
- مفتاحٌ واحد

ملاحظات: ابدأ بالمشكلة.
Second note line.

---

## الصورة
النموذجُ يُختار تلقائيّاً.
![الشعار](img/logo.png)

---

## الخطوات
1. ربطُ الدفع
2. الإطلاق
`

describe("parse", () => {
  const deck = parseDeck(AR)
  test("slides split on ---; the first lone # heading with one line under it is the cover", () => {
    expect(deck.slides.map((s) => s.kind)).toEqual(["title", "content", "content", "content"])
    expect(deck.slides[0]).toMatchObject({ title: "سوق النماذج", subtitle: "عرضٌ تجريبيّ" })
    expect(deck.title).toBe("سوق النماذج")
    expect(deck.rtl).toBe(true)
  })
  test("bullets with a second level, bold runs, numbered items keep their numbers", () => {
    const s = deck.slides[1]!
    expect(s.bullets.map((b) => b.level)).toEqual([0, 1, 0])
    expect(s.bullets[0]!.runs).toEqual([{ text: "أكثرُ من ", bold: false }, { text: "300 نموذج", bold: true }])
    expect(deck.slides[3]!.bullets.map((b) => b.number)).toEqual([1, 2])
    expect(s.bullets[0]!.number).toBeUndefined()
  })
  test("notes start at «ملاحظات:» and take every following line; images are collected; paragraphs kept", () => {
    expect(deck.slides[1]!.notes).toEqual(["ابدأ بالمشكلة.", "Second note line."])
    expect(deck.slides[2]!.images).toEqual([{ alt: "الشعار", path: "img/logo.png" }])
    expect(deck.slides[2]!.paragraphs.length).toBe(1)
  })
  test("an English deck is ltr even when its notes are Arabic", () => {
    expect(parseDeck("# Title\n\n---\n\n## A\n- one\n\nNote: ملاحظة بالعربيّة").rtl).toBe(false)
  })
  test("inline markdown: links keep their text, code ticks and single stars are dropped", () => {
    expect(parseRuns("see [docs](https://x.y) and \x60npm test\x60 *now*")).toEqual([{ text: "see docs and npm test now", bold: false }])
  })
})

describe("images", () => {
  test("PNG and JPEG sizes come from the bytes; anything else is not an image", () => {
    expect(imageSize(png(300, 200))).toEqual({ width: 300, height: 200, kind: "png" })
    expect(imageSize(jpeg(640, 480))).toEqual({ width: 640, height: 480, kind: "jpeg" })
    expect(imageSize(new TextEncoder().encode("GIF89a........................"))).toBeUndefined()
  })
  test("fit keeps the aspect ratio and centres", () => {
    expect(fitInto({ x: 0, y: 0, w: 1000, h: 1000 }, 200, 100)).toEqual({ x: 0, y: 250, w: 1000, h: 500 })
    expect(fitInto({ x: 10, y: 10, w: 100, h: 50 }, 100, 100)).toEqual({ x: 35, y: 10, w: 50, h: 50 })
  })
})

describe("zip", () => {
  test("round-trips through a central-directory reader with correct CRCs (stored and deflated entries)", () => {
    const big = new TextEncoder().encode("<a>".repeat(500))
    const tiny = new Uint8Array([1, 2, 3])
    const files = unzip(zip([{ name: "big.xml", data: big }, { name: "مجلد/صغير.bin", data: tiny }]))
    expect([...files.keys()]).toEqual(["big.xml", "مجلد/صغير.bin"])
    expect(files.get("big.xml")).toEqual(big)
    expect(files.get("مجلد/صغير.bin")).toEqual(tiny)
  })
  test("crc32 matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926)
  })
})

describe("pptx", () => {
  const deck = parseDeck(AR)
  const { bytes, skipped } = deckPptx(deck, DECK_THEMES.dark, [{ path: "img/logo.png", bytes: png(300, 200) }], new Date("2026-10-01T12:00:00Z"))
  const files = unzip(bytes)
  const text = (name: string): string => new TextDecoder().decode(files.get(name)!)
  test("[Content_Types].xml is the first entry and declares every slide", () => {
    expect([...files.keys()][0]).toBe("[Content_Types].xml")
    for (let i = 1; i <= 4; i += 1) expect(text("[Content_Types].xml")).toContain(`/ppt/slides/slide${i}.xml`)
  })
  test("every relationship target exists in the package", () => {
    const missing: string[] = []
    let checked = 0
    for (const [name] of files) {
      if (!name.endsWith(".rels")) continue
      // «_rels/.rels» اسمُه لا شيءَ قبل النقطة — [^/]* لا [^/]+.
      const dir = name.replace(/_rels\/[^/]*\.rels$/u, "")
      for (const m of text(name).matchAll(/Target="([^"]+)"/gu)) {
        const parts = `${dir}${m[1]}`.split("/")
        const resolved: string[] = []
        for (const p of parts) { if (p === "..") resolved.pop(); else if (p !== "" && p !== ".") resolved.push(p) }
        checked += 1
        if (!files.has(resolved.join("/"))) missing.push(`${name} ⇒ ${m[1]}`)
      }
    }
    expect(missing).toEqual([])
    // توأمٌ إيجابيّ: الفحصُ مرّ على المراجع فعلاً (الحزمةُ + العرض + القالب + الشريحة الأمّ + أربع شرائح وصورة).
    expect(checked).toBeGreaterThanOrEqual(3 + 6 + 1 + 2 + 4 + 1)
  })
  test("presentation lists four slides at 16:9; the image is embedded once with its relationship", () => {
    expect((text("ppt/presentation.xml").match(/<p:sldId /gu) ?? []).length).toBe(4)
    expect(text("ppt/presentation.xml")).toContain('<p:sldSz cx="12192000" cy="6858000"/>')
    expect(files.has("ppt/media/image1.png")).toBe(true)
    expect(text("ppt/slides/_rels/slide3.xml.rels")).toContain('Target="../media/image1.png"')
    expect(text("ppt/slides/slide3.xml")).toContain('r:embed="rId2"')
    expect(skipped).toEqual([])
  })
  test("each slide id resolves to its own slide part — not to the master or the theme", () => {
    const rels = text("ppt/_rels/presentation.xml.rels")
    const ids = [...text("ppt/presentation.xml").matchAll(/<p:sldId id="\d+" r:id="(rId\d+)"\/>/gu)].map((m) => m[1]!)
    expect(ids.map((rid) => new RegExp(`Id="${rid}" Type="[^"]+/slide" Target="(slides/slide\\d+\\.xml)"`, "u").exec(rels)?.[1])).toEqual(["slides/slide1.xml", "slides/slide2.xml", "slides/slide3.xml", "slides/slide4.xml"])
  })
  test("titles and plain paragraphs are rtl too, not only bullets", () => {
    const paraOf = (xml: string, needle: string): string => xml.split("<a:p>").find((p) => p.includes(needle)) ?? ""
    expect(paraOf(text("ppt/slides/slide3.xml"), "النموذجُ يُختار")).toContain('rtl="1"')
    expect(paraOf(text("ppt/slides/slide2.xml"), "لماذا؟")).toContain('algn="r" rtl="1"')
    const en = deckPptx(parseDeck("# T\n\n---\n\n## Why\nplain"), DECK_THEMES.light, [])
    expect(paraOf(new TextDecoder().decode(unzip(en.bytes).get("ppt/slides/slide2.xml")!), "plain")).toContain('algn="l" rtl="0"')
  })
  test("Arabic paragraphs are rtl and right-aligned; numbered items use auto-numbering from their number", () => {
    expect(text("ppt/slides/slide2.xml")).toContain('algn="r" rtl="1"')
    expect(text("ppt/slides/slide4.xml")).toContain('<a:buAutoNum type="arabicPeriod"/>')
    expect(text("ppt/slides/slide2.xml")).toContain('<a:buChar char="•"/>')
    expect(text("ppt/slides/slide2.xml")).toContain('b="1"')
  })
  test("text is escaped; a missing image is named in skipped, not silently dropped", () => {
    const r = deckPptx(parseDeck("# A & <B>\n\n---\n\n## x\n![a](nope.png)"), DECK_THEMES.light, [])
    expect(new TextDecoder().decode(unzip(r.bytes).get("ppt/slides/slide1.xml")!)).toContain("A &amp; &lt;B&gt;")
    expect(r.skipped).toEqual(["nope.png"])
  })
})

describe("html", () => {
  const html = deckHtml(parseDeck(AR), DECK_THEMES.dark, [{ path: "img/logo.png", bytes: png(3, 2) }])
  test("16:9 pages, rtl document, ltr footer (measured: «4 / 1» in an Arabic PDF), numbered markers, embedded image", () => {
    expect(html).toContain("@page{size:13.333in 7.5in;margin:0}")
    expect(html).toContain('<html lang="ar" dir="rtl">')
    expect(html).toContain('<footer dir="ltr">1 / 4</footer>')
    expect(html).toContain('data-n="1."')
    expect(html).toContain("data:image/png;base64,")
    expect((html.match(/<section class="slide">/gu) ?? []).length).toBe(4)
  })
})

describe("body size", () => {
  test("shrinks as the slide fills", () => {
    const s = (n: number) => parseDeck(`## t\n${Array.from({ length: n }, (_, i) => `- item ${i}`).join("\n")}`).slides[0]!
    expect(bodySize(s(3), false)).toBe(24)
    expect(bodySize(s(7), false)).toBe(20)
    expect(bodySize(s(12), false)).toBe(14)
  })
})

describe("command", () => {
  test("defaults and flags", () => {
    expect(parseSlidesCommand("docs/deck.md")).toEqual({ source: "docs/deck.md", theme: "dark", formats: ["pptx", "pdf", "html"] })
    expect(parseSlidesCommand("deck.md --theme light --accent #16a34a --formats pdf,pptx --out q3")).toEqual({ source: "deck.md", theme: "light", accent: "16A34A", formats: ["pdf", "pptx"], out: "q3" })
  })
  test("refusals name the problem", () => {
    expect(() => parseSlidesCommand("deck.txt")).toThrow("الصيغة")
    expect(() => parseSlidesCommand("deck.md --theme blue")).toThrow("--theme")
    expect(() => parseSlidesCommand("deck.md --formats docx")).toThrow("docx")
    expect(() => parseSlidesCommand("deck.md --out ../x")).toThrow("--out")
    expect(() => parseSlidesCommand("deck.md --out a\\b")).toThrow("--out")
  })
})
