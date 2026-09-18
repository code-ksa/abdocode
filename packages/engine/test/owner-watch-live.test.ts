/**
 * يتيمُ 10236 حيّاً على المحرّك الحقيقيّ (stdio مؤطَّر): المحرّكُ يُشغَّل بـ`ABDO_DESKTOP_OWNER_PID` = pid عمليةٍ قصيرة العمر؛
 * حين تموت يبثّ المحرّكُ إطارَ «bye: مالكُ المحرّك … مات» ويخرج بنفسه برمز 0 — بلا قتلٍ من الخارج ومع stdin ما زال مفتوحاً
 * (هذا هو الشكلُ المقيس: الأنبوبُ لا ينتهي فلا يُعوَّل عليه). التوأمُ السلبيّ: مالكٌ حيّ (هذه العمليةُ نفسُها) ⇦ لا bye ولا خروج.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

const REPO = resolve(import.meta.dir, "../../..")
const source = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text()

describe("owner watch — wiring pins", () => {
  test("the watch is armed before ready, aborts the running turn with a bounded wait, stops turn servers, closes the journals, then exits 0", () => {
    const watch = source.indexOf("const ownerPid = parseOwnerPid(process.env.ABDO_DESKTOP_OWNER_PID)")
    const ready = source.indexOf("if (shellAuthenticated) { emitReady(); armIdleExit() }")
    expect(watch).toBeGreaterThan(0); expect(ready).toBeGreaterThan(watch)
    const block = source.slice(watch, ready)
    expect(block).toContain("running?.controller.abort()")
    expect(block).toContain("await Promise.race([activeTurn.catch(() => undefined), Bun.sleep(3_000)])")
    expect(block).toContain("const orphans = turnServers.stopAll()")
    expect(block).toContain('emit({ kind: "bye", why: ownerGoneLine(ownerPid) })')
    expect(block).toContain("durableMemory.close(); serveJournal.close()")
    expect(block).toContain("process.exit(0)")
  })
})

const spawnEngine = (ownerPid: number, token: string) => {
  const state = mkdtempSync(join(tmpdir(), "abdo-owner-live-"))
  writeFileSync(join(state, "settings.json"), JSON.stringify({ railPolicy: "strict" }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], {
    cwd: REPO,
    env: { ...process.env, ABDO_SHELL_TOKEN: token, ABDO_FRAMED_STDIO: "1", ABDO_DESKTOP_OWNER_PID: String(ownerPid), ABDO_CODE_STATE_DIR: state, ABDO_CODE_SETTINGS: join(state, "settings.json"), ABDO_VAULT_HOME: state, USERPROFILE: state, HOME: state, ABDO_TEST_NATIVE_BINARY_DIR: process.env.ABDO_TEST_NATIVE_BINARY_DIR ?? resolve(REPO, "packages/desktop/src-tauri/payload/bin") },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const decoder = new LocalJsonFrameDecoder()
  const seen: Record<string, unknown>[] = []
  void (async () => { for await (const bytes of child.stdout) seen.push(...(decoder.push(bytes) as Record<string, unknown>[])) })()
  const until = async (probe: () => boolean, ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms
    while (!probe()) { if (Date.now() >= deadline) return false; await Bun.sleep(100) }
    return true
  }
  const send = async (frame: Readonly<Record<string, unknown>>): Promise<void> => { child.stdin.write(encodeLocalJsonFrame(frame)); await child.stdin.flush() }
  const cleanup = async () => { try { child.kill() } catch { /* خرج بنفسه */ } await child.exited; for (let i = 0; i < 20; i += 1) { try { rmSync(state, { recursive: true, force: true }); break } catch { await Bun.sleep(250) } } }
  return { child, seen, until, send, cleanup }
}

describe("owner watch — live engine", () => {
  test.skipIf(process.platform !== "win32")("the engine whose owner died says bye and exits 0 on its own while stdin stays open", async () => {
    // مالكٌ قصيرُ العمر: يعيش ٤ ثوانٍ ثمّ يموت — المحرّكُ يراه حيّاً عند الإقلاع.
    const owner = Bun.spawn([process.execPath, "-e", "await Bun.sleep(4000)"], { stdout: "ignore", stderr: "ignore" })
    const e = spawnEngine(owner.pid, "owner-token")
    try {
      await e.send({ kind: "hello", shell: "desktop", token: "owner-token" })
      expect(await e.until(() => e.seen.some((f) => f.kind === "ready"), 30_000)).toBe(true)
      await owner.exited
      // ٥ ث × غيابان + هامش: الخروجُ الذاتيّ خلال ٢٥ ث من موت المالك.
      const exitCode = await Promise.race([e.child.exited, Bun.sleep(25_000).then(() => "still-alive" as const)])
      expect(exitCode).toBe(0)
      const bye = e.seen.filter((f) => f.kind === "bye").map((f) => String(f.why ?? ""))
      expect(bye.some((why) => why.includes(`مالكُ المحرّك (pid ${owner.pid}) مات`))).toBe(true)
    } finally { await e.cleanup() }
  }, 90_000)

  test.skipIf(process.platform !== "win32")("a living owner keeps the engine up: no bye, no exit after three watch intervals (negative twin)", async () => {
    const e = spawnEngine(process.pid, "owner-token-2")
    try {
      await e.send({ kind: "hello", shell: "desktop", token: "owner-token-2" })
      expect(await e.until(() => e.seen.some((f) => f.kind === "ready"), 30_000)).toBe(true)
      const outcome = await Promise.race([e.child.exited.then((code) => `exited:${code}`), Bun.sleep(16_000).then(() => "alive" as const)])
      expect(outcome).toBe("alive")
      expect(e.seen.some((f) => f.kind === "bye")).toBe(false)
    } finally { await e.cleanup() }
  }, 90_000)
})
