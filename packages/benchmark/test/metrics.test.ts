import { describe, expect, test } from "bun:test"
import { extractEventMetrics, METRICS_SCHEMA_VERSION, STRATEGY_EXECUTION_KEY_FORMAT } from "../src/index"

const ev = (type: string, data: Record<string, unknown>) => ({ type, data })

describe("extractEventMetrics", () => {
  test("counts provider requests, tool calls, failures, and reads/writes", () => {
    const events = [
      ev("input.admitted", { text: "do it" }),
      ev("model.request.started", { requestId: "r1" }),
      ev("tool.started", { tool: "read_file", argsHash: "h1" }),
      ev("tool.executed", { tool: "read_file", ok: true }),
      ev("tool.started", { tool: "write_file", argsHash: "h2", idempotencyKey: "k1" }),
      ev("tool.executed", { tool: "write_file", ok: true, idempotencyKey: "k1" }),
      ev("tool.started", { tool: "shell", argsHash: "h3" }),
      ev("tool.executed", { tool: "shell", ok: false }),
      ev("message.appended", { role: "assistant", text: "done!!" }),
      ev("model.usage", { inputTokens: 5855, outputTokens: 94 }),
      ev("run.completed", {}),
    ]
    const m = extractEventMetrics(events)
    expect(m.providerRequests).toBe(1)
    expect(m.toolCalls).toBe(3)
    expect(m.failedToolCalls).toBe(1)
    expect(m.filesRead).toBe(1)
    expect(m.filesModified).toBe(1)
    expect(m.terminal).toBe(true)
    expect(m.finalState).toBe("completed")
    // REAL provider usage (from model.usage), not an estimate
    expect(m.inputTokens).toBe(5855)
    expect(m.outputTokens).toBe(94)
  })

  test("tokens are UNAVAILABLE (null) when the provider reported no usage — never estimated", () => {
    const m = extractEventMetrics([ev("model.request.started", {}), ev("message.appended", { role: "assistant", text: "hi" }), ev("run.completed", {})])
    expect(m.inputTokens).toBeNull()
    expect(m.outputTokens).toBeNull()
  })

  test("usage sums across multiple turns", () => {
    const m = extractEventMetrics([ev("model.usage", { inputTokens: 100, outputTokens: 20 }), ev("model.usage", { inputTokens: 150, outputTokens: 30 })])
    expect(m.inputTokens).toBe(250)
    expect(m.outputTokens).toBe(50)
  })

  test("a repeated tool argsHash counts as a wasted repeat", () => {
    const events = [
      ev("tool.started", { tool: "read_file", argsHash: "same" }),
      ev("tool.executed", { tool: "read_file", ok: true }),
      ev("tool.started", { tool: "read_file", argsHash: "same" }),
      ev("tool.executed", { tool: "read_file", ok: true }),
    ]
    expect(extractEventMetrics(events).repeatedToolCalls).toBe(1)
  })

  test("a duplicate idempotency key is a duplicate side effect (must be 0 in a good run)", () => {
    const events = [
      ev("tool.executed", { tool: "write_file", ok: true, idempotencyKey: "k" }),
      ev("tool.executed", { tool: "write_file", ok: true, idempotencyKey: "k" }),
    ]
    expect(extractEventMetrics(events).duplicateSideEffects).toBe(1)
  })

  test("no terminal event means the run is not terminal (stuck candidate)", () => {
    const m = extractEventMetrics([ev("model.request.started", {})])
    expect(m.terminal).toBe(false)
  })

  test("counts tool.repeated_call_blocked and run.verification_unavailable", () => {
    const events = [
      ev("tool.started", { tool: "shell", argsHash: "h", toolExecutionId: "t1" }),
      ev("tool.executed", { tool: "shell", ok: false, toolExecutionId: "t1", resultHash: "FP" }),
      ev("tool.started", { tool: "shell", argsHash: "h", toolExecutionId: "t2" }),
      ev("tool.executed", { tool: "shell", ok: false, toolExecutionId: "t2", resultHash: "FP" }),
      ev("tool.repeated_call_blocked", { tool: "shell", argsHash: "h", resultHash: "FP" }),
      ev("run.verification_unavailable", { epoch: 1 }),
      ev("run.completed", { verification: "unavailable" }),
    ]
    const m = extractEventMetrics(events)
    expect(m.repeatedCallsBlocked).toBe(1)
    expect(m.verificationUnavailable).toBe(1)
    expect(m.toolCalls).toBe(2) // the blocked call is NOT a tool execution
  })

  test("counts redundant STRATEGY blocks and executions per semantic state", () => {
    // The long-0 shape: one install runs, an unrelated edit follows, the second
    // install is refused. The gate reads both numbers — the reinstall executed
    // once per dependency state, and the guard is visibly doing the work.
    const events = [
      ev("tool.started", { tool: "shell", argsHash: "h1", toolExecutionId: "t1", strategy: "dependency_reinstall", semanticStateHash: "DEP_A" }),
      ev("tool.executed", { tool: "shell", ok: true, toolExecutionId: "t1", resultHash: "OK" }),
      ev("tool.started", { tool: "write_file", argsHash: "h2", toolExecutionId: "t2" }),
      ev("tool.executed", { tool: "write_file", ok: true, toolExecutionId: "t2" }),
      ev("tool.redundant_strategy_blocked", { tool: "shell", strategy: "dependency_reinstall", semanticStateHash: "DEP_A", reason: "already_succeeded" }),
      // after a REAL dependency change the same strategy legitimately runs again
      ev("tool.started", { tool: "shell", argsHash: "h3", toolExecutionId: "t3", strategy: "dependency_reinstall", semanticStateHash: "DEP_B" }),
      ev("tool.executed", { tool: "shell", ok: true, toolExecutionId: "t3", resultHash: "OK" }),
      ev("run.completed", {}),
    ]
    const m = extractEventMetrics(events)
    expect(m.redundantStrategiesBlocked).toBe(1)
    expect(m.maxStrategyExecutionsPerState).toBe(1) // never twice at one dependency state
    expect(m.toolCalls).toBe(3) // the blocked strategy never executed
  })

  test("a state RETURNED to in a new epoch is not scored as a repeat", () => {
    // The fetch shape: the destination is missing, gets downloaded, is deleted,
    // and is missing again. Both fetches execute at the SAME semantic hash, and
    // both are correct — the world moved in between, which is what the epoch
    // records. Keying the metric on the hash alone would score the guard as
    // having failed on a run where it behaved exactly as designed.
    const events = [
      ev("tool.started", { tool: "shell", argsHash: "h1", toolExecutionId: "t1", strategy: "resource_fetch", semanticStateHash: "MISSING", stateEpoch: 0 }),
      ev("tool.executed", { tool: "shell", ok: true, toolExecutionId: "t1", resultHash: "OK", postSemanticStateHash: "DIGEST" }),
      ev("tool.redundant_strategy_blocked", { tool: "shell", strategy: "resource_fetch", semanticStateHash: "DIGEST", stateEpoch: 0, reason: "state_produced_by_prior_run" }),
      ev("tool.started", { tool: "shell", argsHash: "h2", toolExecutionId: "t2" }), // the delete
      ev("tool.executed", { tool: "shell", ok: true, toolExecutionId: "t2", resultHash: "RM" }),
      ev("tool.started", { tool: "shell", argsHash: "h3", toolExecutionId: "t3", strategy: "resource_fetch", semanticStateHash: "MISSING", stateEpoch: 1 }),
      ev("tool.executed", { tool: "shell", ok: true, toolExecutionId: "t3", resultHash: "OK", postSemanticStateHash: "DIGEST" }),
      ev("run.completed", {}),
    ]
    const m = extractEventMetrics(events)
    expect(m.maxStrategyExecutionsPerState).toBe(1) // once per state PER EPOCH
    expect(m.redundantStrategiesBlocked).toBe(1)
  })

  test("without an epoch on the events the metric measures exactly as before", () => {
    // Runs recorded before the epoch existed must not change their score: a
    // missing `stateEpoch` reads as 0, so two executions at one hash are still
    // the repeat they always were.
    const events = [
      ev("tool.started", { tool: "shell", argsHash: "h1", toolExecutionId: "t1", strategy: "dependency_reinstall", semanticStateHash: "DEP_A" }),
      ev("tool.executed", { tool: "shell", ok: true, toolExecutionId: "t1", resultHash: "OK" }),
      ev("tool.started", { tool: "shell", argsHash: "h2", toolExecutionId: "t2", strategy: "dependency_reinstall", semanticStateHash: "DEP_A" }),
      ev("tool.executed", { tool: "shell", ok: true, toolExecutionId: "t2", resultHash: "OK" }),
      ev("run.completed", {}),
    ]
    expect(extractEventMetrics(events).maxStrategyExecutionsPerState).toBe(2)
  })

  test("the strategy-execution KEY is versioned — changing it must bump the metrics schema", () => {
    // This is the whole point of the two constants. `maxStrategyExecutionsPerState`
    // means "executions per (strategy, scope, epoch, state)". Add a field, drop
    // one, reorder them, and the number answers a different question — at which
    // point results measured before and after are not the same series and must
    // not share a baseline. If you edit the key, this test fails; the fix is to
    // bump METRICS_SCHEMA_VERSION with it, never to just update the string.
    expect(STRATEGY_EXECUTION_KEY_FORMAT).toBe("strategy:scope:stateEpoch:semanticStateHash")
    expect(METRICS_SCHEMA_VERSION).toBe(2) // 1 -> 2 when `stateEpoch` entered the key
    // And the definition the version describes is the one actually in force:
    // the same strategy+scope+hash in two epochs counts once each, not twice.
    const events = [
      ev("tool.started", { tool: "shell", argsHash: "h1", toolExecutionId: "t1", strategy: "s", scope: "pkg", semanticStateHash: "H", stateEpoch: 0 }),
      ev("tool.executed", { tool: "shell", ok: true, toolExecutionId: "t1", resultHash: "OK" }),
      ev("tool.started", { tool: "shell", argsHash: "h2", toolExecutionId: "t2", strategy: "s", scope: "pkg", semanticStateHash: "H", stateEpoch: 1 }),
      ev("tool.executed", { tool: "shell", ok: true, toolExecutionId: "t2", resultHash: "OK" }),
      ev("run.completed", {}),
    ]
    expect(extractEventMetrics(events).maxStrategyExecutionsPerState).toBe(1)
  })
})
