/**
 * الفجوة #5 (2026-09-27) — الأوامرُ المائلة المخصّصة: الملفُّ، والمحرّكُ الحقيقيّ، ولوحةُ «/» في القشرة نفسِها.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import vm from "node:vm"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { expandCustomCommand, listCustomCommands } from "../src/custom-commands"
import { stripChildEnv } from "../../tools/src/env-strip"

const dirs = () => {
  const root = mkdtempSync(join(tmpdir(), "abdo-cmd-")), project = join(root, "proj"), user = join(root, "user")
  mkdirSync(join(project, ".abdo", "commands"), { recursive: true }); mkdirSync(user, { recursive: true })
  return { root, project, user }
}

test("files become commands: the project overrides the user, reserved and malformed names are not commands, descriptions come from front matter", () => {
  const { root, project, user } = dirs()
  writeFileSync(join(user, "review.md"), "Review as the user wants.")
  writeFileSync(join(user, "explain.md"), "---\ndescription: \"Explain the code\"\n---\nExplain $ARGUMENTS simply.")
  writeFileSync(join(project, ".abdo", "commands", "review.md"), "---\ndescription: Review this repo's way\n---\nReview the diff for $ARGUMENTS.")
  writeFileSync(join(project, ".abdo", "commands", "skill.md"), "hijack the skill directive")
  writeFileSync(join(project, ".abdo", "commands", "bad name.md"), "x")
  writeFileSync(join(project, ".abdo", "commands", "notes.txt"), "x")
  expect(listCustomCommands(project, user).map((c) => [c.name, c.source, c.description])).toEqual([["explain", "user", "Explain the code"], ["review", "project", "Review this repo's way"]])
  expect(expandCustomCommand("/review src/app.ts", project, user)).toEqual({ name: "review", source: "project", body: "Review the diff for src/app.ts." })
  expect(expandCustomCommand("/Explain the loop", project, user)!.body).toBe("Explain the loop simply.")
  rmSync(root, { recursive: true, force: true })
})

test("the twins: text that only looks like a command stays exactly as written", () => {
  const { root, project, user } = dirs()
  writeFileSync(join(project, ".abdo", "commands", "plain.md"), "Do the plain thing.")
  expect(expandCustomCommand("/plain extra words", project, user)!.body).toBe("Do the plain thing.\n\nextra words")
  for (const text of ["/usr/bin/env is broken", "/skill ext/name do it", "/unknown thing", "please /plain", "/plain"].slice(0, 4)) expect(expandCustomCommand(text, project, user), text).toBeUndefined()
  expect(expandCustomCommand("/plain", project, user)!.body).toBe("Do the plain thing.")
  rmSync(root, { recursive: true, force: true })
})

test("on the real engine: the command is listed on ready, expanded before the model sees it, and named in the turn", async () => {
  const { root, project } = dirs()
  writeFileSync(join(project, ".abdo", "commands", "greet.md"), "---\ndescription: Greet someone\n---\nReply with exactly: Hello, $ARGUMENTS!")
  const bodies: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const payload = await request.json() as { stream?: boolean; messages?: unknown }
    bodies.push(JSON.stringify(payload.messages ?? []))
    const content = "Hello, world!"
    if (payload.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const settings = join(root, "settings.json")
  writeFileSync(settings, JSON.stringify({
    language: "en", mode: "auto", modelRole: "agent", routerGate: "off", project, railPolicy: "thin", workMode: "basic",
    agentModel: "fx/model", chatModel: "fx/model",
    plugins: { projectAwareness: false, sessionAwareness: false, generalAwareness: false, verifier: false, reviewer: false, delegation: false, inventory: false },
    superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 },
    customProviders: [{ id: "fx", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }],
  }))
  const frames: any[] = []
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: { ...stripChildEnv(process.env).env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: join(root, "state"), ABDO_SHELL_TOKEN: "t", ABDO_FRAMED_STDIO: "1", USERPROFILE: join(root, "home"), HOME: join(root, "home"), ABDO_VAULT_HOME: root, ABDO_MAX_AGENT_EPOCHS: "2", ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text(), decoder = new LocalJsonFrameDecoder()
  const reading = (async () => { for await (const bytes of child.stdout) for (const frame of decoder.push(bytes)) frames.push(frame) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean, label: string) => { const deadline = Date.now() + 60_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out: " + label); await Bun.sleep(15) } }
  try {
    send({ kind: "hello", shell: "desktop", token: "t" })
    await wait(() => frames.some((f) => f.kind === "ready"), "ready")
    expect(frames.find((f) => f.kind === "ready").customCommands).toEqual([{ name: "greet", description: "Greet someone", source: "project" }])
    send({ kind: "submit", mode: "auto", turn: { id: "c1", body: "/greet world" } })
    await wait(() => frames.some((f) => f.turnId === "c1" && ["done", "refused", "unresolved"].includes(f.kind)), "turn end")
    expect(bodies[0]).toContain("Reply with exactly: Hello, world!")
    expect(bodies[0]).not.toContain("/greet world")
    expect(frames.some((f) => f.turnId === "c1" && f.kind === "event" && String(f.payload).startsWith("⌘ أمرٌ مخصّص /greet من .abdo/commands/greet.md"))).toBe(true)
  } finally {
    child.kill(); await child.exited; await reading; await stderr; server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)

test("in the shell's own palette: a custom command is offered, and it is sent with its slash so the engine expands it", () => {
  const html = readFileSync(new URL("../../desktop/ui/index.html", import.meta.url), "utf8")
  const palette = html.slice(html.indexOf("    let customCommands = [];"), html.indexOf("let palSel ="))
  const items = html.slice(html.indexOf("const paletteItems = () =>"), html.indexOf("const renderPalette = () =>"))
  const fire = html.slice(html.indexOf("const fire = () => {"), html.indexOf('el("send").onclick = fire;'))
  const calls: { body: string }[] = []
  const prompt = { value: "" }
  const context: Record<string, unknown> = {
    prompt, engineUp: true, working: undefined, palette: { style: {} }, notice: () => undefined,
    window: { AbdoDesktopShell: { api: { chatWork: { prepareSubmission: () => ({ conversationMode: "code", attachments: [] }) } } } },
    submitBody: (body: string) => { calls.push({ body }); return true },
  }
  vm.createContext(context)
  vm.runInContext(`${palette}${items}${fire}globalThis.setCustom = (list) => { customCommands = list }; globalThis.items = paletteItems; globalThis.send = fire;`, context)
  ;(context.setCustom as (l: unknown) => void)([{ name: "greet", description: "Greet someone", source: "project" }, { name: "status", description: "shadow", source: "project" }])
  prompt.value = "/gr"
  expect((context.items as () => { cmd: string; desc: string }[])().map((c) => [c.cmd, c.desc])).toEqual([["/greet", "Greet someone"]])
  // اسمٌ يطابق أمراً مدمجاً لا يُعرض مرّتين ولا يحجب المدمج.
  prompt.value = "/status"
  expect((context.items as () => { cmd: string }[])().map((c) => c.cmd)).toEqual(["/status"])
  prompt.value = "/greet world"; (context.send as () => void)()
  expect(calls.at(-1)!.body).toBe("/greet world")
  prompt.value = "/status"; (context.send as () => void)()
  expect(calls.at(-1)!.body).toBe("status")
})
