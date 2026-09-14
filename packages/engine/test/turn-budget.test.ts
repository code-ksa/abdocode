import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chargeableUsage } from "../src/token-budget"
import { TURN_CAP_ENV, TurnSpendMeter, closeToDone, renderCap, renderTurnBudgetLine, turnTokenCap } from "../src/turn-budget"

// الأرقام المقيسة نفسها التي يثبت بها token-budget.test الفعّال: 43 + (4558−4224) + 4224×0.25 = 1433.
const PROBE = { inputTokens: 4558, outputTokens: 43, cachedInputTokens: 4224 }

const savedCap = process.env[TURN_CAP_ENV]
const savedDiscount = process.env.ABDO_CLOUD_CACHE_DISCOUNT
beforeEach(() => { delete process.env[TURN_CAP_ENV]; delete process.env.ABDO_CLOUD_CACHE_DISCOUNT })
afterEach(() => {
  if (savedCap === undefined) delete process.env[TURN_CAP_ENV]; else process.env[TURN_CAP_ENV] = savedCap
  if (savedDiscount === undefined) delete process.env.ABDO_CLOUD_CACHE_DISCOUNT; else process.env.ABDO_CLOUD_CACHE_DISCOUNT = savedDiscount
})

describe("turn token cap — ABDO_TURN_TOKEN_CAP parsing (absent = no cap, malformed = fail-closed)", () => {
  test("absent or blank means no cap — nothing is constructed", () => {
    for (const raw of [undefined, "", "  "]) expect(turnTokenCap(raw)).toBeUndefined()
    delete process.env[TURN_CAP_ENV]
    expect(turnTokenCap()).toBeUndefined()
  })

  test("malformed values are 'invalid', never a silent default", () => {
    for (const raw of ["abc", "0", "-5", "1e6", "12.5", "9007199254740993", "300k", "+5"]) expect(turnTokenCap(raw)).toBe("invalid")
  })

  test("a safe positive integer is the cap, whitespace tolerated", () => {
    expect(turnTokenCap("600000")).toBe(600000)
    expect(turnTokenCap(" 300000 ")).toBe(300000)
    process.env[TURN_CAP_ENV] = "1"
    expect(turnTokenCap()).toBe(1)
  })
})

describe("TurnSpendMeter — charges effective tokens, the 💳 unit", () => {
  test("the probe entry costs 1433 at the default 0.25 discount", () => {
    const meter = new TurnSpendMeter(300000)
    meter.charge(PROBE)
    const s = meter.snapshot()
    expect(s.spent).toBe(1433)
    expect(s.calls).toBe(1)
    expect(s.peakCall).toBe(1433)
  })

  test("an entry without cachedInputTokens (cacheAccounting OFF shape) is charged raw: 4601", () => {
    const meter = new TurnSpendMeter(300000)
    meter.charge(chargeableUsage(PROBE, 100, 10, false))
    expect(meter.snapshot().spent).toBe(4601)
  })

  test("ABDO_CLOUD_CACHE_DISCOUNT=1 charges raw even with the field present", () => {
    process.env.ABDO_CLOUD_CACHE_DISCOUNT = "1"
    const meter = new TurnSpendMeter(300000)
    meter.charge(PROBE)
    expect(meter.snapshot().spent).toBe(4601)
  })

  test("peakCall is the largest single call, spent is the sum", () => {
    const meter = new TurnSpendMeter(300000)
    meter.charge({ inputTokens: 1000, outputTokens: 0 })
    meter.charge({ inputTokens: 4000, outputTokens: 0 })
    meter.charge({ inputTokens: 2000, outputTokens: 0 })
    expect(meter.snapshot()).toMatchObject({ spent: 7000, calls: 3, peakCall: 4000 })
  })
})

describe("TurnSpendMeter — strict per-call verdict", () => {
  test("refuses when spent + estimate exceeds the cap, naming the variable and the numbers", () => {
    const meter = new TurnSpendMeter(2000)
    meter.charge(PROBE)
    const refused = meter.verdict(600)
    expect(refused.allowed).toBe(false)
    expect(refused.message).toContain(TURN_CAP_ENV)
    expect(refused.message).toContain("منفَق 1433 + مقدَّر 600 > سقف الدور 2000")
    expect(meter.snapshot().tripped).toBe(true)
    expect(meter.snapshot().refusals).toBe(1)
  })

  test("allows when the estimate fits and tripped stays false", () => {
    const meter = new TurnSpendMeter(2000)
    meter.charge(PROBE)
    const ok = meter.verdict(500)
    expect(ok).toEqual({ allowed: true, spent: 1433, cap: 2000 })
    expect(meter.snapshot().tripped).toBe(false)
    expect(meter.snapshot().refusals).toBe(0)
  })

  test("an invalid cap refuses the very first call by name with the raw value, and the gate is exhausted at once", () => {
    const meter = new TurnSpendMeter("invalid", 0.25, "300k")
    const refused = meter.verdict(1)
    expect(refused.allowed).toBe(false)
    expect(refused.message).toContain(TURN_CAP_ENV)
    expect(refused.message).toContain("300k")
    expect(meter.snapshot().tripped).toBe(true)
    expect(meter.gate()).toBe("exhausted")
    expect(meter.grantGrace(2)).toBe(0)
    expect(meter.snapshot().graceUsed).toBe(false)
  })

  test("TB-2: an invalid cap that no cloud call ever consulted leaves the gate open — a purely local turn is not stopped by a variable it never touched", () => {
    const meter = new TurnSpendMeter("invalid", 0.25, "abc")
    expect(meter.gate(2)).toBe("open")
    expect(meter.gate(3)).toBe("open")
    // A zero grant never counts as a grace; the cli guard (granted > 0) turns it into an honest stop.
    expect(meter.grantGrace(2)).toBe(0)
    expect(meter.snapshot()).toMatchObject({ graceUsed: false, tripped: false, refusals: 0, spent: 0, calls: 0 })
    // The first cloud attempt is refused by name and only then exhausts the gate.
    expect(meter.verdict(10).allowed).toBe(false)
    expect(meter.gate(3)).toBe("exhausted")
  })

  test("verdict records the largest estimated request as peakRequest, whether allowed or refused", () => {
    const meter = new TurnSpendMeter(20000)
    meter.verdict(3000)
    meter.verdict(12000)
    meter.verdict(5000)
    expect(meter.snapshot().peakRequest).toBe(12000)
    meter.charge({ inputTokens: 9000, outputTokens: 0 })
    expect(meter.verdict(15000).allowed).toBe(false)
    expect(meter.snapshot().peakRequest).toBe(15000)
  })
})

// Every cloud charge in cli.ts is preceded by a verdict with the same estimate (estimated + requestOutputCap);
// the helper mirrors that pairing so the gate tests exercise the real predictor (peakRequest).
const cloudCall = (meter: TurnSpendMeter, estimate: number, effective: number): boolean => {
  const allowed = meter.verdict(estimate).allowed
  if (allowed) meter.charge({ inputTokens: effective, outputTokens: 0 })
  return allowed
}

describe("TurnSpendMeter — boundary gate with the peak-request predictor and one grace", () => {
  test("open while spent + peakRequest fits; exhausted once it does not", () => {
    const meter = new TurnSpendMeter(10000)
    cloudCall(meter, 4000, 4000)
    expect(meter.gate()).toBe("open")
    cloudCall(meter, 4000, 4000)
    expect(meter.gate()).toBe("exhausted")
  })

  test("TB-1: the predictor is the pre-check unit — in the cache regime (effective ≪ estimate) the gate closes before an epoch whose first call would be refused", () => {
    // 93% cache: each call is estimated 2500 + 8192 (agent output cap) but costs ~3000 effective.
    const meter = new TurnSpendMeter(100000)
    for (let i = 0; i < 30; i++) expect(cloudCall(meter, 2500 + 8192, 3000)).toBe(true)
    expect(meter.snapshot()).toMatchObject({ spent: 90000, calls: 30, peakCall: 3000, peakRequest: 10692 })
    // The old peakCall predictor said 90000 + 3000 ≤ 100000 → "open" — and the very next verdict(10692) was refused mid-epoch.
    expect(meter.gate(5)).toBe("exhausted")
    // A grace sized in the same unit admits one more call: min(25000, 2×10692) = 21384 ≥ the peak request.
    expect(meter.grantGrace(5)).toBe(21384)
    expect(meter.gate(5)).toBe("open")
    expect(meter.verdict(10692).allowed).toBe(true)
    expect(meter.snapshot().tripped).toBe(false)
  })

  test("TB-1 invariant: whenever the gate reopens after grantGrace, a verdict of peakRequest is admitted", () => {
    let checked = 0
    for (const [cap, estimate, effective, calls] of [[100000, 10692, 3000, 30], [50000, 9000, 9000, 5], [300000, 44000, 12000, 22], [64000, 12000, 1200, 44]] as const) {
      const meter = new TurnSpendMeter(cap)
      for (let i = 0; i < calls; i++) expect(cloudCall(meter, estimate, effective)).toBe(true)
      expect(meter.gate(2)).toBe("exhausted")
      const granted = meter.grantGrace(2)
      if (granted > 0 && meter.gate(2) === "open") {
        checked += 1
        const { peakRequest, tripped } = meter.snapshot()
        expect(tripped).toBe(false)
        expect(meter.verdict(peakRequest).allowed).toBe(true)
        expect(meter.snapshot().tripped).toBe(false)
      }
    }
    expect(checked).toBeGreaterThanOrEqual(3)
  })

  test("a grace too small to admit the peak request leaves the gate exhausted — the host then stops instead of running a doomed epoch", () => {
    // cap < 4 × 8192: ceil(cap/4) = 5000 is smaller than the agent output cap alone; two near-full calls.
    const meter = new TurnSpendMeter(20000)
    for (let i = 0; i < 2; i++) expect(cloudCall(meter, 2500 + 8192, 9000)).toBe(true)
    expect(meter.snapshot()).toMatchObject({ spent: 18000, peakRequest: 10692 })
    expect(meter.gate(2)).toBe("exhausted")
    expect(meter.grantGrace(2)).toBe(5000)
    // 18000 + 10692 = 28692 > 20000 + 5000 → still exhausted; the cli guard `granted > 0 && gate(epoch) === "open"` fails → honest stop.
    expect(meter.gate(2)).toBe("exhausted")
    expect(meter.snapshot().graceUsed).toBe(true)
    expect(meter.grantGrace(2)).toBe(0)
  })

  test("the predictor never drops below the largest charged call (an under-estimated request still counts)", () => {
    const meter = new TurnSpendMeter(7000)
    expect(cloudCall(meter, 1000, 4000)).toBe(true)
    expect(meter.snapshot()).toMatchObject({ peakRequest: 1000, peakCall: 4000 })
    // 4000 + max(1000, 4000) = 8000 > 7000.
    expect(meter.gate(2)).toBe("exhausted")
  })

  test("grace = min(ceil(cap/4), 2×peakRequest), lasts exactly one epoch, granted once", () => {
    const meter = new TurnSpendMeter(10000)
    cloudCall(meter, 4000, 4000)
    cloudCall(meter, 4000, 4000)
    expect(meter.gate(3)).toBe("exhausted")
    expect(meter.grantGrace(3)).toBe(2500)
    expect(meter.snapshot()).toMatchObject({ graceTokens: 2500, graceUsed: true, graceEpoch: 3 })
    // 8000 + 4000 = 12000 ≤ 10000 + 2500 → the grace epoch runs.
    expect(meter.gate(3)).toBe("open")
    // Inside the grace epoch the per-call check honours the grace too.
    expect(meter.verdict(4000).allowed).toBe(true)
    // Next epoch: the grace has lapsed and cannot be granted again.
    expect(meter.gate(4)).toBe("exhausted")
    expect(meter.grantGrace(4)).toBe(0)
    expect(meter.snapshot().graceUsed).toBe(true)
    expect(meter.snapshot().graceTokens).toBe(2500)
  })

  test("grace is bounded by 2×peakRequest when that is the smaller number", () => {
    const meter = new TurnSpendMeter(100000)
    cloudCall(meter, 3000, 3000)
    expect(meter.grantGrace(2)).toBe(6000)
  })

  test("a mid-epoch trip is sticky (tripped never resets) and a grace ≤ cap/4 cannot admit a call larger than cap/4 that already failed", () => {
    const meter = new TurnSpendMeter(5000)
    cloudCall(meter, 4000, 4000)
    expect(meter.verdict(4000).allowed).toBe(false)
    expect(meter.snapshot().tripped).toBe(true)
    expect(meter.gate(2)).toBe("exhausted")
    // 4000 + 4000 = 8000 > 5000 + min(ceil(5000/4) = 1250, 2×4000) — the same call does not fit a second time.
    expect(meter.grantGrace(2)).toBe(1250)
    expect(meter.verdict(4000).allowed).toBe(false)
    expect(meter.snapshot()).toMatchObject({ tripped: true, refusals: 2 })
    // A fitting call afterwards does not clear the trip: the host reads `tripped` and hands back.
    expect(meter.verdict(1).allowed).toBe(true)
    expect(meter.snapshot().tripped).toBe(true)
  })
})

describe("closeToDone — host evidence only", () => {
  test("truth table", () => {
    expect(closeToDone({ probePending: true, openSprints: 5, receipts: 3 })).toBe(true)
    expect(closeToDone({ probePending: false, openSprints: 1, receipts: 3 })).toBe(true)
    expect(closeToDone({ probePending: false, openSprints: 2, receipts: 3 })).toBe(false)
    expect(closeToDone({ probePending: false, openSprints: undefined, receipts: 3 })).toBe(false)
    expect(closeToDone({ probePending: false, openSprints: 0, receipts: 3 })).toBe(false)
    // Never grace a turn that ran nothing.
    expect(closeToDone({ probePending: true, openSprints: 1, receipts: 0 })).toBe(false)
  })
})

describe("renderTurnBudgetLine — the ⏱ line", () => {
  test("exact text without grace", () => {
    const s = { cap: 300000 as const, spent: 1433, calls: 1, peakCall: 1433, peakRequest: 4600, graceTokens: 0, graceUsed: false, tripped: false, refusals: 0 }
    expect(renderTurnBudgetLine(s, 2)).toBe("⏱ سقف الدور (حقبة 2): فعّال=1433/300000 · نداءات=1 · أكبر نداء=1433 · سماحة=—")
  })

  test("names the used grace and an invalid cap", () => {
    const meter = new TurnSpendMeter(10000)
    cloudCall(meter, 4000, 4000)
    meter.grantGrace(2)
    expect(renderTurnBudgetLine(meter.snapshot(), 2)).toBe("⏱ سقف الدور (حقبة 2): فعّال=4000/10000 · نداءات=1 · أكبر نداء=4000 · سماحة=2500 (مستعملة)")
    expect(renderTurnBudgetLine(new TurnSpendMeter("invalid").snapshot(), 1)).toContain("فعّال=0/غير صالح")
  })

  test("renderCap is the one Arabic rendering of the cap — the English literal never leaks", () => {
    expect(renderCap("invalid")).toBe("غير صالح")
    expect(renderCap(300000)).toBe("300000")
    expect(renderTurnBudgetLine(new TurnSpendMeter("invalid").snapshot(), 1)).not.toContain("invalid")
  })
})

describe("OFF paths — the hooks object is byte-identical to a meterless turn (owner rule 6)", () => {
  // Mirrors the three cli.ts lines pinned by token-economy-wiring.test: the meter exists only
  // when the toggle is on AND a cap is set; otherwise the spread contributes nothing.
  const buildHooks = (turnBudgetOn: boolean) => {
    const turnCap = turnBudgetOn ? turnTokenCap() : undefined
    const turnMeter = turnCap === undefined ? undefined : new TurnSpendMeter(turnCap)
    const signal = new AbortController().signal
    const onDelta = (_text: string) => {}
    const hooks = { signal, onDelta, ...(turnMeter === undefined ? {} : { turnMeter }) }
    return { hooks, legacy: { signal, onDelta }, turnMeter }
  }

  test("toggle ON without the env var: no meter, hooks identical to the legacy literal", () => {
    delete process.env[TURN_CAP_ENV]
    const { hooks, legacy, turnMeter } = buildHooks(true)
    expect(turnMeter).toBeUndefined()
    expect(Object.keys(hooks)).toEqual(Object.keys(legacy))
    expect(hooks).toEqual(legacy)
  })

  test("toggle OFF with a cap set: no meter either", () => {
    process.env[TURN_CAP_ENV] = "300000"
    const { hooks, legacy, turnMeter } = buildHooks(false)
    expect(turnMeter).toBeUndefined()
    expect(Object.keys(hooks)).toEqual(Object.keys(legacy))
    expect(hooks).toEqual(legacy)
  })

  test("toggle ON with a cap set: the meter rides inside hooks", () => {
    process.env[TURN_CAP_ENV] = "300000"
    const { hooks, turnMeter } = buildHooks(true)
    expect(turnMeter).toBeInstanceOf(TurnSpendMeter)
    expect(Object.keys(hooks)).toEqual(["signal", "onDelta", "turnMeter"])
  })
})
