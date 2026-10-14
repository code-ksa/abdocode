/**
 * 10-14 — measured against Claude Code with the same model (claude-sonnet-5-5): Claude writes two or three files and runs a command in one
 * reply. That reply used to be refused whole and re-asked. Now the calls run in the model's order, each through the single-call path with
 * its guards, each call id answered by its own tool reply, and the model is asked again only after the last one.
 */
import { expect, test } from "bun:test"
import { runTextAgentLoop, type NativeAgentReply } from "../src"

type Member = { command: string; call: { id: string; name: string; input: unknown } }
const write = (id: string, path: string): Member => ({ command: `write ${path} <<<\nx`, call: { id, name: "abdo_write", input: { path, content: "x" } } })
const run = (id: string, command: string): Member => ({ command: `run ${command}`, call: { id, name: "abdo_run", input: { command } } })
const queueOf = (...members: Member[]): NativeAgentReply => ({ kind: "native", text: "أكتب الملفّين ثمّ أشغّل.", command: members[0]!.command, call: members[0]!.call, queue: members.slice(1) })
type Seen = { role: string; content: string; toolCallId?: string; toolCalls?: readonly { id: string }[] }

test("a queued reply runs every call in order with one model call after the last, one assistant message, every id answered", async () => {
  const dispatched: string[] = []
  const asks: { history: readonly Seen[] }[] = []
  let turn = 0
  const result = await runTextAgentLoop({
    input: "اكتب ملفّين وشغّل الاختبار", history: [], maxRounds: 6, isCallable: (name) => name === "write" || name === "run",
    ask: async (_prompt, history) => {
      asks.push({ history: [...history] as never })
      return turn++ === 0 ? queueOf(write("w1", "a.js"), write("w2", "b.js"), run("r1", "npm test")) : "تم"
    },
    dispatch: async (command) => { dispatched.push(command.split("\n", 1)[0]!); return command.startsWith("run") ? "exit 0\n3 passed" : `wrote ${command.split(/\s+/u)[1]}` },
  })
  expect(dispatched).toEqual(["write a.js <<<", "write b.js <<<", "run npm test"])
  expect(asks).toHaveLength(2) // the reply, then one follow-up after the queue — not three
  const history = asks[1]!.history
  const assistants = history.filter((m) => m.role === "assistant")
  expect(assistants).toHaveLength(1)
  expect(assistants[0]!.toolCalls!.map((c) => c.id)).toEqual(["w1", "w2", "r1"])
  const tools = history.filter((m) => m.role === "tool")
  expect(tools.map((m) => m.toolCallId)).toEqual(["w1", "w2", "r1"])
  expect(tools[2]!.content).toContain("3 passed")
  expect(result.answer).toContain("تم")
})

test("the twin: a single call still asks the model after it — the queue is the only path that skips the ask", async () => {
  const asks: number[] = []
  let turn = 0
  await runTextAgentLoop({
    input: "اكتب", history: [], maxRounds: 6, isCallable: (name) => name === "write",
    ask: async () => { asks.push(turn); const w = write(`w${turn}`, `f${turn}.js`); return turn++ < 2 ? { kind: "native", text: "", command: w.command, call: w.call } : "تم" },
    dispatch: async (command) => `wrote ${command.split(/\s+/u)[1]}`,
  })
  expect(asks).toHaveLength(3)
})
