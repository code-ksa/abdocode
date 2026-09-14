import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

// ص2 — صنفُ الذاكرة كما في كلود: memory-note بصنفٍ يعود في memory-notes بقيمته؛ صنفٌ مجهول يُرفض؛ وبلا صنفٍ تبقى الملاحظةُ كما كانت.

const ROOT = resolve(import.meta.dir, "../../..")

test("memory-note carries a category that the notes frame returns; unknown categories are refused", async () => {
  const base = mkdtempSync(join(tmpdir(), "abdo-memcat-")), state = join(base, "state"), project = join(base, "proj")
  mkdirSync(state, { recursive: true }); mkdirSync(project, { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "proj" }))
  const settings = join(state, "settings.json")
  writeFileSync(settings, JSON.stringify({ language: "ar", mode: "read-only", project, chatModel: "x/model", agentModel: "x/model", modelRole: "chat", memorySearchEnabled: false, semanticMemoryEnabled: false, customProviders: [{ id: "x", label: "x", baseUrl: "http://127.0.0.1:9/v1", vaultKey: "", local: true, models: ["model"] }] }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], { cwd: ROOT, env: { ...process.env, ABDO_SHELL_TOKEN: "memcat", ABDO_FRAMED_STDIO: "1", ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, USERPROFILE: base, HOME: base, ABDO_VAULT_HOME: base, ABDO_REQUIRE_SPRINT_PLAN: "0" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const errors = new Response(child.stderr).text(), frames: any[] = []
  const decoder = new LocalJsonFrameDecoder()
  void (async () => { for await (const bytes of child.stdout) frames.push(...decoder.push(bytes)) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const next = async (kind: string, where?: (f: any) => boolean) => { const deadline = Date.now() + 30_000; for (;;) { const i = frames.findIndex((f) => f.kind === kind && (where === undefined || where(f))); if (i >= 0) return frames.splice(i, 1)[0]; if (Date.now() > deadline) throw Error("Missing " + kind + ": " + JSON.stringify(frames.map((f) => f.kind + (f.why ? ":" + f.why : ""))).slice(-1500)); await Bun.sleep(15) } }
  try {
    send({ kind: "hello", shell: "desktop", token: "memcat" }); await next("ready")
    send({ kind: "memory-note", title: "المدير", text: "مديري اسمه سعد ويفضّل التقارير القصيرة", scope: "project", sensitive: false, category: "person" })
    await next("memory-saved")
    const notes = await next("memory-notes")
    const saved = notes.facts.find((f: any) => f.key === "المدير")
    expect(saved.value.category).toBe("person")
    expect(saved.value.note).toContain("سعد")
    send({ kind: "memory-note", title: "بلا صنف", text: "ملاحظة عادية", scope: "project", sensitive: false })
    await next("memory-saved")
    const notes2 = await next("memory-notes")
    expect(notes2.facts.find((f: any) => f.key === "بلا صنف").value.category).toBeUndefined()
    send({ kind: "memory-note", title: "خطأ", text: "نص", scope: "project", sensitive: false, category: "secret" })
    const refused = await next("refused")
    expect(refused.why).toContain("صنفُ الذاكرة")
  } finally { child.kill(); await child.exited; await errors; rmSync(base, { recursive: true, force: true }) }
}, 90_000)
