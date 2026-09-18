/**
 * Sprint 21 GATE — zero shell-quoting errors.
 *
 * Every argument here is one that a hand-quoted command line gets wrong on at
 * least one platform: spaces, both kinds of quote, `$HOME`, backticks, `&&`,
 * a semicolon, a newline, a tab, a Windows path with backslashes and a trailing
 * one, `%PATH%`, `!DELAYED!`, Arabic, an emoji, and a glob.
 *
 * The test does not inspect a string — it spawns a REAL process and compares
 * the argv the child actually received, byte for byte, with what was sent. That
 * is the only way to prove the quoting question is gone rather than moved: on
 * Windows the argument goes through CreateProcess's own parsing rules, and a
 * "safe quoting" helper that looks right in a log can still arrive wrong.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ToolRegistry, PolicyToolRunner, type Approver } from "@abdo/tools"
import { runCommandTool } from "../src/run-command"
import { shellTool } from "../src/shell"
import { needsShell, renderForDisplay, toArgv, validateCommand, commandDigestInput } from "../src/command"

const yes: Approver = { approve: async () => true }

/** The arguments that break hand-written command lines. */
const HOSTILE = [
  "a plain one",
  "two words",
  'has "double" quotes',
  "has 'single' quotes",
  "$HOME",
  "${NOT_EXPANDED}",
  "`backticks`",
  "a && b",
  "semi;colon",
  "pipe|char",
  "new\nline",
  "tab\there",
  "C:\\Users\\someone\\a b",
  "trailing\\",
  "%PATH%",
  "!DELAYED!",
  "مرحبا بالعالم",
  "emoji 🚀 here",
  "*.ts",
  "--flag=value with space",
  "",
]

function workspace(fn: (dir: string, run: (input: unknown) => Promise<unknown>) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-cmd-"))
    try {
      // A child that reports exactly what it received.
      writeFileSync(join(dir, "echo-argv.mjs"), "console.log(JSON.stringify(process.argv.slice(2)))\n")
      const registry = new ToolRegistry().register(runCommandTool(dir)).register(shellTool(dir))
      const runner = new PolicyToolRunner(registry, { approver: yes } as never)
      await fn(dir, (input) => runner.run({ name: "run_command", input }, { executionId: "tex_cmd" }))
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      } catch {
        /* Windows may briefly hold a handle */
      }
    }
  }
}

describe("GATE — arguments arrive exactly as sent", () => {
  test(
    "every hostile argument survives the round trip through a real process",
    workspace(async (dir, run) => {
      const outcome = (await run({
        executable: process.execPath,
        args: [join(dir, "echo-argv.mjs"), ...HOSTILE],
        timeoutMs: 60_000,
      })) as { ok: boolean; output?: { stdout?: string; exitCode?: number }; error?: string }

      expect(outcome.ok).toBe(true)
      const received = JSON.parse((outcome.output?.stdout ?? "").trim().split("\n").pop() ?? "[]") as string[]
      // the child prints argv.slice(2), which is exactly the arguments it was given
      expect(received).toEqual(HOSTILE)
    }),
    120_000,
  )

  test(
    "a path with a space is ONE argument, not two",
    workspace(async (dir, run) => {
      const outcome = (await run({
        executable: process.execPath,
        args: [join(dir, "echo-argv.mjs"), "my file.txt"],
        timeoutMs: 60_000,
      })) as { ok: boolean; output?: { stdout?: string } }

      const received = JSON.parse((outcome.output?.stdout ?? "").trim().split("\n").pop() ?? "[]") as string[]
      expect(received).toHaveLength(1)
      expect(received[0]).toBe("my file.txt")
    }),
    120_000,
  )

  test(
    "$HOME is a literal argument, not something the shell expanded",
    workspace(async (dir, run) => {
      const outcome = (await run({
        executable: process.execPath,
        args: [join(dir, "echo-argv.mjs"), "$HOME", "$(whoami)"],
        timeoutMs: 60_000,
      })) as { ok: boolean; output?: { stdout?: string } }

      const received = JSON.parse((outcome.output?.stdout ?? "").trim().split("\n").pop() ?? "[]") as string[]
      expect(received[0]).toBe("$HOME")
      expect(received[1]).toBe("$(whoami)")
    }),
    120_000,
  )

  test(
    "`rm -rf /` as an ARGUMENT is data, because there is no shell to read it",
    workspace(async (dir, run) => {
      const outcome = (await run({
        executable: process.execPath,
        args: [join(dir, "echo-argv.mjs"), "x && rm -rf /", "; rm -rf /"],
        timeoutMs: 60_000,
      })) as { ok: boolean; output?: { stdout?: string } }

      const received = JSON.parse((outcome.output?.stdout ?? "").trim().split("\n").pop() ?? "[]") as string[]
      expect(received[0]).toBe("x && rm -rf /")
      expect(received[1]).toBe("; rm -rf /")
    }),
    120_000,
  )
})

describe("the spec refuses what it cannot honour", () => {
  test("an executable with arguments baked in is rejected, with the reason", () => {
    const problems = validateCommand({ executable: "npm install", args: [] })
    expect(problems).toHaveLength(1)
    expect(problems[0]!.detail).toContain("put the arguments in args[]")
  })

  test("a NUL byte anywhere is refused — it truncates at the OS boundary", () => {
    expect(validateCommand({ executable: "node\0evil", args: [] })).toHaveLength(1)
    expect(validateCommand({ executable: "node", args: ["ok", "bad\0here"] })).toHaveLength(1)
  })

  test("env handles are NAMES, never values", () => {
    expect(validateCommand({ executable: "node", args: [], envHandles: ["PATH", "HOME"] })).toEqual([])
    const withValue = validateCommand({ executable: "node", args: [], envHandles: ["TOKEN=secret"] })
    expect(withValue.length).toBeGreaterThan(0)
  })

  test("a nonsense timeout is refused rather than silently ignored", () => {
    expect(validateCommand({ executable: "node", args: [], timeoutMs: 0 })).toHaveLength(1)
    expect(validateCommand({ executable: "node", args: [], timeoutMs: -5 })).toHaveLength(1)
  })

  test("a valid spec has nothing to say", () => {
    expect(validateCommand({ executable: "node", args: ["-e", "console.log(1)"], cwd: "sub" })).toEqual([])
  })
})

describe("display is for humans, argv is what runs", () => {
  test("the rendering quotes for legibility, and is never what executes", () => {
    const spec = { executable: "node", args: ["-e", "console.log('hi')", "my file.txt"] }
    expect(renderForDisplay(spec)).toContain('"my file.txt"')
    // what runs is the array, untouched
    expect(toArgv(spec)).toEqual(["node", "-e", "console.log('hi')", "my file.txt"])
  })

  test("two different argument lists cannot collide into one digest input", () => {
    const a = commandDigestInput({ executable: "node", args: ["a b", "c"] })
    const b = commandDigestInput({ executable: "node", args: ["a", "b c"] })
    expect(a).not.toBe(b)
  })
})

describe("which path a command belongs on", () => {
  test("shell features are recognised, so the choice is explicit", () => {
    expect(needsShell("npm test")).toBe(false)
    expect(needsShell("npm test && npm build")).toBe(true)
    expect(needsShell("cat a | grep b")).toBe(true)
    expect(needsShell("echo $HOME")).toBe(true)
    expect(needsShell("ls *.ts")).toBe(true)
    expect(needsShell("node script.js --flag=1")).toBe(false)
  })
})
