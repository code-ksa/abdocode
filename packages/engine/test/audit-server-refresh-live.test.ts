import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { auditServerScript, ManagedServers, parseServerCommand } from "../src/managed-server"

// 10-14 — measured with claude-sonnet-5-5 on m11: audit measured a production server older than the latest build (14 s), warned at the
// end, then the model stopped it, restarted it and audited again; and with no managed server audit refused, costing five calls before
// «run --bg». refreshStale restarts the stale server before measuring; auditServerScript names what the kernel starts.

const lease = () => { const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") }); const p = s.port!; s.stop(true); return p }

test("live: refreshStale restarts a production server older than the build and it serves the new build; fresh servers are left alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-refresh-"))
  const port = lease()
  writeFileSync(join(dir, "server.js"), `const html = require("fs").readFileSync(__dirname + "/dist/index.html", "utf8"); Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: () => new Response(html) })`)
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { start: "bun server.js" } }))
  mkdirSync(join(dir, "dist")); writeFileSync(join(dir, "dist", "index.html"), "build-1")
  const servers = new ManagedServers()
  const command = parseServerCommand(`npm run start -- --port ${port}`, dir) ?? { launch: ["npm", "run", "start"], port }
  try {
    await servers.start({ ...command, port }, dir)
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("build-1")
    expect(await servers.refreshStale(dir)).toBe("") // the twin: no rebuild ⇒ untouched
    await Bun.sleep(30)
    writeFileSync(join(dir, "dist", "index.html"), "build-2")
    const note = await servers.refreshStale(dir)
    expect(note).toContain("أُعيد تشغيلُ")
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("build-2")
    expect(await servers.refreshStale(dir)).toBe("") // restarted after the build ⇒ fresh again
  } finally {
    servers.stopAll?.()
    for (let i = 0; i < 10; i++) { try { rmSync(dir, { recursive: true, force: true }); break } catch { await Bun.sleep(300) } }
  }
}, 90_000)

test("auditServerScript: start when built (or no dev), dev when not built, the lockfile names the manager, nothing without scripts", () => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-audit-script-"))
  try {
    expect(auditServerScript(dir)).toBeUndefined()
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite", start: "node server/index.js" } }))
    expect(auditServerScript(dir)).toBe("npm run dev")
    mkdirSync(join(dir, "dist")); writeFileSync(join(dir, "dist", "index.html"), "x")
    expect(auditServerScript(dir)).toBe("npm run start")
    writeFileSync(join(dir, "pnpm-lock.yaml"), "")
    expect(auditServerScript(dir)).toBe("pnpm run start")
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { start: "node s.js" } }))
    rmSync(join(dir, "dist"), { recursive: true, force: true })
    expect(auditServerScript(dir)).toBe("pnpm run start")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("wiring: audit refreshes before measuring and starts the project server through the command gate instead of refusing", () => {
  const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")
  const helper = cli.slice(cli.indexOf("const autoStartProjectServer = async (turnId: string)"))
  expect(helper.length).toBeLessThan(cli.length)
  expect(helper).toContain('if (!await gate(turnId, "command", `تشغيل خادم المشروع للتدقيق: ${script}`, "run")) return undefined')
  expect(helper).toContain("if (parsed === undefined || projectAuthAudit(PROJECT_DIR) !== undefined || dependencyAudit(PROJECT_DIR) !== undefined) return undefined")
  // both doors use it: the early surface guard (no surface yet) and the audit body
  expect(cli).toContain("const started = /https?:\\/\\//iu.test(rest) ? undefined : await autoStartProjectServer(turnId)")
  expect(cli).toContain("if (managedPort === undefined) managedPort = await autoStartProjectServer(turnId)")
  expect(cli.indexOf('let serverNote = await turnServers.refreshStale(PROJECT_DIR)')).toBeLessThan(cli.indexOf('audit يحتاج خادماً مُداراً يعمل لهذا المشروع'))
})

test("a lone port prefix is not a compound command: «$env:PORT=3111; npm start» and «PORT=3113 npm start» are managed servers on that port", () => {
  expect(parseServerCommand("$env:PORT=3111; npm start")).toEqual({ launch: ["npm", "start"], port: 3111 })
  expect(parseServerCommand("$env:PORT='3112'; npm run start")).toEqual({ launch: ["npm", "run", "start"], port: 3112 })
  expect(parseServerCommand("PORT=3113 npm start")).toEqual({ launch: ["npm", "start"], port: 3113 })
  // the twins: a real compound command stays on the ordinary path, and an explicit --port still wins
  expect(parseServerCommand("$env:PORT=3111; npm start; whoami")).toBeUndefined()
  expect(parseServerCommand("npm start; rm x")).toBeUndefined()
  expect(parseServerCommand("$env:PORT=3111; npm run start -- --port 4000")?.port).toBe(4000)
})
