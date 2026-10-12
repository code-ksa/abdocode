/**
 * 10-08 — measured on abdo-router: every deploy step passed (env from the vault, build, managed start "Ready in 118ms") and
 * `--check http://127.0.0.1:3000/api/health` answered "no reply" — it was fetched from the dev machine, while 127.0.0.1 names the server's
 * own loopback (the container publishes only 22). A loopback check runs on the server over ssh; a public URL is still fetched locally.
 */
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addServer, deploy, findProfile, isLoopbackUrl, loopbackCheckScript, type RemoteDeps, type VaultAccess } from "../src/servers/remote"

const sh = Bun.which("sh")

test.if(sh !== null)("the check script, run by a real sh, reads the status of a live loopback server and retries a closed one", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (r) => new Response(new URL(r.url).pathname === "/api/health" ? "ok" : "no", { status: new URL(r.url).pathname === "/api/health" ? 200 : 404 }) })
  try {
    const ok = Bun.spawn([sh!, "-c", loopbackCheckScript(`http://127.0.0.1:${server.port}/api/health`)], { stdout: "pipe" })
    expect(await new Response(ok.stdout).text()).toContain("HTTP_STATUS=200")
  } finally { server.stop(true) }
}, 60_000)

test("isLoopbackUrl", () => {
  for (const u of ["http://127.0.0.1:3000/api/health", "http://localhost/", "http://[::1]:8080/x"]) expect(isLoopbackUrl(u)).toBe(true)
  for (const u of ["https://app.example.com/health", "http://10.0.0.5:3000/", "http://127.0.0.10/"]) expect(isLoopbackUrl(u)).toBe(false)
})

function harness(sshStdout: (cmd: string) => string) {
  const calls: string[][] = []
  const store = new Map<string, string>()
  const vault: VaultAccess = { get: async (h) => store.get(h), set: async (h, v) => { if (/[\r\n]/u.test(v)) return false; store.set(h, v); return true }, forget: async (h) => { store.delete(h) } }
  const deps: RemoteDeps = {
    ssh: "ssh", scp: "scp", keygen: "ssh-keygen", tar: "tar", now: () => new Date("2026-10-08T23:10:32Z"),
    run: (argv) => {
      calls.push([...argv])
      if (argv[0] === "tar") { Bun.write(argv[argv.indexOf("-czf") + 1]!, "archive"); return { code: 0, stdout: "", stderr: "" } }
      if (argv[0] === "ssh") return { code: 0, stdout: sshStdout(argv[argv.length - 1]!), stderr: "" }
      return { code: 0, stdout: "", stderr: "" }
    },
  }
  return { calls, vault, deps }
}

test("deploy runs a loopback --check on the server and reads its status there; the local fetcher is not used", async () => {
  const root = mkdtempSync(join(tmpdir(), "abdo-lbc-")), project = mkdtempSync(join(tmpdir(), "abdo-lbp-"))
  try {
    const h = harness((cmd) => (cmd.includes("HTTP_STATUS=") ? "HTTP_STATUS=200\n" : "ok\n"))
    await addServer(root, { name: "box", target: "root@127.0.0.1:2222" }, h.vault, h.deps)
    let localFetches = 0
    const r = await deploy(root, project, findProfile(root, "box")!, { start: "npm start", check: "http://127.0.0.1:3000/api/health" }, h.vault, h.deps, async () => { localFetches += 1; return 0 })
    expect(localFetches).toBe(0)
    expect(r.ok).toBe(true)
    expect(r.steps.at(-1)).toMatchObject({ step: "check", ok: true })
    expect(r.steps.at(-1)!.detail).toContain("من الخادم نفسِه")
    expect(h.calls.some((c) => c[0] === "ssh" && c[c.length - 1]!.includes("'http://127.0.0.1:3000/api/health'"))).toBe(true)
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }) }
})

test("a public --check URL is still fetched from here", async () => {
  const root = mkdtempSync(join(tmpdir(), "abdo-lbc-")), project = mkdtempSync(join(tmpdir(), "abdo-lbp-"))
  try {
    const h = harness(() => "ok\n")
    await addServer(root, { name: "box", target: "deploy@1.2.3.4" }, h.vault, h.deps)
    let localFetches = 0
    const r = await deploy(root, project, findProfile(root, "box")!, { check: "https://app.example.com/health" }, h.vault, h.deps, async () => { localFetches += 1; return 200 })
    expect(localFetches).toBe(1)
    expect(r.ok).toBe(true)
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }) }
})
