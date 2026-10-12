/**
 * 10-09 — measured on crm-pipeline (nemotron-ultra): three turns closed no sprint while `ls -la crm.db` and `curl -s -o /dev/null -w
 * "%{http_code}" …` were refused as "Linux syntax", each refusal costing a full model call. Unambiguous translations are applied and
 * announced; destructive and remote-shell commands are untouched. The translated commands are run for real in PowerShell 5.1.
 */
import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { linuxismRepair } from "../src/powershell-call-repair"

const fixed = (c: string) => linuxismRepair(c)?.command

test("unambiguous Linux habits are translated and announced", () => {
  expect(fixed('curl -s -o /dev/null -w "%{http_code}" http://localhost:3400/companies')).toBe('curl.exe -s -o NUL -w "%{http_code}" http://localhost:3400/companies')
  expect(fixed("ls -la crm.db")).toBe("Get-ChildItem -Force crm.db")
  expect(fixed("ls -l")).toBe("Get-ChildItem -Force")
  expect(fixed("mkdir -p data/backups")).toBe("New-Item -ItemType Directory -Force data/backups | Out-Null")
  expect(fixed("npm test 2>/dev/null")).toBe("npm test 2>$null")
  expect(linuxismRepair("ls -la crm.db")!.note).toContain("ls -la ⇦ Get-ChildItem -Force")
})

test("the twins: destructive, remote, already-native and argument-position words are left alone", () => {
  for (const c of ["rm -rf node_modules", "ssh host 'ls -la /srv && curl -s http://x'", "wsl ls -la", "docker exec box ls -la", "Get-ChildItem", "curl.exe -s http://x", "echo curl is great", "npm run build"]) {
    expect(linuxismRepair(c)).toBeUndefined()
  }
})

test.skipIf(process.platform !== "win32")("the translated commands run in PowerShell 5.1 and do what the original meant", async () => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-linuxism-"))
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 204 }) })
  // async spawn: a synchronous one blocks this process, and the test server lives in it — curl would wait for a server that cannot answer
  const ps = async (cmd: string): Promise<string> => {
    const p = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", cmd], { cwd: dir, stdout: "pipe", stderr: "pipe" })
    const out = await new Response(p.stdout).text()
    await p.exited
    return out
  }
  try {
    writeFileSync(join(dir, "crm.db"), "x")
    expect((await ps(fixed(`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:${server.port}/`)!)).trim()).toBe("204")
    expect(await ps(fixed("ls -la crm.db")!)).toContain("crm.db")
    await ps(fixed("mkdir -p a/b/c")!)
    expect(existsSync(join(dir, "a", "b", "c"))).toBe(true)
  } finally { server.stop(true); rmSync(dir, { recursive: true, force: true }) }
}, 60_000)
