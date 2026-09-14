/**
 * Sprint 47 wired live — the repair, tested against what a real model sent.
 *
 * Every "repairs" case below is a literal string a 2B model put in the
 * `executable` field during a live run, with the error message telling it
 * plainly, each time, that the field takes a program and `args` takes the rest.
 * The message was right and the model did not act on it, which is precisely
 * when a mechanical repair earns its place.
 */
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

  test("the real `node -e` line from the run keeps its script as one argument", () => {
    const line = `node -e "const db = require('x'); console.log(db)"`
    const r = repairCommandSpec(spec(line))
    expect(r.repaired).toBe(true)
    expect(r.spec.args).toEqual(["-e", "const db = require('x'); console.log(db)"])
  })
})
