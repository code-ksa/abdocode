/**
 * CL-03 gate: atomic reservation before any side effect, state rebuilt from
 * events, fail-closed on deny/expiry/revocation, and no wildcard binding.
 */
import { describe, expect, test } from "bun:test"
import { MemoryEventStore } from "@abdo/event-store"
import { CONTROL_CONTRACT_VERSION, type ControlRequest } from "@abdo/control-contracts"
import { GrantEvents, GrantLedger, OPERATION_HASH_VERSION, operationHash, type GrantSpec } from "../src/index"

const request = (over: Partial<ControlRequest> = {}): ControlRequest => ({
  version: CONTROL_CONTRACT_VERSION,
  sessionId: "ses_1",
  runId: "run_1",
  attemptId: 1,
  requestId: "req_1",
  toolExecutionId: "tex_1",
  actor: { agent: "abdo", model: "m", provider: "p" },
  tool: "shell",
  capability: "package.install",
  target: { kind: "workspace", workspace: "/w", scope: "packages/api" },
  normalizedOperation: { kind: "shell", summary: "npm install", certainty: "uncertain" },
  risk: { level: "high", dangerous: false, certainty: "classified" },
  argsHash: "args_1",
  secretRefs: [],
  provenance: ["model_tool_call"],
  ...over,
})

const spec = (req: ControlRequest, over: Partial<GrantSpec> = {}): GrantSpec => ({
  sessionId: req.sessionId,
  capability: req.capability,
  target: "workspace:/w#packages/api",
  operationHash: operationHash(req),
  scope: { kind: "once" },
  reason: "user asked to reinstall anyway",
  grantedBy: "human:cli",
  ...over,
})

describe("CL-03 durable grants", () => {
  test("a grant is reserved once, and the second attempt finds nothing", async () => {
    const store = new MemoryEventStore()
    const ledger = new GrantLedger(store)
    const req = request()
    const id = await ledger.issue(spec(req))

    expect((await ledger.reserve(req, [id])).reserved).toBe(true)
    const second = await ledger.reserve(req, [id])
    expect(second.reserved).toBe(false)
    expect(second.reason).toBe("no_matching_active_grant")
    expect((await ledger.state(id))!.status).toBe("exhausted")
  })

  test("ATOMIC: concurrent reservations of one use — exactly one wins", async () => {
    const store = new MemoryEventStore()
    const ledger = new GrantLedger(store)
    const req = request()
    const id = await ledger.issue(spec(req))

    // Ten racers, one use. This is the property that a process-global flag
    // cannot provide and that a read-then-write check would get wrong.
    const results = await Promise.all(Array.from({ length: 10 }, () => ledger.reserve(req, [id])))
    expect(results.filter((r) => r.reserved)).toHaveLength(1)

    const consumed = (await store.read("grant", id)).filter((e) => e.type === GrantEvents.Consumed)
    expect(consumed).toHaveLength(1)
    expect((await ledger.state(id))!.usedCount).toBe(1)
  })

  test("ATOMIC with maxUses: exactly N of M racers win", async () => {
    const store = new MemoryEventStore()
    const ledger = new GrantLedger(store)
    const req = request()
    const id = await ledger.issue(spec(req, { scope: { kind: "session" }, maxUses: 3 }))

    const results = await Promise.all(Array.from({ length: 12 }, () => ledger.reserve(req, [id])))
    expect(results.filter((r) => r.reserved)).toHaveLength(3)
    expect((await ledger.state(id))!.usedCount).toBe(3)
    expect((await ledger.state(id))!.status).toBe("exhausted")
  })

  test("the cap can NEVER be exceeded under concurrency (use index == sequence)", async () => {
    // A tail-derived sequence let racers that all saw usedCount=2 take a third
    // AND a fourth use: the store serialised the writes but could not see the
    // cap. Binding use N to sequence N makes capacity and concurrency one fact.
    for (const maxUses of [1, 2, 3, 5]) {
      const store = new MemoryEventStore()
      const ledger = new GrantLedger(store)
      const req = request()
      const id = await ledger.issue(spec(req, { scope: { kind: "session" }, maxUses }))
      const results = await Promise.all(Array.from({ length: 20 }, () => ledger.reserve(req, [id])))
      expect(results.filter((r) => r.reserved)).toHaveLength(maxUses)
      expect((await ledger.state(id))!.usedCount).toBe(maxUses)
      expect((await store.read("grant", id)).filter((e) => e.type === GrantEvents.Consumed)).toHaveLength(maxUses)
    }
  })

  test("RESTART: state is rebuilt from events, not from process memory", async () => {
    const store = new MemoryEventStore()
    const req = request()
    const first = new GrantLedger(store)
    const id = await first.issue(spec(req, { scope: { kind: "session" }, maxUses: 2 }))
    await first.reserve(req, [id])

    // A brand-new ledger — as after a restart, or in a second process.
    const afterRestart = new GrantLedger(store)
    const state = await afterRestart.state(id)
    expect(state!.usedCount).toBe(1)
    expect(state!.status).toBe("active")
    expect((await afterRestart.reserve(req, [id])).reserved).toBe(true)
    expect((await afterRestart.reserve(req, [id])).reserved).toBe(false) // exhausted, durably
  })

  test("REVOKED is fail-closed, and the reason survives", async () => {
    const store = new MemoryEventStore()
    const ledger = new GrantLedger(store)
    const req = request()
    const id = await ledger.issue(spec(req, { scope: { kind: "session" }, maxUses: 5 }))
    await ledger.revoke(id, "user changed their mind")

    expect((await ledger.reserve(req, [id])).reserved).toBe(false)
    const state = await ledger.state(id)
    expect(state!.status).toBe("revoked")
    expect(state!.revokedReason).toBe("user changed their mind")
  })

  test("EXPIRED is fail-closed, and the expiry is recorded once", async () => {
    const store = new MemoryEventStore()
    let now = 1_000
    const ledger = new GrantLedger(store, () => now)
    const req = request()
    const id = await ledger.issue(spec(req, { scope: { kind: "session" }, maxUses: 5, expiresAt: 2_000 }))

    expect((await ledger.reserve(req, [id])).reserved).toBe(true)
    now = 2_001
    expect((await ledger.reserve(req, [id])).reserved).toBe(false)
    expect((await ledger.state(id))!.status).toBe("expired")
    await ledger.reserve(req, [id]) // again
    const expiries = (await store.read("grant", id)).filter((e) => e.type === GrantEvents.Expired)
    expect(expiries).toHaveLength(1) // recorded once, not on every attempt
  })

  test("NO WILDCARD: capability, target and operation must all match exactly", async () => {
    const store = new MemoryEventStore()
    const ledger = new GrantLedger(store)
    const req = request()
    const id = await ledger.issue(spec(req, { scope: { kind: "session" }, maxUses: 99 }))

    // different capability
    expect((await ledger.reserve(request({ capability: "code.execute" }), [id])).reserved).toBe(false)
    // different package root — the sibling-package case
    expect(
      (await ledger.reserve(request({ target: { kind: "workspace", workspace: "/w", scope: "packages/web" } }), [id])).reserved,
    ).toBe(false)
    // different arguments = a different operation
    expect((await ledger.reserve(request({ argsHash: "args_2" }), [id])).reserved).toBe(false)
    // different session
    expect((await ledger.reserve(request({ sessionId: "ses_2" }), [id])).reserved).toBe(false)
    // the exact request still works
    expect((await ledger.reserve(req, [id])).reserved).toBe(true)
  })

  test("SCOPE narrows, never widens: run- and execution-scoped grants do not leak", async () => {
    const store = new MemoryEventStore()
    const ledger = new GrantLedger(store)
    const req = request()
    const runScoped = await ledger.issue(spec(req, { scope: { kind: "run", runId: "run_1" }, maxUses: 99 }))
    expect((await ledger.reserve(request({ runId: "run_2" }), [runScoped])).reserved).toBe(false)
    expect((await ledger.reserve(req, [runScoped])).reserved).toBe(true)

    const execScoped = await ledger.issue(spec(req, { scope: { kind: "tool_execution", toolExecutionId: "tex_1" }, maxUses: 99 }))
    expect((await ledger.reserve(request({ toolExecutionId: "tex_2" }), [execScoped])).reserved).toBe(false)
    expect((await ledger.reserve(req, [execScoped])).reserved).toBe(true)
  })

  test("a denial creates NO grant — a refusal is not a weak approval", async () => {
    const store = new MemoryEventStore()
    const ledger = new GrantLedger(store)
    await ledger.requested("ses_1", { capability: "package.install", target: "workspace:/w", operationHash: "op" }, "apr_1")
    await ledger.denied("ses_1", "apr_1", "human said no")

    const events = await store.read("session", "ses_1")
    expect(events.map((e) => e.type)).toEqual([GrantEvents.Requested, GrantEvents.Denied])
    expect(await ledger.listForSession("ses_1")).toEqual([])
  })

  test("a grant hashed by a DIFFERENT normalizer generation is inapplicable (fail closed)", async () => {
    // CL-04 changes how operations are normalized. An old grant must not be
    // silently reinterpreted under the new function.
    const store = new MemoryEventStore()
    const ledger = new GrantLedger(store)
    const req = request()
    const old = await ledger.issue(spec(req, { scope: { kind: "session" }, maxUses: 9, operationHashVersion: 0 }))
    expect((await ledger.reserve(req, [old])).reserved).toBe(false)

    // ...while a grant issued under the CURRENT version still works.
    const current = await ledger.issue(spec(req, { scope: { kind: "session" }, maxUses: 9 }))
    expect((await ledger.state(current))!.operationHashVersion).toBe(OPERATION_HASH_VERSION)
    expect((await ledger.reserve(req, [current])).reserved).toBe(true)
  })

  test("INVARIANT: every consumed event sits at the sequence equal to its use index", async () => {
    // This is what makes the capacity check and the concurrency token one fact.
    // If a future non-terminal event ever interleaves, this breaks loudly here.
    const store = new MemoryEventStore()
    const ledger = new GrantLedger(store)
    const req = request()
    const id = await ledger.issue(spec(req, { scope: { kind: "session" }, maxUses: 4 }))
    await Promise.all(Array.from({ length: 10 }, () => ledger.reserve(req, [id])))

    const events = await store.read("grant", id)
    expect(events[0]!.type).toBe(GrantEvents.Granted) // sequence 0
    for (const e of events.filter((x) => x.type === GrantEvents.Consumed)) {
      expect(Number(e.sequence)).toBe(Number((e.data as { useIndex: number }).useIndex))
    }
  })

  test("partial consumption then a CONCURRENT revoke: cap held, nothing consumed after revocation", async () => {
    const store = new MemoryEventStore()
    const ledger = new GrantLedger(store)
    const req = request()
    const id = await ledger.issue(spec(req, { scope: { kind: "session" }, maxUses: 8 }))
    await ledger.reserve(req, [id]) // partial: one use spent

    // A revoke racing against six more reservations.
    const results = await Promise.all([
      ...Array.from({ length: 6 }, () => ledger.reserve(req, [id])),
      ledger.revoke(id, "revoked mid-flight").then(() => ({ reserved: false }) as const),
    ])
    const state = (await ledger.state(id))!
    expect(state.status).toBe("revoked")

    const events = await store.read("grant", id)
    const revokeSeq = Number(events.find((e) => e.type === GrantEvents.Revoked)!.sequence)
    const consumedSeqs = events.filter((e) => e.type === GrantEvents.Consumed).map((e) => Number(e.sequence))
    // No use was taken after the revocation landed.
    expect(consumedSeqs.every((seq) => seq < revokeSeq)).toBe(true)
    // The cap was never exceeded, and the ledger's count matches the log.
    expect(state.usedCount).toBeLessThanOrEqual(8)
    expect(state.usedCount).toBe(consumedSeqs.length)
    expect(results.filter((r) => r.reserved).length).toBe(consumedSeqs.length - 1) // minus the pre-race use
    // ...and nothing can be reserved afterwards.
    expect((await ledger.reserve(req, [id])).reserved).toBe(false)
  })

  test("partial consumption then EXPIRY under concurrency: fail closed, cap intact", async () => {
    const store = new MemoryEventStore()
    let now = 1_000
    const ledger = new GrantLedger(store, () => now)
    const req = request()
    const id = await ledger.issue(spec(req, { scope: { kind: "session" }, maxUses: 8, expiresAt: 2_000 }))
    await ledger.reserve(req, [id])
    await ledger.reserve(req, [id])

    now = 2_001 // expires between uses
    const results = await Promise.all(Array.from({ length: 6 }, () => ledger.reserve(req, [id])))
    expect(results.filter((r) => r.reserved)).toHaveLength(0)

    const state = (await ledger.state(id))!
    expect(state.status).toBe("expired")
    expect(state.usedCount).toBe(2) // exactly what was spent before expiry
    const events = await store.read("grant", id)
    expect(events.filter((e) => e.type === GrantEvents.Expired)).toHaveLength(1)
  })

  test("an unknown grant id reserves nothing (fail closed, no throw)", async () => {
    const ledger = new GrantLedger(new MemoryEventStore())
    expect((await ledger.reserve(request(), ["grant_does_not_exist"])).reserved).toBe(false)
  })
})
