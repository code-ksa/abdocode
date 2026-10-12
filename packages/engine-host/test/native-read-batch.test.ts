/**
 * 10-09 — up to four native read calls in one reply (as Codex and Claude do): one model round trip instead of four. Every call id gets
 * its own tool reply — a provider refuses a request that leaves an id unanswered — and a member read before still gets a reply.
 */
import { expect, test } from "bun:test"
import { runTextAgentLoop, type NativeAgentReply } from "../src"

const read = (id: string, path: string) => ({ command: `read ${path}`, call: { id, name: "abdo_read", input: { path } } })
const batchOf = (...members: ReturnType<typeof read>[]): NativeAgentReply => ({ kind: "native", text: "", command: members[0]!.command, call: members[0]!.call, batch: members })

test("a native read batch dispatches each member once and answers every call id in order, in one round trip", async () => {
  const dispatched: string[] = []
  const asks: { prompt: string; history: readonly { role: string; content: string; toolCallId?: string; toolCalls?: readonly { id: string }[] }[] }[] = []
  let turn = 0
  const result = await runTextAgentLoop({
    input: "اقرأ الملفّات الثلاثة", history: [], maxRounds: 4, isCallable: (name) => name === "read",
    ask: async (prompt, history) => {
      asks.push({ prompt, history: [...history] as never })
      return turn++ === 0 ? batchOf(read("c1", "a.ts"), read("c2", "b.ts"), read("c3", "c.ts")) : "تم"
    },
    dispatch: async (command) => { dispatched.push(command); return `content of ${command.slice(5)}` },
  })
  expect(dispatched).toEqual(["read a.ts", "read b.ts", "read c.ts"])
  expect(asks).toHaveLength(2) // the batch, then one follow-up — not four asks
  const history = asks[1]!.history
  const assistant = history.find((m) => m.role === "assistant" && m.toolCalls !== undefined)!
  expect(assistant.toolCalls!.map((c) => c.id)).toEqual(["c1", "c2", "c3"])
  const tools = history.filter((m) => m.role === "tool")
  expect(tools.map((m) => m.toolCallId)).toEqual(["c1", "c2", "c3"])
  expect(tools[0]!.content).toContain("content of a.ts")
  expect(tools[2]!.content).toContain("content of c.ts")
  expect(result.answer).toContain("تم")
})

test("the twin: a member read before is not run again but its call id still gets a reply; an all-repeat batch twice stops as duplicate", async () => {
  const dispatched: string[] = []
  let turn = 0
  let lastHistory: readonly { role: string; toolCallId?: string }[] = []
  const result = await runTextAgentLoop({
    input: "اقرأ", history: [], maxRounds: 8, isCallable: (name) => name === "read",
    ask: async (_prompt, history) => {
      lastHistory = [...history] as never
      const n = turn++
      if (n === 0) return batchOf(read("c1", "a.ts"), read("c2", "b.ts"))
      if (n === 1) return batchOf(read("c3", "a.ts"), read("c4", "d.ts")) // a.ts was read — only d.ts runs
      return batchOf(read(`r${n}a`, "a.ts"), read(`r${n}b`, "b.ts")) // all repeats, again and again
    },
    dispatch: async (command) => { dispatched.push(command); return `content of ${command.slice(5)}` },
  })
  expect(dispatched).toEqual(["read a.ts", "read b.ts", "read d.ts"])
  const answered = lastHistory.filter((m) => m.role === "tool").map((m) => m.toolCallId)
  for (const id of ["c1", "c2", "c3", "c4"]) expect(answered).toContain(id)
  expect(result.stopReason).toBe("duplicate")
})
