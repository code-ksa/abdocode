/** Implicit corrections through the real framed engine: a plain message such as
 * "لا، استخدم PostgreSQL بدل SQLite" becomes an unconfirmed inferred memory that
 * reaches the next request marked as such, conflicts with an explicit note are
 * announced to the model and to the Memory panel, confirming promotes it to an
 * explicit note, forgetting drops it, the setting stops learning, and history
 * search off keeps inferred project memory out of a new conversation. Scripted
 * local HTTP provider; runs on the source and the compiled engine. */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

test("implicit corrections are learned as unconfirmed memory, surfaced with their conflicts, and governed by the user", async () => {
  const root = resolve(import.meta.dir, "../../..")
  const home = mkdtempSync(join(tmpdir(), "abdo-inferred-live-"))
  const state = join(home, "state"), project = join(home, "project"), settings = join(home, "settings.json")
  mkdirSync(state); mkdirSync(project)
  const requests: { stream?: boolean; messages: { role: string; content: string }[] }[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean; messages: { role: string; content: string }[] }
    requests.push(body)
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content: "Noted." }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 2 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "Noted." }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } })
  } })
  writeFileSync(settings, JSON.stringify({
    project, language: "en", mode: "read-only", modelRole: "chat", chatModel: "inferred-fixture/model", agentModel: "inferred-fixture/model",
    routerGate: "off", railPolicy: "thin", memorySearchEnabled: true, semanticMemoryEnabled: false,
    plugins: { projectAwareness: false, sessionAwareness: false, generalAwareness: false, verifier: false, reviewer: false, delegation: false },
    customProviders: [{ id: "inferred-fixture", label: "Local inferred test", baseUrl: `http://127.0.0.1:${server.port}/v1`, local: true, vaultKey: "", models: ["model"] }],
  }))
  const executable = process.env.ABDO_TEST_ENGINE
  const child = Bun.spawn(executable ? [executable, "serve"] : [process.execPath, "packages/engine/src/cli.ts", "serve"], {
    cwd: root, env: { ...process.env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, ABDO_SHELL_TOKEN: "inferred-fixture", ABDO_FRAMED_STDIO: "1", ABDO_VAULT_HOME: home, USERPROFILE: home, HOME: home, ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "", ABDO_PROJECT: project, ABDO_CLOUD_DAILY_TOKENS: "0" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text()
  const decoder = new LocalJsonFrameDecoder(), frames: any[] = []
  const reader = (async () => { for await (const chunk of child.stdout) for (const frame of decoder.push(chunk)) frames.push(frame) })()
  const wait = async (check: () => boolean) => {
    const deadline = Date.now() + 30_000
    while (!check()) { if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(frames).slice(-900)} stderr=${(await Promise.race([stderr, Bun.sleep(50).then(() => "")])).slice(-600)}`); await Bun.sleep(10) }
  }
  const send = async (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); await child.stdin.flush() }
  const submit = async (id: string, body: string) => {
    const before = requests.length
    await send({ kind: "submit", turn: { id, body } })
    await wait(() => frames.some((f) => (f.kind === "done" || f.kind === "refused") && f.turnId === id))
    expect(frames.find((f) => f.kind === "done" && f.turnId === id)?.outcome).toBe("completed")
    return JSON.stringify(requests.slice(before))
  }
  const latestNotes = () => frames.filter((f) => f.kind === "memory-notes").at(-1) as { facts: any[]; inferred: any[]; conflicts: any[] }
  try {
    await send({ kind: "hello", shell: "desktop", token: "inferred-fixture" })
    await wait(() => frames.some((f) => f.kind === "ready"))
    await send({ kind: "memory-note", title: "database", text: "SQLite for the local fixture", scope: "project" })
    await wait(() => frames.some((f) => f.kind === "memory-saved" && f.title === "database"))

    // 1. A plain correction is learned as inferred memory and announced with its confidence and source turn.
    const learned = await submit("correct-db", "لا، استخدم PostgreSQL بدل SQLite")
    const inferredFrame = frames.find((f) => f.kind === "memory-inferred" && f.turnId === "correct-db")
    expect(inferredFrame).toMatchObject({ topic: "database", note: "PostgreSQL (not SQLite)", confidence: 0.8 })
    expect(latestNotes().inferred).toEqual([expect.objectContaining({ key: "database", scope: "project", confidence: 0.8, sourceTurnId: "correct-db" })])
    // The same turn already sees it, marked unconfirmed, and the conflict with the explicit note is announced.
    expect(learned).toContain("PostgreSQL (not SQLite)")
    expect(learned).toContain("unconfirmed inference from a user message")
    expect(learned).toContain("[MEMORY_CONFLICTS]")
    expect(learned).toContain("SQLite for the local fixture")
    expect(latestNotes().conflicts).toEqual([expect.objectContaining({ kind: "inferred-vs-note", topic: "database", noteTitle: "database", noteIsNewer: false })])

    // 2. A second correction on the same topic replaces the first instead of piling up.
    await submit("correct-db-again", "use MariaDB instead of PostgreSQL")
    expect(latestNotes().inferred).toHaveLength(1)
    expect(latestNotes().inferred[0].value.to).toBe("MariaDB")
    const next = await submit("plain", "Tell me about the schema.")
    expect(next).toContain("MariaDB (not PostgreSQL)")
    expect(next).not.toContain("PostgreSQL (not SQLite)")

    // 3. Confirming writes an explicit note; the explicit note now agrees, so the conflict is gone.
    await send({ kind: "memory-note", title: "database", text: "MariaDB", scope: "project" })
    await wait(() => frames.filter((f) => f.kind === "memory-saved" && f.title === "database").length === 2)
    // إطارُ الملاحظات يصل بعد إطار الحفظ لا معه: تحت حِمل السويتة الكاملة كان التوقّعُ يقرأ اللقطةَ السابقة
    // فيحمرّ بلا عيبٍ في المنتج. الانتظارُ يبقي الحكمَ نفسَه (يرمي عند المهلة) ويزيل السباق.
    await wait(() => latestNotes().conflicts.length === 0)
    expect(latestNotes().conflicts).toEqual([])
    // 4. Forgetting an inferred memory through the same frame as notes.
    const inferredId = latestNotes().inferred[0].id
    await send({ kind: "memory-forget", id: inferredId })
    await wait(() => frames.some((f) => f.kind === "memory-forgotten" && f.id === inferredId))
    expect(latestNotes().inferred).toEqual([])
    const after = await submit("after-forget", "Anything about the schema?")
    expect(after).not.toContain("MariaDB (not PostgreSQL)")
    expect(after).toContain("MariaDB")

    // 5. The setting stops learning for the next turn; questions never learned anything.
    await send({ kind: "settings-set", settings: { inferredMemoryEnabled: false } })
    await wait(() => frames.some((f) => f.kind === "settings" && f.settings.inferredMemoryEnabled === false))
    await submit("no-learn", "use bun instead of npm")
    expect(frames.filter((f) => f.kind === "memory-inferred")).toHaveLength(2)
    await send({ kind: "settings-set", settings: { inferredMemoryEnabled: true } })
    await wait(() => frames.some((f) => f.kind === "settings" && f.settings.inferredMemoryEnabled === true))
    await submit("question", "use bun instead of npm?")
    expect(frames.filter((f) => f.kind === "memory-inferred")).toHaveLength(2)

    // 6. Learned again, then history search off: a new conversation sees explicit notes but not inferences.
    await submit("learn-bun", "use bun instead of npm")
    expect(frames.filter((f) => f.kind === "memory-inferred")).toHaveLength(3)
    await send({ kind: "settings-set", settings: { memorySearchEnabled: false } })
    await wait(() => frames.some((f) => f.kind === "settings" && f.settings.memorySearchEnabled === false))
    await send({ kind: "session-new" })
    await wait(() => frames.some((f) => f.kind === "session"))
    const isolated = await submit("new-session", "Which package manager?")
    expect(isolated).toContain("MariaDB")
    expect(isolated).not.toContain("bun (not npm)")
    await send({ kind: "settings-set", settings: { memorySearchEnabled: true } })
    await wait(() => frames.filter((f) => f.kind === "settings" && f.settings.memorySearchEnabled === true).length >= 1)
    const searching = await submit("new-session-search", "Which package manager now?")
    expect(searching).toContain("bun (not npm)")
  } finally {
    child.kill(); await child.exited; await reader.catch(() => {}); server.stop(true)
    if (resolve(home).includes("abdo-inferred-live-")) rmSync(home, { recursive: true, force: true })
  }
}, 120_000)
