import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ManagedServers, parseServerCommand, resolveLauncher, wrappedServerViolation } from "../src/managed-server"

describe("server command detection — managed lifecycle", () => {
  test("recognises the server shapes that orphaned live", () => {
    expect(parseServerCommand("npm start")?.port).toBe(3000)
    expect(parseServerCommand("npm run dev")?.port).toBe(3000)
    expect(parseServerCommand("npm start -- -p 3001")?.port).toBe(3001)
    // 2026-09-13: مشروعُ Vite يستمع على 5173 — «npm run dev» بلا منفذٍ صريح يأخذ منفذَ الكومة من package.json/vite.config، والصريحُ يبقى سيّداً
    const viteProject = mkdtempSync(join(tmpdir(), "abdo-vite-"))
    writeFileSync(join(viteProject, "package.json"), JSON.stringify({ scripts: { dev: "vite", build: "tsc && vite build" } }))
    expect(parseServerCommand("npm run dev", viteProject)?.port).toBe(5173)
    expect(parseServerCommand("npm run dev -- --port 4000", viteProject)?.port).toBe(4000)
    const nextProject = mkdtempSync(join(tmpdir(), "abdo-next-"))
    writeFileSync(join(nextProject, "package.json"), JSON.stringify({ scripts: { dev: "next dev" } }))
    expect(parseServerCommand("npm run dev", nextProject)?.port).toBe(3000)
    expect(parseServerCommand("next start --port 4200")?.port).toBe(4200)
    expect(parseServerCommand("bun run start")?.port).toBe(3000)
  })

  // الحادثة الحية e2e-1788089398170: غلاف powershell أفلت خادماً من الإدارة.
  test("refuses a server wrapped in powershell with a named redirect", () => {
    expect(wrappedServerViolation('powershell -NoProfile -Command "$OutputEncoding=[Text.Encoding]::UTF8; npm start"')).toContain("غلاف")
    expect(wrappedServerViolation('powershell -Command "Start-Sleep -Seconds 2; npm start"')).toContain("أمراً مباشراً")
    expect(wrappedServerViolation('powershell -Command "Start-Process npm -ArgumentList start"')).toBeDefined()
    // أوامر powershell عادية لا خادم فيها تمرّ.
    expect(wrappedServerViolation('powershell -Command "Invoke-WebRequest -Uri http://127.0.0.1:3000/ -UseBasicParsing"')).toBeUndefined()
    expect(wrappedServerViolation('powershell -Command "npm run build"')).toBeUndefined()
    expect(wrappedServerViolation("npm start")).toBeUndefined()
  })

  // مستودع pnpm متعدد الحزم (إيدو جلوبال): المرشّح يسبق السكربت — بلا هذا
  // الشكل كان الأمر يمرّ من run فيحجبها مهلتها وتنجو شجرته (الحادثة المؤسِّسة).
  test("workspace-filtered server launches are managed, filter preserved, port parsed", () => {
    expect(parseServerCommand("pnpm --filter @taalim/web dev")?.port).toBe(3000)
    expect(parseServerCommand("pnpm --filter=@taalim/web run dev")?.port).toBe(3000)
    expect(parseServerCommand("pnpm -F web start")?.port).toBe(3000)
    expect(parseServerCommand("npm -w apps/web run dev")?.port).toBe(3000)
    expect(parseServerCommand("pnpm --filter web dev -- -p 3051")?.port).toBe(3051)
    expect(parseServerCommand("pnpm --filter @taalim/web dev")?.launch.join(" ")).toBe("pnpm --filter @taalim/web dev")
    expect(parseServerCommand("turbo run dev")?.port).toBe(3000)
    // بناءٌ أو اختبار بمرشّح يبقى عابراً.
    expect(parseServerCommand("pnpm --filter @taalim/web build")).toBeUndefined()
    expect(parseServerCommand("pnpm --filter web test")).toBeUndefined()
  })

  test("transient commands stay on the ordinary path", () => {
    expect(parseServerCommand("npm run build")).toBeUndefined()
    expect(parseServerCommand("npm test")).toBeUndefined()
    expect(parseServerCommand("npm install better-sqlite3")).toBeUndefined()
    // الحادثة الحية: أمر مركب يقتل node ثم يشغّل — ليس تشغيلاً صافياً.
    expect(parseServerCommand("powershell -Command Stop-Process; npm start")).toBeUndefined()
  })
})

describe("managed servers — real lifecycle", () => {
  test("starts a real server, reports the port, and kills the tree at turn end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-srv-"))
    const port = 3900 + Math.floor(Math.random() * 90)
    writeFileSync(join(dir, "server.mjs"), `Bun.serve({ port: ${port}, fetch: () => new Response("up") })`)
    const servers = new ManagedServers()
    const receipt = await servers.start({ launch: ["bun", "server.mjs"], port }, dir)
    expect(receipt).toContain("تحت إدارة النواة")
    expect(receipt).toContain(String(port))
    expect(servers.active).toBe(1)
    const live = await fetch(`http://127.0.0.1:${port}/`)
    expect(await live.text()).toBe("up")
    const stopped = servers.stopAll()
    expect(stopped).toContain("أوقفت النواة")
    expect(servers.active).toBe(0)
    // قتل الشجرة على ويندوز غير فوري — نستطلع الإغلاق بدل مهلة ثابتة.
    let closed = false
    for (let i = 0; i < 20 && !closed; i += 1) {
      await Bun.sleep(500)
      try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) }) } catch { closed = true }
    }
    expect(closed).toBe(true)
  }, 30_000)

  // الحادثة الحية الثالثة: npm.cmd يموت بعد إنجاب next فتنقطع الشجرة
  // وينجو الحفيد من قتل النسب — القتل بالمُنصت المقيس يصل إليه.
  test("kills the listener even when the spawn chain is broken (npm.cmd pattern)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-srv-broken-"))
    const port = 3870
    writeFileSync(join(dir, "server.mjs"), `Bun.serve({ port: ${port}, fetch: () => new Response("orphan") })`)
    // cmd يولد الخادم منفصلاً ثم يموت — يقطع النسب كما تفعل npm.cmd.
    const servers = new ManagedServers()
    // أبٌ يولّد الخادم منفصلاً ثم يموت — قطعُ نسبٍ أمين لنمط npm.cmd،
    // بلا حرب اقتباسات cmd/start (فشلت مرتين في هذه البيئة).
    writeFileSync(join(dir, "parent.mjs"),
      'import { spawn } from "node:child_process"\n' +
      'const child = spawn(process.execPath, ["server.mjs"], { detached: true, stdio: "ignore", cwd: process.cwd() })\n' +
      "child.unref()\nprocess.exit(0)\n")
    const receipt = await servers.start({ launch: [process.execPath, "parent.mjs"], port }, dir)
    expect(receipt).toContain("تحت إدارة النواة")
    const live = await fetch(`http://127.0.0.1:${port}/`)
    expect(await live.text()).toBe("orphan")
    servers.stopAll()
    let closed = false
    for (let i = 0; i < 20 && !closed; i += 1) {
      await Bun.sleep(500)
      try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) }) } catch { closed = true }
    }
    expect(closed).toBe(true)
  }, 30_000)

  // الحادثة الحية e2e-1788296470333 (جولة qwen3.8-max 2026-09-02): المُشغّل
  // العاري «npm» رمى ENOENT فأفلت إلى catch الدور فأسقط الجولة كلها. الآن
  // فشلُ الإطلاق إيصالٌ لا رمية — والدور ينجو ويرى فشلاً قابلاً للتصرّف.
  test("a launcher that cannot spawn returns a receipt, never throws (round survives)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-srv-nolaunch-"))
    const servers = new ManagedServers()
    // اسمٌ لا يُحلّ ولا يوجد تنفيذياً — يجب أن يُلتقط إيصالاً، لا يُرمى.
    const bogus = "abdo-nonexistent-launcher-xyz"
    let receipt = ""
    await expect((async () => { receipt = await servers.start({ launch: [bogus, "start"], port: 3866 }, dir) })()).resolves.toBeUndefined()
    expect(receipt).toContain("فشل تشغيل الخادم")
    expect(receipt).toContain(bogus)
    expect(servers.active).toBe(0)
  }, 30_000)

  // كتالوج 6.3 امتدّ إلى عائلة node: الاسم العاري يُحلّ لمسارٍ مطلق موجود.
  test("resolveLauncher resolves node-family launchers to an absolute path, passes others through", () => {
    const npm = resolveLauncher("npm")
    expect(npm.endsWith("npm.cmd") || npm.endsWith("npm.exe")).toBe(true)
    expect(npm).not.toBe("npm")
    // اسمٌ يحمل مساراً أو امتداداً تنفيذياً — يُترك كما هو.
    expect(resolveLauncher("C:/Program Files/nodejs/npm.cmd")).toBe("C:/Program Files/nodejs/npm.cmd")
    expect(resolveLauncher("npm.cmd")).toBe("npm.cmd")
    // غير الموجود يُترك للنظام (تلتقطه start إيصالاً).
    expect(resolveLauncher("abdo-nonexistent-launcher-xyz")).toBe("abdo-nonexistent-launcher-xyz")
  })

  test("a server that never listens is reaped, not orphaned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-srv-dead-"))
    writeFileSync(join(dir, "server.mjs"), "process.exit(7)")
    const servers = new ManagedServers()
    const receipt = await servers.start({ launch: ["bun", "server.mjs"], port: 3899 }, dir)
    expect(receipt).toContain("خرج برمز 7")
    expect(servers.active).toBe(0)
    expect(servers.stopAll()).toBeUndefined()
  }, 30_000)

  // الحادثة الحية: رفضنا منفذاً يملكه الدور نفسه بعبارة «ليست من هذا الدور».
  test("re-requesting our own live port returns its receipt, not a false refusal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-srv-own-"))
    const port = 3860
    writeFileSync(join(dir, "server.mjs"), `Bun.serve({ port: ${port}, fetch: () => new Response("up") })`)
    const servers = new ManagedServers()
    await servers.start({ launch: ["bun", "server.mjs"], port }, dir)
    const again = await servers.start({ launch: ["bun", "server.mjs"], port }, dir)
    expect(again).toContain("خادمك يعمل فعلاً")
    expect(again).not.toContain("رُفض")
    expect(servers.active).toBe(1)
    servers.stopAll()
  }, 30_000)

  test("a foreign-owned port gets a leased free port, reported by name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-srv-lease-"))
    const port = 3880
    // الخادم يقرأ PORT من البيئة — قناة الإيجار للخوادم العامة.
    writeFileSync(join(dir, "server.mjs"), 'Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response("leased") })')
    const foreign = Bun.serve({ port, fetch: () => new Response("foreign") })
    try {
      const servers = new ManagedServers()
      const receipt = await servers.start({ launch: ["bun", "server.mjs"], port }, dir)
      expect(receipt).toContain("أجّرت لك النواة")
      expect(receipt).toContain("3881")
      const probe = await fetch("http://127.0.0.1:3881/")
      expect(await probe.text()).toBe("leased")
      servers.stopAll()
      // الأجنبي لم يُمسّ — «قتلها قرارها لا قرارك».
      const still = await fetch(`http://127.0.0.1:${port}/`)
      expect(await still.text()).toBe("foreign")
    } finally {
      foreign.stop(true)
    }
  }, 30_000)

  test("npm-style launches receive the leased port after the -- separator", async () => {
    const { parseServerCommand } = await import("../src/managed-server")
    expect(parseServerCommand("npm start")?.launch.join(" ")).toBe("npm start")
    // withPort يُختبر عبر الإيجار الحي أعلاه؛ هنا شكل الأمر المصفّى فقط.
    expect(parseServerCommand("npm start -- -p 3001")?.port).toBe(3001)
  })
})
