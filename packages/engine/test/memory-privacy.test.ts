import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { SqliteFactStore } from "@abdo/memory"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { factsForAutomaticRecall, recallBrief } from "../src/turn-memory"
import { projectAwarenessBrief } from "../src/project-awareness"

const priorFact = "rose-copper-otter"
const ownerNote = "owner-cobalt-ibis"
const sessionNote = "session-saffron-hawk"
const ownerInstruction = "instruction-violet-finch"
const ownerAwareness = "owner-amber-fox"
const priorAwareness = "prior-silver-lynx"
const priorGeneral = "general-copper-thrush"
const currentMessage = "current-indigo-swan"
const awarenessText = `# ABDO-AWARENESS\n\n## حقائق مقيسة\n- ${priorAwareness}\n\n## قرارات المالك لهذا المشروع\n- ${ownerAwareness}\n`

describe("local conversation privacy", () => {
  test("disabled automatic recall rejects unscoped learned facts and foreign owner notes", () => {
    const facts = [
      { kind: "project_fact" as const, key: "tests:passing", sourceEventIds: ["prior-tool-result"] },
      { kind: "project_fact" as const, key: "owner-note:explicit", sourceEventIds: ["owner-note:1"] },
      { kind: "project_fact" as const, key: "owner-note:forged", sourceEventIds: ["prior-tool-result"] },
      { kind: "project_fact" as const, key: "owner-note:foreign", sessionId: "past", sourceEventIds: ["owner-note:2"] },
      { kind: "active_task" as const, key: "turn:current", sessionId: "current", sourceEventIds: ["current-turn"] },
    ]
    expect(factsForAutomaticRecall(facts, false, "current").map((f) => f.key)).toEqual(["owner-note:explicit", "turn:current"])
    expect(factsForAutomaticRecall(facts, true, "current")).toBe(facts)
    expect(recallBrief([{ key: "owner-note:explicit", value: { note: ownerNote, sensitive: false } }])).toContain(ownerNote)
  })

  test("project instructions remain while generated session sections are excluded", () => {
    const brief = projectAwarenessBrief(awarenessText, 900, false)
    expect(brief).toContain(ownerAwareness)
    expect(brief).not.toContain(priorAwareness)
    expect(projectAwarenessBrief(awarenessText)).toContain(priorAwareness)
  })

  for (const routerGate of ["off", "cheap"] as const) {
    test(`recorded provider requests honor privacy changes and preserve current chat (${routerGate})`, async () => {
      // Isolated project, journal, settings, vault home and local HTTP receiver.
      // No real provider, credential or user's project is read or modified.
      const root = resolve(import.meta.dir, "../../..")
      const home = mkdtempSync(join(tmpdir(), "abdo-memory-privacy-"))
      const state = join(home, "state"), project = join(home, "project"), settings = join(home, "settings.json")
      mkdirSync(state); mkdirSync(project)
      writeFileSync(join(project, "ABDO-AWARENESS.md"), awarenessText)
      writeFileSync(join(state, "abdo-general-awareness.json"), JSON.stringify({ version: 1, lessons: [
        { key: priorGeneral, cls: "env_trap", text: `Earlier lesson ${priorGeneral}`, seen: 1, firstSeen: 1, lastSeen: 1 },
      ] }))
      const store = new SqliteFactStore(join(state, "abdocode-memory.sqlite"))
      const fact = store.record({ projectId: project, kind: "project_fact", key: "tests:passing", value: `PRIOR SESSION TEST RESULT: ${priorFact}`, sourceEventIds: ["prior-session-tool-result"] })
      store.verify(fact.id)
      for (let i = 0; i < 24; i++) {
        const noise = store.record({ projectId: project, kind: "project_fact", key: `wrote:unrelated-${i}`, value: `Unrelated file number ${i}`, sourceEventIds: [`other-result-${i}`] })
        store.verify(noise.id)
      }
      store.close()
      const requests: unknown[] = []
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        const body = await request.json() as { stream?: boolean }
        requests.push(body)
        if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content: "Hello." }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 2 } })
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hello." }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } })
      } })
      writeFileSync(settings, JSON.stringify({
        project, language: "en", mode: "read-only", modelRole: "chat", chatModel: "privacy-fixture/model", agentModel: "privacy-fixture/model", gateModel: "privacy-fixture/model",
        // هـ1 (2026-09-07): الرفيعُ يُسقط الوعيَ العامّ بالتصميم (أمر المالك 09-06)؛ المستوى ليس موضوعَ هذا الاختبار فيُثبَّت متوسطاً (بلا خطّة إلزامية).
        routerGate, railPolicy: "medium", memorySearchEnabled: false,
        projectInstructions: { path: project, text: ownerInstruction },
        customProviders: [{ id: "privacy-fixture", label: "Local privacy test", baseUrl: `http://127.0.0.1:${server.port}/v1`, local: true, vaultKey: "", models: ["model"] }],
      }))
      const executable = process.env.ABDO_TEST_ENGINE
      const child = Bun.spawn(executable ? [executable, "serve"] : [process.execPath, "packages/engine/src/cli.ts", "serve"], {
        cwd: root, env: { ...process.env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, ABDO_SHELL_TOKEN: "privacy-fixture", ABDO_FRAMED_STDIO: "1", ABDO_VAULT_HOME: home, USERPROFILE: home, HOME: home, ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "", ABDO_PROJECT: project },
        stdin: "pipe", stdout: "pipe", stderr: "pipe",
      })
      const stderr = new Response(child.stderr).text()
      const decoder = new LocalJsonFrameDecoder(), frames: any[] = []
      const reader = (async () => { for await (const chunk of child.stdout) for (const frame of decoder.push(chunk)) frames.push(frame) })()
      const wait = async (check: () => boolean) => {
        const deadline = Date.now() + 15_000
        while (!check()) { if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(frames).slice(-600)}`); await Bun.sleep(10) }
      }
      const send = async (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); await child.stdin.flush() }
      const submit = async (id: string, body: string) => {
        const count = requests.length
        await send({ kind: "submit", turn: { id, body } })
        await wait(() => frames.some((f) => (f.kind === "done" || f.kind === "refused") && f.turnId === id))
        expect(frames.find((f) => f.kind === "done" && f.turnId === id)?.outcome).toBe("completed")
        // Every request the turn produced — the work request and, with semantic
        // recall on by default, the ranking request — is held to the same privacy
        // assertions: a disabled history must not leak through ranking either.
        const batch = requests.slice(count)
        expect(batch.length).toBeGreaterThanOrEqual(1)
        return JSON.stringify(batch)
      }
      try {
        await send({ kind: "hello", shell: "desktop", token: "privacy-fixture" })
        await wait(() => frames.some((f) => f.kind === "ready"))
        expect(frames.find((f) => f.kind === "ready").settings.memorySearchEnabled).toBe(false)
        await send({ kind: "session-new" })
        await wait(() => frames.some((f) => f.kind === "session"))
        const session = frames.find((f) => f.kind === "session").id
        await send({ kind: "memory-note", title: "explicit", text: ownerNote, scope: "project" })
        await wait(() => frames.some((f) => f.kind === "memory-saved"))
        await send({ kind: "memory-note", title: "current", text: sessionNote, scope: "session" })
        await wait(() => frames.some((f) => f.kind === "memory-saved" && f.scope === "session"))
        const disabled = await submit("privacy-disabled", `Hello ${currentMessage}.`)
        expect(disabled).not.toContain(priorFact)
        expect(disabled).not.toContain(priorAwareness)
        expect(disabled).not.toContain(priorGeneral)
        expect(disabled).toContain(ownerNote)
        expect(disabled).toContain(sessionNote)
        expect(disabled).toContain(currentMessage)
        if (routerGate === "off") {
          expect(disabled).toContain(ownerInstruction)
          expect(disabled).toContain(ownerAwareness)
        }
        // Positive control proves stored history is retrievable, then disabling
        // it again must affect the next request without restarting the engine.
        await send({ kind: "settings-set", settings: { memorySearchEnabled: true } })
        await wait(() => frames.some((f) => f.kind === "settings" && f.settings.memorySearchEnabled === true))
        const enabled = await submit("privacy-enabled", "Hello, explain the prior session result.")
        expect(enabled).toContain(priorFact)
        expect(enabled).toContain(ownerNote)
        // The current conversation's own note must not vanish when history search is on
        // (a project-only query used to drop every session-scoped fact, including ours).
        expect(enabled).toContain(sessionNote)
        if (routerGate === "off") {
          expect(enabled).toContain(priorAwareness)
          expect(enabled).toContain(priorGeneral)
        }
        const before = frames.length
        await send({ kind: "settings-set", settings: { memorySearchEnabled: false } })
        await wait(() => frames.slice(before).some((f) => f.kind === "settings" && f.settings.memorySearchEnabled === false))
        const disabledAgain = await submit("privacy-disabled-again", "Hello once more.")
        expect(disabledAgain).not.toContain(priorFact)
        expect(disabledAgain).not.toContain(priorAwareness)
        expect(disabledAgain).not.toContain(priorGeneral)
        expect(disabledAgain).toContain(ownerNote)
        expect(disabledAgain).toContain(currentMessage)
        // Opening this saved conversation restores its own history, without
        // silently appending unrelated shared project facts through recall.
        await send({ kind: "recall", session })
        await wait(() => frames.some((f) => f.kind === "archive" && f.session === session))
        const reopened = await submit("privacy-reopened", "Hello after reopening.")
        expect(reopened).not.toContain(priorFact)
        expect(reopened).not.toContain(priorAwareness)
        expect(reopened).not.toContain(priorGeneral)
        expect(reopened).toContain(ownerNote)
        expect(reopened).toContain(sessionNote)
        expect(reopened).toContain(currentMessage)
      } finally {
        child.kill(); await child.exited; await reader; await stderr
        server.stop(true); rmSync(home, { recursive: true, force: true })
      }
    }, 45_000)
  }
})
