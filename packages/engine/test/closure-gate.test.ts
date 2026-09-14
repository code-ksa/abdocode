import { describe, expect, test } from "bun:test"
import type { ToolVerdict } from "@abdo/engine-host"
import { browserProofVerdict, declaredOutputEvidence, httpEvidenceVerdict, mockedAwayViolation, outputEvidenceVerdict } from "../src/closure-gate"

describe("browser proof (2026-09-13): a goal asking to open/shoot/click is not closed by a green build", () => {
  const okv = { ok: true } as ToolVerdict
  const goal = "شغّل المشروع وافتحه في متصفّحك، والتقط الصفحة كاملةً (shot full)، وتحقّق أنّ الروابط تعمل بالنقر"
  test("build + dev server alone → the three missing browser receipts are named", () => {
    const v = browserProofVerdict(goal, [{ command: "run npm run build", output: "ok", verdict: okv }, { command: "run --bg npm run dev", output: "listening", verdict: okv }])
    expect(v).toContain("open <الرابط>")
    expect(v).toContain("shot full")
    expect(v).toContain("tap <مرجع>")
  })
  test("twin: successful open + shot + tap receipts satisfy it; a failed shot does not; a goal without browser words never asks", () => {
    const done = [{ command: "open http://127.0.0.1:5173", output: "فُتحت", verdict: okv }, { command: "shot full", output: "التُقطت 3 بلاطات", verdict: okv }, { command: "tap r12", output: "نُقر", verdict: okv }]
    expect(browserProofVerdict(goal, done)).toBeUndefined()
    expect(browserProofVerdict(goal, [done[0]!, { command: "shot full", output: "تعذّرت اللقطة", verdict: { ok: false, reason: "tool_failed", denied: false } as ToolVerdict }, done[2]!])).toContain("shot full")
    expect(browserProofVerdict("اكتب دالّة تجمع رقمين", [])).toBeUndefined()
    // مراجعة 09-14 — لا إيجابيّاتٍ كاذبة: «click handler» و«زرّ يلتقط screenshot» بلا سياق متصفّحٍ لا يطلبان دليلاً؛ ومتصفّحٌ موقوفٌ = لا شرط.
    expect(browserProofVerdict("add a click handler to the nav and a button that takes a screenshot", [])).toBeUndefined()
    expect(browserProofVerdict(goal, [], false)).toBeUndefined()
  })
})

describe("mocked-away test guard — S10 / catalog 8.6", () => {
  test("refuses mocking the unit under test itself", () => {
    const src = 'import { getUser } from "./db"\nvi.mock("./db")\ntest("x", () => { expect(getUser()).toBe(1) })'
    expect(mockedAwayViolation("app/lib/db.test.ts", src)).toContain("يستبدل الوحدة")
  })

  test("refuses expect with no real assertion", () => {
    expect(mockedAwayViolation("x.test.ts", 'test("x", () => { expect(thing) })')).toContain("بلا مطابقة")
  })

  test("allows mocking a genuine external boundary", () => {
    const src = 'import { save } from "./db"\nvi.mock("node:fs")\ntest("x", () => { expect(save(1)).toBe(true) })'
    expect(mockedAwayViolation("app/lib/db.test.ts", src)).toBeUndefined()
  })

  test("ignores non-test files", () => {
    expect(mockedAwayViolation("app/lib/db.ts", 'vi.mock("./db")')).toBeUndefined()
  })
})

describe("http evidence verdict — S10 / KF-25", () => {
  test("rejects an empty run with no probes", () => {
    expect(httpEvidenceVerdict([])).toContain("لا دليل")
  })

  test("rejects a data route that 200s with an empty or error body", () => {
    expect(httpEvidenceVerdict([{ path: "/api/services", status: 200, body: "" }])).toContain("فارغ")
    expect(httpEvidenceVerdict([{ path: "/api/services", status: 200, body: '{"error":"فشل"}' }])).toContain("خطأ")
    expect(httpEvidenceVerdict([{ path: "/api/services", status: 500, body: "" }])).toContain("عطل")
  })

  test("accepts public 200s, protected 401/403, and data routes with real bodies", () => {
    const verdict = httpEvidenceVerdict([
      { path: "/", status: 200, body: "<html>..." },
      { path: "/admin", status: 401, body: "" },
      { path: "/api/services", status: 200, body: '[{"id":1,"title":"x"}]' },
    ])
    expect(verdict).toBeUndefined()
  })
})

describe("output evidence verdict — catalog 15.x (silent exit-code gate)", () => {
  const wasmGoal = "اكتب محمّل Node بحيث node loader.mjs 7 يطبع fib(7)=13 ثم سلّم."

  test("extracts an explicit «دليل الخرج:» line and an implicit measurable claim", () => {
    expect(declaredOutputEvidence("افعل كذا.\nدليل الخرج: مرحبا: 3")).toEqual(["مرحبا: 3"])
    expect(declaredOutputEvidence(wasmGoal)).toEqual(["fib(7)=13"])
  })

  test("a descriptive claim with no literal payload is not binding", () => {
    expect(declaredOutputEvidence("البرنامج يطبع رسالة استخدام عند الخطأ")).toEqual([])
    expect(outputEvidenceVerdict("البرنامج يطبع رسالة استخدام عند الخطأ", [])).toBeUndefined()
  })

  test("replays the WASM incident: exit 0 with silent stdout is rejected by name", () => {
    const receipts = [{ command: "run node loader.mjs 7", output: "انتهى الأمر برمز 0" }]
    expect(outputEvidenceVerdict(wasmGoal, receipts)).toContain("fib(7)=13")
  })

  test("a run receipt actually carrying the output satisfies the gate", () => {
    const receipts = [{ command: "run node loader.mjs 7", output: "fib(7)=13\nانتهى الأمر برمز 0" }]
    expect(outputEvidenceVerdict(wasmGoal, receipts)).toBeUndefined()
  })

  test("a write receipt echoing the literal is not behavior and does not count", () => {
    const receipts = [{ command: "write test.mjs", output: 'كُتب الملف: assert.equal(out, "fib(7)=13")' }]
    expect(outputEvidenceVerdict(wasmGoal, receipts)).toContain("fib(7)=13")
  })

  test("a goal with no declared evidence keeps the gate inapplicable", () => {
    expect(outputEvidenceVerdict("ابنِ موقعاً صغيراً واختبره", [])).toBeUndefined()
  })

  test("clitic-prefixed Arabic claims arm the gate (وسيطبع/فيطبع/ستطبع)", () => {
    expect(declaredOutputEvidence("اكتب السكربت وسيطبع fib(7)=13 عند التشغيل")).toEqual(["fib(7)=13"])
    expect(declaredOutputEvidence("شغّله فيطبع المجموع 165.50")).toEqual(["165.50"])
    expect(declaredOutputEvidence("والدالة ستطبع «مرحبا: 3».")).toEqual(["مرحبا: 3"])
  })

  test("wrapping strips to a fixed point: quote+period in either order, ASCII comma too", () => {
    expect(declaredOutputEvidence("دليل الخرج: «مرحبا: 3».")).toEqual(["مرحبا: 3"])
    expect(declaredOutputEvidence("يطبع fib(7)=13, ثم يخرج")).toEqual(["fib(7)=13"])
  })

  test("a FAILING receipt quoting the needle in its error text does not satisfy the gate", () => {
    const receipts = [{ command: "run node main.js", output: 'SyntaxError near console.log("fib(7)=13")\nانتهى الأمر برمز 1' }]
    expect(outputEvidenceVerdict(wasmGoal, receipts)).toContain("fib(7)=13")
  })

  test("read-back and echo commands are not behavior: type/findstr/echo receipts do not count", () => {
    const type = [{ command: "run type main.py", output: 'print("fib(7)=13")\nانتهى الأمر برمز 0' }]
    expect(outputEvidenceVerdict(wasmGoal, type)).toContain("fib(7)=13")
    const findstr = [{ command: 'run findstr /C:"fib(7)=13" main.py', output: 'main.py: print("fib(7)=13")\nانتهى الأمر برمز 0' }]
    expect(outputEvidenceVerdict(wasmGoal, findstr)).toContain("fib(7)=13")
    const echo = [{ command: "run echo fib(7)=13", output: "fib(7)=13\nانتهى الأمر برمز 0" }]
    expect(outputEvidenceVerdict(wasmGoal, echo)).toContain("fib(7)=13")
  })

  test("the receipt's own command echo line is stripped before matching", () => {
    const receipts = [{ command: "run node check.js fib(7)=13", output: "$ node check.js fib(7)=13\nلا خرج\nانتهى الأمر برمز 0" }]
    expect(outputEvidenceVerdict(wasmGoal, receipts)).toContain("fib(7)=13")
  })

  test("a genuine successful program run still satisfies the gate", () => {
    const receipts = [{ command: "run node loader.mjs 7", output: "$ node loader.mjs 7\nfib(7)=13\nانتهى الأمر برمز 0" }]
    expect(outputEvidenceVerdict(wasmGoal, receipts)).toBeUndefined()
  })
})

describe("output evidence verdict — explicit tool verdicts decide which receipts are usable", () => {
  const goal = "اكتب app.js ثم شغّله.\nدليل الخرج: Hello Riyadh"

  test("an ok verdict admits a markerless run receipt carrying the evidence (legacy text rejects it)", () => {
    const ok: ToolVerdict = { ok: true }
    expect(outputEvidenceVerdict(goal, [{ command: "run node app.js", output: "Hello Riyadh" }])).toContain("Hello Riyadh")
    expect(outputEvidenceVerdict(goal, [{ command: "run node app.js", output: "Hello Riyadh", verdict: ok }])).toBeUndefined()
  })

  test("a failing verdict excludes a receipt even when its text ends in exit 0 and carries the evidence", () => {
    const failed: ToolVerdict = { ok: false, reason: "aborted", denied: false }
    const output = "Hello Riyadh\nانتهى الأمر برمز 0"
    expect(outputEvidenceVerdict(goal, [{ command: "run node app.js", output }])).toBeUndefined()
    expect(outputEvidenceVerdict(goal, [{ command: "run node app.js", output, verdict: failed }])).toContain("Hello Riyadh")
  })
})
