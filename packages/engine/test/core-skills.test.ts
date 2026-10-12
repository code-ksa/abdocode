/**
 * 10-09 — ops skills built in (abdo-ops): the agent sees them in its system prompt and loads one itself, with no install —
 * the way a strong coding agent knows its skills by name and description. Module checks on the real bundle, then live on the real
 * engine: a fake provider captures the system prompt and asks for a skill; with plugins.opsSkills off both disappear (the twin).
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { CORE_SKILL_PACKAGES, coreSkillBody, coreSkillsBrief, coreSkillsCatalogue } from "../src/core-skills"

const ROOT = resolve(import.meta.dir, "../../..")
const BUNDLED = join(ROOT, "extensions", "bundled")
const OPS = ["ubuntu-server", "node-24", "packages", "deploy", "git-commit", "git-push", "testing", "verify-delivery"]

describe("core skills — the bundle on disk", () => {
  test("the catalogue is exactly the eight ops skills, each with a description", () => {
    const all = coreSkillsCatalogue(BUNDLED)
    expect(CORE_SKILL_PACKAGES).toEqual(["abdo-ops"])
    expect(all.map((s) => s.ref).sort()).toEqual(OPS.map((id) => `abdo-ops/${id}`).sort())
    for (const s of all) expect(s.description.length).toBeGreaterThan(40)
  })
  test("a body loads by reference from the manifest; other packages and unknown skills fall through as undefined", () => {
    expect(coreSkillBody(BUNDLED, "abdo-ops/deploy")).toContain("server sandbox")
    expect(coreSkillBody(BUNDLED, "abdo-ops/git-commit")).toContain("git add -A")
    expect(coreSkillBody(BUNDLED, "abdo-security/secret-scan")).toBeUndefined()
    expect(coreSkillBody(BUNDLED, "abdo-ops/nope")).toBeUndefined()
    expect(coreSkillBody(undefined, "abdo-ops/deploy")).toBeUndefined()
  })
  test("the advert names every skill and tells the agent to verify before claiming done; nothing to advertise ⇒ empty", () => {
    const brief = coreSkillsBrief(coreSkillsCatalogue(BUNDLED))
    for (const id of OPS) expect(brief).toContain(`abdo-ops/${id}`)
    expect(brief).toContain("verify-delivery")
    expect(coreSkillsBrief([])).toBe("")
  })
  test("a skill whose text looks like a credential is refused, as on the local path", () => {
    const root = mkdtempSync(join(tmpdir(), "abdo-core-skill-"))
    try {
      const dir = join(root, "abdo-ops")
      mkdirSync(join(dir, "skills", "leaky"), { recursive: true })
      writeFileSync(join(dir, "abdocode-extension.json"), JSON.stringify({ schemaVersion: 1, id: "abdo-ops", name: "x", version: "1", description: "x", skills: ["skills/leaky"], mcpServers: [] }))
      writeFileSync(join(dir, "skills", "leaky", "SKILL.md"), "---\nname: leaky\ndescription: a skill that carries a key by mistake\n---\nuse sk-" + "a".repeat(20) + "\n")
      expect(() => coreSkillBody(root, "abdo-ops/leaky")).toThrow("credential")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

async function live(opsOn: boolean): Promise<{ system: string; receipts: string }> {
  const base = mkdtempSync(join(tmpdir(), "abdo-core-live-")), state = join(base, "state"), project = join(base, "proj")
  mkdirSync(project, { recursive: true }); mkdirSync(join(state, "trust"), { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "proj", version: "1.0.0" }))
  let calls = 0
  const bodies: string[] = []
  const answer = (body: { stream?: boolean }, content: string): Response => body.stream === false
    ? Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } })
    : new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const text = await request.text()
    bodies.push(text)
    calls += 1
    return answer(JSON.parse(text) as { stream?: boolean }, calls === 1 ? "نفّذ: skill abdo-ops/deploy" : "تمّ.")
  } })
  const settings = join(state, "settings.json")
  writeFileSync(settings, JSON.stringify({ language: "ar", agentModel: "fake/model", chatModel: "fake/model", modelRole: "agent", mode: "read-only", project, routerGate: "off", railPolicy: "thin", workMode: "basic", plugins: { opsSkills: opsOn, inventory: false, verifier: false, reviewer: false, delegation: false, projectAwareness: false, sessionAwareness: false, generalAwareness: false, semanticFrame: false, lessons: false, usageMeter: false }, superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 }, customProviders: [{ id: "fake", label: "fake", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }] }))
  const { createHash } = await import("node:crypto")
  writeFileSync(join(state, "trust", createHash("sha256").update(resolve(project).toLowerCase()).digest("hex") + ".json"), JSON.stringify({ project, trustedAt: new Date().toISOString(), by: "test" }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], { cwd: ROOT, env: { ...process.env, ABDO_SHELL_TOKEN: "tool-test", ABDO_FRAMED_STDIO: "1", ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, ABDO_CODE_TRUST_DIR: join(state, "trust"), USERPROFILE: base, HOME: base, ABDO_VAULT_HOME: base, ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_BUNDLED_EXTENSIONS: BUNDLED }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const errors = new Response(child.stderr).text(), frames: any[] = []
  const decoder = new LocalJsonFrameDecoder()
  void (async () => { for await (const bytes of child.stdout) frames.push(...decoder.push(bytes)) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean) => { const deadline = Date.now() + 120_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out " + JSON.stringify(frames).slice(-2000)); await Bun.sleep(15) } }
  try {
    send({ kind: "hello", shell: "desktop", token: "tool-test" }); await wait(() => frames.some((f) => f.kind === "ready"))
    send({ kind: "submit", mode: "read-only", turn: { id: "k1", body: "جهّز خادماً تجريبيّاً للمشروع" } })
    await wait(() => frames.some((f) => f.turnId === "k1" && ["done", "refused", "unresolved"].includes(f.kind)))
    return { system: bodies[0] ?? "", receipts: bodies[1] ?? "" }
  } finally { child.kill(); await child.exited; server.stop(true); await errors; for (let i = 0; i < 20; i += 1) { try { rmSync(base, { recursive: true, force: true }); break } catch { await Bun.sleep(250) } } }
}

describe("core skills — live on the engine", () => {
  test.skipIf(process.platform !== "win32")("on: the system prompt advertises the ops skills, and «skill abdo-ops/deploy» loads the body with no install", async () => {
    const r = await live(true)
    expect(r.system).toContain("abdo-ops/deploy")
    expect(r.system).toContain("abdo-ops/verify-delivery")
    expect(r.receipts).toContain("core-skill name=\\\"abdo-ops/deploy\\\"")
    expect(r.receipts).toContain("server sandbox")
  }, 120_000)
  test.skipIf(process.platform !== "win32")("off (the twin): neither advertised nor loaded — the refusal names the switch's way back", async () => {
    const r = await live(false)
    expect(r.system).not.toContain("abdo-ops/deploy")
    expect(r.receipts).not.toContain("core-skill")
    expect(r.receipts).toContain("abdo-ops/deploy")
  }, 120_000)
})
