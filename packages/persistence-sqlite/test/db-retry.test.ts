import { describe, expect, test } from "bun:test"
import { DatabaseBusyError } from "@abdo/contracts/error"
import { isBusy, withBusyRetry, withBusyRetrySync } from "../src/index"

const noSleep = async () => {}

describe("withBusyRetry", () => {
  test("classifies SQLITE_BUSY / database is locked", () => {
    expect(isBusy(new Error("SQLITE_BUSY: database is locked"))).toBe(true)
    expect(isBusy(new Error("database is locked"))).toBe(true)
    expect(isBusy(new Error("syntax error"))).toBe(false)
  })

  test("succeeds after transient busy errors", async () => {
    let calls = 0
    const r = await withBusyRetry(
      () => {
        calls++
        if (calls < 3) throw new Error("SQLITE_BUSY")
        return "ok"
      },
      { baseMs: 1, sleep: noSleep },
    )
    expect(r).toBe("ok")
    expect(calls).toBe(3)
  })

  test("surfaces DatabaseBusyError after the retry budget", async () => {
    let caught: unknown
    try {
      await withBusyRetry(() => { throw new Error("SQLITE_BUSY") }, { maxRetries: 2, baseMs: 1, sleep: noSleep })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(DatabaseBusyError)
    expect((caught as DatabaseBusyError).attempts).toBe(3)
  })

  test("non-busy errors are re-thrown immediately (no retry)", async () => {
    let calls = 0
    await expect(
      withBusyRetry(() => { calls++; throw new Error("boom") }, { sleep: noSleep }),
    ).rejects.toThrow("boom")
    expect(calls).toBe(1)
  })
})

describe("withBusyRetrySync", () => {
  test("constructor-time setup survives transient contention", () => {
    let calls = 0
    const sleeps: number[] = []
    const result = withBusyRetrySync(() => {
      calls++
      if (calls < 3) throw new Error("database is locked")
      return "ready"
    }, { baseMs: 2, sleep: (ms) => sleeps.push(ms) })
    expect(result).toBe("ready")
    expect(sleeps).toEqual([2, 4])
  })

  test("constructor-time contention is bounded", () => {
    expect(() => withBusyRetrySync(() => {
      throw new Error("SQLITE_BUSY")
    }, { maxRetries: 1, sleep: () => {} })).toThrow(DatabaseBusyError)
  })
})
