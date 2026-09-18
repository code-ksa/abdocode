import { describe, expect, test } from "bun:test"
import { MOBILE_EMULATION, classifyWindowMode, clickToShot, cssBoxToWindow, cssScale, cssToScreen, cssViewport, fitFactor, frameFromPane, frameFromWindow, frameLine, shotToClick, viewportBox, windowToCss, type ViewportFrame } from "../src/viewport-map"

// S7 (09-18) — خريطةُ المنفذ: زرٌّ معروف في CSS عند (100,200) بحجم 80×40 (مركزُه 140,220) يُصيبه النقرُ في الأوضاع الأربعة
// وعلى مقياسَي 1.25 و1.5، والعكسُ يعيد النقطةَ نفسَها — بلا رؤية.

const BUTTON = { x: 100, y: 200, width: 80, height: 40 }
const CENTER = { x: 140, y: 220 }

describe("S7 — الأوضاعُ الأربعة على مقياسَي 1.25 و1.5", () => {
  test("ملءُ الشاشة: لا إزاحةَ عميل؛ الفعليُّ = CSS × المقياس", () => {
    for (const [scale, ex, ey] of [[1.25, 175, 275], [1.5, 210, 330]] as const) {
      const frame: ViewportFrame = { mode: "fullscreen", window: { x: 0, y: 0, width: 1920, height: 1080 }, client: { x: 0, y: 0, width: 1920, height: 1080 }, scale }
      const hit = shotToClick(frame, CENTER, "css")
      expect(hit).toEqual({ x: ex, y: ey, inside: true })
      expect(clickToShot(frame, hit, "css")).toEqual(CENTER)
      expect(cssBoxToWindow(frame, BUTTON)).toEqual({ x: 100 * scale, y: 200 * scale, width: 80 * scale, height: 40 * scale })
    }
  })
  test("نافذة: إزاحةُ الإطار وشريطِ الأدوات تُضاف بعد المقياس؛ والشاشيُّ يضيف أصلَ النافذة", () => {
    for (const [scale, ex, ey] of [[1.25, 183, 395], [1.5, 218, 450]] as const) {
      const frame: ViewportFrame = { mode: "windowed", window: { x: 100, y: 50, width: 1176, height: 1530 }, client: { x: 8, y: 120, width: 1160, height: 1402 }, scale }
      expect(shotToClick(frame, CENTER, "css")).toEqual({ x: ex, y: ey, inside: true })
      expect(cssToScreen(frame, CENTER)).toEqual({ x: ex + 100, y: ey + 50 })
      expect(windowToCss(frame, { x: ex, y: ey })).toEqual(CENTER)
      // لقطةُ النافذة نفسُها فضاءُ النقر؛ ولقطةُ الشاشة (أصلُها -1920 على شاشةٍ يسار الرئيسة) تُطرح منها الأصول
      expect(shotToClick(frame, { x: ex, y: ey }, "window")).toEqual({ x: ex, y: ey, inside: true })
      const screenFrame: ViewportFrame = { ...frame, window: { x: -1920 + 100, y: 50, width: 1176, height: 1530 } }
      expect(shotToClick(screenFrame, { x: 100 + ex, y: ey + 50 }, "screen", { x: -1920, y: 0 })).toEqual({ x: ex, y: ey, inside: true })
      expect(clickToShot(screenFrame, { x: ex, y: ey }, "screen", { x: -1920, y: 0 })).toEqual({ x: 100 + ex, y: ey + 50 })
    }
  })
  test("لوحة (المتصفّحُ المملوك): المنفذُ هو العميلُ كلُّه، ومنفذُ CSS يُستنتج من الفعليّ", () => {
    for (const [scale, ex, ey] of [[1.25, 175, 275], [1.5, 210, 330]] as const) {
      const frame = frameFromPane({ viewportWidth: 1024, viewportHeight: 768, scale })
      expect(frame.mode).toBe("normal")
      expect(frame.client).toEqual({ x: 0, y: 0, width: 1024 * scale, height: 768 * scale })
      expect(shotToClick(frame, CENTER, "css")).toEqual({ x: ex, y: ey, inside: true })
      expect(cssViewport(frame)).toEqual({ width: 1024, height: 768 })
    }
  })
  test("محاكاةُ جوّال 375×812: صندوقُ حروفٍ موسَّط — بكامل الحجم إن اتّسع، ومصغَّراً ليتّسع إن لم يتّسع", () => {
    // 1.25: الجهازُ 468.75×1015 يتّسع في 1000×1200 ⇦ ملاءمة 1، الصندوقُ موسَّط أفقيّاً وعموديّاً
    const fits = frameFromPane({ viewportWidth: 800, viewportHeight: 960, scale: 1.25, emulation: MOBILE_EMULATION })
    expect(fits.mode).toBe("mobile-emulation")
    expect(fitFactor(fits)).toBe(1)
    expect(viewportBox(fits)).toEqual({ x: 265.625, y: 92.5, width: 468.75, height: 1015 })
    expect(shotToClick(fits, CENTER, "css")).toEqual({ x: 440.625, y: 367.5, inside: true })
    expect(clickToShot(fits, { x: 440.625, y: 367.5 }, "css")).toEqual(CENTER)
    expect(cssViewport(fits)).toEqual(MOBILE_EMULATION)
    // 1.5: الجهازُ 562.5×1218 أطولُ من 1200 ⇦ يُصغَّر بنسبة 1200/1218 ويُوسَّط أفقيّاً
    const shrunk: ViewportFrame = { mode: "mobile-emulation", window: { x: 0, y: 0, width: 1000, height: 1200 }, client: { x: 0, y: 0, width: 1000, height: 1200 }, scale: 1.5, emulation: MOBILE_EMULATION }
    const fit = 1200 / 1218
    expect(fitFactor(shrunk)).toBeCloseTo(fit, 6)
    expect(cssScale(shrunk)).toBeCloseTo(1.5 * fit, 6)
    const box = viewportBox(shrunk)
    expect(box.y).toBe(0)
    expect(box.height).toBeCloseTo(1200, 2)
    expect(box.x).toBeCloseTo((1000 - 375 * 1.5 * fit) / 2, 2)
    const hit = shotToClick(shrunk, CENTER, "css")
    expect(hit.x).toBeCloseTo(box.x + 140 * 1.5 * fit, 2)
    expect(hit.y).toBeCloseTo(220 * 1.5 * fit, 2)
    expect(hit.inside).toBe(true)
    const back = clickToShot(shrunk, hit, "css")
    expect(back.x).toBeCloseTo(140, 2)
    expect(back.y).toBeCloseTo(220, 2)
    // نقطةٌ خارج صندوق الجهاز (في الحروف) ما زالت داخل النافذة، ونقطةٌ خارج النافذة تُعلَّم
    expect(shotToClick(shrunk, { x: -400, y: 0 }, "css").inside).toBe(false)
    expect(shotToClick(fits, { x: -100, y: 10 }, "css").inside).toBe(true)
  })
})

describe("S7 — بناءُ الإطار وسطرُ الإيصال", () => {
  test("من قياس نافذة ويندوز: ملءُ الشاشة حين تغطّي شاشتَها (تسامحُ بكسلين)، وإلّا نافذة", () => {
    const monitor = { x: 0, y: 0, width: 1920, height: 1080 }
    expect(classifyWindowMode({ x: 0, y: 0, width: 1920, height: 1080 }, monitor)).toBe("fullscreen")
    expect(classifyWindowMode({ x: -1, y: 1, width: 1921, height: 1079 }, monitor)).toBe("fullscreen")
    expect(classifyWindowMode({ x: 0, y: 0, width: 1176, height: 1530 }, monitor)).toBe("windowed")
    expect(classifyWindowMode({ x: 0, y: 0, width: 1920, height: 1080 }, undefined)).toBe("windowed")
    const f = frameFromWindow({ left: 0, top: 0, width: 1176, height: 1530, clientLeft: 8, clientTop: 31, clientWidth: 1160, clientHeight: 1491, scale: 1.25, monitor })
    expect(f).toEqual({ mode: "windowed", window: { x: 0, y: 0, width: 1176, height: 1530 }, client: { x: 8, y: 31, width: 1160, height: 1491 }, scale: 1.25 })
    // غيابُ حقول العميل والمقياس ⇦ النافذةُ كلُّها بمقياس 1، لا خطأ
    expect(frameFromWindow({ left: 5, top: 6, width: 100, height: 50 })).toEqual({ mode: "windowed", window: { x: 5, y: 6, width: 100, height: 50 }, client: { x: 0, y: 0, width: 100, height: 50 }, scale: 1 })
    expect(frameFromWindow({ left: 0, top: 0, width: 10, height: 10, scale: 0 }).scale).toBe(1)
  })
  test("سطرُ الإيصال بالشكل الذي يقرؤه النموذج", () => {
    expect(frameLine({ mode: "windowed", window: { x: 0, y: 0, width: 1176, height: 1530 }, client: { x: 0, y: 0, width: 1176, height: 1530 }, scale: 1.25 })).toBe("الوضع: نافذة، الإطار 1176×1530 @ (0,0)، المقياس 1.25")
    expect(frameLine({ mode: "windowed", window: { x: 100, y: 50, width: 1176, height: 1530 }, client: { x: 8, y: 120, width: 1160, height: 1402 }, scale: 1.5 })).toBe("الوضع: نافذة، الإطار 1176×1530 @ (100,50)، العميل 1160×1402 @ (8,120)، المقياس 1.5")
    expect(frameLine({ mode: "fullscreen", window: { x: 0, y: 0, width: 1920, height: 1080 }, client: { x: 0, y: 0, width: 1920, height: 1080 }, scale: 1 })).toBe("الوضع: ملء الشاشة، الإطار 1920×1080 @ (0,0)، المقياس 1")
    expect(frameLine(frameFromPane({ viewportWidth: 1024, viewportHeight: 768, scale: 1.25 }))).toBe("الوضع: لوحة، الإطار 1280×960 @ (0,0)، المقياس 1.25")
    expect(frameLine(frameFromPane({ viewportWidth: 800, viewportHeight: 960, scale: 1.25, emulation: MOBILE_EMULATION }))).toBe("الوضع: محاكاة جوّال 375×812 في صندوق 469×1015 @ (266,93)، الإطار 1000×1200 @ (0,0)، المقياس 1.25")
  })
})
