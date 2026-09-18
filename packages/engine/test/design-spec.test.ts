// S9 (2026-09-18) — تصميمُ الواجهات بلا Canva: المواصفةُ من شجرة الصناديق، الرندرُ الحتميّ (وRTL)، المقارنةُ بالبكسل على PNG مولَّدةٍ هنا،
// خُطّافُ الرؤية بنموذجٍ محقون، وأسلاكُ الأمر في الطبقات (الكتالوج، المُوزِّع، الجسر، الإضافة، المتصفّح المملوك، التعريض).
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { SPEC_WALKER, specWalkerExpression } from "@abdo/browser"
import { TOOLS } from "@abdo/tools/catalogue"
import { BRIDGE_TOOLS, ChromeBridge } from "../src/mcp-servers/chrome-bridge"
import { TOOL_FAMILIES, exposedByIntent } from "../src/tool-exposure"
import {
  DESIGN_USAGE, SPEC_VISION_SYSTEM, compareRendering, decodePng, encodePng, extractSpec, extractSpecFromScreenshot, normalizeColor,
  parseDesignCommand, parseSpecReply, renderSpec, resampleImage, summarizeSpec, type SpecDump,
} from "../src/design-spec"

const read = (...parts: string[]) => readFileSync(resolve(import.meta.dir, "..", ...parts), "utf8").replace(/\r\n/gu, "\n")

/** صفحةُ هبوطٍ RTL كما يعطيها الماشي: body ⇦ غلافٌ واحد ⇦ header/main/footer، وفيها زرٌّ وعنوانٌ وبطاقةٌ وصورةٌ وحقلٌ ورابطُ تنقّل. */
const fixtureDump = (): SpecDump => ({
  url: "https://x.test/", title: "Landing", dir: "rtl", lang: "ar", viewport: { w: 1280, h: 720, docW: 1280, docH: 1400 },
  body: { background: "rgb(250, 250, 250)", color: "rgb(20, 20, 20)", font: "Tajawal, sans-serif", fontSize: "16px" }, fonts: ["Tajawal 400 normal"], capped: false,
  nodes: [
    { i: 0, p: -1, d: 0, t: "body", x: 0, y: 0, w: 1280, h: 1400, n: 1, s: { fontFamily: "Tajawal, sans-serif", fontSize: "16px", color: "rgb(20, 20, 20)" } },
    { i: 1, p: 0, d: 1, t: "div", x: 0, y: 0, w: 1280, h: 1400, n: 3, s: { fontFamily: "Tajawal", fontSize: "16px", color: "rgb(20, 20, 20)" }, c: "app" },
    { i: 2, p: 1, d: 2, t: "header", x: 0, y: 0, w: 1280, h: 72, n: 2, s: { display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: "16px", paddingRight: "40px", paddingBottom: "16px", paddingLeft: "40px", backgroundColor: "rgb(255, 255, 255)", fontFamily: "Tajawal", fontSize: "16px", color: "rgb(20, 20, 20)", boxShadow: "rgba(0, 0, 0, 0.1) 0px 1px 2px 0px" } },
    { i: 3, p: 1, d: 2, t: "main", x: 0, y: 72, w: 1280, h: 600, n: 3, s: { display: "grid", gridTemplateColumns: "400px 400px 400px", gap: "24px", paddingTop: "48px", paddingRight: "40px", paddingBottom: "48px", paddingLeft: "40px", backgroundColor: "rgb(250, 250, 250)", fontFamily: "Tajawal", fontSize: "16px", color: "rgb(20, 20, 20)" } },
    { i: 4, p: 1, d: 2, t: "footer", x: 0, y: 672, w: 1280, h: 728, n: 1, s: { backgroundColor: "rgb(17, 24, 39)", color: "rgb(255, 255, 255)", paddingTop: "24px", paddingBottom: "24px", fontFamily: "Tajawal", fontSize: "14px" } },
    { i: 5, p: 2, d: 3, t: "nav", x: 40, y: 16, w: 400, h: 40, n: 3, s: { display: "flex", gap: "24px", fontFamily: "Tajawal", fontSize: "16px", color: "rgb(20, 20, 20)" }, r: "navigation" },
    { i: 6, p: 2, d: 3, t: "button", x: 1100, y: 16, w: 140, h: 40, n: 0, s: { backgroundColor: "rgb(51, 85, 255)", color: "rgb(255, 255, 255)", borderRadius: "12px", paddingTop: "10px", paddingRight: "20px", paddingBottom: "10px", paddingLeft: "20px", fontFamily: "Tajawal", fontSize: "16px", fontWeight: "700" }, tx: "ابدأ الآن", ref: "r1" },
    { i: 7, p: 3, d: 3, t: "h1", x: 40, y: 120, w: 1200, h: 48, n: 0, s: { fontFamily: "Tajawal", fontSize: "40px", fontWeight: "700", color: "rgb(17, 24, 39)", textAlign: "right" }, tx: "منصّةٌ تصنع الواجهات", ref: "r2" },
    { i: 8, p: 3, d: 3, t: "div", x: 40, y: 200, w: 400, h: 240, n: 2, s: { backgroundColor: "rgb(255, 255, 255)", borderRadius: "16px", boxShadow: "rgba(0, 0, 0, 0.08) 0px 4px 12px 0px", paddingTop: "24px", paddingRight: "24px", paddingBottom: "24px", paddingLeft: "24px", fontFamily: "Tajawal", fontSize: "16px", color: "rgb(20, 20, 20)" }, c: "card" },
    { i: 9, p: 3, d: 3, t: "img", x: 464, y: 200, w: 400, h: 240, n: 0, s: { borderRadius: "16px", objectFit: "cover" }, img: { src: "https://x.test/hero.jpg", nw: 1600, nh: 960, alt: "بطل" } },
    { i: 10, p: 8, d: 4, t: "p", x: 64, y: 224, w: 352, h: 48, n: 0, s: { fontFamily: "Tajawal", fontSize: "16px", color: "rgb(20, 20, 20)", lineHeight: "24px" }, tx: "نصٌّ تعريفيّ قصير" },
    { i: 11, p: 5, d: 4, t: "a", x: 40, y: 24, w: 60, h: 24, n: 0, s: { fontFamily: "Tajawal", fontSize: "16px", color: "rgb(20, 20, 20)" }, tx: "الرئيسيّة", href: "/", ref: "r3" },
    { i: 12, p: 3, d: 3, t: "input", x: 40, y: 480, w: 400, h: 44, n: 0, s: { borderRadius: "8px", borderTopWidth: "1px", borderTopColor: "rgb(209, 213, 219)", paddingLeft: "12px", fontFamily: "Tajawal", fontSize: "16px", color: "rgb(20, 20, 20)", backgroundColor: "rgb(255, 255, 255)" }, f: { type: "email", placeholder: "بريدك" }, ref: "r4" },
  ],
})

const solid = (w: number, h: number, rgb: readonly [number, number, number]): Uint8Array => {
  const a = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i += 1) { a[i * 4] = rgb[0]; a[i * 4 + 1] = rgb[1]; a[i * 4 + 2] = rgb[2]; a[i * 4 + 3] = 255 }
  return a
}

describe("S9 — extractSpec from a walker dump", () => {
  test("palette is deduplicated hex with roles and usage; typography is grouped by role; body is carried", () => {
    const spec = extractSpec(fixtureDump())
    expect(spec.version).toBe(1)
    expect(spec.source).toEqual({ kind: "dom", url: "https://x.test/", title: "Landing" })
    expect(spec.viewport).toEqual({ width: 1280, height: 720, documentHeight: 1400, direction: "rtl", lang: "ar" })
    expect(spec.body).toEqual({ background: "#fafafa", color: "#141414", font: "Tajawal", fontSize: 16 })
    const colors = spec.palette.map((p) => p.color)
    expect(new Set(colors).size).toBe(colors.length)
    expect(colors[0]).toBe("#fafafa") // أكبر مساحة: خلفيّة الجسم + main
    const blue = spec.palette.find((p) => p.color === "#3355ff")!
    expect(blue.roles).toEqual(["background"]); expect(blue.uses).toBe(1)
    const ink = spec.palette.find((p) => p.color === "#111827")!
    expect(ink.roles).toEqual(["background", "text"]) // footer background + h1 text — لونٌ واحد بدورين
    expect(spec.palette.find((p) => p.color === "#d1d5db")!.roles).toEqual(["border"])
    expect(spec.typography.map((t) => [t.role, t.size, t.weight])).toEqual([["heading", 40, 700], ["nav", 16, 400], ["button", 16, 700], ["body", 16, 400]])
    expect(spec.typography[3]!.lineHeight).toBe(24)
  })
  test("sections are found below the single-child wrapper with box, background, padding and layout; items summarise children", () => {
    const spec = extractSpec(fixtureDump())
    expect(spec.sections.map((s) => [s.id, s.tag, s.box.y, s.box.h])).toEqual([["s1", "header", 0, 72], ["s2", "main", 72, 600], ["s3", "footer", 672, 728]])
    expect(spec.sections[0]!.layout).toEqual({ display: "flex", direction: "row", justify: "space-between", align: "center" })
    expect(spec.sections[0]!.padding).toEqual([16, 40, 16, 40])
    expect(spec.sections[0]!.background).toBe("#ffffff")
    expect(spec.sections[1]!.layout).toEqual({ display: "grid", columns: 3, gap: 24 })
    expect(spec.sections[1]!.items.map((i) => i.tag)).toEqual(["h1", "div", "img", "input"])
    expect(spec.sections[1]!.items[0]).toEqual({ tag: "h1", box: { x: 40, y: 120, w: 1200, h: 48 }, text: "منصّةٌ تصنع الواجهات", ref: "r2" })
    expect(spec.sections[1]!.summary).toBe("منصّةٌ تصنع الواجهات نصٌّ تعريفيّ قصير")
  })
  test("components are classified with box, colors, radius, shadow, border and font; spacing and assets are collected", () => {
    const spec = extractSpec(fixtureDump())
    expect(spec.components.map((c) => c.kind)).toEqual(["nav", "heading", "button", "input", "card", "image", "link"])
    const button = spec.components.find((c) => c.kind === "button")!
    expect(button).toMatchObject({ id: "c3", tag: "button", ref: "r1", box: { x: 1100, y: 16, w: 140, h: 40 }, text: "ابدأ الآن", color: "#ffffff", background: "#3355ff", radius: 12, font: { family: "Tajawal", size: 16, weight: 700 } })
    expect(spec.components.find((c) => c.kind === "heading")).toMatchObject({ level: 1, textAlign: "right", color: "#111827" })
    expect(spec.components.find((c) => c.kind === "card")).toMatchObject({ radius: 16, shadow: "rgba(0, 0, 0, 0.08) 0px 4px 12px 0px", text: "نصٌّ تعريفيّ قصير" })
    expect(spec.components.find((c) => c.kind === "input")).toMatchObject({ placeholder: "بريدك", border: { width: 1, color: "#d1d5db" }, text: "" })
    expect(spec.components.find((c) => c.kind === "image")).toMatchObject({ src: "https://x.test/hero.jpg", text: "بطل" })
    expect(spec.spacing).toEqual([10, 16, 20, 24, 40, 48])
    expect(spec.assets).toEqual([{ kind: "image", src: "https://x.test/hero.jpg", alt: "بطل", box: { w: 400, h: 240 }, natural: { w: 1600, h: 960 } }])
  })
  test("accepts the bridge's labelled text form and refuses what is not a dump, by name", () => {
    const labelled = `شجرةُ المواصفة (تبويبُ المستخدم، جيل 3):\n${JSON.stringify(fixtureDump())}`
    expect(extractSpec(labelled).sections).toHaveLength(3)
    expect(() => extractSpec("nothing here")).toThrow("لا JSON")
    expect(() => extractSpec("{ not json")).toThrow("JSON غير صالح")
    expect(() => extractSpec(JSON.stringify({ url: "x" }))).toThrow("nodes")
  })
  test("colors normalise to hex, alpha is kept, transparent is dropped", () => {
    expect(normalizeColor("rgb(51, 85, 255)")).toBe("#3355ff")
    expect(normalizeColor("rgba(0, 0, 0, 0.5)")).toBe("#00000080")
    expect(normalizeColor("rgb(51 85 255 / 50%)")).toBe("#3355ff80")
    expect(normalizeColor("rgba(0, 0, 0, 0)")).toBeUndefined()
    expect(normalizeColor("#ABC")).toBe("#aabbcc")
    expect(normalizeColor("linear-gradient(red, blue)")).toBe("linear-gradient(red, blue)")
  })
  test("summary is compact Arabic with the numbers the model needs", () => {
    const text = summarizeSpec(extractSpec(fixtureDump()))
    expect(text).toContain("المنفذ 1280×720، الوثيقة 1400px، الاتجاه rtl")
    expect(text).toContain("s2 <main> 0,72 1280×600 خلفيّة #fafafa [grid 3 أعمدة فجوة 24]")
    expect(text).toContain("c3 زرّ <button r1> 1100,16 140×40 خلفيّة #3355ff لون #ffffff زوايا 12")
    expect(text.length).toBeLessThan(4000)
  })
})

describe("S9 — renderSpec", () => {
  test("deterministic: same spec (even reordered) gives the same bytes; no clock, no randomness", () => {
    const spec = extractSpec(fixtureDump())
    const html = renderSpec(spec)
    expect(renderSpec(JSON.parse(JSON.stringify(spec)))).toBe(html)
    expect(renderSpec({ ...spec, components: [...spec.components].reverse(), sections: [...spec.sections].reverse() })).toBe(html)
    expect(html).not.toMatch(/\d{13}/u)
  })
  test("RTL-aware, exact px boxes, colors, fonts, semantic tags", () => {
    const html = renderSpec(extractSpec(fixtureDump()))
    expect(html).toContain('<html lang="ar" dir="rtl">')
    expect(html).toContain("direction:rtl")
    expect(html).toContain('<header class="sec" id="s1" style="left:0px;top:0px;width:1280px;height:72px;background:#ffffff;padding:16px 40px 16px 40px;display:flex;flex-direction:row;justify-content:space-between;align-items:center">')
    expect(html).toContain("grid-template-columns:repeat(3,1fr);gap:24px")
    expect(html).toContain('<button class="cmp button" id="c3" style="left:1100px;top:16px;width:140px;height:40px;font:700 16px/1.2 Tajawal,sans-serif;color:#ffffff;background:#3355ff;border-radius:12px" type="button">ابدأ الآن</button>')
    expect(html).toContain('<h1 class="cmp heading" id="c2"')
    expect(html).toContain('<img class="cmp image" id="c6"')
    expect(html).toContain('src="https://x.test/hero.jpg" alt="بطل"')
    expect(html).toContain('placeholder="بريدك"')
    expect(html).toContain(":root{--c1:#fafafa;")
    const ltr = renderSpec(extractSpec({ ...fixtureDump(), dir: "ltr", lang: "" }))
    expect(ltr).toContain('<html lang="en" dir="ltr">')
  })
  test("untrusted text and urls cannot break out of the page", () => {
    const spec = extractSpec(fixtureDump())
    const hostile = {
      ...spec,
      components: [
        { ...spec.components[2]!, text: '<script>alert(1)</script>" onclick="x' },
        { ...spec.components[5]!, src: "javascript:alert(1)" },
        { ...spec.components[4]!, background: 'url("javascript:alert(1)")', shadow: "0 0 0 red}</style><script>" },
      ],
    }
    const html = renderSpec(hostile)
    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&quot; onclick=&quot;x")
    expect(html).not.toContain("javascript:")
    expect(html).toContain('class="cmp image ph"') // صورةٌ بلا مصدرٍ آمن ⇦ عنصرٌ نائب
    expect(html).not.toContain("</style><script>")
  })
})

describe("S9 — PNG codec and compareRendering", () => {
  test("encode/decode round-trips RGBA and refuses non-PNG by name", () => {
    const png = encodePng(5, 3, solid(5, 3, [10, 20, 30]))
    const back = decodePng(png)
    expect([back.width, back.height, back.rgba[0], back.rgba[1], back.rgba[2], back.rgba[3]]).toEqual([5, 3, 10, 20, 30, 255])
    expect(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toThrow("ليس ملفَّ PNG")
  })
  test("identical images are 100 with no regions; a half-different image is 50 with the differing region boxed and coloured", () => {
    const red = encodePng(64, 32, solid(64, 32, [255, 0, 0]))
    const same = compareRendering(red, red)
    expect(same.similarity).toBe(100); expect(same.meanDelta).toBe(0); expect(same.regions).toEqual([]); expect(same.verdict).toContain("مطابقٌ")
    const half = solid(64, 32, [255, 0, 0])
    for (let y = 0; y < 32; y += 1) for (let x = 32; x < 64; x += 1) { const o = (y * 64 + x) * 4; half[o] = 0; half[o + 2] = 255 }
    const report = compareRendering(red, encodePng(64, 32, half))
    expect(report.similarity).toBe(50)
    expect(report.meanDelta).toBe(85)
    expect(report.sizeMismatch).toBe(false)
    expect(report.regions.length).toBeGreaterThanOrEqual(1); expect(report.regions.length).toBeLessThanOrEqual(5)
    for (const r of report.regions) { expect(r.box.x).toBeGreaterThanOrEqual(32); expect(r.diff).toBe(100); expect(r.target).toBe("#ff0000"); expect(r.candidate).toBe("#0000ff") }
    expect(report.verdict).toContain("التشابه 50%")
  })
  test("large or differently sized images are compared on the target's frame downscaled to ≤ 480px", () => {
    const big = encodePng(1000, 500, solid(1000, 500, [255, 255, 255]))
    const small = encodePng(500, 250, solid(500, 250, [255, 255, 255]))
    const report = compareRendering(big, small)
    expect(report.compared).toEqual({ width: 480, height: 240 })
    expect(report.sizeMismatch).toBe(true)
    expect(report.similarity).toBe(100)
    expect(report.verdict).toContain("مطابقٌ")
    expect(resampleImage(decodePng(big), 10, 5).rgba.length).toBe(10 * 5 * 4)
  })
})

describe("S9 — screenshot source (vision hook with an injected model)", () => {
  const png = encodePng(320, 200, solid(320, 200, [250, 250, 250]))
  test("the hook passes the strict schema prompt and the PNG, and normalises the JSON reply (even fenced)", async () => {
    const seen: { system: string; body: string; mime: string; bytes: number }[] = []
    const result = await extractSpecFromScreenshot(png, async (system, body, image) => {
      seen.push({ system, body, mime: image.mime, bytes: Buffer.from(image.data, "base64").length })
      return '```json\n{"viewport":{"width":320,"height":200,"direction":"rtl"},"palette":[{"color":"rgb(250, 250, 250)","roles":["background"],"uses":1}],"sections":[{"id":"s1","tag":"header","box":{"x":0,"y":0,"w":320,"h":60},"background":"#ffffff","padding":[8,16,8,16],"layout":{"display":"flex","direction":"row","gap":12},"summary":"top","items":[]}],"components":[{"id":"c1","kind":"button","box":{"x":200,"y":10,"w":100,"h":40},"text":"Go","color":"#fff","background":"#3355ff","radius":8,"font":{"family":"Inter","size":14,"weight":600}}],"spacing":[8,16],"assets":[]}\n```'
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(seen).toHaveLength(1)
    expect(seen[0]!.system).toBe(SPEC_VISION_SYSTEM)
    expect(seen[0]!.body).toBe("The screenshot is 320x200 pixels. Return the JSON specification now.")
    expect(seen[0]!.mime).toBe("image/png"); expect(seen[0]!.bytes).toBe(png.length)
    expect(result.spec.source.kind).toBe("screenshot")
    expect(result.spec.viewport).toEqual({ width: 320, height: 200, documentHeight: 200, direction: "rtl" })
    expect(result.spec.palette).toEqual([{ color: "#fafafa", roles: ["background"], uses: 1, area: 0 }])
    expect(result.spec.components[0]).toMatchObject({ kind: "button", color: "#ffffff", background: "#3355ff", radius: 8, font: { family: "Inter", size: 14, weight: 600 } })
    expect(renderSpec(result.spec)).toContain('dir="rtl"')
    for (const key of ['"palette"', '"typography"', '"sections"', '"components"', '"spacing"', '"assets"', "ltr", "rtl"]) expect(SPEC_VISION_SYSTEM).toContain(key)
  })
  test("failures are named: prose reply, empty spec, throwing model, non-PNG input", async () => {
    expect(await extractSpecFromScreenshot(png, async () => "I cannot see the image.")).toEqual({ ok: false, why: "جوابُ نموذج الرؤية بلا كائن JSON" })
    expect(await extractSpecFromScreenshot(png, async () => "{\"viewport\":{\"width\":1}}")).toEqual({ ok: false, why: "نموذجُ الرؤية أعاد مواصفةً بلا أقسامٍ ولا مكوّنات" })
    expect((await extractSpecFromScreenshot(png, async () => { throw new Error("timeout") })) as { why: string }).toMatchObject({ ok: false, why: "نموذجُ الرؤية لم يُجب: timeout" })
    expect((await extractSpecFromScreenshot(new Uint8Array([0, 1, 2]), async () => "{}")) as { why: string }).toMatchObject({ ok: false, why: "ليس ملفَّ PNG (التوقيعُ مختلف)" })
    expect(parseSpecReply("{bad}", { width: 1, height: 1 })).toEqual({ ok: false, why: "جوابُ نموذج الرؤية ليس JSON صالحاً" })
    expect(parseSpecReply("no braces", { width: 1, height: 1 })).toEqual({ ok: false, why: "جوابُ نموذج الرؤية بلا كائن JSON" })
  })
})

describe("S9 — operator command parsing", () => {
  test("spec/render/compare/shot forms and their usage refusals", () => {
    expect(parseDesignCommand("spec page")).toEqual({ verb: "spec", target: "page" })
    expect(parseDesignCommand("spec https://x.test/ design/spec.json")).toEqual({ verb: "spec", target: "https://x.test/", out: "design/spec.json" })
    expect(parseDesignCommand("render design/spec.json design/index.html")).toEqual({ verb: "render", spec: "design/spec.json", out: "design/index.html" })
    expect(parseDesignCommand("compare a.png b.png")).toEqual({ verb: "compare", target: "a.png", candidate: "b.png" })
    expect(parseDesignCommand("shot")).toEqual({ verb: "shot", label: "candidate" })
    expect(parseDesignCommand("shot ../x y")).toEqual({ verb: "shot", label: "x" })
    expect(parseDesignCommand("spec")).toEqual({ verb: "usage", why: DESIGN_USAGE })
    expect(parseDesignCommand("render only-one")).toMatchObject({ verb: "usage" })
    expect(parseDesignCommand("")).toEqual({ verb: "usage", why: DESIGN_USAGE })
  })
})

describe("S9 — wiring pins across the layers", () => {
  test("the walker is one ASCII source shared byte-for-byte by the owned browser and the extension", () => {
    expect(/^[\x20-\x7e\n]+$/u.test(SPEC_WALKER)).toBe(true)
    expect(SPEC_WALKER).not.toContain("`"); expect(SPEC_WALKER).not.toContain("${")
    expect(SPEC_WALKER).toContain('own = own.replace(/\\s+/g, " ")') // الشرطةُ المائلة نجت من String.raw
    const background = read("..", "browser-bridge", "extension", "background.js")
    expect(background).toContain(`const SPEC = ${SPEC_WALKER}\n`)
    expect(background).toContain('case "inspect": return String(args.mode) === "spec" ? inPage(tab.id, SPEC, [600, String(args.target || "")]) : inPage(tab.id, INSPECT, [String(args.mode || "styles"), String(args.target || "")])')
    expect(background.indexOf("const SPEC = ")).toBeLessThan(background.indexOf("const INSPECT = ")) // شريحةُ INSPECT في اختبار التكافؤ تبقى دالّةً واحدة
    expect(JSON.parse(read("..", "browser-bridge", "extension", "manifest.json")).version).toBe("0.6.5")
    const cdp = read("..", "browser", "src", "cdp.ts")
    expect(cdp).toContain("async readSpec(rootRef = \"\", limit = SPEC_WALKER_LIMIT): Promise<string> {")
    expect(cdp).toContain("return this.#eval(specWalkerExpression(limit, rootRef))")
    expect(specWalkerExpression(600, "r7")).toBe(`JSON.stringify((${SPEC_WALKER})(600, "r7"))`)
    expect(specWalkerExpression(9999, "bad ref")).toEndWith('(2000, ""))')
  })
  test("catalogue, dispatcher, bridge and exposure", () => {
    const design = TOOLS.find((t) => t.name === "design")!
    expect(design).toMatchObject({ effect: "read", runner: "design", agentCallable: true })
    expect(design.usage).toBe("design spec <page | rN | رابط | ملف.png | ملف.json> [ملف الإخراج.json] | design render <spec.json> <out.html> | design compare <target.png> <candidate.png> | design shot <اسم>")
    const cli = read("src", "cli.ts")
    expect(cli).toContain('case "design":\n        // S9')
    expect(cli).toContain("return runDesignTool(rest, turnId, hooks)")
    expect(cli).toContain("const runDesignTool = async (rest: string, turnId: string, hooks: AskHooks): Promise<DispatchResultV> => {")
    expect(cli).toContain("dumpText = await surface.readSpec(ref)")
    expect(cli).toContain('const r = await session.call(toolName, JSON.stringify({ mode: "spec", target: ref }))')
    // القراءةُ عبر الإضافة تقف على البوّابة قبل النداء؛ والكتابةُ في المشروع بمسار write
    expect(cli.indexOf('await gate(turnId, "outside-workspace", `إضافةُ المتصفّح (تبويبُك الحقيقيّ) inspect spec')).toBeLessThan(cli.indexOf('JSON.stringify({ mode: "spec", target: ref })'))
    expect(cli).toContain("const written = await runWriteToolV(\"write\", `write ${cmd.out} <<< ${html}`, turnId, hooks)")
    expect(cli).toContain("const written = await runWriteToolV(\"write\", `write ${out} <<< ${json}`, turnId, hooks)")
    const inspect = BRIDGE_TOOLS.find((t) => t.name === "inspect")!
    expect((inspect.inputSchema.properties as { mode: { enum: string[] } }).mode.enum).toEqual(["styles", "dom", "css", "assets", "spec"])
    expect(TOOL_FAMILIES.browser).toContain("design")
    expect(exposedByIntent("design", new Set())).toBe(false)
    expect(exposedByIntent("design", new Set(["browser"]))).toBe(true)
    expect(read("..", "tools", "src", "catalogue.ts")).toContain('| "desktop" | "design"')
  })
  test("bridge: spec mode reaches the extension whole (not sliced), and an unknown root ref is refused before it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-design-bridge-"))
    const bridge = new ChromeBridge({ port: 0, token: "tok", stateDir: dir, announce: () => {} })
    const port = bridge.start()
    const received: { action: string; args: Record<string, unknown> }[] = []
    const bigDump = { ...fixtureDump(), nodes: Array.from({ length: 120 }, (_, i) => ({ ...fixtureDump().nodes[6]!, i: i + 1, p: 0 })) }
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=tok`)
    await new Promise<void>((ok) => { ws.onopen = () => ok() })
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { id: number; action: string; args: Record<string, unknown> }
      received.push({ action: m.action, args: m.args })
      ws.send(JSON.stringify({ id: m.id, ok: true, result: m.action === "page" ? [{ ref: "r1", role: "button", name: "Go" }] : bigDump }))
    }
    try {
      expect(await bridge.run("inspect", { mode: "spec", target: "r9" })).toContain("مرجعٌ غير معروف")
      expect(received).toEqual([])
      const whole = await bridge.run("inspect", { mode: "spec" })
      expect(whole.startsWith("شجرةُ المواصفة (تبويبُ المستخدم، جيل 1):\n")).toBe(true)
      expect(JSON.stringify(bigDump).length).toBeGreaterThan(7000)
      expect(extractSpec(whole).components).toHaveLength(60) // JSON كاملٌ لا مقصوص عند ٧٠٠٠ كما styles
      expect(received[0]).toEqual({ action: "inspect", args: { mode: "spec", target: "" } })
      await bridge.run("page", {})
      await bridge.run("inspect", { mode: "spec", target: "r1" })
      expect(received[2]!.args).toEqual({ mode: "spec", target: "r1" })
    } finally { ws.close(); bridge.stop(); rmSync(dir, { recursive: true, force: true }) }
  })
})

describe("S9 — the walker in a real page (positive twin)", () => {
  // كأختها في extension-inspect: حزمةُ Playwright من البيئة لا من نصٍّ ثابت؛ غيابُها = يُتخطّى ويُقال. الكروميوم الكامل المثبَّت لدى Playwright.
  const playwrightPackage = process.env.ABDO_TEST_PLAYWRIGHT_PACKAGE ?? ""
  const chromeExe = ["1228", "1234"].map((v) => `${process.env.LOCALAPPDATA ?? ""}/ms-playwright/chromium-${v}/chrome-win64/chrome.exe`).find((p) => existsSync(p))
  const available = existsSync(playwrightPackage) && chromeExe !== undefined
  // مقيس 09-14: Playwright يعلّق تحت bun ويعمل تحت node — التوأمُ يُشغَّل طفلَ node ويعيد JSON.
  test.if(available)("SPEC_WALKER reads real boxes and computed styles; extractSpec builds the spec from them; a root ref narrows the walk", () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-design-twin-"))
    try {
      const fixture = `<!doctype html><html dir="rtl" lang="ar"><head><style>body{margin:0;font-family:Tahoma;color:rgb(20,20,20);background:rgb(250,250,250)}
        header{display:flex;justify-content:space-between;align-items:center;height:72px;padding:16px 40px;background:#fff}
        main{display:grid;grid-template-columns:400px 400px 400px;gap:24px;padding:48px 40px;min-height:600px}
        .btn{background:rgb(51,85,255);color:#fff;border-radius:12px;padding:10px 20px;font-weight:700;border:0;height:40px}
        .card{background:#fff;border-radius:16px;box-shadow:0 4px 12px rgba(0,0,0,.08);padding:24px;min-height:200px}
        footer{background:rgb(17,24,39);color:#fff;padding:24px;height:200px}</style></head>
        <body><header><nav><a href="/">الرئيسيّة</a></nav><button class="btn" data-abdo-ref="r1">اضغط</button></header>
        <main><h1 style="grid-column:1/4;font-size:40px">عنوان</h1><div class="card"><p>نصّ</p></div><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="dot" width="30" height="30"><input type="email" placeholder="بريدك"></main>
        <footer>ذيل</footer></body></html>`
      writeFileSync(join(dir, "fixture.html"), fixture)
      writeFileSync(join(dir, "twin.mjs"), [
        'import { createRequire } from "node:module"', 'import { readFileSync } from "node:fs"',
        `const require = createRequire(${JSON.stringify(playwrightPackage)})`,
        'const { chromium } = require("playwright")',
        `const browser = await chromium.launch({ headless: true, executablePath: ${JSON.stringify(chromeExe)} })`,
        'const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })',
        `await page.setContent(readFileSync(${JSON.stringify(join(dir, "fixture.html"))}, "utf8"))`,
        `const whole = await page.evaluate(${JSON.stringify(specWalkerExpression(600, ""))})`,
        `const scoped = await page.evaluate(${JSON.stringify(specWalkerExpression(600, "r1"))})`,
        'console.log(JSON.stringify({ whole, scoped }))', 'await browser.close()',
      ].join("\n"))
      const child = Bun.spawnSync(["node", join(dir, "twin.mjs")], { stdout: "pipe", stderr: "pipe" })
      expect(child.exitCode, child.stderr.toString()).toBe(0)
      const out = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!) as { whole: string; scoped: string }
      const dump = JSON.parse(out.whole) as SpecDump
      expect(dump.viewport).toMatchObject({ w: 1280, h: 720 }); expect(dump.dir).toBe("rtl"); expect(dump.capped).toBe(false)
      expect(dump.nodes[0]).toMatchObject({ t: "body", p: -1, x: 0, y: 0, w: 1280 })
      const button = dump.nodes.find((n) => n.t === "button")!
      expect(button).toMatchObject({ ref: "r1", tx: "اضغط", h: 40 })
      expect(button.s.backgroundColor).toBe("rgb(51, 85, 255)"); expect(button.s.borderRadius).toBe("12px"); expect(button.s.fontWeight).toBe("700")
      expect(dump.nodes.find((n) => n.t === "input")!.f).toEqual({ type: "email", placeholder: "بريدك" })
      expect(dump.nodes.find((n) => n.t === "img")!.img).toMatchObject({ alt: "dot", src: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" }) // الطبيعيُّ ٠×٠: gif مبتور لا يُفكّ — يُبلَّغ كما يراه المتصفّح
      const spec = extractSpec(dump)
      expect(spec.viewport).toMatchObject({ width: 1280, height: 720, direction: "rtl", lang: "ar" })
      expect(spec.sections.map((s) => s.tag)).toEqual(["header", "main", "footer"])
      expect(spec.sections[0]!.layout).toMatchObject({ display: "flex", direction: "row", justify: "space-between", align: "center" })
      expect(spec.sections[0]!.padding).toEqual([16, 40, 16, 40])
      expect(spec.sections[1]!.layout).toEqual({ display: "grid", columns: 3, gap: 24 })
      expect(spec.components.find((c) => c.kind === "button")).toMatchObject({ ref: "r1", background: "#3355ff", color: "#ffffff", radius: 12, text: "اضغط", font: { weight: 700 } })
      expect(spec.components.find((c) => c.kind === "heading")).toMatchObject({ level: 1, font: { size: 40 } })
      expect(spec.components.find((c) => c.kind === "card")).toMatchObject({ radius: 16, text: "نصّ" })
      expect(spec.components.find((c) => c.kind === "input")).toMatchObject({ placeholder: "بريدك" })
      expect(spec.palette.map((p) => p.color)).toContain("#3355ff")
      expect(spec.spacing).toContain(24)
      expect(renderSpec(spec)).toContain('dir="rtl"')
      const scoped = JSON.parse(out.scoped) as SpecDump
      expect(scoped.nodes[0]).toMatchObject({ t: "button", p: -1, ref: "r1" }); expect(scoped.nodes).toHaveLength(1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)
})
