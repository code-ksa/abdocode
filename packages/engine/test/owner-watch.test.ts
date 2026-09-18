import { describe, expect, test } from "bun:test"
import { OWNER_WATCH_INTERVAL_MS, OWNER_WATCH_MISSES, ownerGoneLine, parseOwnerPid, pidAlive, watchOwner } from "../src/owner-watch"

// يتيمُ 10236 (مقيس 09-14): المحرّكُ يحكم على موت مالكه بالـpid — غيابان متتاليان ثمّ نداءٌ واحد.

describe("owner watch — pure", () => {
  test("parseOwnerPid accepts positive integers only", () => {
    expect(parseOwnerPid("2172")).toBe(2172)
    expect(parseOwnerPid(undefined)).toBeUndefined()
    expect(parseOwnerPid("")).toBeUndefined()
    expect(parseOwnerPid("0")).toBeUndefined()
    expect(parseOwnerPid("-5")).toBeUndefined()
    expect(parseOwnerPid("abc")).toBeUndefined()
    expect(parseOwnerPid("12.5")).toBeUndefined()
  })

  test("pidAlive: self is alive, an absurd pid is dead", () => {
    expect(pidAlive(process.pid)).toBe(true)
    expect(pidAlive(2_147_483_000)).toBe(false)
  })

  test("defaults: 5s interval, two misses; the gone line names the pid", () => {
    expect(OWNER_WATCH_INTERVAL_MS).toBe(5_000)
    expect(OWNER_WATCH_MISSES).toBe(2)
    expect(ownerGoneLine(10236)).toBe("مالكُ المحرّك (pid 10236) مات — خروجٌ ذاتيّ يحرّر قفل الحالة")
  })

  test("fires once after two consecutive misses; a single miss followed by life resets the count", async () => {
    const answers = [true, false, true, false, false, false]
    let fired = 0
    const stop = watchOwner(7, () => { fired += 1 }, { intervalMs: 10, alive: () => answers.shift() ?? false })
    await Bun.sleep(120)
    stop()
    expect(fired).toBe(1)
    // الحكمُ وقع عند الجواب الخامس (الغيابُ الثاني المتتالي)، لا عند الثاني (غيابٌ مفرد).
    expect(answers).toEqual([false])
  })

  test("stop() before the verdict prevents the callback (negative twin)", async () => {
    let fired = 0
    const stop = watchOwner(7, () => { fired += 1 }, { intervalMs: 10, alive: () => false })
    stop()
    await Bun.sleep(60)
    expect(fired).toBe(0)
  })
})
