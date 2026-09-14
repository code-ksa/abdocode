import { describe, expect, test } from "bun:test"
import { extractText, GOOGLE_TOOLS, GoogleConnector, googleOptionsFromEnv, serveGoogleMcp } from "../src/mcp-servers/google"

// خادمُ جوجل على واجهاتٍ زائفة (Gmail/Calendar/Drive) تطالب بـBearer: بحثٌ وقراءةٌ ومسودّة وأحداثٌ وملفّات، و401 يجدّد الرمز
// بالـrefresh ثمّ يعيد الطلب؛ وحلقةُ MCP على stdio تعلن الأدواتِ الثماني. لا شبكةَ خارجية.

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url")

function fakeGoogle() {
  let valid = "access-1"
  const posted: { path: string; body: unknown }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/token") { const form = new URLSearchParams(await request.text()); if (form.get("refresh_token") === "refresh-1" && form.get("client_id") === "gid" && form.get("client_secret") === "gsecret") { valid = "access-2"; return Response.json({ access_token: "access-2", token_type: "Bearer", expires_in: 3600 }) } return Response.json({ error: "invalid_grant" }, { status: 400 }) }
      if (request.headers.get("authorization") !== `Bearer ${valid}`) return Response.json({ error: { code: 401, message: "Invalid Credentials" } }, { status: 401 })
      const p = url.pathname
      if (p === "/gmail/messages") return Response.json({ messages: [{ id: "m1" }, { id: "m2" }] })
      if (p === "/gmail/messages/m1" && url.searchParams.get("format") === "metadata") return Response.json({ id: "m1", snippet: "hello there", payload: { headers: [{ name: "From", value: "a@x.test" }, { name: "Subject", value: "Invoice" }, { name: "Date", value: "Mon" }] } })
      if (p === "/gmail/messages/m2" && url.searchParams.get("format") === "metadata") return Response.json({ id: "m2", snippet: "second", payload: { headers: [{ name: "From", value: "b@x.test" }, { name: "Subject", value: "Meeting" }, { name: "Date", value: "Tue" }] } })
      if (p === "/gmail/messages/m1" && url.searchParams.get("format") === "full") return Response.json({ id: "m1", payload: { mimeType: "multipart/alternative", headers: [{ name: "From", value: "a@x.test" }, { name: "To", value: "me@x.test" }, { name: "Subject", value: "Invoice" }, { name: "Date", value: "Mon" }], parts: [{ mimeType: "text/plain", body: { data: b64url("Please pay 100 SAR") } }, { mimeType: "text/html", body: { data: b64url("<p>Please <b>pay</b></p>") } }] } })
      if (p === "/gmail/drafts" && request.method === "POST") { posted.push({ path: p, body: await request.json() }); return Response.json({ id: "d1" }) }
      if (p === "/gmail/drafts/send" && request.method === "POST") { posted.push({ path: p, body: await request.json() }); return Response.json({ id: "sent-1" }) }
      if (p === "/calendar/v3/calendars/primary/events" && request.method === "GET") return Response.json({ items: [{ id: "e1", summary: "Court", start: { dateTime: "2026-09-07T09:00:00+03:00" }, end: { dateTime: "2026-09-07T10:00:00+03:00" }, location: "Jeddah" }] })
      if (p === "/calendar/v3/calendars/primary/events" && request.method === "POST") { posted.push({ path: p, body: await request.json() }); return Response.json({ id: "e2", htmlLink: "https://cal/e2" }) }
      if (p === "/drive/v3/files" && url.searchParams.get("q") !== null) return Response.json({ files: [{ id: "f1", name: "Contract.docx", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-09-01T00:00:00Z", webViewLink: "https://drive/f1" }] })
      if (p === "/drive/v3/files/f1" && url.searchParams.get("fields") !== null) return Response.json({ id: "f1", name: "Contract", mimeType: "application/vnd.google-apps.document" })
      if (p === "/drive/v3/files/f1/export") return new Response("Contract text body", { headers: { "content-type": "text/plain" } })
      if (p === "/drive/v3/files/f2" && url.searchParams.get("fields") !== null) return Response.json({ id: "f2", name: "photo.png", mimeType: "image/png" })
      return new Response("nf " + p, { status: 404 })
    },
  })
  const base = `http://127.0.0.1:${server.port}`
  return { server, posted, options: { accessToken: "stale", refreshToken: "refresh-1", clientId: "gid", clientSecret: "gsecret", tokenUrl: `${base}/token`, gmailBase: `${base}/gmail`, apisBase: base }, stop: () => server.stop(true) }
}

describe("mcp-google — Gmail وCalendar وDrive على واجهاتٍ زائفة", () => {
  test("بحثٌ وقراءةٌ ومسودّةٌ وإرسال؛ الرمزُ الفاسد يُجدَّد مرّةً ثمّ تمرّ كلُّ النداءات", async () => {
    const g = fakeGoogle()
    try {
      const google = new GoogleConnector(g.options)
      const search = await google.run("gmail_search", { query: "invoice", max: 2 })
      expect(search).toContain("[m1] Mon · من: a@x.test · Invoice")
      expect(search).toContain("hello there")
      const read = await google.run("gmail_read", { id: "m1" })
      expect(read).toContain("العنوان: Invoice")
      expect(read).toContain("Please pay 100 SAR")
      expect(read).not.toContain("<b>")
      const draft = await google.run("gmail_draft", { to: "c@x.test", subject: "Re", body: "مرحباً" })
      expect(draft).toContain("d1")
      const raw = (g.posted[0]!.body as { message: { raw: string } }).message.raw
      expect(Buffer.from(raw, "base64url").toString("utf8")).toContain("Subject: Re")
      expect(await google.run("gmail_send_draft", { draftId: "d1" })).toContain("sent-1")
    } finally { g.stop() }
  })

  test("التقويم وDrive: سردٌ وإنشاءٌ وبحثٌ وقراءةُ مستندٍ نصّاً، والملفُّ غيرُ النصّيّ يُقال", async () => {
    const g = fakeGoogle()
    try {
      const google = new GoogleConnector({ ...g.options, accessToken: "access-1" })
      expect(await google.run("calendar_events", {})).toContain("[e1] 2026-09-07T09:00:00+03:00 ⇦ 2026-09-07T10:00:00+03:00 · Court · Jeddah")
      expect(await google.run("calendar_create", { summary: "Meet", start: "2026-09-08T09:00:00+03:00", end: "2026-09-08T10:00:00+03:00", attendees: ["x@y.test"] })).toContain("e2")
      expect((g.posted.at(-1)!.body as { attendees: { email: string }[] }).attendees).toEqual([{ email: "x@y.test" }])
      expect(await google.run("drive_search", { query: "Contract" })).toContain("[f1] Contract.docx")
      expect(await google.run("drive_read", { id: "f1" })).toContain("Contract text body")
      expect(await google.run("drive_read", { id: "f2" })).toContain("ليس نصّاً")
    } finally { g.stop() }
  })

  test("بلا refresh ⇒ 401 يقول للمستخدم أن يعيد الربط", async () => {
    const g = fakeGoogle()
    try { await expect(new GoogleConnector({ ...g.options, accessToken: "bad", refreshToken: undefined }).run("gmail_search", { query: "x" })).rejects.toThrow("أعد الربط") }
    finally { g.stop() }
  })

  test("extractText: النصُّ الصريح أوّلاً وإلا HTML مجرَّد", () => {
    expect(extractText({ mimeType: "text/html", body: { data: b64url("<style>x{}</style><p>Hi&nbsp;<i>there</i></p>") } })).toBe("Hi there")
    expect(extractText(undefined)).toBe("")
  })

  test("حلقةُ MCP على stdio تعلن الأدواتِ الثماني وترفض المجهول؛ الخياراتُ من البيئة", async () => {
    expect(googleOptionsFromEnv({ ABDO_CONNECTOR_ACCESS: "a", ABDO_CONNECTOR_TOKEN_URL: "https://t" })).toEqual({ accessToken: "a", tokenUrl: "https://t" })
    const out: string[] = []
    const lines = [JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }), JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }), JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope" } })]
    await serveGoogleMcp({}, (async function* () { for (const l of lines) yield l })(), (l) => out.push(l))
    const replies = out.map((l) => JSON.parse(l))
    expect(replies[0].result.serverInfo.name).toBe("abdocode-google")
    expect(replies[1].result.tools.map((t: { name: string }) => t.name)).toEqual(GOOGLE_TOOLS.map((t) => t.name))
    expect(replies[2].error.code).toBe(-32602)
  })
})
