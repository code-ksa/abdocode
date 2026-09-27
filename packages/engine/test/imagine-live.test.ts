/**
 * الفجوة #11 (2026-09-27) — توليدُ الصور: الصيغُ المقيسة، والحفظُ عبر write_file في النواة، والمحرّكُ الحقيقيّ مع مزوّدٍ محلّيّ مزيّف.
 * التوأم: مزوّدٌ نفدت حصّتُه (429) يُقال برقمه ولا ملفّ، وما ليس صورةً يُرفض.
 */
import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { writeFileTool } from "../../builtin-tools/src/file-tools"
import { defaultImagePath, extractImage, imageKind, imageRequestBody, parseImagineCommand } from "../src/mind/imagine"
import { stripChildEnv } from "../../tools/src/env-strip"

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

test("write_file carries bytes as base64 — new files only; text writes are unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "abdo-b64-"))
  const tool = writeFileTool(root)
  const ctx = { executionId: "b64", mode: "BUILD" } as never
  const made = await tool.run({ path: "a.png", content: PNG_B64, encoding: "base64" }, ctx)
  expect(made.ok).toBe(true)
  expect([...readFileSync(join(root, "a.png")).subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
  expect(made.output).toMatchObject({ bytes: Buffer.from(PNG_B64, "base64").byteLength })
  expect(await tool.run({ path: "a.png", content: PNG_B64, encoding: "base64" }, ctx)).toMatchObject({ ok: false, error: expect.stringContaining("new files only") })
  expect(await tool.run({ path: "b.png", content: "not base64!", encoding: "base64" }, ctx)).toMatchObject({ ok: false, error: expect.stringContaining("not valid base64") })
  expect(await tool.run({ path: "c.txt", content: "hello", encoding: "latin1" }, ctx)).toMatchObject({ ok: false })
  expect((await tool.run({ path: "d.txt", content: "مرحبا" }, ctx)).ok).toBe(true)
  expect(readFileSync(join(root, "d.txt"), "utf8")).toBe("مرحبا")
  rmSync(root, { recursive: true, force: true })
})

test("the request, the reply shapes and the bytes", () => {
  expect(parseImagineCommand("a red square on white --out art/red.png")).toEqual({ prompt: "a red square on white", out: "art/red.png" })
  expect(() => parseImagineCommand("cat --out notes.txt")).toThrow(/امتدادَ صورة/u)
  expect(JSON.parse(imageRequestBody("wan2.7-image", "a cat")).messages[0].content).toEqual([{ type: "text", text: "a cat" }])
  expect(extractImage(JSON.stringify({ output: { choices: [{ message: { content: [{ image: "https://oss.example/x.png" }] } }] } }))).toEqual({ url: "https://oss.example/x.png" })
  expect(extractImage(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }))).toEqual({ base64: PNG_B64 })
  expect(extractImage(JSON.stringify({ choices: [{ message: { content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${PNG_B64}` } }] } }] }))).toEqual({ base64: PNG_B64 })
  expect(extractImage(JSON.stringify({ error: { message: "quota exhausted" } }))).toMatchObject({ error: expect.stringContaining("quota exhausted") })
  expect(extractImage("<html>")).toMatchObject({ error: expect.stringContaining("ليس JSON") })
  expect(imageKind(Buffer.from(PNG_B64, "base64"))).toBe("png")
  expect(imageKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpg")
  expect(imageKind(new TextEncoder().encode("<html>"))).toBeUndefined()
  expect(defaultImagePath("A Red Square!", "png", 1)).toBe("images/a-red-square-1.png")
})

async function imagineTurn(mode: "url" | "b64" | "quota" | "html") {
  let port = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/img.png") return mode === "html" ? new Response("<html>nope</html>", { headers: { "content-type": "text/html" } }) : new Response(Buffer.from(PNG_B64, "base64"), { headers: { "content-type": "image/png" } })
    const payload = await request.json() as { model?: string; stream?: boolean }
    if (payload.model === "image-model") {
      if (mode === "quota") return Response.json({ error: { message: "Your token-plan quota has been exhausted" } }, { status: 429 })
      return Response.json(mode === "b64" ? { data: [{ b64_json: PNG_B64 }] } : { output: { choices: [{ message: { content: [{ image: `http://127.0.0.1:${port}/img.png` }] } }] } })
    }
    const text = JSON.stringify(payload)
    const content = text.includes("🖼") || text.includes("تعذّر") || text.includes("ليس صورةً") ? "Done." : `نفّذ: imagine a red square on white${mode === "b64" ? "" : " --out art/red.png"}`
    if (payload.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  port = server.port
  const home = mkdtempSync(join(tmpdir(), "abdo-imagine-")), project = join(home, "proj"), settings = join(home, "settings.json")
  mkdirSync(project, { recursive: true })
  writeFileSync(settings, JSON.stringify({
    language: "en", mode: "full-access", modelRole: "agent", routerGate: "off", project, railPolicy: "thin", workMode: "basic",
    agentModel: "fx/model", chatModel: "fx/model", imageGenModel: "fx/image-model",
    plugins: { projectAwareness: false, sessionAwareness: false, generalAwareness: false, verifier: false, reviewer: false, delegation: false, inventory: false },
    superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 },
    customProviders: [{ id: "fx", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model", "image-model"] }],
  }))
  const frames: any[] = []
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: { ...stripChildEnv(process.env).env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: join(home, "state"), ABDO_SHELL_TOKEN: "t", ABDO_FRAMED_STDIO: "1", USERPROFILE: home, HOME: home, ABDO_VAULT_HOME: home, ABDO_MAX_AGENT_EPOCHS: "2", ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text(), decoder = new LocalJsonFrameDecoder()
  const reading = (async () => { for await (const bytes of child.stdout) for (const frame of decoder.push(bytes)) frames.push(frame) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean, label: string) => { const deadline = Date.now() + 60_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out: " + label); await Bun.sleep(15) } }
  try {
    send({ kind: "hello", shell: "desktop", token: "t" })
    await wait(() => frames.some((f) => f.kind === "ready"), "ready")
    send({ kind: "submit", mode: "full-access", turn: { id: "i1", body: "Draw a red square on white" } })
    await wait(() => frames.some((f) => f.turnId === "i1" && ["done", "refused", "unresolved"].includes(f.kind)), "turn end")
    const result = frames.find((f) => f.turnId === "i1" && f.kind === "tool-result")
    const files = (dir: string): string[] => existsSync(dir) ? require("node:fs").readdirSync(dir) : []
    return { output: String(result?.output ?? ""), verdict: result?.verdict, project, art: files(join(project, "art")), images: files(join(project, "images")) }
  } finally {
    child.kill(); await child.exited; await reading; await stderr; server.stop(true)
    setTimeout(() => rmSync(home, { recursive: true, force: true }), 0)
  }
}

test("on the real engine: the image comes back from the provider, downloads, and is saved through the kernel", async () => {
  const byUrl = await imagineTurn("url")
  expect(byUrl.verdict).toMatchObject({ ok: true })
  expect(byUrl.output).toContain("🖼 art/red.png")
  expect(byUrl.output).toContain("png (fx/image-model)")
  expect(byUrl.art).toEqual(["red.png"])
  const byB64 = await imagineTurn("b64")
  expect(byB64.verdict).toMatchObject({ ok: true })
  expect(byB64.images).toHaveLength(1)
  expect(byB64.images[0]).toMatch(/^a-red-square-on-white-\d+\.png$/u)
}, 150_000)

test("the twins: an exhausted quota is said with its code and nothing is written; what is not an image is refused", async () => {
  const quota = await imagineTurn("quota")
  expect(quota.verdict).toMatchObject({ ok: false })
  expect(quota.output).toContain("HTTP 429")
  expect(quota.output).toContain("quota has been exhausted")
  expect(quota.art).toEqual([])
  const html = await imagineTurn("html")
  expect(html.output).toContain("ما وصل ليس صورةً")
  expect(html.art).toEqual([])
}, 150_000)
