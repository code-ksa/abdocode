/**
 * Runtime Completion Protocol (12I.6 fix 5) — the runtime, not the prompt,
 * owns completion: no final after mutations without objective verification,
 * no repeated verification without new mutations, read loops end in a
 * tool-free finalization turn, and a broken finalization closes degraded.
 */
import { describe, expect, test } from "bun:test"
import { unenforcedToolRunner } from "@abdo/control-contracts"
import { MemoryEventStore } from "@abdo/event-store"
import { EventTypes, SessionRuntime, type CompletionPolicy, type ModelClient, type ModelInput, type ModelTurn } from "../src/index"

const okTools = unenforcedToolRunner({ async run() { return { ok: true as const, output: "content" } } }, "test fake")

/** Scripted model: consumes `turns` in order; `onFinalize` answers finalize-phase calls. */
function scriptedModel(turns: ModelTurn[], onFinalize?: () => ModelTurn | Error): ModelClient & { phases: (string | undefined)[] } {
  let i = 0
  const client = {
    phases: [] as (string | undefined)[],
    async call(input: ModelInput): Promise<ModelTurn> {
      client.phases.push(input.phase)
      if (input.phase === "finalize" && onFinalize) {
        const r = onFinalize()
        if (r instanceof Error) throw r
        return r
      }
      const t = turns[Math.min(i, turns.length - 1)]!
      i++
      return t
    },
  }
  return client
}

const edit = (path: string): ModelTurn => ({ kind: "tools", calls: [{ id: "c", name: "edit_file", input: { path } }] })
const read = (path: string): ModelTurn => ({ kind: "tools", calls: [{ id: "c", name: "read_file", input: { path } }] })
const final = (text: string): ModelTurn => ({ kind: "final", text })

function policy(verifyImpl: () => Promise<{ ok: boolean; detail?: string }>, extra: Partial<CompletionPolicy> = {}): CompletionPolicy {
  return {
    isMutating: (tool) => tool !== "read_file",
    verify: verifyImpl,
    maxNoProgressTurns: 3,
    maxVerificationAttempts: 3,
    ...extra,
  }
}

const typesOf = async (store: MemoryEventStore, ses: string) => (await store.read("session", ses)).map((e) => e.type)

describe("runtime completion protocol", () => {
  test("T1 read loop: edit, then endless identical reads -> verify once, tool-free finalization, completed (reads bounded)", async () => {
    const store = new MemoryEventStore()
    let verifies = 0
    // edit once, then the model would read the same file forever
    const model = scriptedModel([edit("a.ts"), read("a.ts"), read("a.ts"), read("a.ts"), read("a.ts"), read("a.ts"), read("a.ts")], () => final("closed properly"))
    const runtime = new SessionRuntime({ store, model, tools: okTools, completion: policy(async () => (verifies++, { ok: true })) })
    await runtime.admit("ses_loop", "do the task")
    const r = await runtime.run("ses_loop")

    expect(r.state).toBe("completed")
    expect(r.reason).toBe("completed")
    expect(r.text).toBe("closed properly")
    expect(verifies).toBe(1) // one mutation epoch -> exactly one verification
    const types = await typesOf(store, "ses_loop")
    expect(types).toContain(EventTypes.FinalizationRequested)
    expect(types).toContain(EventTypes.VerificationPassed)
    /**
     * The bound TIGHTENED on 2026-08-20, and the assertion moved with it.
     *
     * This used to require `run.no_progress_detected`, because that was the
     * route by which the read loop got stopped: three wasted turns, then a
     * forced verification, then finalization. The runtime now checks once the
     * epoch's work has landed and the model spends a turn changing nothing, so
     * the loop ends after ONE read instead of four and the no-progress path is
     * never entered here.
     *
     * The assertion was for the MECHANISM; every property in this test's own
     * name — verify once, tool-free finalization, completed, reads bounded —
     * holds more strongly than before. So the bound is now 1, which would fail
     * against the old behaviour, rather than 4, which passes against both.
     */
    const reads = (await store.read("session", "ses_loop")).filter((e) => e.type === EventTypes.ToolExecuted && (e.data as { tool?: string }).tool === "read_file")
    expect(reads.length).toBeLessThanOrEqual(1)
    expect(model.phases).toContain("finalize")
  })

  test("T2 early final after edit is intercepted: verify fails -> feedback turn -> fix -> verify passes -> completed", async () => {
    const store = new MemoryEventStore()
    const results = [{ ok: false, detail: "typecheck failed: TS2363" }, { ok: true }]
    let verifies = 0
    // model: edit, premature final, (gets feedback) fix edit, final again
    const model = scriptedModel([edit("broken.ts"), final("done (wrong)"), edit("broken.ts"), final("done (fixed)")])
    const runtime = new SessionRuntime({ store, model, tools: okTools, completion: policy(async () => results[verifies++] ?? { ok: true }) })
    await runtime.admit("ses_early", "fix the bug")
    const r = await runtime.run("ses_early")

    expect(r.state).toBe("completed")
    expect(r.text).toBe("done (fixed)")
    expect(verifies).toBe(2)
    const events = await store.read("session", "ses_early")
    const types = events.map((e) => e.type)
    expect(types).toContain(EventTypes.VerificationFailed)
    expect(types).toContain(EventTypes.VerificationPassed)
    // the failure was fed back as a user message the model can see
    const feedback = events.find((e) => e.type === EventTypes.MessageAppended && (e.data as { role?: string }).role === "user")
    expect(String((feedback?.data as { text?: string })?.text)).toContain("TS2363")
    // two mutation epochs: the fix after a failed verification opens epoch 2
    const epochs = events.filter((e) => e.type === EventTypes.MutationEpochStarted).map((e) => (e.data as { epoch: number }).epoch)
    expect(epochs).toEqual([1, 2])
  })

  test("T3 verify fail -> fix -> pass yields mutationEpoch=2 verified (verifiedEpoch follows)", async () => {
    const store = new MemoryEventStore()
    const results = [{ ok: false, detail: "still broken" }, { ok: true }]
    let verifies = 0
    const model = scriptedModel([edit("f.ts"), final("v1"), edit("f.ts"), final("v2")])
    const runtime = new SessionRuntime({ store, model, tools: okTools, completion: policy(async () => results[verifies++] ?? { ok: true }) })
    await runtime.admit("ses_epoch", "task")
    const r = await runtime.run("ses_epoch")
    expect(r.state).toBe("completed")
    const events = await store.read("session", "ses_epoch")
    const passed = events.filter((e) => e.type === EventTypes.VerificationPassed).map((e) => (e.data as { epoch: number }).epoch)
    expect(passed).toEqual([2]) // the pass belongs to the SECOND epoch
  })

  test("T4 read-only task: the verifier IS consulted, and a policy with nothing to check says so", async () => {
    // CHANGED 2026-08-19 after a live run, and the reason matters more than the
    // assertion. This test used to require that a run which mutated nothing was
    // NEVER verified. A live run then read eight files, said "done", and was
    // reported `completed` — while the acceptance criteria, checked
    // independently a second later, said the file it was asked to create had
    // never been created. A RUN COULD COMPLETE BY DOING NOTHING.
    //
    // The old expectation put the decision in the wrong place. Whether there is
    // anything to verify is the POLICY's question, not the runtime's: a policy
    // with nothing applicable answers `ran: false`, which is recorded as
    // "never objectively verified" rather than as a pass. So read-only work is
    // still not punished — it is simply no longer able to claim it finished
    // work it never did.
    const store = new MemoryEventStore()
    let verifies = 0
    const model = scriptedModel([read("doc.ts"), final("the answer")])
    const runtime = new SessionRuntime({ store, model, tools: okTools, completion: policy(async () => (verifies++, { ok: true, ran: false })) })
    await runtime.admit("ses_qa", "what does this do?")
    const r = await runtime.run("ses_qa")
    expect(r.state).toBe("completed")
    expect(r.text).toBe("the answer")
    // consulted exactly once, and its answer — not the runtime's assumption —
    // is what let the final through
    expect(verifies).toBe(1)
  })

  test("T4b a run that was asked to CHANGE something and changed nothing cannot report completed", async () => {
    // the live failure, as a test. The verifier says the objective is unmet;
    // the run must not be allowed to call that done however confidently the
    // model phrased its final answer.
    const store = new MemoryEventStore()
    const model = scriptedModel([read("doc.ts"), final("Done! I have created the dashboard.")])
    const runtime = new SessionRuntime({
      store,
      model,
      tools: okTools,
      completion: policy(async () => ({ ok: false, ran: true, detail: "admin/dashboard.html was never created" })),
    })
    await runtime.admit("ses_lie", "create admin/dashboard.html")
    const r = await runtime.run("ses_lie")
    expect(r.state).not.toBe("completed")
  })

  test("T5 several edits before concluding = ONE mutation epoch = ONE verification", async () => {
    const store = new MemoryEventStore()
    let verifies = 0
    const threeEdits: ModelTurn = {
      kind: "tools",
      calls: [
        { id: "c1", name: "edit_file", input: { path: "a.ts" } },
        { id: "c2", name: "edit_file", input: { path: "b.ts" } },
        { id: "c3", name: "edit_file", input: { path: "c.ts" } },
      ],
    }
    const model = scriptedModel([threeEdits, final("all three edited")])
    const runtime = new SessionRuntime({ store, model, tools: okTools, completion: policy(async () => (verifies++, { ok: true })) })
    await runtime.admit("ses_multi", "edit three files")
    const r = await runtime.run("ses_multi")
    expect(r.state).toBe("completed")
    expect(verifies).toBe(1)
    const epochs = (await store.read("session", "ses_multi")).filter((e) => e.type === EventTypes.MutationEpochStarted)
    expect(epochs).toHaveLength(1)
  })

  test("T6 finalization stream breaks after verification -> completed_degraded, never normal completion", async () => {
    const store = new MemoryEventStore()
    const model = scriptedModel(
      [edit("x.ts"), read("x.ts"), read("x.ts"), read("x.ts"), read("x.ts"), read("x.ts")],
      () => Object.assign(new Error("provider 400: bad request"), { status: 400 }), // non-retryable
    )
    const runtime = new SessionRuntime({ store, model, tools: okTools, completion: policy(async () => ({ ok: true })) })
    await runtime.admit("ses_degraded", "task")
    const r = await runtime.run("ses_degraded")

    expect(r.state).toBe("completed")
    expect(r.reason).toBe("completed_degraded") // separate, honest state
    const done = (await store.read("session", "ses_degraded")).find((e) => e.type === EventTypes.RunCompleted)
    expect((done?.data as { degraded?: boolean }).degraded).toBe(true)
    expect((done?.data as { reason?: string }).reason).toBe("completed_degraded")
  })

  test("T2b verification exhaustion: re-finalizing WITHOUT new mutations ends as verification_exhausted", async () => {
    const store = new MemoryEventStore()
    // model edits once then keeps re-finalizing with no fix; verifier always fails
    const model = scriptedModel([edit("bad.ts"), final("a"), final("b"), final("c"), final("d")])
    const runtime = new SessionRuntime({ store, model, tools: okTools, completion: policy(async () => ({ ok: false, detail: "always broken" })) })
    await runtime.admit("ses_exhaust", "task")
    const r = await runtime.run("ses_exhaust")
    expect(r.state).toBe("failed")
    expect(r.reason).toBe("verification_exhausted")
  })

  test("T7 no objective verifier applies: run completes but records UNAVAILABLE, never a pass", async () => {
    const store = new MemoryEventStore()
    const model = scriptedModel([edit("a.ts"), final("done")])
    const runtime = new SessionRuntime({
      store,
      model,
      tools: okTools,
      completion: policy(async () => ({ ok: true, ran: false, detail: "no objective verifier applies" })),
    })
    await runtime.admit("ses_unav", "task")
    const r = await runtime.run("ses_unav")

    expect(r.state).toBe("completed")
    const events = await store.read("session", "ses_unav")
    const types = events.map((e) => e.type)
    expect(types).toContain(EventTypes.VerificationUnavailable)
    expect(types).not.toContain(EventTypes.VerificationPassed) // unavailable !== passed
    // the terminal event itself must carry the honest status
    const done = events.find((e) => e.type === EventTypes.RunCompleted)
    expect((done?.data as { verification?: string }).verification).toBe("unavailable")
  })

  test("T7b applicable verifier: terminal completed event carries verification:'passed'", async () => {
    const store = new MemoryEventStore()
    const model = scriptedModel([edit("a.ts"), final("done")])
    const runtime = new SessionRuntime({ store, model, tools: okTools, completion: policy(async () => ({ ok: true, detail: "typecheck passed" })) })
    await runtime.admit("ses_pass", "task")
    await runtime.run("ses_pass")
    const done = (await store.read("session", "ses_pass")).find((e) => e.type === EventTypes.RunCompleted)
    expect((done?.data as { verification?: string }).verification).toBe("passed")
  })

  test("T8 a guarded rollback is DURABLY visible: started before, terminal after, receipt on tool.executed", async () => {
    const store = new MemoryEventStore()
    // Tool runner mimicking @abdo/tools: a partial failure whose own mutation
    // started -> it rolls back and reports; the runtime must log all of it.
    const receipt = {
      executionId: "tex_ignored",
      path: "f.ts",
      beforeHash: "aaa",
      mutationStarted: true,
      mutationCommitted: false,
    }
    const tools = unenforcedToolRunner({
      async run(
        _call: unknown,
        opts?: { executionId?: string; onRollbackStart?: (r: typeof receipt) => Promise<void> | void },
      ) {
        const own = { ...receipt, executionId: opts?.executionId ?? receipt.executionId }
        await opts?.onRollbackStart?.(own)
        return {
          ok: false as const,
          error: "write began then failed",
          mutation: own,
          rollback: { status: "completed" as const, reason: "tool_failed_after_mutation_started", receipt: own },
        }
      },
    }, "test fake")
    const model = scriptedModel([edit("f.ts"), final("gave up")])
    const runtime = new SessionRuntime({ store, model, tools, completion: policy(async () => ({ ok: true })) })
    await runtime.admit("ses_rb", "task")
    await runtime.run("ses_rb")

    const events = await store.read("session", "ses_rb")
    const types = events.map((e) => e.type)
    const iStarted = types.indexOf(EventTypes.ToolRollbackStarted)
    const iExec = types.indexOf(EventTypes.ToolExecuted)
    const iDone = types.indexOf(EventTypes.ToolRollbackCompleted)
    expect(iStarted).toBeGreaterThan(-1)
    expect(iDone).toBeGreaterThan(-1)
    expect(iStarted).toBeLessThan(iExec) // logged BEFORE the disk was touched
    expect(iDone).toBeGreaterThan(iExec)
    const exec = events[iExec]!.data as { mutation?: { mutationStarted: boolean; executionId: string } }
    expect(exec.mutation?.mutationStarted).toBe(true) // the receipt is in the durable record
    const done = events[iDone]!.data as { restoredHash?: string; reason?: string }
    expect(done.restoredHash).toBe("aaa")
    expect(done.reason).toBe("tool_failed_after_mutation_started")
  })

  test("T9 crash after verification UNAVAILABLE: resume finalizes without re-running tools or the verifier", async () => {
    // A run died AFTER run.verification_unavailable but BEFORE its terminal
    // event. The resume replay must rebuild verifiedEpoch from UNAVAILABLE
    // (unblocking completion) while keeping the honest status — and it must
    // never re-run the verifier or any tool.
    const store = new MemoryEventStore()
    const ses = "ses_resume_unav"
    const runId = "run_crashed_unav"
    const seed = async (type: string, data: Record<string, unknown>) => {
      await store.append({ aggregateKind: "session", aggregateId: ses, type, data: { runId, ...data } })
    }
    await seed(EventTypes.MutationEpochStarted, { epoch: 1 })
    await seed(EventTypes.VerificationUnavailable, { epoch: 1, detail: "no objective verifier applies" })
    // ...process dies here (no terminal event)...

    let verifies = 0
    let toolRuns = 0
    const tools = unenforcedToolRunner({ async run() { toolRuns++; return { ok: true as const, output: "x" } } }, "test fake")
    const model = scriptedModel([final("closing after crash")])
    const runtime = new SessionRuntime({
      store,
      model,
      tools,
      completion: policy(async () => (verifies++, { ok: true, ran: false })),
    })
    const r = await runtime.continueRun(ses, { runId, attempt: 2, fromState: "executing_tool", fromTurn: 2 })

    expect(r.state).toBe("completed")
    // CHANGED 2026-08-19: the verifier IS re-run after a resume. The old
    // expectation reused a verification taken before the process died, and a
    // process that died is exactly the case where the world may have moved
    // underneath it (Sprint 95's whole subject). One cheap check on resume
    // beats trusting a result from before the crash.
    expect(verifies).toBe(1)
    expect(toolRuns).toBe(0) // no tool re-execution on resume
    const done = (await store.read("session", ses)).filter((e) => e.type === EventTypes.RunCompleted).at(-1)
    expect((done?.data as { verification?: string }).verification).toBe("unavailable")
  })
})

// ── Repeated-identical-failure blocking (long-0 `npx jest` ×6 loop, 2026-07-23) ──
// A general Tool-Runtime guard (not a jest/long-0 special case): a call that
// already FAILED TWICE with the IDENTICAL result in the current epoch is refused
// WITHOUT spawning a process; the model gets a structured error and no-progress
// drives finalization, never a hard tool_failed spiral.
import { createHash } from "crypto"

const shellCall = (command: string): ModelTurn => ({ kind: "tools", calls: [{ id: "c", name: "shell", input: { command } }] })
const editCall = (path: string): ModelTurn => ({ kind: "tools", calls: [{ id: "c", name: "edit_file", input: { path } }] })
// Mirrors the runtime's hashArgs for a single-key object (canonicalize = identity here).
const argHash = (input: unknown): string => createHash("sha256").update(JSON.stringify(input)).digest("hex")

interface ToolOutcomeShape { ok: boolean; output?: unknown; error?: string; resultFingerprint?: string; mutation?: unknown }
function scriptedRunner(handler: (call: { name: string; input: unknown }, n: number) => ToolOutcomeShape) {
  const r = {
    invocations: 0,
    async run(call: { name: string; input: unknown }) {
      r.invocations++
      return handler(call, r.invocations) as never
    },
  }
  return unenforcedToolRunner(r, "test fake")
}
const blockedEvents = async (store: MemoryEventStore, ses: string) =>
  (await store.read("session", ses)).filter((e) => e.type === EventTypes.ToolRepeatedCallBlocked)

describe("repeated-identical-call blocking (fail-loop AND success-thrash)", () => {
  test("TEST 2/7: 2 identical FAILURES then the 3rd is BLOCKED with no additional process spawn", async () => {
    const store = new MemoryEventStore()
    const runner = scriptedRunner(() => ({ ok: false, error: "boom", output: { failureClass: "empty_failure_output" }, resultFingerprint: "FP1" }))
    const model = scriptedModel([shellCall("npx jest"), shellCall("npx jest"), shellCall("npx jest"), final("verifier unavailable — stated as a limitation")])
    const runtime = new SessionRuntime({ store, model, tools: runner, completion: policy(async () => ({ ok: true, ran: false }), { isMutating: () => false }) })
    await runtime.admit("ses_block", "run the tests")
    const r = await runtime.run("ses_block")

    expect(r.state).toBe("completed")
    expect(runner.invocations).toBe(2) // the 3rd identical call NEVER spawned a process
    const blocked = await blockedEvents(store, "ses_block")
    expect(blocked).toHaveLength(1)
    const d = blocked[0]!.data as { error: { code: string }; resultHash: string; tool: string; priorOutcome: string }
    expect(d.error.code).toBe("repeated_identical_tool_result")
    expect(d.priorOutcome).toBe("failed")
    expect(d.tool).toBe("shell")
    // no tool.started/tool.executed pair exists for the blocked call
    const execs = (await store.read("session", "ses_block")).filter((e) => e.type === EventTypes.ToolExecuted)
    expect(execs).toHaveLength(2)
  })

  test("TEST 2b: mutating shell SUCCESS ×2 (rm -rf && npm install thrash) then the 3rd is BLOCKED — real mutating case", async () => {
    const store = new MemoryEventStore()
    // The actual disease: a SUCCESSFUL, MUTATING shell command repeated with the
    // identical result. shell is `isMutating` here (as the real bench policy has
    // it), so the mutation EPOCH churns — but the ledger keys on workspace
    // GENERATION, which shell never bumps, so the block still fires on the 3rd.
    // Non-deterministic stdout is irrelevant: a success is compared coarsely.
    let n = 0
    const runner = scriptedRunner(() => ({ ok: true, output: { exitCode: 0 }, resultFingerprint: `npm-noise-${n++}` }))
    const cmd = "rm -rf node_modules && npm install"
    const model = scriptedModel([shellCall(cmd), shellCall(cmd), shellCall(cmd), final("stopped thrashing")])
    // THE VERIFIER FAILS, deliberately, and that is the realistic shape: a model
    // hammers the same command BECAUSE the objective is not met yet. It used to
    // pass here, which since 2026-08-20 means the runtime declares the objective
    // met and ends the run before a third attempt — the better outcome, and one
    // that never exercises the guard this test exists for.
    const runtime = new SessionRuntime({
      store,
      model,
      tools: runner,
      completion: policy(async () => ({ ok: false, detail: "the toolchain is still not set up" }), { isMutating: (t) => t === "shell" }),
    })
    await runtime.admit("ses_thrash", "set up the toolchain")
    const r = await runtime.run("ses_thrash")

    expect(r.state).not.toBe("completed") // the objective was never met
    expect(runner.invocations).toBe(2) // 3rd identical SUCCESS blocked — no spawn, despite epoch churn AND noisy stdout
    const blocked = await blockedEvents(store, "ses_thrash")
    expect(blocked).toHaveLength(1)
    expect((blocked[0]!.data as { priorOutcome: string }).priorOutcome).toBe("succeeded")
  })

  test("TEST 2c: a real edit (new workspace generation) RE-ALLOWS a previously-blocked SUCCESS thrash", async () => {
    const store = new MemoryEventStore()
    // shell success ×2 -> 3rd blocked; then edit_file (mutationCommitted) bumps
    // the workspace generation; the SAME shell command is allowed again — proving
    // "re-allow on a real project-state change", not merely on a new epoch.
    const runner = scriptedRunner((call) =>
      call.name === "edit_file"
        ? { ok: true, output: { replaced: 1 }, mutation: { executionId: "x", path: "package.json", beforeHash: "h", mutationStarted: true, mutationCommitted: true } }
        : { ok: true, output: { exitCode: 0 }, resultFingerprint: "npm-ok" },
    )
    const cmd = "rm -rf node_modules && npm install"
    const model = scriptedModel([shellCall(cmd), shellCall(cmd), shellCall(cmd), editCall("package.json"), shellCall(cmd), final("done")])
    // Failing verifier, for the reason given in TEST 2b: with a passing one the
    // runtime now ends the run at the first non-mutating turn, and the re-allow
    // this test is about never gets a chance to happen.
    const runtime = new SessionRuntime({
      store,
      model,
      tools: runner,
      completion: policy(async () => ({ ok: false, detail: "still not set up" }), { isMutating: (t) => t !== "read_file" }),
    })
    await runtime.admit("ses_gen_reallow", "task")
    const r = await runtime.run("ses_gen_reallow")

    expect(r.state).not.toBe("completed")
    // shell×2 ran, 3rd blocked, edit ran (generation++), shell ran AGAIN = 4 invocations
    expect(runner.invocations).toBe(4)
    const blocked = await blockedEvents(store, "ses_gen_reallow")
    expect(blocked).toHaveLength(1) // only the pre-edit third call
    expect((blocked[0]!.data as { generation: number }).generation).toBe(0) // blocked at gen 0
  })

  test("TEST 4: a DIFFERENT result each time is new information — never blocked", async () => {
    const store = new MemoryEventStore()
    let k = 0
    const runner = scriptedRunner(() => ({ ok: false, error: "boom", resultFingerprint: `FP${k++}` }))
    const model = scriptedModel([shellCall("cmd"), shellCall("cmd"), shellCall("cmd"), final("done exploring")])
    const runtime = new SessionRuntime({ store, model, tools: runner, completion: policy(async () => ({ ok: true, ran: false }), { isMutating: () => false }) })
    await runtime.admit("ses_newinfo", "task")
    const r = await runtime.run("ses_newinfo")

    expect(r.state).toBe("completed")
    expect(runner.invocations).toBe(3) // every call had a new result -> all ran
    expect(await blockedEvents(store, "ses_newinfo")).toHaveLength(0)
  })

  test("TEST 6: a CHANGING result (fail→ok→fail, all different) is never blocked — only truly identical repeats are", async () => {
    const store = new MemoryEventStore()
    // Each call's result differs from the last, so the count never accumulates —
    // the guardrail that a command whose result keeps changing (real progress /
    // a real state change) is NEVER mistaken for a no-information repeat.
    const runner = scriptedRunner((_c, n) =>
      n === 2 ? { ok: true, output: "ok", resultFingerprint: "FP_OK" } : { ok: false, error: "boom", resultFingerprint: `FP_FAIL_${n}` },
    )
    const model = scriptedModel([shellCall("cmd"), shellCall("cmd"), shellCall("cmd"), final("done")])
    const runtime = new SessionRuntime({ store, model, tools: runner, completion: policy(async () => ({ ok: true, ran: false }), { isMutating: () => false }) })
    await runtime.admit("ses_clear", "task")
    const r = await runtime.run("ses_clear")

    expect(r.state).toBe("completed")
    expect(runner.invocations).toBe(3) // every result differed -> count never hit 2 -> none blocked
    expect(await blockedEvents(store, "ses_clear")).toHaveLength(0)
  })

  test("TEST 3: an edit (new workspace generation) RE-ALLOWS a previously-blocked identical FAILURE", async () => {
    const store = new MemoryEventStore()
    const runner = scriptedRunner((call) =>
      call.name === "edit_file"
        ? { ok: true, output: { replaced: 1 }, mutation: { executionId: "x", path: "f.ts", beforeHash: "h", mutationStarted: true, mutationCommitted: true } }
        : { ok: false, error: "boom", resultFingerprint: "FP1" },
    )
    const model = scriptedModel([shellCall("cmd"), shellCall("cmd"), shellCall("cmd"), editCall("f.ts"), shellCall("cmd"), final("done")])
    const runtime = new SessionRuntime({ store, model, tools: runner, completion: policy(async () => ({ ok: true }), { isMutating: (t) => t === "edit_file" }) })
    await runtime.admit("ses_gen_fail_reallow", "task")
    const r = await runtime.run("ses_gen_fail_reallow")

    expect(r.state).toBe("completed")
    // shell x2 ran (3rd blocked at gen 0), edit ran (generation++), shell ran AGAIN at gen 1 = 4 invocations
    expect(runner.invocations).toBe(4)
    expect(await blockedEvents(store, "ses_gen_fail_reallow")).toHaveLength(1) // only the gen-0 third call
  })

  test("TEST 8: crash/restart rebuilds the result ledger from events — the same call blocks on resume", async () => {
    const store = new MemoryEventStore()
    const ses = "ses_block_resume"
    const runId = "run_block_crash"
    const H = argHash({ command: "npx jest" })
    const seed = async (type: string, data: Record<string, unknown>) =>
      store.append({ aggregateKind: "session", aggregateId: ses, type, data: { runId, ...data } })
    // two prior identical shell failures with the same resultHash (epoch 0), then the process died (no terminal)
    await seed(EventTypes.ToolStarted, { tool: "shell", argsHash: H, toolExecutionId: "t1" })
    await seed(EventTypes.ToolExecuted, { toolExecutionId: "t1", tool: "shell", ok: false, resultHash: "FP1" })
    await seed(EventTypes.ToolStarted, { tool: "shell", argsHash: H, toolExecutionId: "t2" })
    await seed(EventTypes.ToolExecuted, { toolExecutionId: "t2", tool: "shell", ok: false, resultHash: "FP1" })

    const runner = scriptedRunner(() => ({ ok: false, error: "boom", resultFingerprint: "FP1" }))
    const model = scriptedModel([shellCall("npx jest"), final("stopped, verifier unavailable")])
    const runtime = new SessionRuntime({ store, model, tools: runner, completion: policy(async () => ({ ok: true, ran: false }), { isMutating: () => false }) })
    const r = await runtime.continueRun(ses, { runId, attempt: 2, fromState: "executing_tool", fromTurn: 2 })

    expect(r.state).toBe("completed")
    expect(runner.invocations).toBe(0) // the rebuilt ledger blocked the resumed identical call — no spawn
    expect(await blockedEvents(store, ses)).toHaveLength(1)
  })
})

describe("no-progress finalization cannot skip verification", () => {
  test("T4c a run that stalls, changes nothing, and is FORCED to finalize still cannot claim completion", async () => {
    // Run 9, as a test. The no-progress detector fired three times, set
    // `finalizing`, and the acceptance site trusts `finalizing` to mean
    // "already verified" — so a run the runtime had just identified as going
    // nowhere was handed a straight path to reporting success. Fixing the
    // first site and not this one is how a defect survives its own fix.
    const store = new MemoryEventStore()
    let verifies = 0
    const model = scriptedModel([
      read("a.ts"),
      read("a.ts"),
      read("a.ts"),
      read("a.ts"),
      final("Done! I have created the dashboard."),
    ])
    const runtime = new SessionRuntime({
      store,
      model,
      tools: okTools,
      completion: policy(async () => (verifies++, { ok: false, ran: true, detail: "nothing was created" })),
    })
    await runtime.admit("ses_stall", "create admin/dashboard.html")
    const r = await runtime.run("ses_stall")
    expect(r.state).not.toBe("completed")
    // and the verifier was actually consulted rather than bypassed
    expect(verifies).toBeGreaterThan(0)
  })
})

describe("a write that changes nothing is the same call", () => {
  const writeCall = (path: string): ModelTurn => ({ kind: "tools", calls: [{ id: "c", name: "write_file", input: { path } }] })
  /** A committed mutation whose after-hash equals its before-hash: the file already held those bytes. */
  const noChangeReceipt = (path: string) => ({
    executionId: `tex_${path}`,
    path,
    beforeHash: "SAME",
    afterHash: "SAME",
    existedBefore: true,
    mutationStarted: true,
    mutationCommitted: true,
  })
  const realChangeReceipt = (path: string, after: string) => ({
    executionId: `tex_${path}_${after}`,
    path,
    beforeHash: "BEFORE",
    afterHash: after,
    existedBefore: true,
    mutationStarted: true,
    mutationCommitted: true,
  })

  // FOUND BY A LIVE RUN (2026-08-20). A 9B rewrote the whole of server.js FOUR
  // times with byte-identical content — same 21,783 bytes, same argsHash. Each
  // rewrite is ~5,400 generated tokens, about 110 seconds on that hardware, so
  // the four ate seven minutes of a twenty-minute budget and the run was
  // cancelled on the wall clock with its objective already met. The guard could
  // not see it: `write_file` returns no result fingerprint, so its outcomes
  // never entered the ledger at all.
  test("the SECOND identical no-change write is blocked", async () => {
    const store = new MemoryEventStore()
    const runner = scriptedRunner((call) => ({ ok: true, output: { path: (call.input as { path: string }).path }, mutation: noChangeReceipt("server.js") }))
    const model = scriptedModel([writeCall("server.js"), writeCall("server.js"), writeCall("server.js"), final("done")])
    const runtime = new SessionRuntime({ store, model, tools: runner, completion: policy(async () => ({ ok: true, ran: true })) })
    await runtime.admit("ses_nochange", "write the file")
    await runtime.run("ses_nochange")

    const blocked = await blockedEvents(store, "ses_nochange")
    expect(blocked.length).toBeGreaterThan(0)
    expect((blocked[0]!.data as { error: { message: string } }).error.message).toContain("already contained")
    // and the tool really was not run a third time
    expect(runner.invocations).toBeLessThanOrEqual(2)
  })

  // The other half of the same rule, and the reason the original comment gave
  // for excluding mutations: a write that genuinely changes the file IS
  // progress, and must never be mistaken for a thrash.
  test("a write that really changes the file is never blocked", async () => {
    const store = new MemoryEventStore()
    let n = 0
    const runner = scriptedRunner(() => {
      n++
      return { ok: true, output: { path: "server.js" }, mutation: realChangeReceipt("server.js", `AFTER${n}`) }
    })
    const model = scriptedModel([writeCall("server.js"), writeCall("server.js"), writeCall("server.js"), final("done")])
    const runtime = new SessionRuntime({ store, model, tools: runner, completion: policy(async () => ({ ok: true, ran: true })) })
    await runtime.admit("ses_change", "write the file")
    await runtime.run("ses_change")

    expect(await blockedEvents(store, "ses_change")).toHaveLength(0)
    expect(runner.invocations).toBeGreaterThanOrEqual(3)
  })
})

describe("a turn the provider cut short is continued, not judged", () => {
  // FOUND BY REVIEW (2026-08-20). The truncation handling emitted its notice
  // from the `streaming` state and looped, which lands on `calling_model` — a
  // transition the table refused. Every turn the provider cut short would have
  // died of an illegal transition instead of being continued: a fix strictly
  // worse than the bug it closed. It shipped because the new branch had no test
  // that ever entered it. This is that test.
  test("a truncated final is continued and the run still reaches a terminal state", async () => {
    const store = new MemoryEventStore()
    const model = scriptedModel([
      { kind: "final", text: "I will start by writing the", truncated: true },
      final("done"),
    ])
    const runtime = new SessionRuntime({ store, model, tools: okTools, completion: policy(async () => ({ ok: true, ran: true })) })
    await runtime.admit("ses_trunc", "do the thing")
    const r = await runtime.run("ses_trunc")

    expect(r.state).toBe("completed")
    const events = await store.read("session", "ses_trunc")
    expect(events.some((e) => e.type === "run.truncated")).toBe(true)
    // the partial text is kept, and the model is told to continue rather than restart
    const msgs = events.filter((e) => e.type === EventTypes.MessageAppended).map((e) => e.data as { role: string; text: string })
    expect(msgs.some((m) => m.role === "assistant" && m.text.includes("I will start by writing the"))).toBe(true)
    expect(msgs.some((m) => m.role === "user" && m.text.includes("cut off"))).toBe(true)
  })

  test("a truncated turn does not spend a verification attempt", async () => {
    const store = new MemoryEventStore()
    let verifications = 0
    const model = scriptedModel([
      { kind: "final", text: "half a sen", truncated: true },
      { kind: "final", text: "half a sen", truncated: true },
      final("done"),
    ])
    const runtime = new SessionRuntime({
      store,
      model,
      tools: okTools,
      completion: policy(async () => {
        verifications++
        return { ok: true, ran: true }
      }),
    })
    await runtime.admit("ses_trunc2", "do the thing")
    const r = await runtime.run("ses_trunc2")

    expect(r.state).toBe("completed")
    // only the real final answer was verified; the two cut-off turns were not
    expect(verifications).toBe(1)
  })
})

describe("the exploration stop is reachable in the configuration that ships", () => {
  // FOUND BY REVIEW (2026-08-20): DEFAULT_BUDGETS are maxTurns 16 and
  // maxReadOnlyTurns 8, so a hard stop at 3x (24) could never fire — the turn
  // budget always ended the run first, under the generic reason `turn_budget`.
  // A guard unreachable in its own default configuration is a comment
  // describing behaviour that does not exist.
  test("a run that only reads stops with a reason that NAMES the behaviour", async () => {
    const store = new MemoryEventStore()
    const model = scriptedModel([read("a.ts")])
    const runtime = new SessionRuntime({
      store,
      model,
      tools: okTools,
      completion: policy(async () => ({ ok: false, ran: true, detail: "nothing was changed" })),
      budgets: { maxTurns: 16, maxReadOnlyTurns: 8 },
    })
    await runtime.admit("ses_explore", "look around")
    const r = await runtime.run("ses_explore")

    expect(r.state).not.toBe("completed")
    const failed = (await store.read("session", "ses_explore")).filter((e) => e.type === EventTypes.RunFailed || e.type === EventTypes.RunPaused)
    const reasons = failed.map((e) => String((e.data as { reason?: string; detail?: string }).reason ?? "") + String((e.data as { detail?: string }).detail ?? ""))
    expect(reasons.join(" ")).toContain("exploration")
  })
})
