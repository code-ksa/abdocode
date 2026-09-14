import { describe, expect, test } from "bun:test"
import { conflictsBrief, detectMemoryConflicts } from "../src/memory-conflicts"

const note = (id: string, title: string, text: string, createdAt: number, sessionId?: string) => ({ id, key: `owner-note:${title}`, value: { note: text, sensitive: false }, createdAt, ...(sessionId ? { sessionId } : {}) })
const inferred = (id: string, topic: string, to: string, from: string | undefined, createdAt: number) => ({ id, key: `inferred:${topic}`, value: { note: from ? `${to} (not ${from})` : to, to, ...(from ? { from } : {}), confidence: 0.8, inferred: true }, createdAt })

describe("memory conflicts", () => {
  test("an inferred correction that contradicts an explicit note is surfaced, with who is newer", () => {
    const older = detectMemoryConflicts([note("n1", "database", "SQLite for the local fixture", 100), inferred("i1", "database", "PostgreSQL", "SQLite", 200)])
    expect(older).toEqual([expect.objectContaining({ kind: "inferred-vs-note", topic: "database", noteId: "n1", otherId: "i1", noteIsNewer: false })])
    const newer = detectMemoryConflicts([note("n1", "database", "SQLite for the local fixture", 300), inferred("i1", "database", "PostgreSQL", "SQLite", 200)])
    expect(newer[0]?.noteIsNewer).toBe(true)
    const brief = conflictsBrief(newer)
    expect(brief.startsWith("[MEMORY_CONFLICTS]")).toBe(true)
    expect(brief).toContain("ask the user which holds")
    expect(brief).toContain("the note is newer and wins")
  })

  test("agreement, unrelated topics and confirmed corrections produce no conflict", () => {
    expect(detectMemoryConflicts([note("n1", "database", "PostgreSQL 16", 100), inferred("i1", "database", "PostgreSQL", "SQLite", 200)])).toEqual([])
    expect(detectMemoryConflicts([note("n1", "look", "violet buttons", 100), inferred("i1", "pnpm", "pnpm", "npm", 200)])).toEqual([])
    expect(detectMemoryConflicts([inferred("i1", "pnpm", "pnpm", "npm", 200)])).toEqual([])
    expect(conflictsBrief([])).toBe("")
  })

  test("a session note that differs from the project note of the same title is reported as conversation-only", () => {
    const conflicts = detectMemoryConflicts([note("p", "language", "Arabic replies", 100), note("s", "language", "English replies for this thread", 200, "s-1")])
    expect(conflicts).toEqual([expect.objectContaining({ kind: "session-vs-project", topic: "language", noteId: "p", otherId: "s" })])
    expect(conflictsBrief(conflicts)).toContain("applies here only")
    expect(detectMemoryConflicts([note("p", "language", "Arabic replies", 100), note("s", "language", "Arabic replies", 200, "s-1")])).toEqual([])
  })

  test("at most six conflicts are reported", () => {
    const facts = Array.from({ length: 10 }, (_, i) => [note(`n${i}`, `t${i}`, `alpha${i} value`, 100), inferred(`i${i}`, `t${i}`, `beta${i}`, `alpha${i}`, 200)]).flat()
    expect(detectMemoryConflicts(facts)).toHaveLength(6)
  })
})
