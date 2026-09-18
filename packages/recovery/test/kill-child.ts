/**
 * Fixture child process — crashes at a configurable point so the parent test can
 * cover every dangerous boundary. Run via Bun.spawn.
 *
 *   bun kill-child.ts <dbFile> <markerFile> <stage>
 *
 * stages:
 *   before_tool_started        die after run.executing_tool, before tool.started
 *   after_started_before_effect die after tool.started, before the side effect
 *   after_effect_before_exec    die after the side effect, before tool.executed  (WORST)
 *   after_exec_before_terminal  die after tool.executed, before a terminal event
 */
import { SqliteEventStore } from "@abdo/persistence-sqlite"

const [dbFile, markerFile, stage = "after_effect_before_exec"] = process.argv.slice(2)
if (!dbFile || !markerFile) process.exit(2)

const store = new SqliteEventStore(dbFile)
const sessionId = "ses_kill"
const runId = "run_1"
const emit = (type: string, data: Record<string, unknown> = {}) =>
  store.append({ aggregateKind: "session", aggregateId: sessionId, type, data: { runId, ...data } })

await emit("input.admitted", { inputId: "i1", text: "create the file" })
await emit("input.promoted", { inputId: "i1" })
await emit("run.admitted")
await emit("run.preparing")
await emit("run.calling", { turn: 1 })
await emit("run.streaming", { turn: 1 })
await emit("run.executing_tool", { turn: 1 })

if (stage === "before_tool_started") process.exit(137)

await emit("tool.started", {
  toolExecutionId: "tex_1",
  tool: "write_file",
  argsHash: "deadbeef",
  idempotencyKey: "v1:write:test-output",
})

if (stage === "after_started_before_effect") process.exit(137)

await Bun.write(markerFile, "written by the tool") // the REAL side effect

if (stage === "after_effect_before_exec") process.exit(137)

await emit("tool.executed", { toolExecutionId: "tex_1", tool: "write_file", ok: true })

if (stage === "after_exec_before_terminal") process.exit(137)

process.exit(0)
