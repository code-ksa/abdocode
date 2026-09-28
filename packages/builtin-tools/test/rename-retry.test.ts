import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { renameRetrying } from "../src/rename-retry"

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: rename`), { code })

describe("renameRetrying — the commit of an atomic write survives a moment's lock on Windows", () => {
  test("a transient EPERM/EACCES/EBUSY is retried with a growing wait, and the successful attempt is reported", () => {
    const failures = ["EPERM", "EACCES", "EBUSY"]
    const waits: number[] = []
    let calls = 0
    const attempt = renameRetrying("a", "b", {
      platform: "win32",
      sleep: (ms) => waits.push(ms),
      rename: () => { calls += 1; const code = failures.shift(); if (code !== undefined) throw errno(code) },
    })
    expect(attempt).toBe(4)
    expect(calls).toBe(4)
    expect(waits).toEqual([25, 50, 100])
  })

  test("a lock that never lifts is thrown after the bounded attempts — the failure is not swallowed", () => {
    let calls = 0
    expect(() => renameRetrying("a", "b", { platform: "win32", attempts: 5, sleep: () => {}, rename: () => { calls += 1; throw errno("EPERM") } })).toThrow("EPERM")
    expect(calls).toBe(5)
  })

  test("a real failure is thrown at once: ENOENT is not retried, nor is EPERM off Windows", () => {
    let calls = 0
    expect(() => renameRetrying("a", "b", { platform: "win32", sleep: () => {}, rename: () => { calls += 1; throw errno("ENOENT") } })).toThrow("ENOENT")
    expect(calls).toBe(1)
    calls = 0
    expect(() => renameRetrying("a", "b", { platform: "linux", sleep: () => {}, rename: () => { calls += 1; throw errno("EPERM") } })).toThrow("EPERM")
    expect(calls).toBe(1)
  })

  test("the positive twin on the real filesystem: an unlocked rename lands on the first attempt", () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-rename-retry-"))
    try {
      writeFileSync(join(dir, "stage.tmp"), "committed")
      expect(renameRetrying(join(dir, "stage.tmp"), join(dir, "target.json"))).toBe(1)
      expect(readFileSync(join(dir, "target.json"), "utf8")).toBe("committed")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
