/**
 * 10-10 — owner: «AbdoCode should change its own settings by the user's commands in chat». Real engine, real `settings` tool, a local fake
 * model that issues the command; the verdict is read from the settings FILE on disk, not from the tool's return text.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { parseChatSettingsCommand, settingsChangeUnasked, typedSettingValue } from "../src/chat-settings"

const runTurn = async (command: string, userBody = "غيّر الإعداد كما أطلب") => {
  const root = resolve(import.meta.dir, "../../..")
  const home = mkdtempSync(join(tmpdir(), "abdo-chat-settings-"))
  const state = join(home, "state"), project = join(home, "project"), settingsFile = join(home, "settings.json")
  mkdirSync(state); mkdirSync(project); writeFileSync(join(project, "README.md"), "# fixture\n")
  let asked = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean }
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } })
    const content = asked++ === 0 ? `نفّذ: ${command}` : "تم."
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } })
  } })
  writeFileSync(settingsFile, JSON.stringify({
    project, language: "ar", mode: "full-access", modelRole: "agent", chatModel: "fx/model", agentModel: "fx/model", gateModel: "fx/model", routerGate: "off", railPolicy: "medium",
    memorySearchEnabled: false, turnNotifications: true,
    customProviders: [{ id: "fx", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, local: true, vaultKey: "", models: ["model"] }],
  }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], {
    cwd: root, env: { ...process.env, ABDO_CODE_SETTINGS: settingsFile, ABDO_CODE_STATE_DIR: state, ABDO_SHELL_TOKEN: "fx", ABDO_FRAMED_STDIO: "1", ABDO_VAULT_HOME: home, USERPROFILE: home, HOME: home, ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "", ABDO_PROJECT: project },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const decoder = new LocalJsonFrameDecoder(), frames: any[] = []
  void (async () => { for await (const chunk of child.stdout) for (const frame of decoder.push(chunk)) frames.push(frame) })()
  const send = async (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); await child.stdin.flush() }
  const wait = async (check: () => boolean) => { const deadline = Date.now() + 90_000; while (!check()) { if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(frames).slice(-800)}`); await Bun.sleep(20) } }
  try {
    await send({ kind: "hello", shell: "desktop", token: "fx" })
    await wait(() => frames.some((f) => f.kind === "ready"))
    await send({ kind: "trust-grant", path: project })
    await send({ kind: "submit", turn: { id: "s-1", body: userBody }, mode: "full-access" })
    await wait(() => frames.some((f) => f.kind === "tool-result" && String(f.cmd ?? "").startsWith("settings")) || frames.some((f) => (f.kind === "done" || f.kind === "refused") && f.turnId === "s-1"))
    await Bun.sleep(300)
    const result = frames.find((f) => f.kind === "tool-result" && String(f.cmd ?? "").startsWith("settings"))
    return { saved: JSON.parse(readFileSync(settingsFile, "utf-8")), output: String(result?.output ?? ""), settingsFrames: frames.filter((f) => f.kind === "settings").length }
  } finally {
    child.kill(); await child.exited; server.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
}

test("pure parsing: typed values, plugin toggles keep the others, security keys refused by name", () => {
  const keys = new Set(["turnNotifications", "cloudTokenCap", "language", "mode"])
  expect(typedSettingValue("off")).toBe(false)
  expect(typedSettingValue("فعّل")).toBe(true)
  expect(typedSettingValue("600_000_000")).toBe(600000000)
  expect(parseChatSettingsCommand("set language en", keys, new Set(), undefined)).toMatchObject({ kind: "set", patch: { language: "en" } })
  expect(parseChatSettingsCommand("plugin readCompaction off", keys, new Set(["readCompaction"]), { opsSkills: true })).toMatchObject({ kind: "set", patch: { plugins: { opsSkills: true, readCompaction: false } } })
  const refused = parseChatSettingsCommand("set mode full-access", keys, new Set(), undefined)
  expect(refused.kind).toBe("error")
  expect((refused as { why: string }).why).toContain("لا يُغيَّر «mode» من المحادثة")
  expect(parseChatSettingsCommand("set nosuchkey 1", keys, new Set(), undefined).kind).toBe("error")
})

test("live: the agent's `settings set turnNotifications off` lands in the settings file and the shell is told", async () => {
  const run = await runTurn("settings set turnNotifications off")
  expect(run.saved.turnNotifications).toBe(false)
  expect(run.output).toContain("حُفظ في الإعدادات")
  expect(run.settingsFrames).toBeGreaterThan(0)
}, 150_000)

test("live twin: `settings set mode read-only` is refused and the file keeps its mode", async () => {
  const run = await runTurn("settings set mode read-only")
  expect(run.saved.mode).toBe("full-access")
  expect(run.output).toContain("لا يُغيَّر «mode» من المحادثة")
}, 150_000)

// 10-10 (مقيس في مهمّة n8n): رسالةٌ ذكرت «Settings» و«الإصدار 4.0.125» فبدّل النموذجُ نموذجَه العامل من تلقاء نفسه وقال «تمّ تنفيذ طلبك».
test("pure: a value the user never wrote is refused; a value in the message, or an on/off with a change verb, passes", () => {
  const n8n = "أكمل المهمة: التقط شاشات لوحة التحكم Templates وInsights وSettings — أُصلحت القناة في الإصدار 4.0.125"
  expect(settingsChangeUnasked(n8n, { model: "deepseek/deepseek-v4.1-flash" }, false)).toContain("لم ترد في رسالة المستخدم")
  expect(settingsChangeUnasked(n8n, { turnNotifications: false }, false)).toContain("لم يطلب")
  expect(settingsChangeUnasked("", { language: "en" }, false)).toContain("لا رسالةَ مستخدم")
  // the twins: what the user asked for goes through
  expect(settingsChangeUnasked("غيّر النموذج إلى deepseek/deepseek-v4-pro", { model: "deepseek/deepseek-v4-pro" }, false)).toBeUndefined()
  expect(settingsChangeUnasked("استعمل deepseek-v4-pro", { model: "deepseek/deepseek-v4-pro" }, false)).toBeUndefined()
  expect(settingsChangeUnasked("أوقف إشعارات نهاية الدور", { turnNotifications: false }, false)).toBeUndefined()
  expect(settingsChangeUnasked("set cloudTokenCap to 600000000", { cloudTokenCap: 600000000 }, false)).toBeUndefined()
  expect(settingsChangeUnasked("disable the readCompaction plugin", { plugins: { readCompaction: false } }, true)).toBeUndefined()
})

test("live: the model changes a setting the user did not ask for — refused, and the file keeps its value", async () => {
  const run = await runTurn("settings set language en", "أكمل المهمة والتقط شاشة Settings في لوحة التحكم — الإصدار 4.0.125")
  expect(run.saved.language).toBe("ar")
  expect(run.output).toContain("لم ترد في رسالة المستخدم")
  expect(run.settingsFrames).toBe(0)
}, 120_000)

test("live twin: the same change when the user asked for it in words is saved", async () => {
  const run = await runTurn("settings set language en", "غيّر لغة عبدو كود إلى en")
  expect(run.saved.language).toBe("en")
  expect(run.output).toContain("✓ حُفظ")
}, 120_000)

test("order: the user-intent check runs before the validator, the approval gate and the save", () => {
  const cli = readFileSync(resolve(import.meta.dir, "../src/cli.ts"), "utf8")
  const at = cli.indexOf('if (name === "settings") {')
  const unasked = cli.indexOf("settingsChangeUnasked(recentAsks,", at)
  expect(unasked).toBeGreaterThan(at)
  for (const later of ["validateSettingsPatch(command.patch)", "await gate(turnId, \"edit\"", "saveSettings(patch)"]) expect(cli.indexOf(later, at)).toBeGreaterThan(unasked)
})

test("«اكمل» keeps an authorization from the user's recent messages; the guard reads the last six, not only this turn", () => {
  const cli = readFileSync(resolve(import.meta.dir, "../src/cli.ts"), "utf8")
  const recent = cli.indexOf("const recentAsks = [turnBodies.get(turnId) ?? \"\", ...[...turnBodies.values()].slice(-6)].join(")
  expect(recent).toBeGreaterThan(0)
  expect(cli.indexOf("settingsChangeUnasked(recentAsks,", recent)).toBeGreaterThan(recent)
  // the earlier instruction plus «اكمل» passes; a value no message ever held is still refused
  const asks = ["امسك المحرّر بإضافة المتصفّح ثم العودة بـbrowser owned", "اكمل"].join("\n")
  expect(settingsChangeUnasked(asks, { browserBackend: "owned" }, false)).toBeUndefined()
  expect(settingsChangeUnasked(asks, { model: "deepseek/deepseek-v4.1-flash" }, false)).toContain("لم ترد في رسالة المستخدم")
})

test("a model asked for as spoken («ديبسيك 4.1 فلاش») passes; the version-number message that first triggered the change does not", () => {
  expect(settingsChangeUnasked("خلي النموذج ديبسيك 4.1 فلاش و ليس 4 فقط", { model: "deepseek/deepseek-v4.1-flash" }, false)).toBeUndefined()
  expect(settingsChangeUnasked("خلّيه deepseek flash", { model: "deepseek/deepseek-v4-flash" }, false)).toContain("لم ترد") // the number 4 was never said
  expect(settingsChangeUnasked("استعمل ديبسيك 4 فلاش", { model: "deepseek/deepseek-v4-flash" }, false)).toBeUndefined()
  // the twins that must stay refused
  expect(settingsChangeUnasked("أُصلحت القناة في الإصدار 4.0.125 — التقط شاشة Settings", { model: "deepseek/deepseek-v4.1-flash" }, false)).toContain("لم ترد")
  expect(settingsChangeUnasked("اكمل", { model: "deepseek/deepseek-v4.1-flash" }, false)).toContain("لم ترد")
  expect(settingsChangeUnasked("خلي النموذج كوين 3", { model: "deepseek/deepseek-v4.1-flash" }, false)).toContain("لم ترد")
})
