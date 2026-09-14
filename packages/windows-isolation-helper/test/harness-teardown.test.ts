/**
 * CL-16A3-B2B-ROOT-FINAL-GATE — the reaper's safety and retry logic, proved
 * without a live server so the guarantees are pinned deterministically.
 *
 *   - a directory Windows is holding open is retried, and it FAILS (not hangs,
 *     not blind-deletes) when the handle never releases;
 *   - the same directory removes cleanly the moment the handle is released;
 *   - an owned queue whose owner process is still ALIVE is DEFERRED, never
 *     deleted, because its liveness is unknown;
 *   - the owned census counts only what appeared after the baseline.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const PS = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`

/**
 * Hold a file inside `dir` open with `FileShare.None`, the way a live server
 * holds its exclusive lock — Windows then refuses to delete that file, so the
 * directory removal fails with a REAL sharing violation until `releaseFlag`
 * appears. A plain Node read handle shares DELETE and would prove nothing.
 */
function holdFile(file: string, readyFlag: string, releaseFlag: string) {
  const cmd = `$f=[System.IO.File]::Open('${file}','Open','Read','None'); New-Item -ItemType File -Path '${readyFlag}' -Force | Out-Null; while (-not (Test-Path -LiteralPath '${releaseFlag}')) { Start-Sleep -Milliseconds 30 }; $f.Close()`
  return Bun.spawn([PS, "-NoProfile", "-Command", cmd], { stdout: "ignore", stderr: "ignore" })
}
const settle = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
/** Block until the holder has confirmed it owns the directory. */
function waitHeld(readyFlag: string): void {
  for (let i = 0; i < 200 && !existsSync(readyFlag); i++) settle(25)
}
import {
  DEFAULT_REAP,
  QUEUE_PREFIX,
  type Census,
  ownedResidue,
  ownerPidOfQueue,
  reapQueue,
  removeWithRetries,
} from "../scripts/harness-teardown"

const scratch: string[] = []
/**
 * Best-effort scratch cleanup, BOUNDED.
 *
 * It used to call `rmSync` directly, and under a loaded full-suite run that
 * consumed the whole 5-second hook budget and failed the suite with
 * `a beforeEach/afterEach hook timed out for this test` — MEASURED once in 442,
 * and not reproducible in five isolated runs of this file.
 *
 * Some of these directories contain a file another process is deliberately
 * holding open with `FileShare.None`; that is the point of the fixture. So the
 * cleanup can genuinely be blocked, and an UNBOUNDED remove in a hook with a
 * fixed budget is a latent timeout waiting for a slow enough machine. P5c2 makes
 * a slow enough machine more likely — every named run now starts a keeper
 * alongside the target — which is how a pre-existing flake surfaced now.
 *
 * `removeWithRetries` is the module this file exists to test, and its entire
 * contract is to FAIL rather than hang. Using it here means the hook cannot
 * outlive its own deadline, and a directory that survives is left for the
 * suite's residue census to report rather than silently retried forever.
 */
afterEach(() => {
  for (const d of scratch.splice(0)) {
    try {
      removeWithRetries(d, Date.now() + 1_500, 100)
    } catch {
      /* best effort: a held directory is reported by the census, not here */
    }
  }
})

describe("removeWithRetries", () => {
  test("removes a free directory on the first pass, no retries", () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-reap-free-"))
    scratch.push(dir)
    writeFileSync(join(dir, "a.txt"), "x")
    const r = removeWithRetries(dir, Date.now() + 5_000, 50)
    expect(r.removed).toBe(true)
    expect(r.retries).toBe(0)
    expect(existsSync(dir)).toBe(false)
  })

  test("a held directory blocks removal until the deadline — FAIL, never hang, never partial-lie", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-reap-locked-"))
    scratch.push(dir)
    const file = join(dir, "held.lock")
    writeFileSync(file, "x")
    const ready = join(tmpdir(), `abdo-reap-ready-${process.pid}-a`)
    const release = join(tmpdir(), `abdo-reap-release-${process.pid}-a`)
    const holder = holdFile(file, ready, release)
    waitHeld(ready) // the holder has confirmed it owns the file
    try {
      const start = Date.now()
      const r = removeWithRetries(dir, Date.now() + 800, 100)
      const elapsed = Date.now() - start
      expect(r.removed).toBe(false) // it did NOT claim success
      expect(existsSync(dir)).toBe(true) // and the directory is genuinely still there
      expect(r.retries).toBeGreaterThan(0) // it really retried
      expect(elapsed).toBeLessThan(5_000) // it returned at the deadline, did not hang
    } finally {
      writeFileSync(release, "")
      await holder.exited
      rmSync(release, { force: true })
      rmSync(ready, { force: true })
    }
  })

  test("removes cleanly the moment the directory is released (fail-then-succeed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-reap-freed-"))
    scratch.push(dir)
    const file = join(dir, "held.lock")
    writeFileSync(file, "x")
    const ready = join(tmpdir(), `abdo-reap-ready-${process.pid}-b`)
    const release = join(tmpdir(), `abdo-reap-release-${process.pid}-b`)
    const holder = holdFile(file, ready, release)
    waitHeld(ready)
    expect(removeWithRetries(dir, Date.now() + 400, 100).removed).toBe(false)
    writeFileSync(release, "")
    await holder.exited
    settle(150)
    const r = removeWithRetries(dir, Date.now() + 5_000, 100)
    rmSync(release, { force: true })
    rmSync(ready, { force: true })
    expect(r.removed).toBe(true)
    expect(existsSync(dir)).toBe(false)
  })
})

describe("reapQueue deletion safety", () => {
  test("DEFERS a queue whose owner process is still alive — unknown liveness, no blind delete", () => {
    // Name the queue with THIS process's pid: an owner that is provably alive.
    const dir = join(tmpdir(), `${QUEUE_PREFIX}${process.pid}`)
    mkdirSync(dir, { recursive: true })
    scratch.push(dir)
    const o = reapQueue(dir, DEFAULT_REAP)
    expect(o.deferred).toBe(true)
    expect(o.removed).toBe(false)
    expect(o.reason).toBe("owner_alive_unknown_liveness")
    expect(existsSync(dir)).toBe(true) // the live owner's queue was left untouched
  })

  test("reaps a server-less queue whose owner is provably gone", () => {
    // A real, now-dead pid: spawn a process, let it exit, reuse its pid in the name.
    const c = Bun.spawnSync(["C:\\Windows\\System32\\cmd.exe", "/c", "exit"], { stdout: "ignore", stderr: "ignore" })
    const deadPid = c.pid
    const dir = join(tmpdir(), `${QUEUE_PREFIX}${deadPid}`)
    mkdirSync(dir, { recursive: true })
    scratch.push(dir)
    // No server.ready, no server.lock: nothing looks alive, so it removes directly.
    const o = reapQueue(dir, { ...DEFAULT_REAP, serverStopTimeoutMs: 1_000, rmTimeoutMs: 3_000 })
    expect(ownerPidOfQueue(dir)).toBe(deadPid)
    expect(o.deferred).toBe(false)
    expect(o.removed).toBe(true)
    expect(existsSync(dir)).toBe(false)
  })
})

describe("the teardown hook is registered where it actually fires", () => {
  /**
   * The defect this pins: `process.on("exit", stopServer)` is NEVER called under
   * `bun test`, so every invocation left its server running and its queue
   * undeletable. Proved with a probe whose only job was to write a file from an
   * `exit` handler — no file appeared. The fix is an `afterAll` in a PRELOADED
   * module, so this asserts the wiring exists rather than trusting the comment.
   */
  test("bunfig preloads the afterAll teardown, and it calls stopServer", () => {
    const bunfig = readFileSync(join(import.meta.dir, "..", "bunfig.toml"), "utf8")
    expect(bunfig).toContain("preload")
    expect(bunfig).toContain("./test/setup-teardown.ts")
    const setup = readFileSync(join(import.meta.dir, "setup-teardown.ts"), "utf8")
    expect(setup).toContain('import { afterAll } from "bun:test"')
    expect(setup).toContain("stopServer()")
  })
})

describe("ownedResidue", () => {
  const census = (over: Partial<Census>): Census => ({
    ts: 1_000,
    procs: [],
    queues: [],
    helperPids: [],
    windowsTerminalPids: [],
    conhostPids: [],
    ...over,
  })

  test("counts only helpers and queues that appeared after the baseline", () => {
    const baseline = census({ ts: 1_000, helperPids: [10], queues: ["/tmp/q-old"] })
    const now = census({
      ts: 2_000,
      helperPids: [10, 20], // 20 is new -> owned
      queues: ["/tmp/q-old", "/tmp/q-new"], // q-new is owned
      procs: [{ pid: 20, name: "abdo-winiso.exe", ppid: 1, createdMs: 1_500 }],
    })
    const r = ownedResidue(baseline, now)
    expect(r.ownedHelper).toBe(1)
    expect(r.ownedHelperPids).toEqual([20])
    expect(r.ownedQueue).toBe(1)
    expect(r.ownedQueues).toEqual(["/tmp/q-new"])
    expect(r.clean).toBe(false)
  })

  test("a console that predates the round window is not attributed to it", () => {
    const baseline = census({ ts: 5_000, conhostPids: [1, 2] })
    const now = census({
      ts: 6_000,
      conhostPids: [1, 2, 3], // pid 3 is new by pid...
      procs: [{ pid: 3, name: "conhost.exe", ppid: 9, createdMs: 4_000 }], // ...but was created BEFORE the window
    })
    const r = ownedResidue(baseline, now)
    expect(r.ownedConhost).toBe(0) // not ours: it predates the round
    expect(r.conhostDelta).toBe(1) // but the delta is reported honestly
    expect(r.clean).toBe(true)
  })

  test("a fully-baseline world is clean", () => {
    const baseline = census({ helperPids: [1], queues: ["/tmp/q"], conhostPids: [7] })
    expect(ownedResidue(baseline, baseline).clean).toBe(true)
  })
})
