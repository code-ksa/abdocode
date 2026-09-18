import { describe, expect, test } from "bun:test"
import {
  compactTrail, isExecDigest, isReadDigest, isTrailDigest, isWriteDigest, runTextAgentLoop, writeDigest,
  type DispatchResult, type TextAgentMessage, type ToolVerdict,
} from "../src"

// م11 — ضغطُ حمولةِ الكتابة: رسائلُ المساعد التي حملت `نفّذ: write <ملف> <<<` كاملاً تُختصر إلى رأسها
// وسطرِ إيصال حين تشيخ خارج نافذة `keepRecent` ويعبر مجموعُها `overChars`. المقيس 09-14: دورٌ استهلك
// ٣٧٣ ألف توكن في ٣٦ نداءً ونصفُ الكتلة كتاباتٌ كاملة متكرّرة لملفٍّ واحد لم يهضمها ضغطُ القراءة/التنفيذ.

type Captured = { prompt: string; history: TextAgentMessage[] }
const prefixBreaks = (calls: readonly Captured[]): number[] => {
  const breaks: number[] = []
  for (let i = 1; i < calls.length; i += 1) {
    const previous = calls[i - 1]!.history
    const current = calls[i]!.history
    if (previous.some((message, index) => !Bun.deepEquals(message, current[index]))) breaks.push(i)
  }
  return breaks
}
const OK: ToolVerdict = { ok: true }
const big = (letter: string, size: number): string => letter.repeat(size)

type Step = { readonly reply: string; readonly command: string; readonly output: string }
type Options = {
  readonly writeCompaction?: { keepRecent: number; overChars: number }
  readonly readCompaction?: { keepRecent: number; overChars: number }
  readonly trailCompaction?: { keepRecent: number; overChars: number; trailChars: number }
}

const runSteps = async (steps: readonly Step[], options: Options = {}) => {
  const calls: Captured[] = []
  const replies = [...steps.map((step) => step.reply), "تم"]
  const byCommand = new Map(steps.map((step) => [step.command, step] as const))
  const result = await runTextAgentLoop({
    input: "اكتب الملاحظات", history: [], maxRounds: steps.length + 2,
    ask: async (prompt, history) => { calls.push({ prompt, history: [...history] }); return replies.shift()! },
    dispatch: async (command): Promise<DispatchResult> => {
      const step = byCommand.get(command)
      if (step === undefined) throw new Error(`unexpected command: ${command.slice(0, 40)}`)
      return { output: step.output, verdict: OK }
    },
    isCallable: (name) => ["read", "list", "run", "write", "edit", "patch"].includes(name),
    ...(options.writeCompaction === undefined ? {} : { writeCompaction: options.writeCompaction }),
    ...(options.readCompaction === undefined ? {} : { readCompaction: options.readCompaction }),
    ...(options.trailCompaction === undefined ? {} : { trailCompaction: options.trailCompaction }),
  })
  return { result, calls }
}

/** أربعُ كتاباتٍ متعاقبة لملفٍّ واحد بحمولاتٍ مختلفة (A..D) — الشكلُ الذي قيس حيّاً. */
const fourWrites = (size = 3000): Step[] => Array.from({ length: 4 }, (_, index) => {
  const command = `write notes.md <<<\n${big(String.fromCharCode(65 + index), size)}`
  return { reply: `نفّذ: ${command}`, command, output: `✓ كُتب notes.md (${size} حرفاً)` }
})

describe("م11 — write-payload compaction", () => {
  test("writeDigest keeps the call head and replaces the payload; no head → undefined", () => {
    const digest = writeDigest(`سأكتب الملفّ الآن.\nنفّذ: write a/b.md <<<\n${big("Z", 500)}`)
    expect(digest).toBeDefined()
    expect(digest!.startsWith("سأكتب الملفّ الآن.\nنفّذ: write a/b.md <<<\n[اختُصرت حمولةُ الكتابة: 500 حرفاً كُتبت فعلاً، بصمة ")).toBe(true)
    expect(digest).not.toContain(big("Z", 500))
    expect(isWriteDigest(digest!)).toBe(true)
    expect(isTrailDigest(digest!)).toBe(true)
    expect(isReadDigest(digest!)).toBe(false)
    expect(isExecDigest(digest!)).toBe(false)
    // الملخّص لا يُقرأ نداءً ثانياً ولا يُهضم مرّتين.
    expect(digest!.split("نفّذ:")).toHaveLength(2)
    expect(writeDigest(digest!)).toBe(digest)
    expect(writeDigest("نفّذ: read a/b.md")).toBeUndefined()
    expect(writeDigest(`نفّذ: edit a/b.md <<<\nx\n>>>\ny`)).toBeUndefined()
    // الرأسُ الغليظ `**نفّذ:**` يُقبل كما يقبله المحلّل.
    expect(writeDigest(`**نفّذ:** write c.txt <<<\nhello`)).toContain("[اختُصرت حمولةُ الكتابة: 5 حرفاً")
  })

  test("compactTrail digests write entries older than the window; legacy callers without `write` never touch them", () => {
    const trail: TextAgentMessage[] = [
      { role: "user", content: "اكتب" },
      { role: "assistant", content: `نفّذ: write n.md <<<\n${big("A", 100)}` },
      { role: "user", content: "نتيجة" },
      { role: "assistant", content: `نفّذ: write n.md <<<\n${big("B", 100)}` },
    ]
    const entries = [{ index: 1, command: "write n.md <<<", kind: "write" as const }, { index: 3, command: "write n.md <<<", kind: "write" as const }]
    const compacted = compactTrail(trail, entries, { read: 0, exec: 0, write: 1 })
    expect(compacted.compacted).toEqual({ read: 0, exec: 0, write: 1 })
    expect(isWriteDigest(compacted.trail[1]!.content)).toBe(true)
    expect(compacted.trail[3]!.content).toContain(big("B", 100))
    const legacy = compactTrail(trail, entries, { read: 0, exec: 0 })
    expect(legacy.compacted).toEqual({ read: 0, exec: 0, write: 0 })
    expect(legacy.trail).toEqual(trail)
  })

  test("(a) older write payloads are digested once their mass crosses overChars; the newest stays full; one pass = one prefix break", async () => {
    const { result, calls } = await runSteps(fourWrites(), { writeCompaction: { keepRecent: 1, overChars: 4000 } })
    const trail = result.continuation
    // [user, asst w0, res0, asst w1, res1, asst w2, res2, asst w3, res3] (the closing «تم» lives in memory, not the continuation); write k sits at 1 + 2k.
    expect(trail).toHaveLength(9)
    // w2 recorded → candidates [w0, w1] ≈ 6050 > 4000 → one pass before the call that follows w2's receipt.
    for (const k of [0, 1]) {
      const message = trail[1 + 2 * k]!
      expect(message.role).toBe("assistant")
      expect(isWriteDigest(message.content)).toBe(true)
      expect(message.content.startsWith("نفّذ: write notes.md <<<\n[اختُصرت حمولةُ الكتابة: 3000 حرفاً كُتبت فعلاً، بصمة ")).toBe(true)
      expect(message.content).not.toContain(big(String.fromCharCode(65 + k), 3000))
    }
    for (const k of [2, 3]) {
      expect(trail[1 + 2 * k]!.content).toContain(big(String.fromCharCode(65 + k), 3000))
      expect(isTrailDigest(trail[1 + 2 * k]!.content)).toBe(false)
    }
    // The tool results themselves are untouched (no exec option).
    for (const k of [0, 1, 2, 3]) expect(trail[2 + 2 * k]!.content).toContain(`✓ كُتب notes.md`)
    expect(prefixBreaks(calls)).toEqual([3])
    expect(result.writeCompactions).toBe(1)
    expect(result.readCompactions).toBe(0)
    expect(result.execCompactions).toBe(0)
    expect(result.commands).toHaveLength(4)
    expect(result.stopReason).toBe("complete")
    // Stable across runs: same payload → same digest bytes.
    const again = await runSteps(fourWrites(), { writeCompaction: { keepRecent: 1, overChars: 4000 } })
    expect(again.result.continuation[1]!.content).toBe(trail[1]!.content)
  })

  test("(b) without the option the trail is byte-identical and no write digest ever appears — also with read+exec compaction on", async () => {
    const legacy = await runSteps(fourWrites())
    const others = await runSteps(fourWrites(), { readCompaction: { keepRecent: 4, overChars: 60_000 }, trailCompaction: { keepRecent: 2, overChars: 30_000, trailChars: 10_000_000 } })
    expect(others.result.continuation).toEqual(legacy.result.continuation)
    expect(others.calls).toEqual(legacy.calls)
    expect(legacy.result.writeCompactions).toBe(0)
    expect(others.result.writeCompactions).toBe(0)
    expect(legacy.result.continuation.some((m) => isWriteDigest(m.content))).toBe(false)
    expect(legacy.result.continuation.filter((m) => m.role === "assistant" && m.content.includes("<<<"))).toHaveLength(4)
  })

  test("(c) under the budget nothing is rewritten: a single big write and small ones never trigger a pass", async () => {
    const steps = fourWrites(500)
    const { result, calls } = await runSteps(steps, { writeCompaction: { keepRecent: 1, overChars: 4000 } })
    expect(prefixBreaks(calls)).toEqual([])
    expect(result.writeCompactions).toBe(0)
    expect(result.continuation.some((m) => isWriteDigest(m.content))).toBe(false)
  })

  test("(d) invalid option shape is refused before any call", async () => {
    await expect(runSteps(fourWrites(10), { writeCompaction: { keepRecent: -1, overChars: 10 } })).rejects.toThrow("text_agent_write_compaction_invalid")
    await expect(runSteps(fourWrites(10), { writeCompaction: { keepRecent: 1, overChars: 0 } })).rejects.toThrow("text_agent_write_compaction_invalid")
  })
})
