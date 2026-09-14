#!/usr/bin/env bun

/** Local-only visual harness. It never starts the engine or reads the vault. */
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const ui = path.join(root, "packages", "desktop", "ui")
const port = 41739

const mock = `<script>
window.__TAURI__ = {
  core: { invoke: async (name, args = {}) => {
    const defaults = { version:1, language:'ar', colorScheme:'system', uiScale:100, followup:'queue', showNavigation:true, showBrowserPane:true, reasoningSummaries:true, expandedTools:false, notifications:{agent:true,permission:true,error:true}, sounds:{agent:false,permission:true,error:true}, keybindings:{commandPalette:'Ctrl+K',settings:'Ctrl+,',newSession:'Ctrl+N'} };
    if (name === 'settings_get' || name === 'settings_reset') return defaults;
    if (name === 'settings_set') return args.settings;
    if (name === 'identity') return { root:'C:\\\\preview', kernel_present:true, engine_present:true };
    if (name === 'pick_directory') return null;
    if (name === 'vault_has') return false;
    return name === 'pane_url' ? '' : undefined;
  }},
  event: { listen: async () => () => {} }
};
</script>`

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url)
    const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1)
    const target = path.resolve(ui, relative)
    if (!target.startsWith(ui + path.sep)) return new Response("refused", { status: 403 })
    if (relative === "index.html") {
      let html = await Bun.file(target).text()
      html = html.replace("default-src 'self';", "default-src 'self'; script-src 'self' 'unsafe-inline';")
      html = html.replace("<script type=\"module\">", `${mock}<script type=\"module\">`)
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
    }
    const file = Bun.file(target)
    return await file.exists() ? new Response(file) : new Response("not found", { status: 404 })
  },
})
console.log(`DESKTOP_UI_PREVIEW http://127.0.0.1:${port}`)
