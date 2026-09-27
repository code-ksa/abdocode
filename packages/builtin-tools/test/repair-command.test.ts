/**
 * Sprint 47 wired live — the repair, tested against what a real model sent.
 *
 * Every "repairs" case below is a literal string a 2B model put in the
 * `executable` field during a live run, with the error message telling it
 * plainly, each time, that the field takes a program and `args` takes the rest.
 * The message was right and the model did not act on it, which is precisely
 * when a mechanical repair earns its place.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { validateCommand } from "../src/command"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { repairCommandSpec, splitCommandLine } from "../src/repair-command"

describe("splitting a command line the way a shell would, minus the shell", () => {
  test("plain words", () => {
    expect(splitCommandLine("ls -la data/")).toEqual(["ls", "-la", "data/"])
  })

  test("a quoted argument stays ONE argument", () => {
    // `node -e "console.log(1)"` split on whitespace becomes four arguments and
    // runs nothing recognisable
    expect(splitCommandLine(`node -e "console.log(1)"`)).toEqual(["node", "-e", "console.log(1)"])
    expect(splitCommandLine(`git commit -m 'two words'`)).toEqual(["git", "commit", "-m", "two words"])
  })

  test("an empty quoted argument survives", () => {
    expect(splitCommandLine(`echo ""`)).toEqual(["echo", ""])
  })
})

describe("repairing what the model actually sent", () => {
  const spec = (executable: string, args: string[] = []) => ({ executable, args })

  for (const line of ["ls -la data/", "ls -la admin/", "git status", "node --check server.js"]) {
    test(`repairs "${line}"`, () => {
      const r = repairCommandSpec(spec(line))
      expect(r.repaired).toBe(true)
      expect(r.spec.executable).toBe(line.split(" ")[0]!)
      expect(r.spec.args.length).toBeGreaterThan(0)
      // MARKED: a repaired call must never look identical to a clean one
      expect(r.note).toContain("repaired")
    })
  }

  test("a bare program name is left completely alone", () => {
    const r = repairCommandSpec(spec("node", ["-e", "1"]))
    expect(r.repaired).toBe(false)
    expect(r.note).toBeUndefined()
    expect(r.spec.executable).toBe("node")
  })

  test("shell features are REFUSED, not split — splitting them changes what they do", () => {
    for (const line of ["cat a.txt | grep x", "npm i && npm test", "echo hi > out.txt", "ls *.ts"]) {
      const r = repairCommandSpec(spec(line))
      expect(r.repaired).toBe(false)
      expect(r.note).toContain("shell features")
    }
  })

  test("a filled args[] alongside a command line is a contradiction, not a repair", () => {
    const r = repairCommandSpec(spec("ls -la", ["data/"]))
    expect(r.repaired).toBe(false)
    expect(r.note).toContain("two different instructions")
  })

  test("an absolute path to a real program is a program even with spaces — a path that does not exist is still a command line", () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo repair "))
    const program = join(dir, "my tool.exe")
    writeFileSync(program, "")
    try {
      const r = repairCommandSpec(spec(program, ["-e", "x"]))
      expect(r).toEqual({ spec: spec(program, ["-e", "x"]), repaired: false })
      expect(r.note).toBeUndefined()
      // التوأم: مسارٌ لا وجود له يبقى سطراً يُقسَم كما كان.
      expect(repairCommandSpec(spec("C:/nope dir/missing.exe --flag")).repaired).toBe(true)
      // والتحقّقُ اللاحق يقبله برنامجاً — لا «يشبه سطرَ أوامر».
      expect(validateCommand(spec(program, ["-e", "x"])).filter((p) => p.field === "executable")).toEqual([])
      expect(validateCommand(spec("C:/nope dir/missing.exe")).some((p) => p.detail.includes("looks like a command line"))).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test("the real `node -e` line from the run keeps its script as one argument", () => {
    const line = `node -e "const db = require('x'); console.log(db)"`
    const r = repairCommandSpec(spec(line))
    expect(r.repaired).toBe(true)
    expect(r.spec.args).toEqual(["-e", "const db = require('x'); console.log(db)"])
  })
})
