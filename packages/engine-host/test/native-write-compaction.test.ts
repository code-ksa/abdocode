/**
 * 10-09 — Hermes inventory item 7 on the native path: write/edit payloads live in the call arguments (`toolCalls[].input`), so write
 * compaction (which reads `نفّذ: write … <<<`) and its size counter (which reads `content`) never saw them; with native tools now the
 * default for nemotron, every file written was resent in full on every later call. Older native writes now become a receipt line.
 */
import { expect, test } from "bun:test"
import { nativeWriteDigest, nativeWritePayloadChars, runTextAgentLoop, type NativeAgentReply, type TextAgentMessage } from "../src"

const big = (letter: string) => letter.repeat(4_000)
const writeReply = (index: number): NativeAgentReply => ({
  kind: "native", text: "", command: `write f${index}.ts <<<\n${big(String.fromCharCode(65 + index))}`,
  call: { id: `w${index}`, name: "abdo_write", input: { path: `f${index}.ts`, content: big(String.fromCharCode(65 + index)) } },
})

test("the pure digest replaces the payload with a receipt line, keeps id/name/path, and is idempotent", () => {
  const message: TextAgentMessage = { role: "assistant", content: "", toolCalls: [writeReply(0).call] }
  expect(nativeWritePayloadChars(message)).toBe(4_000)
  const digested = nativeWriteDigest(message)!
  const input = digested.toolCalls![0]!.input as { path: string; content: string }
  expect(digested.toolCalls![0]!.id).toBe("w0")
  expect(input.path).toBe("f0.ts")
  expect(input.content).toMatch(/^\[اختُصرت حمولةُ الكتابة: 4000 حرفاً كُتبت فعلاً، بصمة [0-9a-f]{8}/u)
  expect(nativeWritePayloadChars(digested)).toBe(0)
  expect(nativeWriteDigest(digested)).toBeUndefined()
  // the twin: a text-protocol message and a read call carry no native payload
  expect(nativeWritePayloadChars({ role: "assistant", content: "نفّذ: write a <<<\nx" })).toBe(0)
  expect(nativeWriteDigest({ role: "assistant", content: "", toolCalls: [{ id: "r", name: "abdo_read", input: { path: "a" } }] })).toBeUndefined()
})

test("in the loop: older native writes are compacted in the history the model receives, the newest stays whole", async () => {
  const histories: TextAgentMessage[][] = []
  let asks = 0
  await runTextAgentLoop({
    input: "اكتب الملفّات", history: [], maxRounds: 8, isCallable: (name) => name === "write",
    writeCompaction: { keepRecent: 1, overChars: 1_000 },
    ask: async (_prompt, history) => {
      histories.push([...history])
      const index = asks++
      return index < 4 ? writeReply(index) : "تم"
    },
    dispatch: async (command) => `✍ ${command.split(" ", 2)[1]} — كُتب`,
  })
  const last = histories[histories.length - 1]!
  const writes = last.filter((m) => m.role === "assistant" && m.toolCalls?.[0]?.name === "abdo_write")
  expect(writes.map((m) => m.toolCalls![0]!.id)).toEqual(["w0", "w1", "w2", "w3"])
  const contents = writes.map((m) => (m.toolCalls![0]!.input as { content: string }).content)
  expect(contents.slice(0, 3).every((c) => c.startsWith("[اختُصرت حمولةُ الكتابة: 4000 حرفاً"))).toBe(true)
  expect(contents[3]).toBe(big("D"))
})
