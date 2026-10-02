import { expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

// 10-02 — measured twice in one day: a shell heredoc turned `\\b` into a raw backspace (0x08) inside a regex. In cli.ts
// `/^plan\\s+(?!show<BS>)/` never excluded `plan show` (the lookahead wanted a backspace), and a fresh tool-family regex
// silently stopped matching "vps", "ssh" and "deploy". No test failed. Control characters have no place in source.
const roots = ["../src", "../../engine-host/src", "../../tools/src"].map((r) => new URL(r, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx|mjs|js)$/.test(name) ? [p] : []
  })
}

test("no control characters (other than tab, LF, CR) in engine, engine-host or tools source", () => {
  const bad: string[] = []
  for (const root of roots) for (const f of files(root)) {
    const text = readFileSync(f, "utf8")
    const m = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.exec(text)
    if (m) bad.push(`${f}:${text.slice(0, m.index).split("\n").length} U+${m[0].charCodeAt(0).toString(16).padStart(4, "0")}`)
  }
  expect(bad).toEqual([])
})
