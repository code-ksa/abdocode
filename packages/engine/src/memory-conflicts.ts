/** Contradictory memories are surfaced, never silently resolved.
 *
 * Two shapes are detected from the active facts of one scope:
 *  1. an inferred correction whose "from" matches what an explicit owner note
 *     still says (the note predates the correction, or the note was written
 *     after it and wins by being explicit);
 *  2. a session note and a project note with the same title but different
 *     text — the session note applies to this conversation only.
 * The model gets a short [MEMORY_CONFLICTS] block asking to confirm before
 * relying on either; the Memory panel offers "keep note" / "apply correction". */
import { memoryTerms } from "./memory-terms"

export interface MemoryFactLike {
  readonly id: string
  readonly key: string
  readonly value: unknown
  readonly sessionId?: string
  readonly createdAt: number
}

export interface MemoryConflict {
  readonly kind: "inferred-vs-note" | "session-vs-project"
  readonly topic: string
  readonly noteId: string
  readonly noteTitle: string
  readonly noteText: string
  readonly otherId: string
  readonly otherText: string
  /** True when the note is newer than the correction: the explicit note wins unless the user says otherwise. */
  readonly noteIsNewer: boolean
}

const noteText = (value: unknown) => typeof value === "object" && value !== null && typeof (value as { note?: unknown }).note === "string" ? (value as { note: string }).note : ""
const overlaps = (a: string, b: string) => {
  const ta = memoryTerms(a), tb = memoryTerms(b)
  return [...ta.tokens].some((t) => tb.tokens.has(t)) || [...ta.concepts].some((c) => tb.concepts.has(c))
}

export function detectMemoryConflicts(facts: readonly MemoryFactLike[]): MemoryConflict[] {
  const notes = facts.filter((f) => f.key.startsWith("owner-note:"))
  const inferred = facts.filter((f) => f.key.startsWith("inferred:"))
  const conflicts: MemoryConflict[] = []
  for (const fact of inferred) {
    const value = fact.value as { to?: unknown; from?: unknown } | null
    if (!value || typeof value.to !== "string") continue
    const to = value.to, from = typeof value.from === "string" ? value.from : undefined
    for (const note of notes) {
      const text = noteText(note.value)
      if (!text) continue
      const noteSaysFrom = from !== undefined && overlaps(text, from)
      const noteSaysTo = overlaps(text, to)
      const sameTopic = overlaps(`${note.key.slice("owner-note:".length)} ${text}`, `${fact.key.slice("inferred:".length)} ${to} ${from ?? ""}`)
      if (noteSaysTo || !(noteSaysFrom || (sameTopic && !overlaps(text, to)))) continue
      if (!noteSaysFrom && !sameTopic) continue
      conflicts.push({ kind: "inferred-vs-note", topic: fact.key.slice("inferred:".length), noteId: note.id, noteTitle: note.key.slice("owner-note:".length), noteText: text.slice(0, 200), otherId: fact.id, otherText: noteText(fact.value).slice(0, 200), noteIsNewer: note.createdAt > fact.createdAt })
    }
  }
  const byTitle = new Map<string, MemoryFactLike[]>()
  for (const note of notes) { const title = note.key.slice("owner-note:".length); byTitle.set(title, [...(byTitle.get(title) ?? []), note]) }
  for (const [title, group] of byTitle) {
    const project = group.find((n) => n.sessionId === undefined), session = group.find((n) => n.sessionId !== undefined)
    if (!project || !session) continue
    const a = noteText(project.value), b = noteText(session.value)
    if (a && b && a.trim() !== b.trim()) conflicts.push({ kind: "session-vs-project", topic: title, noteId: project.id, noteTitle: title, noteText: a.slice(0, 200), otherId: session.id, otherText: b.slice(0, 200), noteIsNewer: project.createdAt > session.createdAt })
  }
  return conflicts.slice(0, 6)
}

export function conflictsBrief(conflicts: readonly MemoryConflict[]): string {
  if (conflicts.length === 0) return ""
  const lines = conflicts.map((c) => c.kind === "inferred-vs-note"
    ? `- "${c.noteTitle}": explicit note says "${c.noteText}"; a later message implied "${c.otherText}" (unconfirmed${c.noteIsNewer ? "; the note is newer and wins unless the user says otherwise" : ""}).`
    : `- "${c.noteTitle}": this conversation's note says "${c.otherText}" while the project note says "${c.noteText}"; the conversation note applies here only.`)
  return "[MEMORY_CONFLICTS] These memories disagree. Do not pick one silently: state the conflict and ask the user which holds before relying on either.\n" + lines.join("\n") + "\n"
}
