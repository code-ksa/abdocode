import {createSettingsDrafts} from '../../desktop/ui/settings-drafts.js'
import {LANGUAGE_CODES} from '../../desktop/ui/language-catalogue.js'
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

const html = readFileSync(new URL("../../desktop/ui/index.html", import.meta.url), "utf8")
const saveCode = html.slice(html.indexOf("    const snapshotSettingsForm ="), html.indexOf('    el("customprovadd").onclick'))
const shellDefaults = {
  version: 1, language: "ar", colorScheme: "light", uiScale: 100, followup: "queue",
  keybindings: { commandPalette: "Ctrl+K", settings: "Ctrl+,", newSession: "Ctrl+N" },
}
function fixture() {
  const controls: Record<string, any> = {
    settingssave: { disabled: false }, settingsreset: { disabled: false },
    setchatmodel: { value: "deepseek/deepseek-v4-flash" }, setagentmodel: { value: "deepseek/deepseek-v4-pro" }, setvisionmodel: { value: "" },
    setmode: { value: "read-only" }, setmodelrole: { value: "auto" }, setrails: { value: "strict" }, setworkmode: { value: "basic" }, setroutergate: { value: "off" },
  }
  let accept!: () => void, reject!: (error: Error) => void
  const wait = new Promise<void>((resolve, fail) => { accept = resolve; reject = fail })
  const runtimeCalls: any[] = [], shellCalls: any[] = [], applied: any[] = [], notices: string[] = []
  const shell = structuredClone(shellDefaults), plugins = { memory: false }, superAbdo = { enabled: true }
  const registry = { revision: 12 }
  const context = {
    settingsDrafts: createSettingsDrafts(), LANGUAGE_CODES, structuredClone, TextEncoder, el: (id: string) => controls[id],
    readShellSettings: () => shell, shellProviders: () => [{ id: "deepseek" }],
    MODE_ORDER: ["read-only", "auto", "full-access"], uiText: (en: string) => en,
    mode: "read-only",
    settingsRefresh: null,
    pluginRegistry: registry, pluginsPatchFromPanel: () => plugins,
    window: { AbdoDesktopShell: {
      settingsPatch: () => ({ superAbdo }),
      applyRuntimeSettings: (patch: any, envelope: any) => { runtimeCalls.push({ patch, envelope }); return wait },
      applyExplicitMode: async (_mode: string) => {},
    } },
    invoke: async (command: string, args: any) => { shellCalls.push({ command, args }); return args.settings },
    applyShellSettings: (value: any) => { applied.push(value) },
    fillSettingsControls() {}, applyMode() {}, renderRailUi() {}, notice: (value: string) => notices.push(value),
  }
  runInNewContext(saveCode, context)
  return { context, controls, shell, plugins, superAbdo, registry, runtimeCalls, shellCalls, applied, notices, accept, reject }
}

test("native Save snapshots all fields and plugin revision before awaiting; repeated clicks cannot overlap", async () => {
  const f = fixture()
  const saving = f.controls.settingssave.onclick()
  expect(f.controls.settingssave.disabled).toBe(true)
  expect(f.controls.settingsreset.disabled).toBe(true)
  expect(f.shellCalls).toHaveLength(0)
  // Simulate settings frames/localization rebuilding the form during the IPC wait.
  f.shell.language = "en"
  f.controls.setchatmodel.value = "changed/while-awaiting"
  f.controls.setrails.value = "thin"
  f.plugins.memory = true
  f.superAbdo.enabled = false
  f.registry.revision = 99
  await f.controls.settingssave.onclick()
  expect(f.runtimeCalls).toHaveLength(1)
  f.accept()
  await saving
  expect(f.runtimeCalls[0].patch).toMatchObject({
    language: "ar", chatModel: "deepseek/deepseek-v4-flash", agentModel: "deepseek/deepseek-v4-pro", visionModel: "",
    railPolicy: "strict", plugins: { memory: false }, superAbdo: { enabled: true },
  })
  expect(f.runtimeCalls[0].envelope).toEqual({ expectedPluginsRevision: 12 })
  expect(f.shellCalls[0]).toMatchObject({ command: "settings_set", args: { settings: { language: "ar" } } })
  expect(f.applied[0].language).toBe("ar")
  expect(f.controls.settingssave.disabled).toBe(false)
  expect(f.controls.settingsreset.disabled).toBe(false)
})

test("the vision model is optional: a set reference travels in the patch, an unknown provider is refused like the other model fields", async () => {
  const f = fixture()
  f.controls.setvisionmodel.value = "deepseek/deepseek-vision"
  // كالاختبار الأوّل: النقرةُ تُلتقط ولا تُنتظر — الانتظارُ بعد accept() وإلا علّق الاختبارُ على وعدٍ لا يُحلّ.
  const saving = f.controls.settingssave.onclick()
  expect(f.runtimeCalls).toHaveLength(1)
  expect(f.runtimeCalls[0].patch).toMatchObject({ visionModel: "deepseek/deepseek-vision" })
  f.accept()
  await saving
  const g = fixture()
  g.controls.setvisionmodel.value = "unknown/vision"
  await g.controls.settingssave.onclick()
  expect(g.runtimeCalls).toHaveLength(0)
  expect(g.shellCalls).toHaveLength(0)
})

test("invalid model or shortcut cannot persist shell or engine settings", async () => {
  const f = fixture()
  f.controls.setagentmodel.value = "unknown/model"
  await f.controls.settingssave.onclick()
  expect(f.runtimeCalls).toHaveLength(0)
  expect(f.shellCalls).toHaveLength(0)
  expect(f.controls.settingssave.disabled).toBe(false)
  f.controls.setagentmodel.value = "deepseek/deepseek-v4-pro"
  f.shell.keybindings.commandPalette = ""
  await f.controls.settingssave.onclick()
  expect(f.runtimeCalls).toHaveLength(0)
  expect(f.shellCalls).toHaveLength(0)
})

test("engine refusal leaves shell language unchanged and releases the Save guard", async () => {
  const f = fixture()
  const saving = f.controls.settingssave.onclick()
  f.reject(new Error("fixture engine refusal"))
  await saving
  expect(f.shellCalls).toHaveLength(0)
  expect(f.applied).toHaveLength(0)
  expect(f.controls.settingssave.disabled).toBe(false)
  expect(f.controls.settingsreset.disabled).toBe(false)
  expect(f.notices.at(-1)).toContain("fixture engine refusal")
})

test("two acknowledged language saves do not emit an extra mode write or stale the plugin revision", async () => {
  const f = fixture()
  let persistedRevision = f.registry.revision
  const modeWrites: any[] = []
  const modeStart = html.indexOf("    const applyMode =")
  const modeCode = html.slice(modeStart, html.indexOf('\n    el("modechip").onclick', modeStart))
  Object.assign(f.context, {
    mode: "read-only", runtimeSettings: {}, engineUp: true,
    MODE_AR: { "read-only": "Read only", auto: "Auto", "full-access": "Full access" },
    Shell: { changeMode: (_old: string, requested: string) => ({ ok: true, mode: requested }) },
    setChipLabel() {}, renderStatus() {},
    sendFrame: (frame: any) => { if (frame.kind === "mode-set") { modeWrites.push(frame); persistedRevision++ } },
  })
  f.controls.modechip = { classList: { toggle() {} } }
  // Run the actual persisted-mode helper too: the former Save call to applyMode
  // would increment persistedRevision without supplying a new plugin snapshot.
  runInNewContext(modeCode + saveCode, f.context)
  f.context.window.AbdoDesktopShell.applyRuntimeSettings = async (patch, envelope) => {
    f.runtimeCalls.push({ patch, envelope })
    if (envelope.expectedPluginsRevision !== persistedRevision) throw Error("fixture stale plugin revision")
    persistedRevision++
    f.registry.revision = persistedRevision
  }
  await f.controls.settingssave.onclick()
  f.shell.language = "en"
  await f.controls.settingssave.onclick()
  expect(f.runtimeCalls.map(call => call.patch.language)).toEqual(["ar", "en"])
  expect(f.runtimeCalls.map(call => call.envelope.expectedPluginsRevision)).toEqual([12, 13])
  expect(modeWrites).toHaveLength(0)
  expect(persistedRevision).toBe(14)
  expect(f.registry.revision).toBe(14)
  expect(f.applied.map(settings => settings.language)).toEqual(["ar", "en"])
  expect(f.notices.some(message => message.includes("stale plugin revision"))).toBe(false)
  expect(f.controls.settingssave.disabled).toBe(false)
})

test("an explicitly changed mode waits for its revision acknowledgment before the next save", async () => {
  const f = fixture()
  let persistedRevision = f.registry.revision
  const explicitModes: string[] = []
  f.context.window.AbdoDesktopShell.applyRuntimeSettings = async (patch, envelope) => {
    expect(envelope.expectedPluginsRevision).toBe(persistedRevision)
    f.runtimeCalls.push({ patch, envelope })
    f.registry.revision = ++persistedRevision
  }
  f.context.window.AbdoDesktopShell.applyExplicitMode = async requested => {
    explicitModes.push(requested)
    expect(f.controls.settingssave.disabled).toBe(true)
    await Promise.resolve()
    f.context.mode = requested
    f.registry.revision = ++persistedRevision
  }
  f.controls.setmode.value = "auto"
  await f.controls.settingssave.onclick()
  f.shell.language = "en"
  await f.controls.settingssave.onclick()
  expect(explicitModes).toEqual(["auto"])
  expect(f.runtimeCalls.map(call => call.envelope.expectedPluginsRevision)).toEqual([12, 14])
  expect(persistedRevision).toBe(15)
  expect(f.controls.settingssave.disabled).toBe(false)
})

test("cold settings open locks editing and Save until both correlated snapshots arrive", async () => {
  const f = fixture()
  const lifecycleStart = html.indexOf("    let settingsBuilt = false;")
  const lifecycle = html.slice(lifecycleStart, html.indexOf("    // ── المنح القائمة", lifecycleStart))
  const ackStart = html.indexOf("        if (settingsRefresh && settingsRefresh.id === f.requestId)")
  const ack = html.slice(ackStart, html.indexOf("        return;", ackStart))
  let opened = false, finishShell!: (value: typeof shellDefaults) => void
  const shellRead = new Promise<typeof shellDefaults>(resolve => { finishShell = resolve })
  const sent: any[] = [], panel = { inert: false }
  f.controls.settings = { classList: { contains: () => opened, add: () => { opened = true } }, setAttribute() {} }
  Object.assign(f.context, {
    engineUp: true, setTimeout, clearTimeout, buildSettings() {},
    document: { querySelectorAll: () => [panel], addEventListener() {} },
    sendFrame: async (frame: any) => { sent.push(frame) },
    invoke: async (command: string) => command === "settings_get" ? shellRead : undefined,
  })
  const api = runInNewContext(lifecycle + saveCode + "\n({openSettings, ack: f=>{" + ack + "}})", f.context)
  api.openSettings()
  expect(f.controls.settingssave.disabled).toBe(true)
  expect(panel.inert).toBe(true)
  await f.controls.settingssave.onclick()
  expect(f.runtimeCalls).toHaveLength(0)
  const request = sent.find(frame => frame.kind === "settings-get")
  expect(request.requestId).toBeTruthy()
  // An unrelated earlier engine snapshot cannot unlock the current form.
  api.ack({ requestId: "earlier-settings-get" })
  finishShell(structuredClone(shellDefaults))
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  expect(f.controls.settingssave.disabled).toBe(true)
  api.ack({ requestId: request.requestId })
  expect(f.controls.settingssave.disabled).toBe(false)
  expect(panel.inert).toBe(false)
  expect(f.applied).toHaveLength(1)
  const requestsBeforeTabSwitch = sent.filter(frame => frame.kind === "settings-get").length
  f.controls.setagentmodel.value = "deepseek/my-unsaved-model"
  api.openSettings()
  expect(sent.filter(frame => frame.kind === "settings-get")).toHaveLength(requestsBeforeTabSwitch)
  expect(f.controls.setagentmodel.value).toBe("deepseek/my-unsaved-model")
})

test("only generated session and trust controls translate; matching user text stays unchanged", () => {
  const appCode = html.slice(html.indexOf("    const uiText ="), html.indexOf("    const addBlock ="))
  const headStart = html.indexOf("    const renderSessionHead =")
  const headCode = html.slice(headStart, html.indexOf("\n    };", headStart) + 8)
  const name = { dataset: {} as Record<string, string>, textContent: "" }
  const trust = { dataset: { appEn: "Project trust", appAr: "ثقة المشروع" }, textContent: "Project trust" }
  const path = { dataset: { userContent: "" }, textContent: "C:/Settings/محادثة جديدة" }
  const transcript = { dataset: {}, textContent: "New conversation" }
  const nodes = [name, trust, path, transcript]
  const controls = { sessionname: name, railback: { disabled: false }, railfwd: { disabled: false } }
  const context = {
    createTranscript: () => ({}), shellSettings: { language: "en" }, sessionAt: -1, sessionOrder: [] as { title: string }[],
    document: { querySelectorAll: (selector: string) => selector === "[data-app-en]" ? nodes.filter(n => "appEn" in n.dataset) : [] },
    el: (id: keyof typeof controls) => controls[id],
  }
  const api = runInNewContext(appCode + headCode + "\n({ renderSessionHead, applyAppControlLabels })", context)
  api.renderSessionHead()
  expect(name.textContent).toBe("New conversation")
  context.shellSettings.language = "ar"
  api.applyAppControlLabels()
  expect(name.textContent).toBe("محادثة جديدة")
  expect(trust.textContent).toBe("ثقة المشروع")
  expect(path.textContent).toBe("C:/Settings/محادثة جديدة")
  expect(transcript.textContent).toBe("New conversation")
  // An actual stored title equal to a default label must not become a control.
  context.sessionAt = 0
  context.sessionOrder = [{ title: "محادثة جديدة" }]
  api.renderSessionHead()
  context.shellSettings.language = "en"
  api.applyAppControlLabels()
  expect(name.textContent).toBe("محادثة جديدة")
  expect(name.dataset.appEn).toBeUndefined()
  expect(trust.textContent).toBe("Project trust")
})

test("trusted project restore before session creation saves no null session and binds after creation", async () => {
  const source = readFileSync(new URL("../../desktop/ui/native-shell.js", import.meta.url), "utf8")
  const remember = source.slice(source.indexOf("  function rememberTrustedProject("), source.indexOf("  let settingsWaiter="))
  const touch = source.slice(source.indexOf("  function touchSession("), source.indexOf("  function autoArchive("))
  const store: any = { projects: [], sessions: [] }
  const snapshot: any = { sessionId: null, project: "C:/Users/example/Documents/crm" }
  const saved: any[] = []
  const ctx: any = { metadata: store, pendingTrustedProject: null, bridge: { snapshot: () => snapshot }, uid: () => "project-1", page: "session", renderSessions() {}, renderPage() {}, error(e: unknown) { throw e }, safeSave: async () => { saved.push(structuredClone(store)) }, sessionMeta(id: string) { let entry = store.sessions.find((s: any) => s.id === id); if (!entry) store.sessions.push(entry = { id }); return entry } }
  runInNewContext(remember + touch, ctx)
  ctx.rememberTrustedProject(snapshot.project)
  await Promise.resolve()
  expect(saved[0].projects).toHaveLength(1)
  expect(saved[0].sessions).toHaveLength(0)
  snapshot.sessionId = "session-1"
  ctx.touchSession("ready")
  await Promise.resolve()
  expect(saved[1].sessions).toEqual([{ id: "session-1", projectId: "project-1", state: "ready", updatedAt: expect.any(String) }])
})
