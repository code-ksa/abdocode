/**
 * Drive writes: multipart upload with conversion to Google Docs / Sheets / Slides, and creating a Doc from text.
 * The engine reads the local file inside the project and passes bytes; the connector never opens a path itself.
 */
import { describe, expect, test } from "bun:test"
import { DRIVE_UPLOAD_MAX, GOOGLE_SCOPES, GOOGLE_TOOLS, GoogleConnector } from "../src/mcp-servers/google"
import { CONNECTORS } from "../src/connectors/registry"

type Seen = { url: string; contentType: string; body: string }
const stub = (reply: (seen: Seen) => Response) => {
  const seen: Seen[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : String(init?.body ?? "")
    const s = { url, contentType: headers["content-type"] ?? "", body }
    seen.push(s)
    return reply(s)
  }) as unknown as typeof fetch
  return { seen, google: new GoogleConnector({ accessToken: "t", apisBase: "https://apis.test", fetchImpl }) }
}
const ok = () => Response.json({ id: "f1", name: "deck", mimeType: "application/vnd.google-apps.presentation", webViewLink: "https://docs.test/f1" })
const metaOf = (body: string) => JSON.parse(body.split("\r\n\r\n")[1]!.split("\r\n")[0]!) as Record<string, unknown>

describe("drive upload", () => {
  test("a pptx is uploaded as multipart and converted to Google Slides, named without the extension", async () => {
    const { seen, google } = stub(ok)
    const f = await google.upload("deck.pptx", new Uint8Array([80, 75, 3, 4]))
    expect(f.webViewLink).toBe("https://docs.test/f1")
    expect(seen[0]!.url).toStartWith("https://apis.test/upload/drive/v3/files?uploadType=multipart")
    expect(seen[0]!.contentType).toStartWith("multipart/related; boundary=")
    expect(metaOf(seen[0]!.body)).toEqual({ name: "deck", mimeType: "application/vnd.google-apps.presentation" })
    expect(seen[0]!.body).toContain("Content-Type: application/vnd.openxmlformats-officedocument.presentationml.presentation")
  })
  test("docx, md and csv convert to Docs and Sheets; convert:false keeps the file as is with its name", async () => {
    const { seen, google } = stub(ok)
    await google.upload("report.docx", new Uint8Array([1]))
    await google.upload("notes.md", new TextEncoder().encode("# hi"))
    await google.upload("prices.csv", new TextEncoder().encode("a,b"))
    await google.upload("deck.pptx", new Uint8Array([1]), { convert: false, folderId: "dir9" })
    expect(seen.map((s) => metaOf(s.body).mimeType)).toEqual(["application/vnd.google-apps.document", "application/vnd.google-apps.document", "application/vnd.google-apps.spreadsheet", undefined])
    expect(metaOf(seen[3]!.body)).toEqual({ name: "deck.pptx", parents: ["dir9"] })
  })
  test("an unknown extension is uploaded as octet-stream without conversion", async () => {
    const { seen, google } = stub(ok)
    await google.upload("data.bin", new Uint8Array([1, 2]))
    expect(metaOf(seen[0]!.body)).toEqual({ name: "data.bin" })
    expect(seen[0]!.body).toContain("Content-Type: application/octet-stream")
  })
  test("the size cap refuses before any request", async () => {
    const { seen, google } = stub(ok)
    await expect(google.upload("big.pdf", new Uint8Array(DRIVE_UPLOAD_MAX + 1))).rejects.toThrow("فوق سقف الرفع")
    expect(seen).toHaveLength(0)
  })
  test("a 403 for a missing scope says to reconnect Google for drive.file", async () => {
    const { google } = stub(() => Response.json({ error: { message: "Request had insufficient authentication scopes." } }, { status: 403 }))
    await expect(google.upload("a.txt", new Uint8Array([1]))).rejects.toThrow("أعد ربطَ جوجل")
  })
})

describe("drive_create_doc and the scope", () => {
  test("creates a Google Doc from text and returns its link", async () => {
    const { seen, google } = stub(() => Response.json({ id: "d1", name: "Plan", mimeType: "application/vnd.google-apps.document", webViewLink: "https://docs.test/d1" }))
    const out = await google.run("drive_create_doc", { title: "Plan", content: "سطرٌ أوّل" })
    expect(out).toContain("https://docs.test/d1")
    expect(metaOf(seen[0]!.body)).toEqual({ name: "Plan", mimeType: "application/vnd.google-apps.document" })
    expect(seen[0]!.body).toContain("Content-Type: text/plain")
  })
  test("drive.file is requested, and the tool is listed and shown on the connector", () => {
    expect(GOOGLE_SCOPES).toContain("https://www.googleapis.com/auth/drive.file")
    expect(GOOGLE_TOOLS.map((t) => t.name)).toContain("drive_create_doc")
    expect(CONNECTORS.find((c) => c.id === "google")!.tools).toContain("drive_create_doc")
  })
})
