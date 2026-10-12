/**
 * 10-08 (مقيس في بروفة النشر): `run server add …` ⇦ PowerShell «server is not recognized». اسمُ أداةٍ للمحرّك بلا برنامجٍ بهذا الاسم
 * يُسمّى بصيغته المباشرة؛ والتوأم: git برنامجٌ حقيقيّ فيمرّ.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { stripChildEnv } from "../../tools/src/env-strip"

test("run + an AbdoCode tool name with no such program is refused with the direct form; a real program (git) still runs", async () => {
  const replies = ["نفّذ: run server add test-server root@127.0.0.1:2222", "نفّذ: run git --version", "Done."]
  let asked = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean }
    const content = replies[Math.min(asked++, replies.length - 1)]!
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const home = mkdtempSync(join(tmpdir(), "abdo-runword-")), project = join(home, "proj"), settings = join(home, "settings.json")
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "p", version: "1.0.0" }))
  writeFileSync(settings, JSON.stringify({
    language: "en", mode: "full-access", modelRole: "agent", routerGate: "off", project, railPolicy: "thin", workMode: "basic",
    agentModel: "fx/model", chatModel: "fx/model",
    plugins: { projectAwareness: false, sessionAwareness: false, generalAwareness: false, verifier: false, reviewer: false, delegation: false, inventory: false },
    superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 },
    customProviders: [{ id: "fx", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }],
  }))
  const frames: any[] = []
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: { ...stripChildEnv(process.env).env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: join(home, "state"), ABDO_SHELL_TOKEN: "t", ABDO_FRAMED_STDIO: "1", USERPROFILE: home, HOME: home, ABDO_VAULT_HOME: home, ABDO_MAX_AGENT_EPOCHS: "3", ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text(), decoder = new LocalJsonFrameDecoder()
  const reading = (async () => { for await (const bytes of child.stdout) for (const frame of decoder.push(bytes)) frames.push(frame) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean) => { const deadline = Date.now() + 90_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out " + JSON.stringify(frames).slice(-1500)); await Bun.sleep(15) } }
  try {
    send({ kind: "hello", shell: "desktop", token: "t" }); await wait(() => frames.some((f) => f.kind === "ready"))
    send({ kind: "submit", mode: "full-access", turn: { id: "w1", body: "Set up the test server" } })
    await wait(() => frames.some((f) => f.turnId === "w1" && ["done", "refused", "unresolved"].includes(f.kind)))
    const results = frames.filter((f) => f.turnId === "w1" && f.kind === "tool-result").map((f) => ({ cmd: String(f.cmd), out: String(f.output) }))
    const by = (prefix: string) => results.find((r) => r.cmd.startsWith(prefix))?.out ?? ""
    expect(by("run server")).toContain("«server» أداةٌ من أدوات عبدو كود لا أمرُ صدفة")
    expect(by("run server")).toContain("بلا run: server add test-server")
    expect(by("run git")).toContain("git version")
  } finally {
    child.kill(); await child.exited; await reading; await stderr; server.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
}, 150_000)
