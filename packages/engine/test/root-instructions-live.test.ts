/**
 * 10-09 — the project's root AGENTS.md / CLAUDE.md / ABDO.md reaches the model on every turn, as Claude Code and Codex load theirs.
 * Folder files below the root were attached on first touch, but the root was left to "orientation", which lists names and headings —
 * a rule written in the root file never reached the model. Live on the real engine: a fake provider captures what the model is sent.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

const ROOT = resolve(import.meta.dir, "../../..")
const RULE = "RULE-7Q: every API route returns JSON with an error field, never an HTML error page."

async function firstRequest(files: Record<string, string>): Promise<string> {
  const base = mkdtempSync(join(tmpdir(), "abdo-root-instr-")), state = join(base, "state"), project = join(base, "proj")
  mkdirSync(project, { recursive: true }); mkdirSync(join(state, "trust"), { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "proj", version: "1.0.0" }))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(project, name), text)
  const bodies: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const text = await request.text()
    bodies.push(text)
    const body = JSON.parse(text) as { stream?: boolean }
    const content = "تمّ."
    return body.stream === false
      ? Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] })
      : new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const settings = join(state, "settings.json")
  writeFileSync(settings, JSON.stringify({ language: "ar", agentModel: "fake/model", chatModel: "fake/model", modelRole: "agent", mode: "read-only", project, routerGate: "off", railPolicy: "thin", workMode: "basic", plugins: { inventory: false, verifier: false, reviewer: false, delegation: false, sessionAwareness: false, generalAwareness: false, semanticFrame: false, lessons: false, usageMeter: false }, superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 }, customProviders: [{ id: "fake", label: "fake", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }] }))
  const { createHash } = await import("node:crypto")
  writeFileSync(join(state, "trust", createHash("sha256").update(resolve(project).toLowerCase()).digest("hex") + ".json"), JSON.stringify({ project, trustedAt: new Date().toISOString(), by: "test" }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], { cwd: ROOT, env: { ...process.env, ABDO_SHELL_TOKEN: "tool-test", ABDO_FRAMED_STDIO: "1", ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, ABDO_CODE_TRUST_DIR: join(state, "trust"), USERPROFILE: base, HOME: base, ABDO_VAULT_HOME: base, ABDO_REQUIRE_SPRINT_PLAN: "0" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const errors = new Response(child.stderr).text(), frames: any[] = []
  const decoder = new LocalJsonFrameDecoder()
  void (async () => { for await (const bytes of child.stdout) frames.push(...decoder.push(bytes)) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean) => { const deadline = Date.now() + 120_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out " + JSON.stringify(frames).slice(-2000)); await Bun.sleep(15) } }
  try {
    send({ kind: "hello", shell: "desktop", token: "tool-test" }); await wait(() => frames.some((f) => f.kind === "ready"))
    send({ kind: "submit", mode: "read-only", turn: { id: "r1", body: "أضف مساراً جديداً للـAPI" } })
    await wait(() => frames.some((f) => f.turnId === "r1" && ["done", "refused", "unresolved"].includes(f.kind)))
    return bodies[0] ?? ""
  } finally { child.kill(); await child.exited; server.stop(true); await errors; for (let i = 0; i < 20; i += 1) { try { rmSync(base, { recursive: true, force: true }); break } catch { await Bun.sleep(250) } } }
}

test.skipIf(process.platform !== "win32")("a rule in the root AGENTS.md reaches the model in the first request of the turn", async () => {
  const sent = await firstRequest({ "AGENTS.md": `# Project rules\n\nSome intro.\n\n## API\n\n${RULE}\n` })
  expect(sent).toContain("RULE-7Q: every API route returns JSON with an error field")
}, 120_000)

test.skipIf(process.platform !== "win32")("CLAUDE.md that only points at AGENTS.md («@AGENTS.md») is not sent twice; a project without root files sends none", async () => {
  const sent = await firstRequest({ "AGENTS.md": `# Rules\n\n${RULE}\n`, "CLAUDE.md": "@AGENTS.md\n" })
  expect(sent.split("RULE-7Q").length - 1).toBe(1)
  const none = await firstRequest({})
  expect(none).not.toContain("RULE-7Q")
  expect(none).not.toContain("تعليماتُ المشروع «AGENTS.md»")
}, 240_000)
