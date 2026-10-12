// نشرُ تحديثات إضافة عبدو كود في المتاجر الثلاثة آلياً — بلا اعتمادات (node 20+: fetch وFormData وBlob مدمجة).
//   node scripts/publish.mjs [--stores chrome,edge,firefox] [--dry-run] [--require-all]
//                            [--notes "<نص>" | --notes-file <ملف>] [--expect-version x.y.z]
// يبني الحزمَ بـpack.mjs (فايرفوكس بمعرّف القائمة الحيّة على AMO) ثمّ يرفع وينشر لكلّ متجرٍ مطلوب.
// الاعتماداتُ من متغيّرات البيئة وحدها، لا تُطبع ولا تُكتب على القرص:
//   فايرفوكس (AMO API v5):          AMO_JWT_ISSUER, AMO_JWT_SECRET
//   إيدج (Edge Add-ons API v1.1):    EDGE_CLIENT_ID, EDGE_API_KEY, EDGE_PRODUCT_ID
//   كروم (Chrome Web Store API v2):  CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN, CWS_PUBLISHER_ID, CWS_EXTENSION_ID
// الغيابُ رفضٌ لا إذن: متجرٌ ينقصه متغيّرٌ يُعلَن «skipped: missing <VAR>» ولا يُحسب نجاحاً.
// رمزُ الخروج: 0 إن نجح كلُّ متجرٍ نُفِّذ؛ 1 إن فشل متجر (أو تُخطّي متجرٌ مع --require-all)؛ 2 لخطأ استعمالٍ أو تعبئة.
// العناوينُ قابلةٌ للتبديل للاختبار (AMO_API_BASE, EDGE_API_BASE, CWS_API_BASE, GOOGLE_OAUTH_URL) — https وحده،
// أو http على 127.0.0.1/localhost فقط، كي لا يُرسَل اعتمادٌ إلى مضيفٍ عارٍ.
// المراجع (قُرئت 2026-10-10): mozilla.github.io/addons-server/topics/api/{auth,addons}.html،
// learn.microsoft.com/microsoft-edge/extensions/update/api/{using-addons-api,addons-api-reference}،
// developer.chrome.com/docs/webstore/using-api و api/reference/rest/v2.
import { createHmac, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "..")
const dist = join(root, "dist")
const env = process.env

// معرّفُ القائمة الحيّة على AMO (slug: abdo-code-bridge) — لا يتغيّر أبداً، والحزمةُ تحمله في browser_specific_settings.
const AMO_ADDON_GUID = "abdo-code-bridge@technologyksa.sa"
const ALL_STORES = ["chrome", "edge", "firefox"]
const REQUIRED = {
  firefox: ["AMO_JWT_ISSUER", "AMO_JWT_SECRET"],
  edge: ["EDGE_CLIENT_ID", "EDGE_API_KEY", "EDGE_PRODUCT_ID"],
  chrome: ["CWS_CLIENT_ID", "CWS_CLIENT_SECRET", "CWS_REFRESH_TOKEN", "CWS_PUBLISHER_ID", "CWS_EXTENSION_ID"],
}
// المعرّفاتُ العامّة (EDGE_PRODUCT_ID, CWS_PUBLISHER_ID, CWS_EXTENSION_ID) تظهر في الإيصالات؛ ما سواها يُحجب.
const SECRET_VARS = ["AMO_JWT_ISSUER", "AMO_JWT_SECRET", "EDGE_CLIENT_ID", "EDGE_API_KEY", "CWS_CLIENT_ID", "CWS_CLIENT_SECRET", "CWS_REFRESH_TOKEN"]

// ---------- الأوامر ----------
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
if (flag("--help") || flag("-h")) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).slice(0, 10).join("\n"))
  process.exit(0)
}
const DRY = flag("--dry-run")
const REQUIRE_ALL = flag("--require-all")
const stores = (option("--stores") ?? ALL_STORES.join(",")).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
const unknown = stores.filter((s) => !ALL_STORES.includes(s))
if (stores.length === 0 || unknown.length > 0) usage(`--stores: unknown store(s) ${unknown.join(",") || "(none)"} — allowed: ${ALL_STORES.join(",")}`)
const POLL_MS = Number(env.BRIDGE_PUBLISH_POLL_MS ?? 5000)
const POLL_TRIES = Number(env.BRIDGE_PUBLISH_POLL_TRIES ?? 120)

function usage(message) { console.error(`publish: ${message}`); process.exit(2) }

// ---------- الحجب: لا سرَّ في أيّ سطرٍ يُطبع ----------
const secrets = new Set(SECRET_VARS.map((v) => env[v]).filter((v) => typeof v === "string" && v.length >= 4))
const addSecret = (value) => { if (typeof value === "string" && value.length >= 4) secrets.add(value) }
function redact(text) {
  let out = String(text)
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(s).join("***")
  return out
}
const say = (line) => console.log(redact(line))
const warn = (line) => console.error(redact(line))

// ---------- التعبئة ----------
const manifest = JSON.parse(readFileSync(join(root, "extension", "manifest.json"), "utf8"))
const version = String(manifest.version)
const expected = option("--expect-version")
if (expected !== undefined && expected !== version) usage(`--expect-version ${expected} but extension/manifest.json is ${version}`)
const notesFile = option("--notes-file")
const notes = (notesFile ? readFileSync(notesFile, "utf8") : option("--notes") ?? env.BRIDGE_RELEASE_NOTES ?? "").trim() || `Abdo Code Bridge ${version}`

const pack = spawnSync(process.execPath, [join(here, "pack.mjs"), "--gecko-id", AMO_ADDON_GUID], { cwd: root, encoding: "utf8" })
if (pack.status !== 0) { warn(`pack failed (exit ${pack.status}):\n${pack.stdout ?? ""}${pack.stderr ?? ""}`); process.exit(2) }
const zipOf = (store) => join(dist, `abdo-code-bridge-${store}-${version}.zip`)
say(`pack: Abdo Code Bridge ${version} built (firefox id ${AMO_ADDON_GUID})${DRY ? " — dry-run, no network" : ""}`)

// ---------- HTTP ----------
class StoreError extends Error {}

function baseUrl(name, fallback) {
  const raw = (env[name] ?? "").trim() || fallback
  let url
  try { url = new URL(raw) } catch { throw new StoreError(`${name} is not a URL`) }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new StoreError(`${name} refused: credentials go over https only (or http to loopback)`)
  return raw.replace(/\/+$/, "")
}

function describeBody(body) {
  if (body === undefined) return ""
  if (body instanceof FormData) return " multipart{" + [...body.entries()].map(([k, v]) => (typeof v === "string" ? `${k}=${v}` : `${k}=<${v.name}, ${v.size} bytes>`)).join(", ") + "}"
  if (body instanceof Uint8Array) return ` <zip ${body.length} bytes>`
  return ` ${body}`
}

function maskHeaders(headers) {
  return Object.entries(headers).map(([k, v]) => {
    if (/^authorization$/i.test(k)) return `${k}: ${String(v).split(" ")[0]} ***`
    if (/^x-clientid$/i.test(k)) return `${k}: ***`
    return `${k}: ${v}`
  }).join("; ")
}

/** Summarise a store's error body: the store's own message and code, never the whole page. */
function storeMessage(text) {
  try {
    const j = JSON.parse(text)
    const parts = []
    if (j.errorCode) parts.push(j.errorCode)
    if (j.error?.status) parts.push(j.error.status)
    const msg = j.error?.message ?? j.message ?? j.detail ?? j.error_description ?? (typeof j.error === "string" ? j.error : undefined)
    if (msg) parts.push(msg)
    if (Array.isArray(j.errors) && j.errors.length) parts.push(j.errors.map((e) => (typeof e === "string" ? e : e.message ?? JSON.stringify(e))).join("; "))
    if (parts.length === 0) parts.push(JSON.stringify(j))
    return parts.join(": ").slice(0, 600)
  } catch { return String(text).replace(/\s+/g, " ").slice(0, 300) }
}

async function http(store, step, method, url, { headers = {}, body, dry = {} } = {}) {
  if (DRY) {
    say(`[${store}] would ${method} ${url}${Object.keys(headers).length ? ` (${maskHeaders(headers)})` : ""}${describeBody(body)}`)
    return { status: dry.status ?? 200, location: dry.location ?? null, json: dry.json ?? {} }
  }
  let res
  try { res = await fetch(url, { method, headers, body }) } catch (e) { throw new StoreError(`${step}: network error ${e?.cause?.code ?? e?.message ?? e}`) }
  const text = await res.text()
  if (!res.ok) throw new StoreError(`${step}: HTTP ${res.status} ${storeMessage(text)}`)
  let json = {}
  if (text.trim()) { try { json = JSON.parse(text) } catch { json = { raw: text } } }
  return { status: res.status, location: res.headers.get("location"), json }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function poll(step, fetchOnce, done) {
  for (let i = 0; i < POLL_TRIES; i++) {
    const r = await fetchOnce()
    if (done(r)) return r
    if (!DRY) await sleep(POLL_MS)
  }
  throw new StoreError(`${step}: still in progress after ${POLL_TRIES} checks`)
}

// ---------- فايرفوكس — AMO API v5 ----------
/** JWT HS256 per the AMO auth page: iss = API key, unique jti, UTC iat, exp ≤ 5 minutes after iat. Fresh per request. */
function amoJwt(issuer, secret) {
  const now = Math.floor(Date.now() / 1000)
  const part = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
  const unsigned = `${part({ alg: "HS256", typ: "JWT" })}.${part({ iss: issuer, jti: randomUUID(), iat: now, exp: now + 180 })}`
  const token = `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`
  addSecret(token)
  return token
}

async function firefox() {
  const api = baseUrl("AMO_API_BASE", "https://addons.mozilla.org/api/v5")
  const auth = () => ({ Authorization: `JWT ${amoJwt(env.AMO_JWT_ISSUER, env.AMO_JWT_SECRET)}` })
  const zip = zipOf("firefox")
  const form = new FormData()
  form.append("upload", new Blob([readFileSync(zip)], { type: "application/zip" }), basename(zip))
  form.append("channel", "listed")
  const up = (await http("firefox", "upload", "POST", `${api}/addons/upload/`, { headers: auth(), body: form, dry: { json: { uuid: "<upload-uuid>", processed: false } } })).json
  if (!up.uuid) throw new StoreError(`upload: no uuid in response ${storeMessage(JSON.stringify(up))}`)
  say(`[firefox] uploaded ${basename(zip)} — upload ${up.uuid}`)
  const checked = up.processed ? up : (await poll("validation", () => http("firefox", "validation", "GET", `${api}/addons/upload/${encodeURIComponent(up.uuid)}/`, { headers: auth(), dry: { json: { uuid: up.uuid, processed: true, valid: true } } }), (r) => r.json.processed === true)).json
  if (!checked.valid) {
    const errors = (checked.validation?.messages ?? []).filter((m) => m.type === "error").map((m) => m.message).slice(0, 5)
    throw new StoreError(`validation failed: ${errors.join("; ") || storeMessage(JSON.stringify(checked.validation ?? checked))}`)
  }
  say(`[firefox] validated — ${checked.validation?.errors ?? 0} errors, ${checked.validation?.warnings ?? 0} warnings`)
  const v = (await http("firefox", "version", "POST", `${api}/addons/addon/${encodeURIComponent(AMO_ADDON_GUID)}/versions/`, {
    headers: { ...auth(), "Content-Type": "application/json" },
    body: JSON.stringify({ upload: up.uuid, release_notes: { "en-US": notes } }),
    dry: { json: { id: "<version-id>", version } },
  })).json
  say(`[firefox] version ${v.version ?? version} created on ${AMO_ADDON_GUID} (id ${v.id ?? "?"}) — listed, awaiting AMO review`)
}

// ---------- إيدج — Edge Add-ons API v1.1 ----------
const EDGE_HINTS = {
  InProgressSubmission: "a submission is already in review — wait for Microsoft to finish it, then re-run",
  UnpublishInProgress: "the extension is being unpublished",
  NoModulesUpdated: "nothing new to publish — bump the version and re-upload",
  ModuleStateUnPublishable: "a module of the submission is invalid — fix it in Partner Center",
  SubmissionValidationError: "submission validation failed",
  CreateNotAllowed: "the API updates existing products only — create the product in Partner Center first",
}
function edgeFailure(step, op) {
  const code = op.errorCode || "Failed"
  const errs = Array.isArray(op.errors) && op.errors.length ? ` [${op.errors.map((e) => (typeof e === "string" ? e : e.message ?? JSON.stringify(e))).join("; ")}]` : ""
  return new StoreError(`${step}: ${code}${EDGE_HINTS[code] ? ` (${EDGE_HINTS[code]})` : ""}: ${op.message ?? ""}${errs}`)
}
const operationId = (location, step) => {
  const id = String(location ?? "").split("/").filter(Boolean).pop()
  if (!id) throw new StoreError(`${step}: no operation id in the Location header`)
  return id
}

async function edge() {
  const api = baseUrl("EDGE_API_BASE", "https://api.addons.microsoftedge.microsoft.com")
  const product = encodeURIComponent(env.EDGE_PRODUCT_ID)
  const auth = { Authorization: `ApiKey ${env.EDGE_API_KEY}`, "X-ClientID": env.EDGE_CLIENT_ID }
  const zip = zipOf("edge")
  const up = await http("edge", "upload", "POST", `${api}/v1/products/${product}/submissions/draft/package`, { headers: { ...auth, "Content-Type": "application/zip" }, body: readFileSync(zip), dry: { status: 202, location: "<upload-operation>" } })
  const upOp = operationId(up.location, "upload")
  say(`[edge] uploaded ${basename(zip)} — operation ${upOp}`)
  const upDone = (await poll("upload status", () => http("edge", "upload status", "GET", `${api}/v1/products/${product}/submissions/draft/package/operations/${encodeURIComponent(upOp)}`, { headers: auth, dry: { json: { status: "Succeeded", message: "dry-run" } } }), (r) => r.json.status !== "InProgress")).json
  if (upDone.status !== "Succeeded") throw edgeFailure("upload", upDone)
  say(`[edge] package accepted — ${upDone.message ?? "Succeeded"}`)
  const pub = await http("edge", "publish", "POST", `${api}/v1/products/${product}/submissions`, { headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ notes }), dry: { status: 202, location: "<publish-operation>" } })
  const pubOp = operationId(pub.location, "publish")
  const pubDone = (await poll("publish status", () => http("edge", "publish status", "GET", `${api}/v1/products/${product}/submissions/operations/${encodeURIComponent(pubOp)}`, { headers: auth, dry: { json: { status: "Succeeded", message: "dry-run" } } }), (r) => r.json.status !== "InProgress")).json
  if (pubDone.status !== "Succeeded") throw edgeFailure("publish", pubDone)
  say(`[edge] submitted for certification — ${pubDone.message ?? "Succeeded"}`)
}

// ---------- كروم — Chrome Web Store API v2 ----------
async function chrome() {
  const tokenUrl = baseUrl("GOOGLE_OAUTH_URL", "https://oauth2.googleapis.com/token")
  const api = baseUrl("CWS_API_BASE", "https://chromewebstore.googleapis.com")
  const form = new URLSearchParams({ client_id: env.CWS_CLIENT_ID, client_secret: env.CWS_CLIENT_SECRET, refresh_token: env.CWS_REFRESH_TOKEN, grant_type: "refresh_token" })
  const tok = (await http("chrome", "oauth token", "POST", tokenUrl, { headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: DRY ? "client_id=***&client_secret=***&refresh_token=***&grant_type=refresh_token" : form.toString(), dry: { json: { access_token: "<access-token>" } } })).json
  if (!tok.access_token) throw new StoreError(`oauth token: no access_token in response`)
  addSecret(tok.access_token)
  say(`[chrome] access token obtained (scope ${tok.scope ?? "chromewebstore"})`)
  const auth = { Authorization: `Bearer ${tok.access_token}` }
  const item = `publishers/${encodeURIComponent(env.CWS_PUBLISHER_ID)}/items/${encodeURIComponent(env.CWS_EXTENSION_ID)}`
  const zip = zipOf("chrome")
  const up = (await http("chrome", "upload", "POST", `${api}/upload/v2/${item}:upload`, { headers: { ...auth, "Content-Type": "application/zip" }, body: readFileSync(zip), dry: { json: { uploadState: "IN_PROGRESS" } } })).json
  let state = up.uploadState
  if (state === "IN_PROGRESS" || state === "UPLOAD_IN_PROGRESS") {
    const st = (await poll("upload status", () => http("chrome", "upload status", "GET", `${api}/v2/${item}:fetchStatus`, { headers: auth, dry: { json: { lastAsyncUploadState: "SUCCEEDED" } } }), (r) => !["IN_PROGRESS", "UPLOAD_IN_PROGRESS"].includes(r.json.lastAsyncUploadState))).json
    state = st.lastAsyncUploadState
  }
  if (state !== "SUCCEEDED") throw new StoreError(`upload: uploadState ${state ?? "missing"} ${storeMessage(JSON.stringify(up))}`)
  say(`[chrome] uploaded ${basename(zip)} — crxVersion ${up.crxVersion ?? version}, ${state}`)
  const pub = (await http("chrome", "publish", "POST", `${api}/v2/${item}:publish`, { headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ publishType: "DEFAULT_PUBLISH" }), dry: { json: { state: "PENDING_REVIEW" } } })).json
  say(`[chrome] submitted for review — state ${pub.state ?? "?"}`)
}

// ---------- التشغيل ----------
const runners = { firefox, edge, chrome }
const results = []
for (const store of stores) {
  const missing = REQUIRED[store].filter((v) => !(env[v] ?? "").trim())
  if (missing.length > 0) { say(`[${store}] skipped: missing ${missing.join(", ")}`); results.push({ store, status: "skipped" }); continue }
  try { await runners[store](); results.push({ store, status: "ok" }) } catch (e) {
    warn(`[${store}] FAILED ${e instanceof StoreError ? e.message : e?.stack ?? e}`)
    results.push({ store, status: "failed" })
  }
}
const count = (s) => results.filter((r) => r.status === s).map((r) => r.store)
say(`summary: ok=[${count("ok").join(",")}] failed=[${count("failed").join(",")}] skipped=[${count("skipped").join(",")}]${DRY ? " (dry-run)" : ""}`)
process.exit(count("failed").length > 0 || (REQUIRE_ALL && count("skipped").length > 0) ? 1 : 0)
