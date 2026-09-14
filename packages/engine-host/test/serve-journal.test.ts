import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openServeJournal } from "../src"

const roots: string[] = []
const database = () => {
  const root = mkdtempSync(join(tmpdir(), "abdo-serve-journal-"))
  roots.push(root)
  return join(root, "events.sqlite")
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("owned serve journal", () => {
  test("admission, output and completion survive a real reopen", async () => {
    const file = database()
    const first = await openServeJournal({ database: file })
    await first.openSession("s-one")
    expect(await first.admit({ turnId: "turn-1", body: "مرحبا", sessionId: "s-one" })).toEqual({
      turnId: "turn-1",
      seq: 1,
      fresh: true,
    })
    expect(await first.emitOutput("turn-1", "أهلاً")).toEqual({ seq: 1, turnId: "turn-1", payload: "أهلاً" })
    await first.complete("turn-1")
    first.close()

    const reopened = await openServeJournal({ database: file })
    const state = reopened.snapshot()
    expect(state.sessions).toEqual(["s-one"])
    expect(state.admissions.get("turn-1")).toEqual({ seq: 1, body: "مرحبا", session: "s-one" })
    expect(state.outputs).toEqual([{ seq: 1, turnId: "turn-1", payload: "أهلاً" }])
    expect(state.completed.has("turn-1")).toBeTrue()
    expect(await reopened.admit({ turnId: "turn-1", body: "مرحبا", sessionId: "s-one" })).toEqual({
      turnId: "turn-1",
      seq: 1,
      fresh: false,
    })
    reopened.close()
  })

  test("one turn id cannot be rebound to another body or session", async () => {
    const journal = await openServeJournal({ database: database() })
    await journal.openSession("s-one")
    await journal.admit({ turnId: "turn-1", body: "original", sessionId: "s-one" })
    expect(journal.admit({ turnId: "turn-1", body: "changed", sessionId: "s-one" })).rejects.toThrow(
      "serve_turn_identity_conflict",
    )
    expect(journal.admit({ turnId: "turn-1", body: "original", sessionId: "s-two" })).rejects.toThrow(
      "serve_turn_identity_conflict",
    )
    journal.close()
  })

  test("legacy JSONL rows import once and the output cursor stays contiguous", async () => {
    const file = database()
    const legacy = [
      { k: "session", id: "legacy-session" },
      { k: "admit", id: "legacy-turn", seq: 1, body: "قديم", session: "legacy-session" },
      { k: "event", seq: 1, turnId: "legacy-turn", payload: "سطر قديم" },
      { k: "done", turnId: "legacy-turn" },
    ] as const
    const first = await openServeJournal({ database: file, legacyRows: legacy })
    first.close()
    const second = await openServeJournal({ database: file, legacyRows: legacy })
    expect(second.snapshot().outputs).toHaveLength(1)
    await second.openSession("new-session")
    await second.admit({ turnId: "new-turn", body: "جديد", sessionId: "new-session" })
    expect(await second.emitOutput("new-turn", "سطر جديد")).toEqual({
      seq: 2,
      turnId: "new-turn",
      payload: "سطر جديد",
    })
    second.close()
  })

  test("a conflicting or gapped legacy stream fails closed", async () => {
    expect(openServeJournal({
      database: database(),
      legacyRows: [
        { k: "admit", id: "turn-1", seq: 1, body: "x", session: "s" },
        { k: "event", seq: 2, turnId: "turn-1", payload: "gap" },
      ],
    })).rejects.toThrow("serve_output_sequence_gap")
  })

  test("output and completion are impossible before admission", async () => {
    const journal = await openServeJournal({ database: database() })
    expect(journal.emitOutput("missing", "x")).rejects.toThrow("serve_output_without_admission")
    expect(journal.complete("missing")).rejects.toThrow("serve_completion_without_admission")
    journal.close()
  })
})
