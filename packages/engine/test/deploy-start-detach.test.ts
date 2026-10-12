/**
 * 10-08 — بروفة النشر: `--start "node server.js"` جرى في المقدّمة عبر ssh فعلّق ٩٠٠ ثانية ثمّ حُسب فاشلاً و«listening on 3000» في خرجه.
 * سكربتُ التشغيل يُقاس بـsh حقيقيّ: يعود خلال ثوانٍ والعمليّةُ حيّة، والنشرُ التالي يوقف السابقة، والخروجُ الفوريّ يُبلَّغ فشلاً بسجلّه،
 * وأوامرُ المدير الذاتيّ (pm2…) تجري كما هي.
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startScript } from "../src/servers/remote"

const sh = Bun.which("sh")


describe.if(sh !== null)("start runs detached and is checked alive", () => {
  // Under a loaded full-suite run, Bun.spawnSync on Windows sometimes never starts the shell (exit code null within milliseconds, no
  // output) — the harness failed, not the start script. One retry for exactly that case; a script that ran and failed stays red.
  const runSh = (script: string) => {
    const once = () => Bun.spawnSync([sh!, "-c", script], { stdout: "pipe", stderr: "pipe", timeout: 30_000 })
    const r = once()
    if (r.exitCode !== null || r.stdout.length > 0 || r.stderr.length > 0) return r
    Bun.sleepSync(500)
    return once()
  }
  test("a foreground server returns in seconds, running; the next start stops the previous one", () => {
    const base = mkdtempSync(join(tmpdir(), "abdo-start-")).replaceAll("\\", "/")
    mkdirSync(join(base, "current"))
    // sh/sleep, not node.exe: under Git Bash a signal does not reach a native Windows child (the target is Linux, where it does)
    const server = "echo 'listening on 3000'; sleep 600"
    try {
      const t0 = Date.now()
      const first = runSh(startScript(base, server))
      expect(Date.now() - t0).toBeLessThan(45_000) // the server sleeps 600 s: returning at all proves detach; 45 s absorbs a loaded full-suite run
      expect(first.exitCode).toBe(0)
      expect(first.stdout.toString()).toContain("running pid")
      expect(first.stdout.toString()).toContain("listening on 3000")
      const pid1 = readFileSync(join(base, "app.pid"), "utf8").trim()
      const second = runSh(startScript(base, server))
      expect(second.exitCode).toBe(0)
      expect(second.stdout.toString()).toContain(`stopped previous ${pid1}`)
      Bun.spawnSync([sh!, "-c", `kill $(cat '${base}/app.pid') 2>/dev/null`])
    } finally { rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }) }
  }, 60_000)
  test("a start that exits at once is a failure carrying its log", () => {
    const base = mkdtempSync(join(tmpdir(), "abdo-start-")).replaceAll("\\", "/")
    mkdirSync(join(base, "current"))
    try {
      const r = Bun.spawnSync([sh!, "-c", startScript(base, "echo 'Error: Cannot find module express' >&2; exit 1")], { stdout: "pipe", stderr: "pipe", timeout: 30_000 })
      expect(r.exitCode).toBe(1)
      expect(r.stderr.toString()).toContain("Cannot find module express")
    } finally { rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }) }
  }, 60_000)
})

test("self-managed starts run as given", () => {
  for (const cmd of ["pm2 restart app", "sudo systemctl restart app", "docker compose up -d"]) {
    expect(startScript("/srv/app", cmd)).toBe(`cd '/srv/app/current' && ${cmd}`)
  }
  expect(startScript("/srv/app", "node server.js")).toContain("nohup setsid sh -c 'node server.js'")
})

// 10-08 (measured with gpt-6.1-sol): «nohup node … > app.log 2>&1 < /dev/null &» became «cd current && nohup … &» — the & backgrounded the
// whole list in a subshell that held ssh's output, so the step hung 300 s and was reported failed.
test("a start ending in & (and a bare nohup/setsid) goes through the managed path, never as «cd && … &»", () => {
  for (const cmd of ["nohup node --env-file=.env server.js > /srv/app/app.log 2>&1 < /dev/null &", "node server.js &", "nohup node server.js", "setsid node server.js"]) {
    const script = startScript("/srv/app", cmd)
    expect(script).not.toMatch(/&&[^;]*&\s*$/u)
    expect(script).toContain("nohup setsid sh -c")
    expect(script).toContain("echo $! > '/srv/app/app.pid'")
    expect(script).not.toContain("sh -c 'nohup")
  }
})
