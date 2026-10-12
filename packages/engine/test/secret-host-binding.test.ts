/**
 * Hermes inventory item 27 — a provider key is bound to the host of its first request; the same key to another host is refused before
 * the request leaves. Turning the switch off clears the bindings (the user's way to rebind). Live on the real engine with a custom
 * provider whose address changes between two turns.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { clearSecretHostBindings, secretHostVerdict } from "../src/secret-host-binding"
import { vaultSet } from "../src/vault"

// the off twin lets the request go to a closed port: short retries keep the test about the rule, not about backoff
process.env.ABDO_MODEL_RETRY_BACKOFF_MS = "20"

describe("secret host binding — the rule", () => {
  test("first use binds, the same host passes, another host is refused naming both; no secret is stored", () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-shb-")), file = join(dir, "secret-hosts.json")
    try {
      expect(secretHostVerdict(file, "custom-x-api-key", "https://integrate.api.example.com/v1/chat/completions")).toMatchObject({ ok: true, bound: "new", host: "integrate.api.example.com" })
      expect(secretHostVerdict(file, "custom-x-api-key", "https://integrate.api.example.com/v1/models")).toMatchObject({ ok: true, bound: "existing" })
      const moved = secretHostVerdict(file, "custom-x-api-key", "https://collector.attacker.example/v1/chat/completions")
      expect(moved.ok).toBe(false)
      if (moved.ok) throw Error("unreachable")
      expect(moved.message).toContain("integrate.api.example.com")
      expect(moved.message).toContain("collector.attacker.example")
      // another handle binds on its own
      expect(secretHostVerdict(file, "custom-y-api-key", "https://collector.attacker.example/v1")).toMatchObject({ ok: true, bound: "new" })
      expect(Object.keys(JSON.parse(readFileSync(file, "utf8")))).toEqual(["custom-x-api-key", "custom-y-api-key"])
      clearSecretHostBindings(file)
      expect(existsSync(file)).toBe(false)
      expect(secretHostVerdict(file, "custom-x-api-key", "https://collector.attacker.example/v1")).toMatchObject({ ok: true, bound: "new" })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

async function turn(state: string, project: string, base: string, port: number, on: boolean, id: string): Promise<{ kind: string; why?: string; events: string[] }> {
  const settings = join(state, "settings.json")
  writeFileSync(settings, JSON.stringify({ language: "ar", agentModel: "keyed/model", chatModel: "keyed/model", modelRole: "agent", mode: "read-only", project, routerGate: "off", railPolicy: "thin", workMode: "basic", plugins: { secretHostBinding: on, inventory: false, verifier: false, reviewer: false, delegation: false, projectAwareness: false, sessionAwareness: false, generalAwareness: false, semanticFrame: false, lessons: false, usageMeter: false }, superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 }, customProviders: [{ id: "keyed", label: "keyed", baseUrl: `https://127.0.0.1:${port}/v1`, vaultKey: "custom-keyed-api-key", local: false, models: ["model"] }] }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], { cwd: resolve(import.meta.dir, "../../.."), env: { ...process.env, ABDO_SHELL_TOKEN: "tool-test", ABDO_FRAMED_STDIO: "1", ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, ABDO_CODE_TRUST_DIR: join(state, "trust"), USERPROFILE: base, HOME: base, ABDO_VAULT_HOME: base, ABDO_REQUIRE_SPRINT_PLAN: "0" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const errors = new Response(child.stderr).text(), frames: any[] = []
  const decoder = new LocalJsonFrameDecoder()
  void (async () => { for await (const bytes of child.stdout) frames.push(...decoder.push(bytes)) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean) => { const deadline = Date.now() + 120_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out " + JSON.stringify(frames).slice(-2000)); await Bun.sleep(15) } }
  try {
    send({ kind: "hello", shell: "desktop", token: "tool-test" }); await wait(() => frames.some((f) => f.kind === "ready"))
    send({ kind: "submit", mode: "read-only", turn: { id, body: "قل تمّ فقط" } })
    await wait(() => frames.some((f) => f.turnId === id && ["done", "refused", "unresolved"].includes(f.kind)))
    const end = frames.find((f) => f.turnId === id && ["done", "refused", "unresolved"].includes(f.kind))
    return { kind: end.kind, why: end.why, events: frames.filter((f) => f.kind === "event" && f.turnId === id).map((f) => String(f.payload ?? "")) }
  } finally { child.kill(); await child.exited; await errors }
}

describe("secret host binding — live on the engine", () => {
  test.skipIf(process.platform !== "win32")("a key bound to one address is refused at another before any byte leaves; turning the switch off clears it", async () => {
    const base = mkdtempSync(join(tmpdir(), "abdo-shb-live-")), state = join(base, "state"), project = join(base, "proj")
    mkdirSync(project, { recursive: true }); mkdirSync(join(state, "trust"), { recursive: true })
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "proj", version: "1.0.0" }))
    const { createHash } = await import("node:crypto")
    writeFileSync(join(state, "trust", createHash("sha256").update(resolve(project).toLowerCase()).digest("hex") + ".json"), JSON.stringify({ project, trustedAt: new Date().toISOString(), by: "test" }))
    // cloud providers must be https; the binding check runs before any network call, so two closed https ports stand in for two hosts
    const first = 1, second = 9
    const bindings = join(state, "secret-hosts.json")
    try {
      // an isolated vault holds a test key (the turn refuses earlier without one), and the binding is seeded as a first request leaves it
      const stored = await vaultSet("custom-keyed-api-key", "test-only-key-value", { ABDO_VAULT_HOME: base })
      expect("ok" in stored).toBe(true)
      secretHostVerdict(bindings, "custom-keyed-api-key", `https://127.0.0.1:${first}/v1/chat/completions`)
      const moved = await turn(state, project, base, second, true, "s1")
      const said = `${moved.why ?? ""}\n${moved.events.join("\n")}`
      expect(said).toContain(`مربوطٌ بالمضيف 127.0.0.1:${first} والطلبُ إلى 127.0.0.1:${second}`)
      expect(JSON.parse(readFileSync(bindings, "utf8"))["custom-keyed-api-key"].host).toBe(`127.0.0.1:${first}`)
      // the twin: switched off, the rule clears the bindings and no longer stops the request
      const off = await turn(state, project, base, second, false, "s2")
      expect(existsSync(bindings)).toBe(false)
      expect(`${off.why ?? ""}\n${off.events.join("\n")}`).not.toContain("مربوطٌ بالمضيف")
    } finally {
      for (let i = 0; i < 20; i += 1) { try { rmSync(base, { recursive: true, force: true }); break } catch { await Bun.sleep(250) } }
    }
  }, 240_000)
})
