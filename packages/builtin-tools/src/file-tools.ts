/**
 * File tools on the safe tool runtime. All paths are confined to the workspace.
 *
 * Mutation compensation is PER-INVOCATION: each mutating execution writes its
 * own backup file (outside the workspace, keyed by executionId) and returns a
 * MutationReceipt. Rollback is driven ONLY by that receipt — there is no shared
 * path-keyed backup map. A call that fails BEFORE mutating (missing file, find
 * text not present) returns `mutationStarted: false`, so the runner never
 * "restores" an earlier call's bytes over completed work (the 2026-07-23
 * multi-11 incident: a redundant failed retry silently reverted both files).
 */
import { createHash, randomUUID } from "crypto"
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { policy, type MutationReceipt, type ToolContext, type ToolDefinition, type ToolResult } from "@abdo/tools"
import { resolveInWorkspace } from "./workspace"

const str = (o: unknown, k: string): string | undefined => {
  const v = (o as Record<string, unknown>)?.[k]
  return typeof v === "string" ? v : undefined
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex")

/** Backups live OUTSIDE the workspace so they never pollute the task's git diff. */
const BACKUP_DIR = join(tmpdir(), "abdo-tool-backups")

/**
 * Commit a text replacement as one same-directory rename. A crash can leave a
 * clearly-named temporary file, but can never expose a half-written target.
 */
function atomicWriteText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${randomUUID()}.abdo-write.tmp`)
  let handle: number | undefined
  try {
    handle = openSync(temporary, "wx", 0o600)
    writeFileSync(handle, content, "utf8")
    fsyncSync(handle)
    closeSync(handle)
    handle = undefined
    renameSync(temporary, path)
  } catch (error) {
    if (handle !== undefined) closeSync(handle)
    if (existsSync(temporary)) rmSync(temporary, { force: true })
    throw error
  }
}

/**
 * Line endings, and why `edit_file` may not compare raw bytes.
 *
 * FOUND IN A LIVE RUN (2026-08-20). A 9B model produced a CORRECT patch for the
 * task -- right route, right guard, right table -- and `edit_file` refused it
 * three times running. The file was authored on Windows and its lines end
 * `\r\n`; the model's `find` string ended `\n`; `before.includes(find)` is a
 * byte comparison, so the text was "not present" while being present on screen
 * in front of anyone who looked. The model retried the identical, correct edit,
 * the repeated-call guard then blocked it, the no-progress guard fired, and the
 * run died looking exactly like a model that could not do the job.
 *
 * Two things were wrong and both are fixed here:
 *
 *  1. The match is now made on line-ending-normalised text, and the resulting
 *     offsets are mapped BACK onto the original bytes, so only the edited span
 *     changes and the rest of the file keeps whatever endings it had. Rewriting
 *     the whole file to one convention would "work" and would turn a two-line
 *     patch into a diff touching every line -- a fix nobody could review.
 *  2. `find text not present` is replaced by a message that says WHICH line
 *     stopped matching and what is actually there. A tool that reports failure
 *     without a way to succeed leaves a model only one move -- try the same
 *     thing again -- and that is what the logs show it doing.
 */
const LF = (s: string): string => s.replace(/\r\n/g, "\n")

/** Dominant line ending of a file, so a replacement is written in its dialect. */
function dominantEol(text: string): "\r\n" | "\n" {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/\n/g) ?? []).length - crlf
  return crlf > lf ? "\r\n" : "\n"
}

/**
 * Index i of the normalised text -> index in the original text.
 * Length is normalised.length + 1 so an end offset is always addressable.
 */
function offsetMap(original: string): number[] {
  const map: number[] = []
  for (let i = 0; i < original.length; i++) {
    if (original[i] === "\r" && original[i + 1] === "\n") continue // the pair is one \n normalised
    map.push(original[i] === "\n" && original[i - 1] === "\r" ? i - 1 : i)
  }
  map.push(original.length)
  return map
}

/**
 * Why a `find` did not match, in terms the caller can act on.
 *
 * Compares line by line against the best-aligned position in the file, so the
 * answer is "line 3 of your find text differs; the file has X there" rather
 * than "no".
 */
function explainNoMatch(before: string, find: string, path: string): string {
  const beforeLines = LF(before).split("\n")
  const findLines = LF(find).split("\n")
  const first = findLines[0] ?? ""
  if (first.trim() === "")
    return `find text not present in ${path}: its first line is blank, so there is nothing to anchor on — start the find text at a distinctive line`

  // The double-escape, said plainly. When the repair above could not rescue it
  // (the unescaped form did not match either), the useful thing to report is
  // still WHY the text is one long line — not the nearest lookalike, which is
  // what a live run was told seven times while it burned its budget.
  if (findLines.length === 1 && /\\n/.test(find))
    return (
      `find text not present in ${path}: your find text contains the two characters \\n where it should contain line breaks — ` +
      `it was escaped twice, so the whole thing is one line. Send the text with real newlines.`
    )

  /**
   * The anchor is CHOSEN BY ALIGNMENT, not by being first.
   *
   * FOUND BY REVIEW (2026-08-20), and it is worse than the silence it replaced.
   * The first version took the first trim-equal line in the file, so a find
   * beginning with `}` or `  });` — every second block in a JavaScript file —
   * anchored on the earliest brace and then reported a difference against a
   * line from an unrelated function. Two consequences, both measured:
   *
   *   - the model is handed a confident WRONG move, where before it was handed
   *     a useless one;
   *   - and if it obeys, the corrected find can match somewhere real, so the
   *     edit SUCCEEDS in the wrong place. A misleading diagnostic that ends in
   *     a successful write is the most expensive kind of help.
   *
   * There was also a short circuit hiding in the shape: the anchor was picked
   * by TRIM equality and the comparison was RAW, so at i === 0 the
   * "differs only in whitespace" branch was true by construction whenever it
   * was reached — the loop could never look at line 2.
   *
   * So: every candidate anchor is scored by how many of its following lines
   * actually match, an exactly-equal first line outranks a trim-equal one, and
   * the report names the best-aligned site.
   */
  const candidates: { index: number; exact: boolean; score: number }[] = []
  for (let k = 0; k < beforeLines.length; k++) {
    const line = beforeLines[k]!
    const exact = line === first
    if (!exact && line.trim() !== first.trim()) continue
    let score = 0
    while (score < findLines.length && beforeLines[k + score] === findLines[score]) score++
    candidates.push({ index: k, exact, score })
  }

  if (candidates.length === 0) {
    const needle = first.trim().slice(0, 24)
    const loose = beforeLines.findIndex((l) => l.includes(needle))
    return loose === -1
      ? `find text not present in ${path}: its FIRST line is nowhere in the file — re-read the file and copy an anchor from it exactly`
      : `find text not present in ${path}: its first line is not an exact line of the file; the closest is line ${loose + 1}: ${JSON.stringify(beforeLines[loose])}`
  }

  candidates.sort((a, b) => b.score - a.score || Number(b.exact) - Number(a.exact) || a.index - b.index)
  const best = candidates[0]!
  const where =
    candidates.length > 1
      ? ` (its first line occurs ${candidates.length} times; this is the closest match, at line ${best.index + 1})`
      : ""

  for (let i = 0; i < findLines.length; i++) {
    const mine = findLines[i] ?? ""
    const theirs = beforeLines[best.index + i]
    if (theirs === undefined)
      return `find text not present in ${path}${where}: it runs past the end of the file after line ${best.index + i}`
    if (theirs !== mine) {
      const sameTrimmed = theirs.trim() === mine.trim()
      return (
        `find text not present in ${path}${where}: line ${i + 1} of your find text differs from line ${best.index + i + 1} of the file` +
        (sameTrimmed ? " only in leading/trailing whitespace" : "") +
        `. file has ${JSON.stringify(theirs)}, you sent ${JSON.stringify(mine)}`
      )
    }
  }
  return `find text not present in ${path}`
}

function writeBackup(executionId: string, content: string): string {
  // [CL-00A:ALLOW file_tools_pep_executor]
  mkdirSync(BACKUP_DIR, { recursive: true })
  const file = join(BACKUP_DIR, `${executionId}.bak`)
  // [CL-00A:ALLOW file_tools_pep_executor]
  writeFileSync(file, content, "utf8")
  return file
}

/**
 * Restore a receipt's exact prior bytes (or delete a created file). Exported so
 * a later verifier / crash recovery can compensate from a persisted receipt.
 * Verifies the backup still matches `beforeHash` before restoring — a hash
 * mismatch means the backup is not what the receipt promised, so it refuses.
 */
export function rollbackFromReceipt(workspace: string, receipt: MutationReceipt): void {
  if (!receipt.mutationStarted || !receipt.path) return
  const abs = resolveInWorkspace(workspace, receipt.path)
  if (receipt.existedBefore === false) {
    // The call CREATED the file; compensation is deletion.
    // [CL-00A:ALLOW file_tools_pep_executor]
    if (existsSync(abs)) rmSync(abs)
    return
  }
  if (!receipt.backupPath || !existsSync(receipt.backupPath)) {
    throw new Error(`rollback backup missing for ${receipt.path} (execution ${receipt.executionId})`)
  }
  const backup = readFileSync(receipt.backupPath, "utf8")
  if (receipt.beforeHash && sha256(backup) !== receipt.beforeHash) {
    throw new Error(`rollback backup hash mismatch for ${receipt.path} (execution ${receipt.executionId})`)
  }
  // [CL-00A:ALLOW file_tools_pep_executor]
  atomicWriteText(abs, backup)
}

export function readFileTool(workspace: string): ToolDefinition {
  return {
    name: "read_file",
    policy: policy({ risk: "read", secretsAccess: "none" }),
    description:
      "Read a UTF-8 text file inside the workspace. Optionally read a range of lines with `offset` (1-based first line) and `limit` (how many lines).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path" },
        // FOUND BY AUDIT (2026-08-20). When a whole-file read was too large for
        // the window, the conversation told the model to "ask for a line range"
        // — and no tool in the product could do that. The schema took `path`
        // and nothing else, `additionalProperties` was false, and nothing
        // resolved the `tool-output://` reference the message named. A live run
        // followed the instruction literally and got `no such file:
        // tool-output://run_command/tex_…`, twice.
        //
        // An affordance that is advertised and not implemented is worse than
        // none: the model spends its turns on the route we told it to take.
        // So the range read is real now, and the message names THIS.
        offset: { type: "number", description: "First line to return, 1-based. Default 1." },
        limit: { type: "number", description: "How many lines to return. Default: to the end of the file." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async run(input): Promise<ToolResult> {
      const p = str(input, "path")
      if (!p) return { ok: false, error: "read_file requires { path }" }
      const num = (k: string): number | undefined => {
        const v = (input as Record<string, unknown>)?.[k]
        return typeof v === "number" && Number.isFinite(v) ? v : undefined
      }
      const offset = num("offset")
      const limit = num("limit")
      try {
        const abs = resolveInWorkspace(workspace, p)
        if (!existsSync(abs)) return { ok: false, error: `no such file: ${p}` }
        const whole = readFileSync(abs, "utf8")
        if (offset === undefined && limit === undefined) return { ok: true, output: { path: p, content: whole } }

        /**
         * A file that ends in a newline has N lines, not N+1.
         *
         * FOUND BY REVIEW (2026-08-20): `split` emits a trailing empty element
         * for every newline-terminated file — the normal case — so `totalLines`
         * was N+1, `offset: N+1` returned `ok: true` with an empty string, and
         * the past-the-end error misstated the count. Four symptoms, one cause.
         * The disagreement was with `wc -l`, `grep -n` and `sed -n`, which the
         * model uses in the same run and reasonably believes.
         */
        const lines = whole.split(/\r?\n/)
        if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
        const from = Math.max(1, Math.floor(offset ?? 1))
        if (from > lines.length) {
          return { ok: false, error: `offset ${from} is past the end of ${p}, which has ${lines.length} line(s)` }
        }
        const count = limit === undefined ? lines.length : Math.max(1, Math.floor(limit))
        const slice = lines.slice(from - 1, from - 1 + count)
        return {
          ok: true,
          output: {
            path: p,
            // The range is stated, because a slice that does not say which
            // slice it is gets reasoned about as though it were the file.
            firstLine: from,
            lastLine: from + slice.length - 1,
            totalLines: lines.length,
            content: slice.join("\n"),
          },
        }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
  }
}

export function listDirTool(workspace: string): ToolDefinition {
  return {
    name: "list_dir",
    policy: policy({ risk: "read" }),
    description: "List directory entries inside the workspace.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Workspace-relative dir path (default '.')" } },
      additionalProperties: false,
    },
    async run(input): Promise<ToolResult> {
      const p = str(input, "path") ?? "."
      try {
        const abs = resolveInWorkspace(workspace, p)
        const entries = readdirSync(abs).map((name) => ({
          name,
          dir: statSync(resolveInWorkspace(workspace, `${p}/${name}`)).isDirectory(),
        }))
        return { ok: true, output: { path: p, entries } }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
  }
}

export function writeFileTool(workspace: string): ToolDefinition {
  return {
    name: "write_file",
    policy: policy({ risk: "medium", reversible: true, supportsDryRun: true }),
    description: "Create or overwrite a UTF-8 file inside the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path" },
        content: { type: "string", description: "Full file content to write" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    async dryRun(input) {
      const p = str(input, "path")
      if (!p) throw new Error("write_file requires { path }")
      resolveInWorkspace(workspace, p) // validate only; no write
      return { wouldWrite: p }
    },
    async run(input, ctx: ToolContext): Promise<ToolResult> {
      const p = str(input, "path")
      const content = str(input, "content")
      if (!p || content === undefined) return { ok: false, error: "write_file requires { path, content }" }
      const executionId = ctx.executionId ?? `tex_${randomUUID()}`
      try {
        const abs = resolveInWorkspace(workspace, p)
        if (ctx.dryRun) return { ok: true, output: { path: p, dryRun: true } }
        const existedBefore = existsSync(abs)
        const before = existedBefore ? readFileSync(abs, "utf8") : null
        const beforeHash = before === null ? null : sha256(before)
        // Precondition work is done; from here the mutation starts.
        const backupPath = before === null ? undefined : writeBackup(executionId, before)
        const base: Omit<MutationReceipt, "mutationCommitted" | "afterHash"> = {
          executionId,
          path: p,
          beforeHash,
          existedBefore,
          ...(backupPath ? { backupPath } : {}),
          mutationStarted: true,
        }
        try {
          // [CL-00A:ALLOW file_tools_pep_executor]
          atomicWriteText(abs, content)
          return {
            ok: true,
            output: { path: p, bytes: Buffer.byteLength(content) },
            mutation: { ...base, afterHash: sha256(content), mutationCommitted: true },
          }
        } catch (e) {
          return {
            ok: false,
            error: e instanceof Error ? e.message : String(e),
            mutation: { ...base, mutationCommitted: false },
          }
        }
      } catch (e) {
        // Path resolution / validation failed before any mutation — no receipt needed.
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
    async rollback(receipt: MutationReceipt) {
      rollbackFromReceipt(workspace, receipt)
    },
  }
}

export function editFileTool(workspace: string): ToolDefinition {
  return {
    name: "edit_file",
    policy: policy({ risk: "medium", reversible: true }),
    description: "Replace occurrences of `find` with `replace` in a workspace file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path" },
        find: { type: "string", description: "Exact text to find" },
        replace: { type: "string", description: "Replacement text" },
        all: { type: "boolean", description: "Replace all occurrences (default first)" },
      },
      required: ["path", "find", "replace"],
      additionalProperties: false,
    },
    async run(input, ctx: ToolContext): Promise<ToolResult> {
      const p = str(input, "path")
      const find = str(input, "find")
      const replace = str(input, "replace")
      if (!p || find === undefined || replace === undefined) {
        return { ok: false, error: "edit_file requires { path, find, replace }" }
      }
      const executionId = ctx.executionId ?? `tex_${randomUUID()}`
      try {
        const abs = resolveInWorkspace(workspace, p)
        if (!existsSync(abs)) {
          // Precondition failure — nothing mutated, nothing to compensate.
          return {
            ok: false,
            error: `no such file: ${p}`,
            mutation: { executionId, path: p, beforeHash: null, mutationStarted: false, mutationCommitted: false },
          }
        }
        const before = readFileSync(abs, "utf8")
        const beforeHash = sha256(before)
        // Match on normalised text (see the note above `LF`): a correct patch
        // written with \n must not be refused by a file written with \r\n.
        const beforeN = LF(before)
        let findN = LF(find)
        let replaceEffective = replace
        let repairedNote: string | undefined

        /**
         * A find text whose newlines were escaped TWICE is repaired, not refused.
         *
         * FOUND IN A LIVE RUN (2026-08-20). The model sent
         *
         *     "const path = require('path');\\nconst fs = require('fs');\\n…"
         *
         * — the two characters backslash and n, and not one line break in the
         * whole string. Every such call failed, and the diagnostic then compared
         * a one-line blob against a line of the file and reported the nearest
         * lookalike, which is true and useless. Seven of the run's tool failures
         * were this, and it ended cancelled on the wall clock.
         *
         * Sprint 47 already decided what to do with this shape of mistake: a
         * MECHANICALLY repairable argument is repaired rather than refused, the
         * repair is bounded to one shape, and the result is MARKED so a call
         * that needed fixing never looks like one that arrived correct.
         *
         * The bound here is strict: only when the text has NO real line breaks,
         * only for `\n` and `\r\n`, and only if the unescaped form actually
         * matches the file. If it does not match, nothing is repaired and the
         * message says what is wrong instead of guessing.
         */
        const unescape = (s: string): string => s.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n")
        if (!findN.includes("\n") && /\\n/.test(findN)) {
          const candidate = unescape(findN)
          if (beforeN.includes(candidate)) {
            findN = candidate
            replaceEffective = unescape(LF(replace))
            repairedNote = "your find/replace text had its line breaks escaped twice (the characters \\n instead of real newlines); repaired mechanically"
          }
        }
        if (findN === "") {
          return {
            ok: false,
            error: "edit_file `find` is empty; an empty match would insert at every position",
            mutation: { executionId, path: p, beforeHash, mutationStarted: false, mutationCommitted: false },
          }
        }
        if (!beforeN.includes(findN)) {
          // Precondition failure — the disk was NOT touched. mutationStarted:false
          // is what stops the runner from restoring an earlier call's backup.
          return {
            ok: false,
            error: explainNoMatch(before, find, p),
            mutation: { executionId, path: p, beforeHash, mutationStarted: false, mutationCommitted: false },
          }
        }
        const backupPath = writeBackup(executionId, before)
        const base: Omit<MutationReceipt, "mutationCommitted" | "afterHash"> = {
          executionId,
          path: p,
          beforeHash,
          backupPath,
          existedBefore: true,
          mutationStarted: true,
        }
        try {
          const all = (input as { all?: boolean }).all === true
          // The replacement is written in the FILE's dialect, not the model's:
          // a \n patch dropped into a \r\n file otherwise leaves a block of
          // mixed endings that the next exact-match edit cannot anchor to.
          const eol = dominantEol(before)
          const replaceInFileDialect = eol === "\r\n" ? LF(replaceEffective).replace(/\n/g, "\r\n") : LF(replaceEffective)
          // Offsets are found in normalised space and applied to the ORIGINAL
          // bytes, so every line the edit did not touch is byte-identical.
          const map = offsetMap(before)
          let cursor = 0
          let out = ""
          let tail = 0
          let replaced = 0
          for (;;) {
            const idx = beforeN.indexOf(findN, cursor)
            if (idx === -1) break
            const start = map[idx]!
            const end = map[idx + findN.length]!
            out += before.slice(tail, start) + replaceInFileDialect
            tail = end
            replaced++
            cursor = idx + findN.length
            if (!all) break
          }
          const after = out + before.slice(tail)
          // [CL-00A:ALLOW file_tools_pep_executor]
          atomicWriteText(abs, after)
          return {
            ok: true,
            // MARKED, on the Sprint 47 rule: a call that needed repairing must
            // never look identical to one that arrived correct, or the model
            // learns that its malformed shape works.
            output: { path: p, replaced, ...(repairedNote !== undefined ? { repaired: repairedNote } : {}) },
            mutation: { ...base, afterHash: sha256(after), mutationCommitted: true },
          }
        } catch (e) {
          return {
            ok: false,
            error: e instanceof Error ? e.message : String(e),
            mutation: { ...base, mutationCommitted: false },
          }
        }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
    async rollback(receipt: MutationReceipt) {
      rollbackFromReceipt(workspace, receipt)
    },
  }
}
