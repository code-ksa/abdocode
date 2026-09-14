import { describe, expect, test } from "bun:test"
import type { ToolVerdict } from "@abdo/engine-host"
import { classifyFailureTier, exitZero, normalizeErrorSignature, receiptFailed, receiptSucceeded, wallFact, WallTracker, ZERO_EXIT_ANYWHERE } from "../src/failure-tiering"

describe("failure tiering — absorbed from Anton root_cause (ideas, not fork)", () => {
  test("environment walls classify as external_wall", () => {
    expect(classifyFailureTier("'taskkill' is not recognized as an internal or external command\nانتهى الأمر برمز 1")).toBe("external_wall")
    expect(classifyFailureTier("Error: provider credential unavailable\nانتهى الأمر برمز 1")).toBe("external_wall")
    expect(classifyFailureTier("HTTP 401 Unauthorized: invalid_api_key\nانتهى الأمر برمز 1")).toBe("external_wall")
    expect(classifyFailureTier("EACCES: permission denied, open '/etc/hosts'")).toBe("external_wall")
  })

  test("the model's own bugs classify as self_inflicted — they never count toward a breaker", () => {
    expect(classifyFailureTier("TypeError: Cannot read properties of undefined\nانتهى الأمر برمز 1")).toBe("self_inflicted")
    expect(classifyFailureTier("app/page.tsx:12:3 - error TS2304: Cannot find name 'foo'")).toBe("self_inflicted")
    expect(classifyFailureTier("Error: Cannot find module './lib/db'")).toBe("self_inflicted")
  })

  test("network blips classify as transient", () => {
    expect(classifyFailureTier("FetchError: ETIMEDOUT api.example.com")).toBe("transient")
    expect(classifyFailureTier("429 Too Many Requests — retry later")).toBe("transient")
  })

  test("unknown failures stay unclassified — neutrality over a false breaker", () => {
    expect(classifyFailureTier("something odd happened\nانتهى الأمر برمز 1")).toBe("unclassified")
  })

  test("signatures normalize paths, numbers, and quoted runs so near-twins hash alike", () => {
    const a = normalizeErrorSignature("Error: connect to engine='gmail-1' at C:\\proj\\one failed after 30s")
    const b = normalizeErrorSignature("Error: connect to engine='gmail-2' at C:\\proj\\two failed after 45s")
    expect(a).toBe(b)
  })

  test("receiptFailed reads the explicit non-zero exit and error-marked silence", () => {
    expect(receiptFailed("انتهى الأمر برمز 1")).toBe(true)
    expect(receiptFailed("انتهى الأمر برمز 0")).toBe(false)
    expect(receiptFailed("fatal: not a git repository")).toBe(true)
    expect(receiptFailed("كل شيء سليم")).toBe(false)
  })

  test("the LAST exit marker governs: quoted subprocess exits do not override the final zero", () => {
    const output = "subprocess log: child exited with code 1 (retried)\nكل شيء سليم\nانتهى الأمر برمز 0"
    expect(receiptFailed(output)).toBe(false)
    expect(receiptSucceeded(output)).toBe(true)
    const inverse = "انتهى الأمر برمز 0 كان متوقعاً لكن\nانتهى الأمر برمز 1"
    expect(receiptFailed(inverse)).toBe(true)
  })

  test("a markerless timeout or kill is a failure, not a silent pass", () => {
    expect(receiptFailed("العملية تجاوزت المهلة")).toBe(true)
    expect(receiptFailed("process timed out after 240000ms")).toBe(true)
    expect(receiptFailed("child killed by watchdog")).toBe(true)
  })

  test("Arabic-named path segments fold into the signature too", () => {
    const a = normalizeErrorSignature("خطأ في C:\\مشاريع\\عيادة-نور\\ملف.ts عند السطر 12")
    const b = normalizeErrorSignature("خطأ في C:\\مشاريع\\مكتبة-الحي\\آخر.ts عند السطر 99")
    expect(a).toBe(b)
  })
})

describe("wall tracker — STUCK is a wall repeated, never a model fixing itself", () => {
  test("the same external wall twice returns a verdict naming it", () => {
    const tracker = new WallTracker()
    const wall = "'cmd' is not recognized as an internal or external command\nانتهى الأمر برمز 1"
    expect(tracker.observe(wall)).toBeUndefined()
    const verdict = tracker.observe(wall)
    expect(verdict?.hits).toBe(2)
    expect(verdict?.evidence).toContain("not recognized")
  })

  test("self-inflicted errors never trip, however often they repeat", () => {
    const tracker = new WallTracker()
    for (let i = 0; i < 6; i++) {
      expect(tracker.observe(`TypeError: x is not a function (attempt ${i})\nانتهى الأمر برمز 1`)).toBeUndefined()
    }
  })

  test("two different walls do not cross-count", () => {
    const tracker = new WallTracker()
    expect(tracker.observe("EACCES: permission denied, open '/var/log/x'\nانتهى الأمر برمز 1")).toBeUndefined()
    expect(tracker.observe("provider credential unavailable\nانتهى الأمر برمز 1")).toBeUndefined()
  })

  test("successful receipts pass through untouched", () => {
    const tracker = new WallTracker()
    expect(tracker.observe("بُني بنجاح\nانتهى الأمر برمز 0")).toBeUndefined()
  })

  test("a confirmed wall distills to a durable keyed fact (cerebellum-lite)", () => {
    const tracker = new WallTracker()
    const wall = "'taskkill' is not recognized as an internal or external command\nانتهى الأمر برمز 1"
    tracker.observe(wall)
    const verdict = tracker.observe(wall)!
    const fact = wallFact(verdict)
    expect(fact.key.startsWith("wall:")).toBe(true)
    expect(fact.value).toContain("not recognized")
    expect(fact.value).toContain("2×")
  })
})

describe("explicit tool verdicts — the verdict governs; its absence never coerces (spec §5/§10)", () => {
  const broken: ToolVerdict = { ok: false, reason: "nonzero_exit", denied: false }
  const denied: ToolVerdict = { ok: false, reason: "policy_denied", denied: true }
  const ok: ToolVerdict = { ok: true }

  test("a markerless wall text is invisible to the legacy predicate; a failing verdict lets the tracker count it twice into STUCK", () => {
    const wall = "EACCES: permission denied"
    expect(receiptFailed(wall)).toBe(false)
    const tracker = new WallTracker()
    expect(tracker.observe(wall, broken)).toBeUndefined()
    const verdict = tracker.observe(wall, broken)
    expect(verdict?.hits).toBe(2)
    expect(verdict?.signature).toBe(normalizeErrorSignature(wall))
  })

  test("a policy denial is not breakage: five denials on wall text never trip the tracker", () => {
    const tracker = new WallTracker()
    for (let i = 0; i < 5; i++) expect(tracker.observe("EACCES: permission denied", denied)).toBeUndefined()
    expect(receiptFailed("EACCES: permission denied\nانتهى الأمر برمز 1", denied)).toBe(false)
  })

  test("an ok verdict on wall text with a non-zero marker overrides the text", () => {
    const tracker = new WallTracker()
    const wall = "'cmd' is not recognized as an internal or external command\nانتهى الأمر برمز 1"
    expect(receiptFailed(wall)).toBe(true)
    expect(tracker.observe(wall, ok)).toBeUndefined()
    expect(tracker.observe(wall, ok)).toBeUndefined()
    expect(receiptFailed(wall, ok)).toBe(false)
  })

  test("exitZero: the verdict wins over the text in both directions; no verdict falls back to the text", () => {
    expect(exitZero("انتهى الأمر برمز 0", { ok: false, reason: "aborted", denied: false })).toBe(false)
    expect(exitZero("انتهى الأمر برمز غير معروف", ok)).toBe(true)
    expect(exitZero("انتهى الأمر برمز 0")).toBe(true)
    expect(exitZero("انتهى الأمر برمز غير معروف")).toBe(false)
  })

  test("ZERO_EXIT_ANYWHERE is byte-identical to the literal it replaced in the three acceptance/memory files", () => {
    // Bun/JSC serialises `u`-flag sources with \uXXXX escapes, so the pin compares against the removed literal itself.
    expect(ZERO_EXIT_ANYWHERE.source).toBe(/(?:انتهى الأمر برمز|exit(?:ed)?(?: with)?(?: code)?)\s*0\b/iu.source)
    expect(ZERO_EXIT_ANYWHERE.flags).toBe("iu")
  })

  test("receiptSucceeded: an ok verdict on a markerless receipt is success; a failing verdict on a zero marker is not", () => {
    expect(receiptSucceeded("no marker", ok)).toBe(true)
    expect(receiptSucceeded("no marker")).toBe(false)
    expect(receiptSucceeded("انتهى الأمر برمز 0", broken)).toBe(false)
  })
})
