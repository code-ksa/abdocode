import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { PolicyToolRunner, ToolRegistry, type Approver } from "@abdo/tools"
import {
  editFileTool,
  PathEscapeError,
  readFileTool,
  registerBuiltins,
  resolveInWorkspace,
  shellTool,
  writeFileTool,
} from "../src/index"

function ws(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-ws-"))
    try {
      await fn(dir)
    } finally {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) } catch { /* best-effort */ }
    }
  }
}

const yes: Approver = { approve: async () => true }
const ctx = { dryRun: false }

describe("workspace confinement", () => {
  test(
    "traversal and absolute escapes are rejected",
    ws((dir) => {
      expect(resolveInWorkspace(dir, "a/b.txt")).toContain(dir)
      expect(() => resolveInWorkspace(dir, "../escape.txt")).toThrow(PathEscapeError)
      expect(() => resolveInWorkspace(dir, "a/../../escape.txt")).toThrow(PathEscapeError)
    }),
  )
})

describe("read/write/edit tools", () => {
  test(
    "write then read round-trips inside the workspace",
    ws(async (dir) => {
      const w = writeFileTool(dir)
      const r = readFileTool(dir)
      const wr = await w.run({ path: "notes/a.txt", content: "hello" }, ctx)
      expect(wr.ok).toBe(true)
      expect(readFileSync(join(dir, "notes/a.txt"), "utf8")).toBe("hello")
      const rd = await r.run({ path: "notes/a.txt" }, ctx)
      expect(rd.ok).toBe(true)
      expect((rd as { output: { content: string } }).output.content).toBe("hello")
    }),
  )

  test(
    "read/write refuse to leave the workspace",
    ws(async (dir) => {
      const w = writeFileTool(dir)
      const res = await w.run({ path: "../evil.txt", content: "x" }, ctx)
      expect(res.ok).toBe(false)
      expect(existsSync(join(dir, "..", "evil.txt"))).toBe(false)
    }),
  )

  test(
    "write rollback restores prior bytes from ITS OWN receipt; new-file rollback deletes",
    ws(async (dir) => {
      const w = writeFileTool(dir)
      // new file: rollback of a create = delete
      const created = await w.run({ path: "f.txt", content: "v1" }, ctx)
      expect(created.ok).toBe(true)
      expect(created.mutation?.mutationCommitted).toBe(true)
      expect(created.mutation?.existedBefore).toBe(false)
      await w.rollback!(created.mutation!)
      expect(existsSync(join(dir, "f.txt"))).toBe(false)
      // existing file: rollback restores the exact prior bytes
      writeFileSync(join(dir, "f.txt"), "original")
      const changed = await w.run({ path: "f.txt", content: "changed" }, ctx)
      expect(changed.ok).toBe(true)
      expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("changed")
      await w.rollback!(changed.mutation!)
      expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("original")
    }),
  )

  test(
    "edit replaces text and rolls back via receipt; missing find text = mutationStarted:false",
    ws(async (dir) => {
      writeFileSync(join(dir, "code.ts"), "const x = 1")
      const e = editFileTool(dir)
      const miss = await e.run({ path: "code.ts", find: "nope", replace: "y" }, ctx)
      expect(miss.ok).toBe(false)
      expect(miss.mutation?.mutationStarted).toBe(false) // precondition failure: nothing to compensate
      const ok = await e.run({ path: "code.ts", find: "1", replace: "2" }, ctx)
      expect(ok.ok).toBe(true)
      expect(ok.mutation?.mutationStarted).toBe(true)
      expect(ok.mutation?.mutationCommitted).toBe(true)
      expect(readFileSync(join(dir, "code.ts"), "utf8")).toBe("const x = 2")
      await e.rollback!(ok.mutation!)
      expect(readFileSync(join(dir, "code.ts"), "utf8")).toBe("const x = 1")
    }),
  )

  test(
    "dry-run write performs no side effect",
    ws(async (dir) => {
      const w = writeFileTool(dir)
      const res = await w.run({ path: "d.txt", content: "x" }, { dryRun: true })
      expect(res.ok).toBe(true)
      expect(existsSync(join(dir, "d.txt"))).toBe(false)
    }),
  )
})

describe("per-invocation rollback (the 2026-07-23 multi-11 incident)", () => {
  const runnerFor = (dir: string) => new PolicyToolRunner(registerBuiltins(new ToolRegistry(), { workspace: dir, shell: false }), { approver: yes })

  test(
    "INCIDENT REPLAY: successful rename survives a redundant failed retry",
    ws(async (dir) => {
      // original: const K11 = 11 -> edit K11 -> LIMIT_11 succeeds; the model
      // redundantly retries; the retry fails "find text not present". The file
      // must KEEP the new content — the old code rolled it back to K11 here.
      writeFileSync(join(dir, "c11.ts"), "export const K11 = 11\n")
      const runner = runnerFor(dir)
      const first = await runner.run({ name: "edit_file", input: { path: "c11.ts", find: "K11", replace: "LIMIT_11" } }, { executionId: "tex_1" })
      expect(first.ok).toBe(true)
      const retry = await runner.run({ name: "edit_file", input: { path: "c11.ts", find: "K11", replace: "LIMIT_11" } }, { executionId: "tex_2" })
      expect(retry.ok).toBe(false)
      expect(!retry.ok && retry.rollback).toBeUndefined() // precondition failure => NO compensation
      expect(readFileSync(join(dir, "c11.ts"), "utf8")).toBe("export const LIMIT_11 = 11\n")
    }),
  )

  test(
    "A and B succeed, C fails before mutating: A and B stay on disk",
    ws(async (dir) => {
      writeFileSync(join(dir, "f.ts"), "alpha beta gamma")
      const runner = runnerFor(dir)
      const a = await runner.run({ name: "edit_file", input: { path: "f.ts", find: "alpha", replace: "ALPHA" } }, { executionId: "tex_a" })
      const b = await runner.run({ name: "edit_file", input: { path: "f.ts", find: "beta", replace: "BETA" } }, { executionId: "tex_b" })
      const c = await runner.run({ name: "edit_file", input: { path: "f.ts", find: "delta", replace: "DELTA" } }, { executionId: "tex_c" })
      expect(a.ok && b.ok).toBe(true)
      expect(c.ok).toBe(false)
      expect(readFileSync(join(dir, "f.ts"), "utf8")).toBe("ALPHA BETA gamma")
    }),
  )

  test(
    "two executions on the same file: the 2nd failing NEVER uses the 1st's backup",
    ws(async (dir) => {
      writeFileSync(join(dir, "g.ts"), "v1")
      const runner = runnerFor(dir)
      // execution 1 creates backup 1 (before = "v1") and commits "v2"
      const one = await runner.run({ name: "write_file", input: { path: "g.ts", content: "v2" } }, { executionId: "tex_one" })
      expect(one.ok).toBe(true)
      expect(one.ok && one.mutation?.executionId).toBe("tex_one")
      // execution 2 fails BEFORE mutating (find missing) — with the old shared
      // path-keyed map this restored backup 1 and erased v2
      const two = await runner.run({ name: "edit_file", input: { path: "g.ts", find: "not-there", replace: "x" } }, { executionId: "tex_two" })
      expect(two.ok).toBe(false)
      expect(readFileSync(join(dir, "g.ts"), "utf8")).toBe("v2")
    }),
  )

  test(
    "verification-failure compensation: rollback(receipt) restores the exact bytes of ITS OWN execution",
    ws(async (dir) => {
      writeFileSync(join(dir, "h.ts"), "original-bytes")
      const e = editFileTool(dir)
      const done = await e.run({ path: "h.ts", find: "original", replace: "changed" }, { ...ctx, executionId: "tex_v" })
      expect(done.ok).toBe(true)
      expect(done.mutation?.executionId).toBe("tex_v")
      expect(readFileSync(join(dir, "h.ts"), "utf8")).toBe("changed-bytes")
      // a later postcondition/verification failure compensates via the receipt
      await e.rollback!(done.mutation!)
      expect(readFileSync(join(dir, "h.ts"), "utf8")).toBe("original-bytes")
    }),
  )

  test(
    "receipt survives as data: rollback from a REHYDRATED receipt (crash-recovery path) verifies hashes",
    ws(async (dir) => {
      writeFileSync(join(dir, "k.ts"), "before-crash")
      const w = writeFileTool(dir)
      const done = await w.run({ path: "k.ts", content: "after-crash" }, { ...ctx, executionId: "tex_crash" })
      expect(done.ok).toBe(true)
      // simulate a restart: the receipt comes back from the event log as plain JSON
      const rehydrated = JSON.parse(JSON.stringify(done.mutation))
      await w.rollback!(rehydrated)
      expect(readFileSync(join(dir, "k.ts"), "utf8")).toBe("before-crash")
      // a receipt whose backup no longer matches its beforeHash must REFUSE
      const tampered = { ...rehydrated, beforeHash: "0".repeat(64) }
      writeFileSync(join(dir, "k.ts"), "after-crash")
      await expect(w.rollback!(tampered)).rejects.toThrow("hash mismatch")
      expect(readFileSync(join(dir, "k.ts"), "utf8")).toBe("after-crash") // untouched
    }),
  )
})

describe("shell tool", () => {
  test(
    "runs a command and captures stdout / exit code",
    ws(async (dir) => {
      const sh = shellTool(dir)
      const res = await sh.run({ command: "echo hello-abdo" }, ctx)
      expect(res.ok).toBe(true)
      expect((res as { output: { stdout: string } }).output.stdout).toContain("hello-abdo")
    }),
  )

  test(
    "a hung command is killed by its timeout",
    ws(async (dir) => {
      const sh = shellTool(dir)
      const res = await sh.run({ command: "sleep 2", timeoutMs: 150 }, ctx)
      expect(res.ok).toBe(false)
      expect((res as { error: string }).error).toContain("timeout")
    }),
  )

  test(
    "cwd stays confined to the workspace",
    ws(async (dir) => {
      const sh = shellTool(dir)
      const res = await sh.run({ command: "echo hi", cwd: "../.." }, ctx)
      expect(res.ok).toBe(false)
    }),
  )

  test(
    "TEST 1: exit 1 with EMPTY stdout/stderr returns a structured diagnostic, not a bare 'exit 1'",
    ws(async (dir) => {
      const sh = shellTool(dir)
      const res = await sh.run({ command: "exit 1" }, ctx)
      expect(res.ok).toBe(false)
      const out = (res as { output: Record<string, unknown> }).output
      expect(out.exitCode).toBe(1)
      expect(out.stdout).toBe("")
      expect(out.stderr).toBe("")
      expect(out.timedOut).toBe(false)
      expect(out.aborted).toBe(false)
      expect(typeof out.durationMs).toBe("number")
      expect(out.failureClass).toBe("empty_failure_output")
      expect(String(out.diagnostic)).toContain("no stdout or stderr")
      // the error string carries the proven facts, never an information-poor "exit 1: "
      expect((res as { error: string }).error).toContain("empty_failure_output")
      // a stable fingerprint accompanies the result (duration excluded)
      expect(typeof (res as { resultFingerprint?: string }).resultFingerprint).toBe("string")
    }),
  )

  test(
    "exit 127 is classified command_not_found (proven, not guessed)",
    ws(async (dir) => {
      const sh = shellTool(dir)
      const res = await sh.run({ command: "this-binary-does-not-exist-xyz" }, ctx)
      expect(res.ok).toBe(false)
      const out = (res as { output: Record<string, unknown> }).output
      expect(out.exitCode).toBe(127)
      expect(out.failureClass).toBe("command_not_found")
    }),
  )

  test(
    "TEST 5: a timeout and an ordinary exit 1 are classified DIFFERENTLY",
    ws(async (dir) => {
      const sh = shellTool(dir)
      const timedOut = await sh.run({ command: "sleep 2", timeoutMs: 150 }, ctx)
      const exit1 = await sh.run({ command: "exit 1" }, ctx)
      expect((timedOut as { output: { failureClass: string } }).output.failureClass).toBe("timeout")
      expect((exit1 as { output: { failureClass: string } }).output.failureClass).toBe("empty_failure_output")
      expect((timedOut as { output: { timedOut: boolean } }).output.timedOut).toBe(true)
    }),
  )

  test(
    "the same failing command produces the IDENTICAL resultFingerprint (duration excluded)",
    ws(async (dir) => {
      const sh = shellTool(dir)
      const a = await sh.run({ command: "exit 3" }, ctx)
      const b = await sh.run({ command: "exit 3" }, ctx)
      expect((a as { resultFingerprint: string }).resultFingerprint).toBe((b as { resultFingerprint: string }).resultFingerprint)
      // a genuinely different result must differ
      const c = await sh.run({ command: "exit 4" }, ctx)
      expect((c as { resultFingerprint: string }).resultFingerprint).not.toBe((a as { resultFingerprint: string }).resultFingerprint)
    }),
  )
})

describe("registerBuiltins + PolicyToolRunner integration", () => {
  test(
    "read auto-allowed; shell needs approval; dangerous shell blocked",
    ws(async (dir) => {
      writeFileSync(join(dir, "pkg.json"), '{"name":"demo"}')
      const registry = registerBuiltins(new ToolRegistry(), { workspace: dir })
      const runner = new PolicyToolRunner(registry, { approver: yes })

      const read = await runner.run({ name: "read_file", input: { path: "pkg.json" } })
      expect(read.ok).toBe(true)

      // dangerous command is denied even WITH an approver? No — approver approves,
      // but a destructive command should be denied when the approver says no.
      const denyRunner = new PolicyToolRunner(registry, { approver: { approve: async () => false } })
      const danger = await denyRunner.run({ name: "shell", input: { command: "rm -rf /" } })
      expect(danger.ok).toBe(false)

      const ok = await runner.run({ name: "shell", input: { command: "echo ok" } })
      expect(ok.ok).toBe(true)
    }),
  )
})

describe("edit_file across line-ending dialects", () => {
  // THE LIVE FAILURE THIS LOCKS. A 9B produced a correct patch for a real task
  // and edit_file refused it three times: the target file was authored on
  // Windows (\r\n) and the model's `find` used \n, so a byte comparison said
  // "not present" about text that was plainly there. The model then retried the
  // identical, correct edit until the repeated-call guard blocked it and the
  // run died looking like a model that could not do the job.
  test(
    "a \n patch applies to a \r\n file",
    ws(async (dir) => {
      const original = "const a = 1;\r\napp.put('/x', auth, h);\r\nconst b = 2;\r\n"
      writeFileSync(join(dir, "server.js"), original)
      const tool = editFileTool(dir)
      const res = await tool.run(
        { path: "server.js", find: "app.put('/x', auth, h);\nconst b = 2;", replace: "app.get('/y', auth, g);\napp.put('/x', auth, h);\nconst b = 2;" },
        { executionId: "tex_crlf", dryRun: false } as never,
      )
      expect(res.ok).toBe(true)
      const after = readFileSync(join(dir, "server.js"), "utf8")
      expect(after).toContain("app.get('/y', auth, g);")
      // The inserted text speaks the FILE's dialect...
      expect(after).not.toMatch(/[^\r]\n/)
      // ...and every line the edit did not touch is byte-identical.
      expect(after.startsWith("const a = 1;\r\n")).toBe(true)
      expect(after.endsWith("const b = 2;\r\n")).toBe(true)
    }),
  )

  test(
    "a \r\n patch applies to a \n file, and the file keeps its own endings",
    ws(async (dir) => {
      writeFileSync(join(dir, "a.js"), "one\ntwo\nthree\n")
      const tool = editFileTool(dir)
      const res = await tool.run({ path: "a.js", find: "two\r\nthree", replace: "TWO\r\nTHREE" }, { executionId: "tex_lf", dryRun: false } as never)
      expect(res.ok).toBe(true)
      expect(readFileSync(join(dir, "a.js"), "utf8")).toBe("one\nTWO\nTHREE\n")
    }),
  )

  test(
    "untouched bytes are not rewritten — the diff stays the size of the edit",
    ws(async (dir) => {
      const original = "a\r\nb\r\nc\r\nd\r\n"
      writeFileSync(join(dir, "m.js"), original)
      const tool = editFileTool(dir)
      await tool.run({ path: "m.js", find: "b", replace: "B" }, { executionId: "tex_min", dryRun: false } as never)
      expect(readFileSync(join(dir, "m.js"), "utf8")).toBe("a\r\nB\r\nc\r\nd\r\n")
    }),
  )

  test(
    "all:true replaces every occurrence across dialects",
    ws(async (dir) => {
      writeFileSync(join(dir, "r.js"), "x\r\nkeep\r\nx\r\n")
      const tool = editFileTool(dir)
      const res = await tool.run({ path: "r.js", find: "x", replace: "Y", all: true }, { executionId: "tex_all", dryRun: false } as never)
      expect(res.ok).toBe(true)
      expect((res.output as { replaced: number }).replaced).toBe(2)
      expect(readFileSync(join(dir, "r.js"), "utf8")).toBe("Y\r\nkeep\r\nY\r\n")
    }),
  )

  // A tool that reports failure without a way to succeed leaves a model one
  // move: try the same thing again. That is what the logs show it doing.
  test(
    "a genuine miss says WHICH line differs and what is actually there",
    ws(async (dir) => {
      writeFileSync(join(dir, "d.js"), "alpha\r\nbeta\r\ngamma\r\n")
      const tool = editFileTool(dir)
      const res = await tool.run({ path: "d.js", find: "alpha\nBETA", replace: "z" }, { executionId: "tex_diag", dryRun: false } as never)
      expect(res.ok).toBe(false)
      const err = (res as { error?: string }).error ?? ""
      expect(err).toContain("line 2")
      expect(err).toContain("beta")
      expect((res.mutation as { mutationStarted: boolean }).mutationStarted).toBe(false)
    }),
  )

  test(
    "a find whose first line is nowhere says so instead of pointing at a wrong line",
    ws(async (dir) => {
      writeFileSync(join(dir, "e.js"), "alpha\r\nbeta\r\n")
      const tool = editFileTool(dir)
      const res = await tool.run({ path: "e.js", find: "zeta\nomega", replace: "z" }, { executionId: "tex_diag2", dryRun: false } as never)
      expect(res.ok).toBe(false)
      expect((res as { error?: string }).error ?? "").toContain("FIRST line")
    }),
  )

  test(
    "an empty find is refused rather than inserting everywhere",
    ws(async (dir) => {
      writeFileSync(join(dir, "f.js"), "alpha\r\n")
      const tool = editFileTool(dir)
      const res = await tool.run({ path: "f.js", find: "", replace: "z" }, { executionId: "tex_empty", dryRun: false } as never)
      expect(res.ok).toBe(false)
      expect(readFileSync(join(dir, "f.js"), "utf8")).toBe("alpha\r\n")
    }),
  )
})

describe("read_file's line ranges", () => {
  // The whole offset/limit path shipped with no tests, and two of the three
  // properties it claimed were already false: a newline-terminated file
  // reported N+1 lines (split's trailing empty element), and `offset: N+1`
  // returned ok:true with an empty string instead of refusing.
  const five = "L1\r\nL2\r\nL3\r\nL4\r\nL5\r\n"

  test(
    "a newline-terminated file has the line count wc -l would report",
    ws(async (dir) => {
      writeFileSync(join(dir, "f.txt"), five)
      const res = await readFileTool(dir).run({ path: "f.txt", offset: 1, limit: 100 }, { dryRun: false } as never)
      const out = (res as { output: { firstLine: number; lastLine: number; totalLines: number; content: string } }).output
      expect(out.totalLines).toBe(5)
      expect(out.firstLine).toBe(1)
      expect(out.lastLine).toBe(5)
      expect(out.content.split("\n")).toHaveLength(5)
    }),
  )

  test(
    "an offset one past the last line is refused, not answered with nothing",
    ws(async (dir) => {
      writeFileSync(join(dir, "f.txt"), five)
      const res = await readFileTool(dir).run({ path: "f.txt", offset: 6 }, { dryRun: false } as never)
      expect(res.ok).toBe(false)
      expect((res as { error?: string }).error).toContain("5 line(s)")
    }),
  )

  test(
    "a range in the middle names the lines it actually returned",
    ws(async (dir) => {
      writeFileSync(join(dir, "f.txt"), five)
      const res = await readFileTool(dir).run({ path: "f.txt", offset: 2, limit: 2 }, { dryRun: false } as never)
      const out = (res as { output: { firstLine: number; lastLine: number; content: string } }).output
      expect(out.firstLine).toBe(2)
      expect(out.lastLine).toBe(3)
      expect(out.content).toBe("L2\nL3")
    }),
  )

  test(
    "a file with no trailing newline counts the same way",
    ws(async (dir) => {
      writeFileSync(join(dir, "g.txt"), "a\r\nb")
      const res = await readFileTool(dir).run({ path: "g.txt", offset: 1 }, { dryRun: false } as never)
      expect((res as { output: { totalLines: number } }).output.totalLines).toBe(2)
    }),
  )

  test(
    "no offset and no limit still returns the file untouched",
    ws(async (dir) => {
      writeFileSync(join(dir, "h.txt"), five)
      const res = await readFileTool(dir).run({ path: "h.txt" }, { dryRun: false } as never)
      expect((res as { output: { content: string } }).output.content).toBe(five)
    }),
  )
})

describe("the edit diagnostic points at the best-aligned site, not the first lookalike", () => {
  // FOUND BY REVIEW: the anchor was the FIRST trim-equal line, so a find
  // beginning with `}` or `});` — every second block in a JS file — reported a
  // difference against an unrelated function. Worse than the silence it
  // replaced: a confident wrong move, and if obeyed it can produce a SUCCESSFUL
  // edit in the wrong place.
  // The anchor `}` occurs three times. Only the LAST one aligns for two lines;
  // the first-occurrence rule reports against line 2 and an unrelated `alpha`.
  const file = ["}", "alpha", "}", "beta", "}", "gamma", "delta"].join("\r\n")

  test(
    "a repeated anchor line resolves to the occurrence that actually aligns",
    ws(async (dir) => {
      writeFileSync(join(dir, "m.js"), file)
      const res = await editFileTool(dir).run(
        { path: "m.js", find: "}\ngamma\nomega", replace: "x" },
        { executionId: "tex_anchor", dryRun: false } as never,
      )
      expect(res.ok).toBe(false)
      const err = (res as { error?: string }).error ?? ""
      // the aligned site: find line 3 against file line 7
      expect(err).toContain("line 3 of your find text")
      expect(err).toContain("line 7 of the file")
      expect(err).toContain("delta")
      // and NOT the first lookalike, which would have blamed line 2 / "alpha"
      expect(err).not.toContain("alpha")
    }),
  )

  test(
    "when the first line occurs many times the message says so",
    ws(async (dir) => {
      writeFileSync(join(dir, "n.js"), file)
      const res = await editFileTool(dir).run(
        { path: "n.js", find: "}\nfunction d() {", replace: "x" },
        { executionId: "tex_many", dryRun: false } as never,
      )
      expect(res.ok).toBe(false)
      expect((res as { error?: string }).error ?? "").toContain("occurs 3 times")
    }),
  )
})

describe("a find text whose newlines were escaped twice", () => {
  // FOUND IN A LIVE RUN (2026-08-20). The model sent the two characters
  // backslash and n where its line breaks should have been, and not one real
  // break in the whole string. Every such call failed, and the diagnostic then
  // compared a one-line blob against a line of the file and named the nearest
  // lookalike: true and useless. Seven of that run's tool failures were this,
  // and it ended cancelled on the wall clock.
  //
  // The escape is built from a character code so that no layer of quoting in
  // this file can quietly turn it back into a real newline — which is exactly
  // what happened on the first attempt at writing this test.
  const BS = String.fromCharCode(92)
  const ESC = BS + "n"
  const file = "const a = require('a');\r\nconst b = require('b');\r\nconst c = 1;\r\n"

  test(
    "it is repaired mechanically, applied, and MARKED",
    ws(async (dir) => {
      writeFileSync(join(dir, "s.js"), file)
      const res = await editFileTool(dir).run(
        { path: "s.js", find: `const a = require('a');${ESC}const b = require('b');`, replace: `const a = 1;${ESC}const b = 2;` },
        { executionId: "tex_esc", dryRun: false } as never,
      )
      expect(res.ok).toBe(true)
      expect(String((res as { output: { repaired?: string } }).output.repaired ?? "")).toContain("escaped twice")
      const after = readFileSync(join(dir, "s.js"), "utf8")
      expect(after).toBe("const a = 1;\r\nconst b = 2;\r\nconst c = 1;\r\n")
      expect(after).not.toContain(ESC)
    }),
  )

  test(
    "a correct call is not marked as repaired",
    ws(async (dir) => {
      writeFileSync(join(dir, "s.js"), file)
      const res = await editFileTool(dir).run(
        { path: "s.js", find: "const b = require('b');", replace: "const b = 2;" },
        { executionId: "tex_plain", dryRun: false } as never,
      )
      expect(res.ok).toBe(true)
      expect((res as { output: { repaired?: string } }).output.repaired).toBeUndefined()
    }),
  )

  test(
    "when unescaping still does not match, the message names the real problem",
    ws(async (dir) => {
      writeFileSync(join(dir, "s.js"), file)
      const res = await editFileTool(dir).run(
        { path: "s.js", find: `const zzz = require('z');${ESC}const qqq = 1;`, replace: "x" },
        { executionId: "tex_esc2", dryRun: false } as never,
      )
      expect(res.ok).toBe(false)
      const err = (res as { error?: string }).error ?? ""
      expect(err).toContain("escaped twice")
      expect(err).not.toContain("the closest is line")
    }),
  )
})
