/**
 * 10-10 — measured from the owner's screenshot: Atlassian answered «Internal Server Error» on the first authorize page because the client
 * AbdoCode had registered dynamically in an earlier attempt (kept in the vault forever) was no longer known there; a freshly registered
 * client got 200 with the same URL. The reused client also carried a stale random redirect port. Real engine, real vault, a fake server
 * that, like Atlassian, forgets the first client after it has been used: the second Connect must register again and link.
 */
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

test("every Connect on a DCR connector registers a fresh client on its own port, so an expired client never blocks linking", async () => {
  const home = mkdtempSync(join(tmpdir(), "abdo-connector-fresh-")), settings = join(home, "settings.json")
  const registered = new Map<string, string>() // client_id → its registered redirect_uri
  const forgotten = new Set<string>()
  const issued: { challenge: string; code: string }[] = []
  let seq = 0
  const fake = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url), origin = `http://127.0.0.1:${fake.port}`
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] })
    if (url.pathname === "/.well-known/oauth-authorization-server") return Response.json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, code_challenge_methods_supported: ["S256"] })
    if (url.pathname === "/register") { const body = await request.json() as { redirect_uris: string[] }; const id = `dyn-${++seq}`; registered.set(id, body.redirect_uris[0]!); return Response.json({ client_id: id }, { status: 201 }) }
    if (url.pathname === "/authorize") {
      const client = url.searchParams.get("client_id") ?? ""
      // like Atlassian: an unknown/forgotten client is a 500, and the redirect must be the one registered for that client
      if (!registered.has(client) || forgotten.has(client)) return new Response("Internal Server Error", { status: 500 })
      if (registered.get(client) !== url.searchParams.get("redirect_uri")) return new Response("redirect mismatch", { status: 400 })
      return new Response("consent page")
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(await request.text())
      const rec = issued.find((i) => i.code === form.get("code"))
      if (!rec || createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") !== rec.challenge) return Response.json({ error: "invalid_grant" }, { status: 400 })
      return Response.json({ access_token: `access-${form.get("client_id")}`, refresh_token: "r", token_type: "Bearer", expires_in: 3600 })
    }
    return new Response("nf", { status: 404 })
  } })
  writeFileSync(settings, JSON.stringify({ language: "ar", mode: "read-only", chatModel: "lp/model", agentModel: "lp/model", modelRole: "chat", plugins: { mcpClient: true }, customProviders: [{ id: "lp", label: "Local proof", baseUrl: "http://127.0.0.1:9/v1", vaultKey: "", local: true, models: ["model"] }] }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], { cwd: resolve(import.meta.dir, "../../.."), env: { ...process.env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: join(home, "state"), ABDO_SHELL_TOKEN: "fresh-test", ABDO_FRAMED_STDIO: "1", ABDO_VAULT_HOME: home, USERPROFILE: home, HOME: home, ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_CONNECTOR_RESOURCE_OVERRIDE: `linear=http://127.0.0.1:${fake.port}/mcp` }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const decoder = new LocalJsonFrameDecoder(), frames: Record<string, any>[] = []
  void (async () => { for await (const chunk of child.stdout) for (const f of decoder.push(chunk)) frames.push(f as Record<string, any>) })()
  const send = async (f: Record<string, unknown>) => { child.stdin.write(encodeLocalJsonFrame(f)); await child.stdin.flush() }
  const next = async (kind: string, where?: (f: Record<string, any>) => boolean) => { const deadline = Date.now() + 60_000; for (;;) { const i = frames.findIndex((f) => f.kind === kind && (where === undefined || where(f))); if (i >= 0) return frames.splice(i, 1)[0]!; if (Date.now() > deadline) throw new Error(`Missing ${kind}: ${JSON.stringify(frames.map((f) => f.kind + (f.state ? ":" + f.state : "")))}`); await Bun.sleep(20) } }
  // one Connect: the "browser" opens the authorize URL (must not be a 500) and returns the code to the loopback
  const connect = async (code: string) => {
    await send({ kind: "connector-auth", id: "linear" })
    const open = await next("connector-open"); const u = new URL(open.url)
    const page = await fetch(u.toString())
    const client = u.searchParams.get("client_id")!
    if (page.status !== 200) return { client, page: page.status, state: "browser-error" }
    issued.push({ challenge: u.searchParams.get("code_challenge")!, code })
    const redirect = new URL(u.searchParams.get("redirect_uri")!); redirect.searchParams.set("code", code); redirect.searchParams.set("state", u.searchParams.get("state")!)
    await fetch(redirect.toString())
    const done = await next("connector-status", (f) => f.id === "linear" && (f.state === "linked" || f.state === "error"))
    return { client, page: page.status, state: done.state }
  }
  try {
    await send({ kind: "hello", shell: "desktop", token: "fresh-test" }); await next("ready")
    const first = await connect("code-1")
    expect(first).toMatchObject({ page: 200, state: "linked" })
    forgotten.add(first.client) // the service expires the first client, as Atlassian did
    const second = await connect("code-2")
    expect(second.client).not.toBe(first.client)
    expect(second).toMatchObject({ page: 200, state: "linked" })
    expect(registered.size).toBe(2)
  } finally { child.kill(); await child.exited; fake.stop(true); rmSync(home, { recursive: true, force: true }) }
}, 120_000)
