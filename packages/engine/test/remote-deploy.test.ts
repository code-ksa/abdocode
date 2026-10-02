import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { familiesFor } from "../src/tool-exposure"
import { DEPLOY_EXCLUDES, addServer, deploy, findProfile, keyHandleFor, listProfiles, parseTarget, removeServer, renderDeploy, rollback, runOnServer, shq, testServer, type RemoteDeps, type VaultAccess } from "../src/servers/remote"

// 10-02 — the user puts in their server, AbdoCode connects and deploys. Here every binary is a recorder, so the exact ssh/scp/tar
// calls, their order, the key's lifetime and what stays out of the archive are measured without a real server.

const PRIVATE = "-----BEGIN OPENSSH PRIVATE KEY-----\nfake-key-body\n-----END OPENSSH PRIVATE KEY-----\n"

function harness(fail: Partial<Record<"ssh" | "scp" | "tar", (argv: readonly string[]) => boolean>> = {}) {
  const calls: string[][] = []
  const keySeen: { path: string; existed: boolean; body: string }[] = []
  const vaultStore = new Map<string, string>()
  const vault: VaultAccess = {
    get: async (h) => vaultStore.get(h),
    set: async (h, v) => { vaultStore.set(h, v); return true },
    forget: async (h) => { vaultStore.delete(h) },
  }
  const deps: RemoteDeps = {
    ssh: "ssh", scp: "scp", keygen: "ssh-keygen", tar: "tar",
    now: () => new Date("2026-10-02T18:30:05Z"),
    run: (argv) => {
      calls.push([...argv])
      const [bin] = argv
      if (bin === "ssh-keygen") {
        const f = argv[argv.indexOf("-f") + 1]!
        if (argv.includes("-y")) return { code: 0, stdout: "ssh-ed25519 AAAAimported user@pc\n", stderr: "" }
        writeFileSync(f, PRIVATE); writeFileSync(`${f}.pub`, "ssh-ed25519 AAAAgenerated abdocode-prod\n")
        return { code: 0, stdout: "", stderr: "" }
      }
      if (bin === "ssh" || bin === "scp") {
        const k = argv[argv.indexOf("-i") + 1]!
        keySeen.push({ path: k, existed: existsSync(k), body: existsSync(k) ? readFileSync(k, "utf8") : "" })
      }
      if (bin === "tar") { writeFileSync(argv[argv.indexOf("-czf") + 1]!, "archive"); if (fail.tar?.(argv)) return { code: 1, stdout: "", stderr: "tar: boom" } }
      if (bin === "ssh" && fail.ssh?.(argv)) return { code: 1, stdout: "", stderr: "Permission denied (publickey)." }
      if (bin === "scp" && fail.scp?.(argv)) return { code: 1, stdout: "", stderr: "scp: lost connection" }
      if (bin === "ssh" && /prev=/.test(argv[argv.length - 1]!)) return { code: 0, stdout: "20261001-120000\n", stderr: "" }
      return { code: 0, stdout: bin === "ssh" ? "ok\n" : "", stderr: "" }
    },
  }
  return { calls, keySeen, vault, vaultStore, deps }
}

const state = () => mkdtempSync(join(tmpdir(), "abdo-servers-"))

describe("targets and quoting", () => {
  test("user@host[:port] is parsed and checked", () => {
    expect(parseTarget("deploy@1.2.3.4")).toEqual({ user: "deploy", host: "1.2.3.4", port: 22 })
    expect(parseTarget("root@app.example.com:2222")).toEqual({ user: "root", host: "app.example.com", port: 2222 })
    for (const bad of ["host-only", "a b@host", "u@ho st", "u@host:99999", "u@-bad-.com", "u@host;rm"]) expect("error" in parseTarget(bad)).toBe(true)
  })
  test("remote shell quoting survives a single quote", () => {
    expect(shq("/srv/it's")).toBe(`'/srv/it'\\''s'`)
  })
})

describe("server add / list / remove", () => {
  test("add generates a key: the private half goes to the vault only, the profile holds no secret, and the public key is shown", async () => {
    const root = state(), h = harness()
    try {
      const r = await addServer(root, { name: "prod", target: "deploy@1.2.3.4", path: "/srv/app" }, h.vault, h.deps)
      expect(r.ok).toBe(true)
      expect(r.text).toContain("ssh-ed25519 AAAAgenerated abdocode-prod")
      expect(h.vaultStore.get(keyHandleFor("prod"))).toBe(PRIVATE)
      const file = readFileSync(join(root, "servers.json"), "utf8")
      expect(file).not.toContain("PRIVATE KEY")
      expect(findProfile(root, "prod")).toMatchObject({ user: "deploy", host: "1.2.3.4", port: 22, path: "/srv/app", keyHandle: "custom-server-prod-key" })
      // the keygen temp folder is gone
      const genDir = h.calls.find((c) => c[0] === "ssh-keygen")![h.calls.find((c) => c[0] === "ssh-keygen")!.indexOf("-f") + 1]!
      expect(existsSync(genDir)).toBe(false)
      expect(await removeServer(root, "prod", h.vault)).toContain("أُزيل")
      expect(h.vaultStore.has(keyHandleFor("prod"))).toBe(false)
      expect(listProfiles(root)).toEqual([])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test("an existing key file is imported (public half derived), bad names and relative paths are refused", async () => {
    const root = state(), h = harness()
    const keyFile = join(root, "id_existing"); writeFileSync(keyFile, PRIVATE)
    try {
      const r = await addServer(root, { name: "web", target: "u@host.example", keyFile }, h.vault, h.deps)
      expect(r.ok).toBe(true)
      expect(h.vaultStore.get(keyHandleFor("web"))).toBe(PRIVATE)
      expect(findProfile(root, "web")!.path).toBe("/home/u/apps/web")
      expect((await addServer(root, { name: "Bad Name", target: "u@h" }, h.vault, h.deps)).ok).toBe(false)
      expect((await addServer(root, { name: "x", target: "u@h", path: "relative/path" }, h.vault, h.deps)).ok).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe("connecting", () => {
  test("ssh pins host keys in AbdoCode's own known_hosts, runs non-interactively, and the key file exists only during the call", async () => {
    const root = state(), h = harness()
    try {
      await addServer(root, { name: "prod", target: "deploy@1.2.3.4:2200", path: "/srv/app" }, h.vault, h.deps)
      const r = await testServer(root, findProfile(root, "prod")!, h.vault, h.deps)
      expect(r.ok).toBe(true)
      const ssh = h.calls.find((c) => c[0] === "ssh")!
      expect(ssh).toContain("BatchMode=yes")
      expect(ssh).toContain("StrictHostKeyChecking=accept-new")
      expect(ssh).toContain(`UserKnownHostsFile="${join(root, "known_hosts")}"`)
      expect(ssh.slice(ssh.indexOf("-p"), ssh.indexOf("-p") + 2)).toEqual(["-p", "2200"])
      expect(ssh).toContain("deploy@1.2.3.4")
      expect(h.keySeen[0]).toMatchObject({ existed: true, body: PRIVATE })
      expect(existsSync(h.keySeen[0]!.path)).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test("permission denied names the missing authorized key; no key in the vault is a named refusal", async () => {
    const root = state(), h = harness({ ssh: () => true })
    try {
      await addServer(root, { name: "prod", target: "deploy@1.2.3.4" }, h.vault, h.deps)
      const r = await testServer(root, findProfile(root, "prod")!, h.vault, h.deps)
      expect(r.ok).toBe(false)
      expect(r.text).toContain("المفتاحُ العامّ غيرُ مضافٍ على الخادم")
      h.vaultStore.clear()
      expect((await runOnServer(root, findProfile(root, "prod")!, "uptime", h.vault, h.deps)).text).toContain("غائبٌ عن الخزنة")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe("deploy and rollback", () => {
  test("pack without secrets or dependencies → prepare → upload → release+current → build → start, in that order", async () => {
    const root = state(), project = state(), h = harness()
    try {
      await addServer(root, { name: "prod", target: "deploy@1.2.3.4", path: "/srv/app" }, h.vault, h.deps)
      const result = await deploy(root, project, findProfile(root, "prod")!, { build: "npm ci && npm run build", start: "pm2 restart app" }, h.vault, h.deps)
      expect(result.ok).toBe(true)
      expect(result.release).toBe("20261002-183005")
      expect(result.steps.map((s) => s.step)).toEqual(["pack", "prepare", "upload", "release", "build", "start"])
      const tar = h.calls.find((c) => c[0] === "tar")!
      for (const ex of [".env", ".env.*", "node_modules", ".git", ".next"]) expect(tar[tar.indexOf(ex) - 1]).toBe("--exclude")
      expect(DEPLOY_EXCLUDES).toContain(".env")
      const remote = h.calls.filter((c) => c[0] === "ssh").map((c) => c[c.length - 1]!)
      expect(remote[1]).toContain("ln -sfn '/srv/app/releases/20261002-183005' '/srv/app/current'")
      expect(remote[1]).toContain("tail -n +6")
      expect(remote[2]).toBe("cd '/srv/app/current' && npm ci && npm run build")
      expect(remote[3]).toBe("cd '/srv/app/current' && pm2 restart app")
      const scp = h.calls.find((c) => c[0] === "scp")!
      expect(scp.slice(scp.indexOf("-P"), scp.indexOf("-P") + 2)).toEqual(["-P", "22"])
      expect(scp[scp.length - 1]).toBe("deploy@1.2.3.4:/srv/app/releases/20261002-183005.tgz")
      // the key and the local archive are gone afterwards
      for (const k of h.keySeen) expect(existsSync(k.path)).toBe(false)
      expect(existsSync(tar[tar.indexOf("-czf") + 1]!)).toBe(false)
      expect(renderDeploy(findProfile(root, "prod")!, result)).toContain("للرجوع: deploy prod --rollback")
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }) }
  })
  test("a failed upload stops before current moves; a failed URL check fails the deploy", async () => {
    const root = state(), project = state()
    try {
      const h = harness({ scp: () => true })
      await addServer(root, { name: "prod", target: "deploy@1.2.3.4", path: "/srv/app" }, h.vault, h.deps)
      const r = await deploy(root, project, findProfile(root, "prod")!, { start: "pm2 restart app" }, h.vault, h.deps)
      expect(r.ok).toBe(false)
      expect(r.steps.map((s) => `${s.step}:${s.ok}`)).toEqual(["pack:true", "prepare:true", "upload:false"])
      expect(h.calls.some((c) => c[0] === "ssh" && /ln -sfn/.test(c[c.length - 1]!))).toBe(false)
      const h2 = harness()
      await addServer(root, { name: "prod", target: "deploy@1.2.3.4", path: "/srv/app" }, h2.vault, h2.deps)
      const checked = await deploy(root, project, findProfile(root, "prod")!, { check: "https://app.example/" }, h2.vault, h2.deps, async () => 502)
      expect(checked.ok).toBe(false)
      expect(checked.steps[checked.steps.length - 1]).toMatchObject({ step: "check", ok: false })
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }) }
  })
  test("rollback points current at the previous release, then the start command", async () => {
    const root = state(), h = harness()
    try {
      await addServer(root, { name: "prod", target: "deploy@1.2.3.4", path: "/srv/app" }, h.vault, h.deps)
      const r = await rollback(root, findProfile(root, "prod")!, "pm2 restart app", h.vault, h.deps)
      expect(r.ok).toBe(true)
      expect(r.text).toContain("current ⇦ releases/20261001-120000")
      const remote = h.calls.filter((c) => c[0] === "ssh").map((c) => c[c.length - 1]!)
      expect(remote[0]).toContain("sed -n 2p")
      expect(remote[1]).toBe("cd '/srv/app/current' && pm2 restart app")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe("wiring", () => {
  test("cli gates every server touch and reads the switch once", () => {
    const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8")
    expect(cli.split('pluginOnNow("remoteDeploy")').length - 1).toBe(1)
    for (const g of ["`نشرُ المشروع على «", "`الرجوعُ إلى الإصدار السابق على «", "`الاتّصالُ بالخادم «", "`تنفيذٌ على «"]) expect(cli).toContain(g)
  })
})

describe("tool family", () => {
  test("a remote server or a deploy opens the server tools; the local dev server does not", () => {
    for (const goal of ["اربط سيرفري وانشر المشروع", "deploy to my VPS", "ارفع المشروع على الاستضافة", "connect over ssh"]) expect(familiesFor(goal).has("servers")).toBe(true)
    for (const goal of ["شغّل الخادم وافتح الصفحة", "run the dev server", "بعد تشغيل الخادم خذ لقطة"]) expect(familiesFor(goal).has("servers")).toBe(false)
  })
})
