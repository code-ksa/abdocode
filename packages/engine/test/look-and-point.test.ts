import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterClickLine, parsePointReply, pointBody, pointReceipt, pointSystem, shotDigest } from "../src/look-and-point"

// ن7 (09-16) — look-and-point: الجوابُ يُقرأ بصرامة (JSON واحد، أعدادٌ صحيحة داخل الصورة) فلا نقرَ على تخمين؛ وبوّابةُ الإقفال
// تقول «الفعلُ لم يقع» حين تتطابق لقطتا قبل/بعد — بدل تكرارٍ أعمى يستهلك الدور.

describe("parsePointReply — strict", () => {
  test("a clean JSON, JSON inside prose, and JSON inside a code fence all yield the same point", () => {
    const want = { ok: true, x: 120, y: 44, label: "Save", confidence: 0.9 }
    expect(parsePointReply('{"found":true,"x":120,"y":44,"label":"Save","confidence":0.9}', 800, 600)).toEqual(want)
    expect(parsePointReply('العنصرُ هنا: {"found":true,"x":120,"y":44,"label":"Save","confidence":0.9} — انتهى', 800, 600)).toEqual(want)
    expect(parsePointReply('```json\n{"found":true,"x":120,"y":44,"label":"Save","confidence":0.9}\n```', 800, 600)).toEqual(want)
  })
  test("not found, prose only, broken JSON, non-integers and out-of-image points are refused by name — never a guess", () => {
    expect(parsePointReply('{"found":false,"why":"لا زرَّ أزرق"}', 800, 600)).toEqual({ ok: false, why: "لم يجد نموذجُ الرؤية العنصرَ: لا زرَّ أزرق" })
    expect(parsePointReply("الزرُّ في الأعلى يميناً تقريباً", 800, 600).ok).toBe(false)
    expect(parsePointReply('{"found":true,"x":', 800, 600).ok).toBe(false)
    expect(parsePointReply('{"found":true,"x":12.5,"y":4}', 800, 600).ok).toBe(false)
    const out = parsePointReply('{"found":true,"x":800,"y":10}', 800, 600)
    expect(out.ok).toBe(false); if (!out.ok) expect(out.why).toContain("خارج الصورة")
    expect(parsePointReply('{"found":true,"x":-1,"y":10}', 800, 600).ok).toBe(false)
  })
  test("confidence is clamped to [0,1] and missing labels do not break the receipt", () => {
    const v = parsePointReply('{"found":true,"x":1,"y":2,"confidence":7}', 10, 10)
    expect(v).toEqual({ ok: true, x: 1, y: 2, label: "", confidence: 1 })
    if (v.ok) expect(pointReceipt(v, "Paint")).toContain("desk click 1 2")
    const w = parsePointReply('{"found":true,"x":1,"y":2,"confidence":"abc"}', 10, 10)
    if (w.ok) expect(w.confidence).toBe(0)
  })
})

describe("prompt, digest and the closure gate", () => {
  test("the prompt asks for one JSON line with image-pixel centre coordinates and carries the image size", () => {
    expect(pointSystem()).toContain('"found":false')
    expect(pointSystem()).toContain("مركز")
    expect(pointBody("زرُّ حفظ", 1024, 768)).toContain("1024×768")
  })
  test("identical shots mean the action did not land; different shots are reported as change", () => {
    const a = shotDigest("AAAA"), b = shotDigest("BBBB")
    expect(a).not.toBe(b); expect(a).toHaveLength(16)
    expect(afterClickLine(a, a)).toContain("الفعلُ لم يقع")
    expect(afterClickLine(a, b)).toContain("تغيّرت الشاشةُ")
  })
})

describe("wiring", () => {
  test("desk point takes the shot, routes it to the vision model, never clicks; the click on the pointed spot verifies by a second shot", () => {
    const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")
    expect(cli).toContain('if (/^point(?:\\s|$)/u.test(rest.trim())) {')
    expect(cli).toContain("const route = shotRoute(loadSettings())")
    expect(cli).toContain("reply = await visionPointAsk(pointSystem(), pointBody(description, width, height)")
    expect(cli).toContain("desktopPointed = { x: verdict.x, y: verdict.y, label: verdict.label, digest: shotDigest(data) }")
    // النقرُ ليس هنا: point يعود بإيصالٍ فقط، والنقرُ فعلُ النموذج التالي بالبوّابة
    const pointAt = cli.indexOf('if (/^point(?:\\s|$)/u.test(rest.trim())) {'), waitAt = cli.indexOf("// ن4 — desk wait <نصّ> [ث]")
    expect(cli.slice(pointAt, waitAt)).not.toContain("MouseButton")
    expect(cli.slice(pointAt, waitAt)).not.toContain('kind: "click"')
    expect(cli).toContain("action.x === desktopPointed.x && action.y === desktopPointed.y")
    expect(cli).toContain("afterClickLine(pointed.digest, shotDigest(")
    const catalogue = readFileSync(join(import.meta.dir, "..", "..", "tools", "src", "catalogue.ts"), "utf8")
    expect(catalogue).toContain("desk point <وصفُ عنصرٍ في اللقطة>")
  })
})
