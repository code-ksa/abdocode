import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildNewerThan, ManagedServers, parseServerCommand } from "../src/managed-server"

// 10-10 (مقيس في مهمّة n8n): بعد «npm run build» قيل «خادمك يعمل فعلاً — لا حاجة لإعادة تشغيله» والخادمُ يقدّم البناءَ القديم، فدار النموذجُ
// بين stop وrun وStop-Process المرفوض. خادمٌ حقيقيّ يقرأ dist/index.html عند إقلاعه (كما يحمّل next start مجلّدَ .next).

const lease = () => { const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") }); const p = s.port!; s.stop(true); return p }

test("live: a production server older than the latest build is restarted on «run --bg … start» and serves the new build; without a rebuild it is left alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-rebuilt-"))
  const port = lease()
  writeFileSync(join(dir, "server.js"), `const html = require("fs").readFileSync(__dirname + "/dist/index.html", "utf8"); Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: () => new Response(html) })`)
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { start: "bun server.js" } }))
  mkdirSync(join(dir, "dist")); writeFileSync(join(dir, "dist", "index.html"), "build-1")
  const servers = new ManagedServers()
  const command = parseServerCommand(`npm run start -- --port ${port}`, dir) ?? { launch: ["npm", "run", "start"], port }
  const cmd = { ...command, port }
  try {
    await servers.start(cmd, dir)
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("build-1")
    // the twin first: no rebuild ⇒ «already running», not restarted
    const again = await servers.start(cmd, dir)
    expect(again).not.toContain("أُعيد تشغيلُ")
    await Bun.sleep(30)
    writeFileSync(join(dir, "dist", "index.html"), "build-2") // the rebuild
    const restarted = await servers.start(cmd, dir)
    expect(restarted).toContain("أُعيد تشغيلُ")
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("build-2")
  } finally {
    servers.stopAll?.()
    for (let i = 0; i < 10; i++) { try { rmSync(dir, { recursive: true, force: true }); break } catch { await Bun.sleep(300) } }
  }
}, 90_000)

test("pure: buildNewerThan reads the build markers on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-marker-"))
  try {
    expect(buildNewerThan(dir, 0)).toBe(false)
    mkdirSync(join(dir, ".next")); writeFileSync(join(dir, ".next", "BUILD_ID"), "x")
    expect(buildNewerThan(dir, Date.now() - 60_000)).toBe(true)
    expect(buildNewerThan(dir, Date.now() + 60_000)).toBe(false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
