#!/usr/bin/env bun

/**
 * Local-only visual harness for the desktop interface.
 *
 *   bun scripts/desktop-ui-preview.ts            — mock host only; never starts the engine or reads a vault
 *   bun scripts/desktop-ui-preview.ts --engine   — the real engine behind the real UI, framed exactly as the
 *                                                  Tauri host frames it, in a fresh temporary state and vault
 *
 * Open `http://127.0.0.1:41739/?lang=en` (or `ar`). Mock replies carry the shapes of the Rust commands
 * (WorkspaceStore, WorkspaceControls, automation Status, extensions Catalog …): a reply of `undefined`
 * where the host returns an object sends the interface down paths the product never takes, and hides
 * the ones it does (measured 2026-09-27 — an empty controls reply froze the page in a reload loop).
 * `vault_set` in engine mode writes a placeholder `<handle>.sec` into the temporary vault — presence
 * only, never the value — so the engine sees a saved key the way it does after the host's DPAPI write.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const ui = path.join(root, "packages", "desktop", "ui")
const port = 41739
const withEngine = process.argv.includes("--engine")
const temp = withEngine ? fs.mkdtempSync(path.join(os.tmpdir(), "abdocode-ui-preview-")) : ""
if (withEngine) fs.mkdirSync(path.join(temp, "project"), { recursive: true })

const mock = `<script>
(() => {
  const engine = ${JSON.stringify(withEngine)};
  const vault = new Set();
  let shell = { version:1, language:(new URLSearchParams(location.search).get('lang') === 'ar' ? 'ar' : 'en'), colorScheme:'system', uiScale:100, followup:'queue', showNavigation:true, showBrowserPane:true, reasoningSummaries:true, expandedTools:false, notifications:{agent:true,permission:true,error:true}, sounds:{agent:false,permission:true,error:true}, keybindings:{commandPalette:'Ctrl+K',settings:'Ctrl+,',newSession:'Ctrl+N'} };
  let store = { version:1, projects:[], sessions:[], schedules:[], artifacts:[], preferences:{ sidebarWidth:356, sidebarSide:'left', classifySessionStates:true, autoArchiveDays:0, interfaceFont:'system', codeFont:'system', transcriptSize:'default', transcriptWidth:'comfortable', uiDensity:'comfortable', accentColor:'gold', codeThemeLight:'abdo-light', codeThemeDark:'abdo-dark', openLinksInBuiltin:true, browserDefaultPermission:'allow', blockedSites:[], browserPersistence:'shared', draftPullRequests:true, branchPrefix:'abdo/' } };
  const automation = { store:{ version:1, enabled:false, stopRequested:false, migratedLegacy:true, schedules:[], jobs:[], workerPid:null, heartbeatAt:null, serviceError:null }, workerRunning:false, taskRegistered:false, serviceSupported:true };
  const listeners = {};
  let termSeq = 0;
  const emit = (name, payload) => { for (const cb of listeners[name] || []) cb({ payload }); };
  const ws = engine ? new WebSocket('ws://' + location.host + '/engine') : null;
  const outbox = [];
  if (ws) {
    ws.onopen = () => { for (const line of outbox.splice(0)) ws.send(line); };
    ws.onmessage = (m) => { for (const cb of listeners['serve-frame'] || []) cb({ payload: m.data }); };
    ws.onclose = () => { for (const cb of listeners['engine-died'] || []) cb({}); };
  }
  window.__TAURI__ = {
    core: { invoke: async (name, args = {}) => {
      switch (name) {
        case 'engine_send': if (!ws) throw 'engine not started in mock mode'; if (ws.readyState === 1) ws.send(args.line); else outbox.push(args.line); return null;
        case 'engine_start': return null;
        case 'settings_get': case 'settings_reset': return structuredClone(shell);
        case 'settings_set': shell = structuredClone(args.settings); return structuredClone(shell);
        case 'identity': return { name:'AbdoCode', version:'preview', root:'C:\\\\preview', kernel_present:false, engine_present:engine, engine_argv:[] };
        case 'pick_directory': return null;
        case 'vault_has': return vault.has(args.key);
        case 'vault_set': if (typeof args.value !== 'string' || args.value.length === 0) throw 'empty value'; vault.add(args.key); if (ws) ws.send(JSON.stringify({ __previewVaultSet: args.key })); return null;
        case 'provider_import_local': return false;
        case 'provider_local_status': case 'provider_local_start': return { running:false, models:[] };
        case 'workspace_store_get': return structuredClone(store);
        case 'workspace_store_set': store = structuredClone(args.store ?? store); return structuredClone(store);
        case 'workspace_controls_get': return { folders:[], profiles:[] };
        case 'workspace_browser_status': return { ownedProcessRunning:false, pid:null, port:9222, endpointReady:false, computerUseEnabled:true };
        case 'desktop_preferences_get': return { version:1, runOnStartup:false, systemTray:false, keepComputerAwake:false };
        case 'local_profile_get': return { version:1, displayName:'', role:'', instructions:'' };
        case 'extensions_list': return { schemaVersion:1, revision:0, packages:[] };
        case 'marketplace_index': return { version:1, entries:[] };
        case 'automation_status': case 'automation_migrate_legacy': return structuredClone(automation);
        case 'release_check': return { status:'current' };
        case 'pane_url': return '';
        // مسرحُ الطرفيّة والمرفقات (2026-09-28): صدفةٌ مزيّفة تصدّي المكتوب، واستيرادٌ يعيد شكلَ المرفق — لقياس مسار الكتابة والإسقاط في المتصفّح.
        case 'terminal_open': { const id = 't' + (++termSeq); setTimeout(() => emit('terminal-output', { id, data: Array.from(new TextEncoder().encode('PS C:\\\\preview> ')) }), 40); return { id, cwd: 'C:\\\\preview', shell: 'powershell.exe', pid: 4242 }; }
        case 'terminal_write': { const text = args.data === '\\r' ? '\\r\\nPS C:\\\\preview> ' : args.data; emit('terminal-output', { id: args.id, data: Array.from(new TextEncoder().encode(text)) }); return null; }
        case 'terminal_resize': case 'terminal_close': return null;
        case 'attachments_import': return (args.files || []).map((f, i) => ({ id: 'att-' + Date.now() + '-' + i, sessionId: args.sessionId, name: f.name, mime: /\\.docx$/i.test(f.name) ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/octet-stream', bytes: Math.floor((f.dataBase64 || '').length * 3 / 4), sha256: 'preview' }));
        default: return null;
      }
    }},
    event: { listen: async (name, cb) => { (listeners[name] ||= []).push(cb); return () => { listeners[name] = listeners[name].filter((x) => x !== cb); }; } }
  };
})();
</script>`

const frame = (line: string): Uint8Array => {
  const body = new TextEncoder().encode(line)
  const out = new Uint8Array(4 + body.length)
  new DataView(out.buffer).setUint32(0, body.length, false)
  out.set(body, 4)
  return out
}

type Socket = { child?: Bun.Subprocess<"pipe", "pipe", "ignore"> }

Bun.serve<Socket, never>({
  hostname: "127.0.0.1",
  port,
  async fetch(request, server) {
    const url = new URL(request.url)
    if (withEngine && url.pathname === "/engine") return server.upgrade(request, { data: {} }) ? undefined : new Response("no upgrade", { status: 400 })
    const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1)
    const target = path.resolve(ui, relative)
    if (!target.startsWith(ui + path.sep)) return new Response("refused", { status: 403 })
    if (relative === "index.html") {
      let html = await Bun.file(target).text()
      html = html.replace("default-src 'self';", `default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:${port};`)
      html = html.replace("<script type=\"module\">", `${mock}<script type=\"module\">`)
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
    }
    const file = Bun.file(target)
    return await file.exists() ? new Response(file) : new Response("not found", { status: 404 })
  },
  websocket: {
    open(ws) {
      // As main.rs starts it: `serve` with framed stdio, but every state path in a fresh temporary folder.
      const child = Bun.spawn([process.execPath, path.join(root, "packages", "engine", "src", "cli.ts"), "serve"], {
        cwd: path.join(root, "packages"),
        env: {
          ...process.env,
          ABDO_FRAMED_STDIO: "1",
          ABDO_INSTALL_ROOT: path.join(root, "packages"),
          ABDO_CODE_STATE_DIR: path.join(temp, "engine-state"),
          ABDO_CODE_SETTINGS: path.join(temp, "engine-settings.json"),
          ABDO_VAULT_HOME: path.join(temp, "vault-home"),
          ABDO_VAULT_DIR: path.join(temp, "vault"),
          ABDO_VAULT_SCRIPT: "",
          ABDO_PROJECT: path.join(temp, "project"),
        },
        stdin: "pipe", stdout: "pipe", stderr: "ignore",
      })
      ws.data.child = child
      void (async () => {
        let buffer = new Uint8Array(0)
        for await (const chunk of child.stdout) {
          const merged = new Uint8Array(buffer.length + chunk.length)
          merged.set(buffer); merged.set(chunk, buffer.length); buffer = merged
          while (buffer.length >= 4) {
            const length = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0, false)
            if (buffer.length < 4 + length) break
            ws.send(new TextDecoder().decode(buffer.subarray(4, 4 + length)))
            buffer = buffer.slice(4 + length)
          }
        }
        ws.close()
      })()
      child.stdin.write(frame(JSON.stringify({ kind: "hello", shell: "desktop" })))
    },
    message(ws, message) {
      const text = String(message)
      if (text.startsWith("{\"__previewVaultSet\"")) {
        const key = (JSON.parse(text) as { __previewVaultSet?: unknown }).__previewVaultSet
        if (typeof key === "string" && /^[a-z0-9][a-z0-9-]{0,120}$/u.test(key)) {
          fs.mkdirSync(path.join(temp, "vault"), { recursive: true })
          fs.writeFileSync(path.join(temp, "vault", `${key}.sec`), "preview-placeholder")
        }
        return
      }
      ws.data.child?.stdin.write(frame(text))
    },
    close(ws) { ws.data.child?.kill() },
  },
})
console.log(`DESKTOP_UI_PREVIEW http://127.0.0.1:${port}${withEngine ? ` (engine, state ${temp})` : ""}`)
