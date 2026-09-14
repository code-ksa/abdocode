import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireStateDirLock, releaseStateDirLock } from "../src/state-dir-lock"

describe("state-dir lock — catalog 10.4", () => {
  test("acquires a free dir and releases it", () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-lock-"))
    const r = acquireStateDirLock(dir)
    expect(r.ok).toBe(true)
    expect(readFileSync(join(dir, "serve.lock"), "utf-8")).toBe(String(process.pid))
    releaseStateDirLock(dir)
    expect(existsSync(join(dir, "serve.lock"))).toBe(false)
  })

  // الحادثة الحية: هارنسان متراكبان كسرا تسلسل الدفتر (sequence_gap).
  test("refuses a dir owned by a live foreign pid, naming the owner", () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-lock-live-"))
    // عمليةٌ حيّة بيقين ليست نحن: أبونا.
    writeFileSync(join(dir, "serve.lock"), String(process.ppid))
    const r = acquireStateDirLock(dir)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.why).toContain(String(process.ppid))
      expect(r.why).toContain("sequence_gap")
    }
  })

  test("takes over a stale lock from a dead pid, with a note", () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-lock-stale-"))
    writeFileSync(join(dir, "serve.lock"), "999999999")
    const r = acquireStateDirLock(dir)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.note).toContain("يتيم")
    expect(readFileSync(join(dir, "serve.lock"), "utf-8")).toBe(String(process.pid))
  })

  test("re-acquiring our own lock is not a refusal", () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-lock-self-"))
    expect(acquireStateDirLock(dir).ok).toBe(true)
    expect(acquireStateDirLock(dir).ok).toBe(true)
  })

  test("release does not touch a lock we do not own", () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-lock-foreign-"))
    writeFileSync(join(dir, "serve.lock"), String(process.ppid))
    releaseStateDirLock(dir)
    expect(existsSync(join(dir, "serve.lock"))).toBe(true)
  })
})
