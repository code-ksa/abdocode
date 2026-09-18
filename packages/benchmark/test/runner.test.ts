import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { bunExec, evaluateGate, runComparative, summaryReport, type AdapterRunResult, type RuntimeAdapter, type TaskContext } from "../src/index"
import type { BenchTask } from "../src/index"

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) {
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(d, { recursive: true, force: true })
        break
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EBUSY") break
        Bun.sleepSync(50)
      }
    }
  }
})

async function tempRepo(): Promise<{ root: string; ref: string }> {
  const root = mkdtempSync(join(tmpdir(), "abdo-bench-repo-"))
  dirs.push(root)
  writeFileSync(join(root, "README.md"), "# base\n")
  await bunExec(["git", "init"], root)
  await bunExec(["git", "config", "user.email", "b@b.co"], root)
  await bunExec(["git", "config", "user.name", "bench"], root)
  await bunExec(["git", "add", "-A"], root)
  await bunExec(["git", "commit", "-m", "base"], root)
  const head = await bunExec(["git", "rev-parse", "HEAD"], root)
  return { root, ref: head.stdout.trim() }
}

const events = (): AdapterRunResult["events"] => [
  { type: "input.admitted", data: { text: "do the task" } },
  { type: "model.request.started", data: { requestId: "r1" } },
  { type: "tool.executed", data: { tool: "write_file", ok: true, idempotencyKey: "k1" } },
  { type: "message.appended", data: { role: "assistant", text: "done" } },
  { type: "run.completed", data: {} },
]

/** A scripted runtime: `worker` performs (or skips) the real file change. */
const scripted = (id: "v1" | "v2", worker: (ctx: TaskContext) => void): RuntimeAdapter => ({
  id,
  async run(ctx) {
    worker(ctx)
    return { finalState: "completed", text: "ok", events: events(), timeToFirstTokenMs: 50, totalMs: id === "v2" ? 1200 : 900, humanApprovals: 0, humanInterventions: id === "v1" ? 1 : 0, recoveryAttempted: false, recoverySucceeded: false }
  },
})

const suite: BenchTask[] = [
  { id: "make-magic", category: "single_file_edit", messages: ["create target.ts with MAGIC"], timeoutMs: 10_000, verification: { requireContains: [{ path: "target.ts", text: "MAGIC" }] } },
  { id: "make-magic-2", category: "qa", messages: ["again"], timeoutMs: 10_000, verification: { requireContains: [{ path: "target.ts", text: "MAGIC" }] } },
]

describe("runComparative (real git isolation, scripted runtimes)", () => {
  test("each trial is isolated; V2 does the work and passes, V1 does not — no cross-contamination", async () => {
    const { root, ref } = await tempRepo()
    const tmpBase = mkdtempSync(join(tmpdir(), "abdo-bench-wt-"))
    dirs.push(tmpBase)

    const v2 = scripted("v2", (ctx) => writeFileSync(join(ctx.workdir, "target.ts"), "export const MAGIC = 1\n"))
    const v1 = scripted("v1", () => {
      /* V1 completes but never writes the file -> verification fails */
    })

    const data = await runComparative(suite, { v1, v2 }, { repoRoot: root, ref, exec: bunExec, tmpBase })

    const s = summaryReport(data)
    expect(s.v2.successRate).toBe(1) // V2 did the work in its own worktree
    expect(s.v1.successRate).toBe(0) // V1 completed but produced nothing -> objective fail
    // order is swapped per task: task0 [v2,v1], task1 [v1,v2]
    expect(data.trials.map((t) => t.runtime)).toEqual(["v2", "v1", "v1", "v2"])
    // failures captured for V1 with a repro
    const fails = data.trials.filter((t) => t.failure)
    expect(fails.length).toBe(2)
    expect(fails.every((t) => t.failure!.runtime === "v1")).toBe(true)
    expect(fails[0]!.failure!.repro).toContain("--task")
  }, 30_000)

  test("gate: V2 self-safety passes and, with V1 present, the comparative success check is evaluated", async () => {
    const { root, ref } = await tempRepo()
    const tmpBase = mkdtempSync(join(tmpdir(), "abdo-bench-wt2-"))
    dirs.push(tmpBase)
    const v2 = scripted("v2", (ctx) => writeFileSync(join(ctx.workdir, "target.ts"), "MAGIC\n"))
    const v1 = scripted("v1", () => {})
    const data = await runComparative([suite[0]!], { v1, v2 }, { repoRoot: root, ref, exec: bunExec, tmpBase })
    const gate = evaluateGate(data)
    expect(gate.checks.find((c) => c.name === "v2_zero_duplicate_side_effects")!.status).toBe("pass")
    expect(gate.checks.find((c) => c.name === "v2_success_ge_v1")!.status).toBe("pass") // v2 100% >= v1 0%
  }, 30_000)
})
