/**
 * 10-09 — measured live on 4.0.114: a message queued in a brand-new conversation (while a turn ran in another) was lost on the way back —
 * an empty conversation is not in the journal, so `recall` refused it («المحادثة المطلوبة غير موجودة في السجل»). The shell now sends
 * `session-keep` when it queues there, and the engine keeps that conversation in history. Real engine, real frames, no model.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

test("a new empty conversation kept by session-keep can be recalled and is listed in history; one not kept cannot", async () => {
  const root = resolve(import.meta.dir, "../../..")
  const home = mkdtempSync(join(tmpdir(), "abdo-session-keep-"))
  const state = join(home, "state"), project = join(home, "project"), settings = join(home, "settings.json")
  mkdirSync(state); mkdirSync(project)
  writeFileSync(settings, JSON.stringify({ project, language: "en", mode: "read-only" }))
  const executable = process.env.ABDO_TEST_ENGINE
  const child = Bun.spawn(executable ? [executable, "serve"] : [process.execPath, "packages/engine/src/cli.ts", "serve"], {
    cwd: root, env: { ...process.env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, ABDO_SHELL_TOKEN: "keep-fixture", ABDO_FRAMED_STDIO: "1", ABDO_VAULT_HOME: home, USERPROFILE: home, HOME: home, ABDO_PROJECT: project },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const decoder = new LocalJsonFrameDecoder(), frames: any[] = []
  void (async () => { for await (const chunk of child.stdout) for (const frame of decoder.push(chunk)) frames.push(frame) })()
  const wait = async (check: () => boolean) => {
    const deadline = Date.now() + 20_000
    while (!check()) { if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(frames).slice(-600)}`); await Bun.sleep(10) }
  }
  const send = async (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); await child.stdin.flush() }
  const next = async (kind: string, from: number) => { await wait(() => frames.slice(from).some((f) => f.kind === kind || f.kind === "refused")); return frames.slice(from).find((f) => f.kind === kind || f.kind === "refused") }
  try {
    await send({ kind: "hello", shell: "desktop", token: "keep-fixture" })
    await wait(() => frames.some((f) => f.kind === "ready"))
    // the twin: an empty conversation that was NOT kept is refused on the way back (the measured failure)
    let at = frames.length; await send({ kind: "session-new" }); const lost = (await next("session", at)).id
    at = frames.length; await send({ kind: "session-new" }); await next("session", at)
    at = frames.length; await send({ kind: "recall", session: lost })
    expect((await next("archive", at)).kind).toBe("refused")
    // kept: session-keep, move away, come back — archive for that very conversation, and history lists it
    at = frames.length; await send({ kind: "session-new" }); const kept = (await next("session", at)).id
    at = frames.length; await send({ kind: "session-keep" })
    expect(await next("session-kept", at)).toMatchObject({ kind: "session-kept", id: kept })
    at = frames.length; await send({ kind: "session-new" }); await next("session", at)
    at = frames.length; await send({ kind: "recall", session: kept })
    expect(await next("archive", at)).toMatchObject({ kind: "archive", session: kept, turns: [] })
    at = frames.length; await send({ kind: "history" })
    const history = await next("history", at)
    expect(history.sessions.map((s: { id: string }) => s.id)).toContain(kept)
    expect(history.sessions.map((s: { id: string }) => s.id)).not.toContain(lost)
  } finally {
    child.kill(); await child.exited
    rmSync(home, { recursive: true, force: true })
  }
}, 60_000)
