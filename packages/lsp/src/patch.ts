/**
 * Range-exact patching (Sprint 42) and diagnostics as a blocker (Sprint 40).
 *
 * The failure this removes is the one every regex-based edit eventually
 * produces: a hundred call sites updated, ninety-eight correctly, and two
 * inside a string literal that now say something nobody wrote. The file still
 * typechecks, the tests still pass, and the damage is found weeks later.
 *
 * So edits are RANGES, applied from the end of the file backwards — an edit
 * applied forwards shifts every later offset, which is how a patch that was
 * computed correctly lands in the wrong place. And the guarantee is checked
 * rather than claimed: `applyEdits` returns the byte ranges it touched, and
 * `verifyUntouched` proves everything outside them is identical.
 *
 * Sprint 40 lives here because it is the same principle one level up: a
 * diagnostic is evidence about the file, and a run that finished with an error
 * diagnostic did not finish. A passing text command does not overrule it —
 * `tsc` in one directory and a language server holding the real compiler
 * options disagree all the time, and the one that read the tsconfig wins.
 */
import type { LspDiagnostic, LspRange } from "./client"

export interface Edit {
  readonly uri: string
  readonly range: LspRange
  readonly newText: string
  /** What this edit is for — carried into the receipt, not decoration. */
  readonly reason?: string
}

export interface AppliedEdit {
  readonly range: LspRange
  /** Byte offsets in the ORIGINAL text that this edit replaced. */
  readonly startOffset: number
  readonly endOffset: number
  readonly newText: string
}

export type PatchResult =
  | { readonly kind: "ok"; readonly text: string; readonly applied: readonly AppliedEdit[] }
  | { readonly kind: "rejected"; readonly why: string; readonly conflicts?: readonly [Edit, Edit][] }

/** Offset of a line/character position, or -1 when the position is off the end. */
export function offsetOf(text: string, line: number, character: number): number {
  if (line < 0 || character < 0) return -1
  let offset = 0
  let currentLine = 0
  while (currentLine < line) {
    const next = text.indexOf("\n", offset)
    if (next === -1) return -1
    offset = next + 1
    currentLine++
  }
  const lineEnd = text.indexOf("\n", offset)
  const limit = lineEnd === -1 ? text.length : lineEnd
  return offset + character > limit ? -1 : offset + character
}

const rangeKey = (r: LspRange): string => `${r.start.line}:${r.start.character}-${r.end.line}:${r.end.character}`

/**
 * Apply edits to one file's text.
 *
 * Overlapping edits are REJECTED, not merged. Two edits over the same span mean
 * the caller computed the change twice or computed it from stale positions, and
 * silently letting one win produces a file nobody intended — the same class of
 * damage as the regex it replaced.
 */
export function applyEdits(text: string, edits: readonly Edit[]): PatchResult {
  const resolved: (AppliedEdit & { source: Edit })[] = []

  for (const edit of edits) {
    const startOffset = offsetOf(text, edit.range.start.line, edit.range.start.character)
    const endOffset = offsetOf(text, edit.range.end.line, edit.range.end.character)
    if (startOffset === -1 || endOffset === -1)
      return { kind: "rejected", why: `the range ${rangeKey(edit.range)} does not exist in this file` }
    if (endOffset < startOffset)
      return { kind: "rejected", why: `the range ${rangeKey(edit.range)} ends before it starts` }
    resolved.push({ range: edit.range, startOffset, endOffset, newText: edit.newText, source: edit })
  }

  const sorted = [...resolved].sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset)
  const conflicts: [Edit, Edit][] = []
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1]!
    const current = sorted[i]!
    // touching ranges are fine; overlapping ones are two answers to one question
    if (current.startOffset < previous.endOffset) conflicts.push([previous.source, current.source])
  }
  if (conflicts.length > 0)
    return {
      kind: "rejected",
      why: `${conflicts.length} pair(s) of edits overlap — two edits over one span means the change was computed twice or from stale positions`,
      conflicts,
    }

  // BACKWARDS: applying forwards shifts every later offset, which is how a
  // correctly computed patch lands in the wrong place
  let out = text
  for (let i = sorted.length - 1; i >= 0; i--) {
    const edit = sorted[i]!
    out = out.slice(0, edit.startOffset) + edit.newText + out.slice(edit.endOffset)
  }

  return {
    kind: "ok",
    text: out,
    applied: sorted.map(({ range, startOffset, endOffset, newText }) => ({ range, startOffset, endOffset, newText })),
  }
}

/**
 * Prove nothing outside the edited ranges changed.
 *
 * Reconstructs the original from the patched text and the applied edits, and
 * compares. This is the S42 guarantee as a computation rather than as a claim:
 * if a single byte outside an intended range moved, the reconstruction differs.
 */
export function verifyUntouched(original: string, patched: string, applied: readonly AppliedEdit[]): {
  ok: boolean
  why: string
} {
  const sorted = [...applied].sort((a, b) => a.startOffset - b.startOffset)
  let rebuilt = ""
  let cursor = 0
  let patchedCursor = 0

  for (const edit of sorted) {
    const between = edit.startOffset - cursor
    rebuilt += patched.slice(patchedCursor, patchedCursor + between)
    patchedCursor += between
    // skip the replacement in the patched text, restore the original span
    rebuilt += original.slice(edit.startOffset, edit.endOffset)
    patchedCursor += edit.newText.length
    cursor = edit.endOffset
  }
  rebuilt += patched.slice(patchedCursor)

  return rebuilt === original
    ? { ok: true, why: `${applied.length} edit(s) applied; every byte outside them is identical` }
    : {
        ok: false,
        why: "text outside the edited ranges changed — the patch did something it did not declare",
      }
}

// --------------------------------------------------------------------------
// Sprint 40 — diagnostics as a first-class signal
// --------------------------------------------------------------------------

export interface CompletionCheck {
  readonly allowed: boolean
  readonly errors: readonly LspDiagnostic[]
  readonly why: string
}

/**
 * May a run claim it finished?
 *
 * An error diagnostic says no, and a passing shell command does not overrule
 * it. The two disagree constantly — `npx tsc` picks up whichever tsconfig it
 * happens to find, while the language server holds the project's real compiler
 * options — and the one that read the project wins.
 *
 * A file whose diagnostics were never obtained also says no. "I did not look"
 * is not "it is clean", and this is the sprint where that distinction stops
 * being a slogan and starts blocking a completion claim.
 */
export function completionAllowed(
  perFile: ReadonlyMap<string, { kind: "ok"; value: readonly LspDiagnostic[] } | { kind: "unavailable"; why: string }>,
  options: { requireDiagnostics?: boolean } = {},
): CompletionCheck {
  const errors: LspDiagnostic[] = []
  const missing: string[] = []

  for (const [uri, result] of perFile) {
    if (result.kind === "unavailable") {
      missing.push(`${uri} (${result.why})`)
      continue
    }
    errors.push(...result.value.filter((d) => d.severity === "error"))
  }

  if (errors.length > 0) {
    return {
      allowed: false,
      errors,
      why:
        `${errors.length} error diagnostic(s) remain: ` +
        `${errors.slice(0, 3).map((e) => `${e.uri}: ${e.message}`).join("; ")}` +
        ` — a passing text command does not overrule the compiler that read this project`,
    }
  }

  if (missing.length > 0 && options.requireDiagnostics !== false) {
    return {
      allowed: false,
      errors: [],
      why: `no diagnostics were available for ${missing.length} changed file(s): ${missing.slice(0, 3).join("; ")} — "not checked" is not "clean"`,
    }
  }

  return { allowed: true, errors: [], why: `${perFile.size} changed file(s) checked, no error diagnostics` }
}
