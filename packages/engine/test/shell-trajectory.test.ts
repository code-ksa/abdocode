import { describe, expect, test } from "bun:test"
import { Trajectory } from "../src/shells/trajectory"

const tool = (turnId: string, cmd: string, epoch = 1, extra: Record<string, unknown> = {}) =>
  ({ kind: "tool", turnId, cmd, epoch, ...extra })
const result = (turnId: string, cmd: string, epoch = 1, extra: Record<string, unknown> = {}) =>
  ({ kind: "tool-result", turnId, cmd, epoch, output: "done", ...extra })
const event = (turnId: string, payload: string, seq = 1) => ({ kind: "event", turnId, seq, payload })

describe("shell trajectory reducer — one row per tool, event lines verbatim", () => {
  test("a tool and its result become ONE row carrying the verdict glyph, reason and duration", () => {
    let store = Trajectory.empty()
    store = Trajectory.fold(store, tool("t1", "run npm test"), 1_000)
    const midFlight = Trajectory.rows(store, "t1")!
    expect(midFlight.epochs[0]!.tools).toHaveLength(1)
    expect(midFlight.epochs[0]!.tools[0]).toMatchObject({ glyph: "·", duration: "—" })
    store = Trajectory.fold(store, result("t1", "run npm test", 1, { verdict: { ok: false, reason: "nonzero_exit", denied: false } }), 3_500)
    const row = Trajectory.rows(store, "t1")!.epochs[0]!.tools[0]!
    expect(row).toMatchObject({ cmd: "run npm test", glyph: "✕", reason: "nonzero_exit", denied: false, duration: "+2.5s" })
    expect(Trajectory.rows(store, "t1")!.epochs[0]!.tools).toHaveLength(1)
  })

  test("a policy refusal is marked as such, and an ok verdict reads ✓", () => {
    let store = Trajectory.fold(Trajectory.empty(), tool("t1", "write a.ts"), 0)
    store = Trajectory.fold(store, result("t1", "write a.ts", 1, { verdict: { ok: false, reason: "guard_refused", denied: true } }), 100)
    expect(Trajectory.rows(store, "t1")!.epochs[0]!.tools[0]).toMatchObject({ glyph: "✕", denied: true })
    let ok = Trajectory.fold(Trajectory.empty(), tool("t2", "read a.ts"), 0)
    ok = Trajectory.fold(ok, result("t2", "read a.ts", 1, { verdict: { ok: true } }), 100)
    expect(Trajectory.rows(ok, "t2")!.epochs[0]!.tools[0]).toMatchObject({ glyph: "✓", reason: "", denied: false })
  })

  test("the SAME cmd twice in one turn yields two rows, paired oldest-first (the feed overwrites; the lens does not)", () => {
    let store = Trajectory.empty()
    store = Trajectory.fold(store, tool("t1", "run npm test"), 0)
    store = Trajectory.fold(store, tool("t1", "run npm test"), 1_000)
    store = Trajectory.fold(store, result("t1", "run npm test", 1, { verdict: { ok: false, reason: "nonzero_exit", denied: false } }), 2_000)
    store = Trajectory.fold(store, result("t1", "run npm test", 1, { verdict: { ok: true } }), 4_000)
    const rows = Trajectory.rows(store, "t1")!.epochs[0]!.tools
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ glyph: "✕", duration: "+2.0s" })
    expect(rows[1]).toMatchObject({ glyph: "✓", duration: "+3.0s" })
  })

  test("event lines are classified BY PREFIX and stored verbatim — never recomputed", () => {
    const lines: readonly [string, string][] = [
      ["📐 أحكام الأدوات ح2: صريح=3/4 · مستنتَج=1", "coverage"],
      ["💳 السحابة: نداءات=2 · توكنز=1200", "cloud"],
      ["✓ نقطة حفظ الحقبة 2: أدوات=3 · السبب=done", "checkpoint"],
      ["📓 مرشّح كتيّب جديد (فشل مجهول تكرر 3×)", "miner"],
      ["🎯 نيّات الحقبة 2: مصرَّح=2 · غائب=0", "intent"],
      ["⏱ سقف الدور بلغ حدّه قبل الحقبة 3: فعّال=100", "turn-budget"],
      ["🚪 البوابة: أُجيب من حارة المحادثة", "gate"],
      ["⛔ جدار خارجي متكرر (3×)", "wall"],
      ["🔐 طلب موافقة [write] في نمط read-only: write a.ts", "approval-asked"],
      ["🔐 قرار الموافقة: سُمح — write a.ts", "approval-decided"],
      ["↻ حقبة 2 · run npm test", "epoch"],
      ["⚠ رد النموذج بلا أداة", "warning"],
      ["— المقيس: 3 أدوات", "meta"],
      ["جوابٌ عاديّ من النموذج", "other"],
    ]
    for (const [payload, kind] of lines) expect(Trajectory.classifyEvent(payload)).toBe(kind)
    let store = Trajectory.empty()
    let seq = 1
    for (const [payload] of lines) store = Trajectory.fold(store, event("t1", payload, seq++), 0)
    const stored = Trajectory.rows(store, "t1")!.epochs.flatMap((e) => e.gates).map((g) => g.text)
    for (const [payload] of lines) expect(stored).toContain(payload)
  })

  test("an event that names its own epoch lands there; one that does not follows the last epoch seen", () => {
    let store = Trajectory.fold(Trajectory.empty(), tool("t1", "run a", 2), 0)
    store = Trajectory.fold(store, event("t1", "📐 أحكام الأدوات ح2: —"), 0)
    store = Trajectory.fold(store, event("t1", "💳 السحابة: نداءات=1"), 0)
    store = Trajectory.fold(store, event("t1", "✓ نقطة حفظ الحقبة 5: أدوات=0"), 0)
    const byEpoch = Object.fromEntries(Trajectory.rows(store, "t1")!.epochs.map((e) => [e.epoch, e.gates.length]))
    expect(byEpoch[2]).toBe(2)
    expect(byEpoch[5]).toBe(1)
    expect(Trajectory.epochOfEvent("↻ حقبة 7 · run x")).toBe(7)
    expect(Trajectory.epochOfEvent("جوابٌ بلا حقبة")).toBeUndefined()
  })

  test("rails set the turn header, model-route names the lane, and done/interrupted set the outcome", () => {
    let store = Trajectory.begin(Trajectory.empty(), "t1", "ابنِ الموقع")
    store = Trajectory.fold(store, { kind: "rails", turnId: "t1", tier: "thin", reason: "نموذج قويّ" }, 0)
    store = Trajectory.fold(store, { kind: "model-route", turnId: "t1", lane: "agent", ref: "ollama/empero" }, 0)
    expect(Trajectory.rows(store, "t1")).toMatchObject({
      body: "ابنِ الموقع", rails: { tier: "thin", reason: "نموذج قويّ" }, route: { lane: "agent", ref: "ollama/empero" },
    })
    expect(Trajectory.rows(Trajectory.fold(store, { kind: "done", turnId: "t1", outcome: "checkpointed" }, 0), "t1")!.outcome).toBe("checkpointed")
    expect(Trajectory.rows(Trajectory.fold(store, { kind: "done", turnId: "t1", outcome: "completed" }, 0), "t1")!.outcome).toBe("completed")
    expect(Trajectory.rows(Trajectory.fold(store, { kind: "interrupted", turnId: "t1" }, 0), "t1")!.outcome).toBe("interrupted")
    expect(Trajectory.rows(Trajectory.fold(store, { kind: "unresolved", turnId: "t1", why: "x" }, 0), "t1")!.outcome).toBe("unresolved")
    expect(Trajectory.rows(Trajectory.fold(store, { kind: "refused", turnId: "t1", why: "Provider unavailable" }, 0), "t1")!.outcome).toBe("failed")
    // ومقاطعةٌ سبقت التمام تبقى الخاتمة: `done` يصل بعد `interrupted` دائماً.
    const cut = Trajectory.fold(Trajectory.fold(store, { kind: "interrupted", turnId: "t1" }, 0), { kind: "done", turnId: "t1", outcome: "checkpointed" }, 0)
    expect(Trajectory.rows(cut, "t1")!.outcome).toBe("interrupted")
  })

  test("A REPLAYED TURN IS FLAGGED: events with no tool frames say so instead of implying zero tools ran", () => {
    const replay = Trajectory.fold(Trajectory.empty(), event("old", "📐 أحكام الأدوات ح1: صريح=4/4"), 0)
    const view = Trajectory.rows(replay, "old")!
    expect(view.eventsOnly).toBe(true)
    expect(view.epochs.flatMap((e) => e.tools)).toHaveLength(0)
    // ودورٌ فيه أداةٌ واحدة ليس إعادةً — ولو حمل عشرين حدثاً.
    let live = Trajectory.fold(Trajectory.empty(), tool("t1", "read a"), 0)
    for (let i = 0; i < 20; i++) live = Trajectory.fold(live, event("t1", `↻ حقبة 1 · ${i}`, i + 1), 0)
    expect(Trajectory.rows(live, "t1")!.eventsOnly).toBe(false)
    // ودورٌ لم يصله شيء بعد ليس «إعادةً» أيضاً.
    expect(Trajectory.rows(Trajectory.begin(Trajectory.empty(), "t9", "س"), "t9")!.eventsOnly).toBe(false)
  })

  test("the store evicts the oldest turn beyond its cap, and keeps arrival order for the picker", () => {
    let store = Trajectory.empty(3)
    for (const id of ["a", "b", "c", "d"]) store = Trajectory.fold(store, tool(id, "read x"), 0)
    expect(Trajectory.turns(store)).toEqual(["d", "c", "b"])
    expect(Trajectory.rows(store, "a")).toBeUndefined()
    expect(Trajectory.rows(store, "d")).toBeDefined()
    // إعادةُ لمس دورٍ قائم لا تكرّره في الترتيب.
    store = Trajectory.fold(store, tool("c", "read y"), 0)
    expect(Trajectory.turns(store)).toEqual(["d", "c", "b"])
  })

  test("a result with no preceding tool frame still becomes a row (a reconnect mid-turn is not a hole) — but its duration is «—», never a fabricated +0.0s", () => {
    const store = Trajectory.fold(Trajectory.empty(), result("t1", "run x", 1, { verdict: { ok: true } }), 5_000)
    const rows = Trajectory.rows(store, "t1")!.epochs[0]!.tools
    expect(rows).toHaveLength(1)
    // بدايةٌ لم تُشهد لا تُخترع: بناءٌ استغرق أربعين ثانيةً كان يُعرض «+0.0s».
    expect(rows[0]).toMatchObject({ glyph: "✓", duration: "—" })
    // والزوجُ الكامل يبقى مقيساً كما كان — «—» للمجهول لا للمعلوم.
    let paired = Trajectory.fold(Trajectory.empty(), tool("t2", "run bun test"), 1_000)
    paired = Trajectory.fold(paired, result("t2", "run bun test", 1, { verdict: { ok: true } }), 41_000)
    expect(Trajectory.rows(paired, "t2")!.epochs[0]!.tools[0]).toMatchObject({ duration: "+40.0s" })
  })

  // العدسة تناقض نفسها في الموضع الذي وُعدت فيه بألّا توهم: الرايةُ كانت
  // من عدّ أُطر `tool`، ونتيجةٌ يتيمة تبني صفّاً بلا إطار — فتُعلَّق لافتة
  // «أحداثٌ فقط، خلوُّ الصفوف ليس دليلاً» فوق صفوفٍ غيرِ خالية.
  test("a turn whose rows came from ORPHAN results is not labelled «events only» — the flag follows the rendered rows", () => {
    let store = Trajectory.fold(Trajectory.empty(), event("t1", "📐 أحكام الأدوات ح1: 3/3"), 0)
    store = Trajectory.fold(store, result("t1", "run bun test", 1, { verdict: { ok: true } }), 1_000)
    const view = Trajectory.rows(store, "t1")!
    expect(view.epochs.flatMap((e) => e.tools).map((t) => t.cmd)).toEqual(["run bun test"])
    expect(view.eventsOnly).toBe(false)
    // وإعادةٌ حقيقيّة (أحداثٌ ولا صفَّ واحد) تبقى مُعلَنة.
    const replay = Trajectory.fold(Trajectory.empty(), event("t2", "📐 أحكام الأدوات ح1: 3/3"), 0)
    expect(Trajectory.rows(replay, "t2")!.eventsOnly).toBe(true)
  })

  test("frames without a turn id, and unknown kinds, leave the store identical", () => {
    const store = Trajectory.fold(Trajectory.empty(), tool("t1", "read a"), 0)
    expect(Trajectory.fold(store, { kind: "tool", cmd: "read b" }, 0)).toBe(store)
    expect(Trajectory.fold(store, { kind: "vault-status", turnId: "t1" }, 0)).toBe(store)
    expect(Trajectory.begin(store, "", "س")).toBe(store)
  })
})
