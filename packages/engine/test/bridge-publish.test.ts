import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

// 10-10 — publish.mjs pushes the browser-extension update to AMO, Edge Add-ons and the Chrome Web Store. Run here against one
// local fake server that speaks the three documented APIs, so every request the script makes is read back and checked: the AMO
// JWT (HS256 over iss/jti/iat/exp, exp ≤ 5 min), the upload → poll → publish order per store, absence of credentials as a named
// refusal, a store's own error surfacing with a non-zero exit, and no secret in stdout/stderr — even when a store echoes one.

const ROOT = resolve(import.meta.dir, "../../browser-bridge")
const VERSION = JSON.parse(readFileSync(join(ROOT, "extension", "manifest.json"), "utf8")).version as string
const GUID = "abdo-code-bridge@technologyksa.sa"

const SECRETS = {
  AMO_JWT_ISSUER: "user:fake-issuer:4242",
  AMO_JWT_SECRET: "amo-secret-5f1c0e7d9a2b4c6e8f00112233445566",
  EDGE_CLIENT_ID: "edge-client-0b9d6c1e-77aa",
  EDGE_API_KEY: "edge-apikey-Zq81LmN0pQr7StUv",
  EDGE_PRODUCT_ID: "d34f98f5-f9b7-42b1-bebb-98707202b21d",
  CWS_CLIENT_ID: "cws-client-1234.apps.example",
  CWS_CLIENT_SECRET: "cws-secret-GOCSPX-AbCdEfGh",
  CWS_REFRESH_TOKEN: "cws-refresh-1//0gXyZ-refresh",
  CWS_PUBLISHER_ID: "publisher-77",
  CWS_EXTENSION_ID: "abcdefghijklmnopabcdefghijklmnop",
}
const ACCESS_TOKEN = "ya29.fake-access-token-from-google"
const MUST_NOT_LEAK = [SECRETS.AMO_JWT_SECRET, SECRETS.AMO_JWT_ISSUER, SECRETS.EDGE_API_KEY, SECRETS.EDGE_CLIENT_ID, SECRETS.CWS_CLIENT_SECRET, SECRETS.CWS_REFRESH_TOKEN, ACCESS_TOKEN]

type Seen = { method: string; path: string; headers: Record<string, string>; body: string; form?: Record<string, string> }
let seen: Seen[] = []
let scenario: { edgePublish?: "InProgressSubmission"; cwsPublish403?: boolean; amoInvalid?: boolean; echoSecret?: boolean } = {}
const polls: Record<string, number> = {}
const tick = (key: string) => (polls[key] = (polls[key] ?? 0) + 1)
let server: ReturnType<typeof Bun.serve>
let base = ""

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      const headers = Object.fromEntries(req.headers.entries())
      const entry: Seen = { method: req.method, path: decodeURIComponent(url.pathname), headers, body: "" }
      if ((headers["content-type"] ?? "").startsWith("multipart/form-data")) {
        const form = await req.formData()
        entry.form = {}
        for (const [k, v] of form.entries()) entry.form[k] = typeof v === "string" ? v : `file:${(v as File).name}:${(v as File).size}`
      } else entry.body = (headers["content-type"] ?? "").includes("zip") ? `<${(await req.arrayBuffer()).byteLength} bytes>` : await req.text()
      seen.push(entry)
      const p = entry.path
      // AMO v5
      if (req.method === "POST" && p === "/api/v5/addons/upload/") return json({ uuid: "up-1", channel: "listed", processed: false, valid: false })
      if (req.method === "GET" && p === "/api/v5/addons/upload/up-1/") {
        if (tick("amo") < 2) return json({ uuid: "up-1", processed: false, valid: false })
        if (scenario.amoInvalid) return json({ uuid: "up-1", processed: true, valid: false, validation: { errors: 1, messages: [{ type: "error", message: "Duplicate add-on ID found." }] } })
        return json({ uuid: "up-1", processed: true, valid: true, validation: { errors: 0, warnings: 2, messages: [] } })
      }
      if (req.method === "POST" && p === `/api/v5/addons/addon/${GUID}/versions/`) return json({ id: 9001, version: VERSION }, 201)
      // Edge v1.1
      const edge = `/v1/products/${SECRETS.EDGE_PRODUCT_ID}`
      if (req.method === "POST" && p === `${edge}/submissions/draft/package`) return new Response(null, { status: 202, headers: { location: "op-up-1" } })
      if (req.method === "GET" && p === `${edge}/submissions/draft/package/operations/op-up-1`)
        return json(tick("edge-up") < 2 ? { id: "op-up-1", status: "InProgress", message: null, errorCode: null, errors: null } : { id: "op-up-1", status: "Succeeded", message: "Successfully updated package to bridge.zip", errorCode: "", errors: null })
      if (req.method === "POST" && p === `${edge}/submissions`) return new Response(null, { status: 202, headers: { location: `${edge}/submissions/operations/op-pub-1` } })
      if (req.method === "GET" && p === `${edge}/submissions/operations/op-pub-1`) {
        if (scenario.edgePublish === "InProgressSubmission")
          return json({ id: "op-pub-1", status: "Failed", message: `Can't publish extension as your extension submission is in progress. Please try again later.${scenario.echoSecret ? ` key=${SECRETS.EDGE_API_KEY}` : ""}`, errorCode: "InProgressSubmission", errors: null })
        return json({ id: "op-pub-1", status: "Succeeded", message: "Successfully created submission with ID sub-77", errorCode: "", errors: null })
      }
      // Google OAuth + CWS v2
      if (req.method === "POST" && p === "/token") return json({ access_token: ACCESS_TOKEN, expires_in: 3599, scope: "https://www.googleapis.com/auth/chromewebstore", token_type: "Bearer" })
      const item = `publishers/${SECRETS.CWS_PUBLISHER_ID}/items/${SECRETS.CWS_EXTENSION_ID}`
      if (req.method === "POST" && p === `/upload/v2/${item}:upload`) return json({ name: item, itemId: SECRETS.CWS_EXTENSION_ID, crxVersion: VERSION, uploadState: "IN_PROGRESS" })
      if (req.method === "GET" && p === `/v2/${item}:fetchStatus`) return json({ name: item, lastAsyncUploadState: tick("cws") < 2 ? "IN_PROGRESS" : "SUCCEEDED" })
      if (req.method === "POST" && p === `/v2/${item}:publish`) {
        if (scenario.cwsPublish403) return json({ error: { code: 403, message: "The caller does not have permission to publish this item.", status: "PERMISSION_DENIED" } }, 403)
        return json({ name: item, itemId: SECRETS.CWS_EXTENSION_ID, state: "PENDING_REVIEW" })
      }
      return json({ detail: "not found" }, 404)
    },
  })
  base = `http://127.0.0.1:${server.port}`
})
afterAll(() => {
  server.stop(true)
  Bun.spawnSync(["node", "scripts/pack.mjs"], { cwd: ROOT }) // leave dist/ as the default pack builds it
})

function cleanEnv(extra: Record<string, string>) {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !(k in SECRETS) && !/^(AMO|EDGE|CWS|GOOGLE_OAUTH|BRIDGE_)/.test(k)) env[k] = v
  return { ...env, AMO_API_BASE: `${base}/api/v5`, EDGE_API_BASE: base, CWS_API_BASE: base, GOOGLE_OAUTH_URL: `${base}/token`, BRIDGE_PUBLISH_POLL_MS: "5", BRIDGE_PUBLISH_POLL_TRIES: "20", ...extra }
}

async function publish(args: string[], extra: Record<string, string>) {
  seen = []
  for (const k of Object.keys(polls)) delete polls[k]
  const proc = Bun.spawn(["node", "scripts/publish.mjs", ...args], { cwd: ROOT, env: cleanEnv(extra), stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { stdout, stderr, code, all: stdout + stderr }
}

function verifyJwt(header: string | undefined) {
  expect(header).toStartWith("JWT ")
  const token = header!.slice(4)
  const [h, p, s] = token.split(".")
  const expected = createHmac("sha256", SECRETS.AMO_JWT_SECRET).update(`${h}.${p}`).digest("base64url")
  expect(s).toBe(expected)
  const head = JSON.parse(Buffer.from(h, "base64url").toString())
  const claims = JSON.parse(Buffer.from(p, "base64url").toString())
  expect(head.alg).toBe("HS256")
  expect(claims.iss).toBe(SECRETS.AMO_JWT_ISSUER)
  expect(typeof claims.jti).toBe("string")
  expect(claims.jti.length).toBeGreaterThan(8)
  const now = Math.floor(Date.now() / 1000)
  expect(Math.abs(claims.iat - now)).toBeLessThan(120)
  expect(claims.exp).toBeGreaterThan(claims.iat)
  expect(claims.exp - claims.iat).toBeLessThanOrEqual(300)
  return claims.jti as string
}

const noLeak = (text: string) => { for (const s of MUST_NOT_LEAK) expect(text).not.toContain(s) }

describe("bridge publish to the three stores", () => {
  test("all three stores: upload, poll, publish in the documented order, with a valid AMO JWT and no secret printed", async () => {
    const r = await publish([], SECRETS)
    expect(r.stderr).toBe("")
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("summary: ok=[chrome,edge,firefox] failed=[] skipped=[]")

    const paths = seen.map((s) => `${s.method} ${s.path}`)
    // Firefox: the pack carries the live listing's id, upload (listed) → poll until processed → version on the add-on
    expect(JSON.parse(readFileSync(join(ROOT, "dist", "unpacked", "firefox", "manifest.json"), "utf8")).browser_specific_settings.gecko.id).toBe(GUID)
    const amo = seen.filter((s) => s.path.startsWith("/api/v5/"))
    expect(amo.map((s) => `${s.method} ${s.path}`)).toEqual(["POST /api/v5/addons/upload/", "GET /api/v5/addons/upload/up-1/", "GET /api/v5/addons/upload/up-1/", `POST /api/v5/addons/addon/${GUID}/versions/`])
    expect(amo[0].form).toEqual({ upload: expect.stringMatching(new RegExp(`^file:abdo-code-bridge-firefox-${VERSION.replace(/\./g, "\\.")}\\.zip:\\d+$`)), channel: "listed" })
    expect(JSON.parse(amo[3].body)).toEqual({ upload: "up-1", release_notes: { "en-US": `Abdo Code Bridge ${VERSION}` } })
    const jtis = amo.map((s) => verifyJwt(s.headers.authorization))
    expect(new Set(jtis).size).toBe(jtis.length) // a fresh token per request

    // Edge: package (zip) → operation from Location → poll → publish with notes → poll
    const edge = seen.filter((s) => s.path.startsWith("/v1/products/"))
    const ep = `/v1/products/${SECRETS.EDGE_PRODUCT_ID}`
    expect(edge.map((s) => `${s.method} ${s.path}`)).toEqual([
      `POST ${ep}/submissions/draft/package`, `GET ${ep}/submissions/draft/package/operations/op-up-1`, `GET ${ep}/submissions/draft/package/operations/op-up-1`,
      `POST ${ep}/submissions`, `GET ${ep}/submissions/operations/op-pub-1`,
    ])
    for (const s of edge) { expect(s.headers.authorization).toBe(`ApiKey ${SECRETS.EDGE_API_KEY}`); expect(s.headers["x-clientid"]).toBe(SECRETS.EDGE_CLIENT_ID) }
    expect(edge[0].headers["content-type"]).toBe("application/zip")
    expect(edge[0].body).toMatch(/^<\d+ bytes>$/)
    expect(JSON.parse(edge[3].body)).toEqual({ notes: `Abdo Code Bridge ${VERSION}` })

    // Chrome: refresh token → access token → upload → fetchStatus until SUCCEEDED → publish
    const item = `publishers/${SECRETS.CWS_PUBLISHER_ID}/items/${SECRETS.CWS_EXTENSION_ID}`
    const cws = seen.filter((s) => s.path === "/token" || s.path.includes("/v2/"))
    expect(cws.map((s) => `${s.method} ${s.path}`)).toEqual(["POST /token", `POST /upload/v2/${item}:upload`, `GET /v2/${item}:fetchStatus`, `GET /v2/${item}:fetchStatus`, `POST /v2/${item}:publish`])
    expect(Object.fromEntries(new URLSearchParams(cws[0].body))).toEqual({ client_id: SECRETS.CWS_CLIENT_ID, client_secret: SECRETS.CWS_CLIENT_SECRET, refresh_token: SECRETS.CWS_REFRESH_TOKEN, grant_type: "refresh_token" })
    for (const s of cws.slice(1)) expect(s.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`)

    expect(paths.length).toBe(4 + 5 + 5)
    // receipts, one line per step
    for (const line of ["[firefox] uploaded", "[firefox] validated", `[firefox] version ${VERSION} created`, "[edge] uploaded", "[edge] package accepted", "[edge] submitted for certification", "[chrome] access token obtained", "[chrome] uploaded", "[chrome] submitted for review — state PENDING_REVIEW"]) expect(r.stdout).toContain(line)
    noLeak(r.all)
    // positive twin of the leak check: the secrets did travel — to the store, not to the log
    expect(JSON.stringify(seen)).toContain(SECRETS.EDGE_API_KEY)
  }, 120_000)

  test("absent credentials are a named refusal, not success; --require-all turns them into failure", async () => {
    const r = await publish([], {})
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("[chrome] skipped: missing CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN, CWS_PUBLISHER_ID, CWS_EXTENSION_ID")
    expect(r.stdout).toContain("[edge] skipped: missing EDGE_CLIENT_ID, EDGE_API_KEY, EDGE_PRODUCT_ID")
    expect(r.stdout).toContain("[firefox] skipped: missing AMO_JWT_ISSUER, AMO_JWT_SECRET")
    expect(r.stdout).toContain("ok=[] failed=[] skipped=[chrome,edge,firefox]")
    expect(seen).toEqual([])
    // one var missing of a store's set is still a refusal, naming that var
    const partial = await publish(["--stores", "edge", "--require-all"], { EDGE_CLIENT_ID: SECRETS.EDGE_CLIENT_ID, EDGE_PRODUCT_ID: SECRETS.EDGE_PRODUCT_ID })
    expect(partial.code).toBe(1)
    expect(partial.stdout).toContain("[edge] skipped: missing EDGE_API_KEY")
    expect(seen).toEqual([])
  }, 120_000)

  test("a store's error exits non-zero with the store's own message, other stores still run, and an echoed secret is masked", async () => {
    scenario = { edgePublish: "InProgressSubmission", cwsPublish403: true, echoSecret: true }
    try {
      const r = await publish([], SECRETS)
      expect(r.code).toBe(1)
      expect(r.stderr).toContain("[edge] FAILED publish: InProgressSubmission (a submission is already in review")
      expect(r.stderr).toContain("Can't publish extension as your extension submission is in progress.")
      expect(r.stderr).toContain("key=***")
      expect(r.stderr).toContain("[chrome] FAILED publish: HTTP 403 PERMISSION_DENIED: The caller does not have permission to publish this item.")
      expect(r.stdout).toContain("summary: ok=[firefox] failed=[chrome,edge] skipped=[]")
      noLeak(r.all)
    } finally { scenario = {} }
    scenario = { amoInvalid: true }
    try {
      const r = await publish(["--stores", "firefox"], SECRETS)
      expect(r.code).toBe(1)
      expect(r.stderr).toContain("[firefox] FAILED validation failed: Duplicate add-on ID found.")
      expect(seen.some((s) => s.path.endsWith("/versions/"))).toBe(false) // no version from an invalid upload
    } finally { scenario = {} }
  }, 120_000)

  test("--dry-run makes no request and prints each one with credentials masked", async () => {
    const r = await publish(["--dry-run"], SECRETS)
    expect(r.code).toBe(0)
    expect(seen).toEqual([])
    expect(r.stdout).toContain(`[firefox] would POST ${base}/api/v5/addons/upload/ (Authorization: JWT ***) multipart{upload=<abdo-code-bridge-firefox-${VERSION}.zip`)
    expect(r.stdout).toContain("channel=listed}")
    expect(r.stdout).toContain(`[edge] would POST ${base}/v1/products/${SECRETS.EDGE_PRODUCT_ID}/submissions (Authorization: ApiKey ***; X-ClientID: ***; Content-Type: application/json)`)
    expect(r.stdout).toContain(`[chrome] would POST ${base}/token (Content-Type: application/x-www-form-urlencoded) client_id=***&client_secret=***&refresh_token=***&grant_type=refresh_token`)
    expect(r.stdout).toContain("summary: ok=[chrome,edge,firefox] failed=[] skipped=[] (dry-run)")
    noLeak(r.all)
  }, 120_000)

  test("refuses to send credentials to a plain-http host, and to publish a version other than the manifest's", async () => {
    const r = await publish(["--stores", "firefox"], { ...SECRETS, AMO_API_BASE: "http://addons.example.test/api/v5" })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("AMO_API_BASE refused")
    expect(seen).toEqual([])
    const wrong = await publish(["--expect-version", "9.9.9"], SECRETS)
    expect(wrong.code).toBe(2)
    expect(wrong.stderr).toContain(`--expect-version 9.9.9 but extension/manifest.json is ${VERSION}`)
    expect(seen).toEqual([])
  }, 120_000)
})
