/**
 * 10-09 — every deploy task built its SSH test server by hand (crm-pipeline: 80 docker commands, 7 server add, 5 ssh-keygen in one turn).
 * `server sandbox <name>` does it in one call; measured live: ready in 19 s, `node -v` v22 and /srv/app over ssh, removed cleanly.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSandbox, removeSandbox, SANDBOX_IMAGE } from "../src/servers/sandbox"
import { decodeKeyFromVault, findProfile, keyHandleFor, type RemoteDeps, type VaultAccess } from "../src/servers/remote"

function harness(opts: { dockerDown?: boolean; imagePresent?: boolean } = {}) {
  const calls: { argv: string[]; input?: string }[] = []
  const store = new Map<string, string>()
  const vault: VaultAccess = { get: async (h) => store.get(h), set: async (h, v) => { if (/[\r\n]/u.test(v)) return false; store.set(h, v); return true }, forget: async (h) => { store.delete(h) } }
  const deps: RemoteDeps = {
    ssh: "ssh", scp: "scp", keygen: "ssh-keygen", tar: "tar", now: () => new Date("2026-10-09T07:18:00Z"),
    run: (argv, o) => {
      calls.push({ argv: [...argv], ...(o?.input === undefined ? {} : { input: o.input }) })
      if (argv[0] === "docker" && argv[1] === "info") return opts.dockerDown ? { code: 1, stdout: "", stderr: "error during connect" } : { code: 0, stdout: "29.7.2", stderr: "" }
      if (argv[0] === "docker" && argv[1] === "image") return { code: opts.imagePresent ? 0 : 1, stdout: "", stderr: "" }
      if (argv[0] === "ssh") return { code: 0, stdout: "system: Linux x86_64\nuser: root\n", stderr: "" }
      return { code: 0, stdout: "", stderr: "" }
    },
  }
  return { calls, vault, store, deps }
}
const freePort = (from: number) => from

describe("server sandbox", () => {
  test("one call: image built once, container on 127.0.0.1 only, key via stdin (never argv), profile saved, connection measured", async () => {
    const root = mkdtempSync(join(tmpdir(), "abdo-sbx-")), h = harness()
    try {
      const r = await createSandbox(root, "crm", h.vault, h.deps, { freePort, sleep: async () => {} })
      expect(r.ok).toBe(true)
      expect(r.text).toContain("root@127.0.0.1:2300")
      const build = h.calls.find((c) => c.argv[1] === "build")!
      expect(build.argv).toEqual(["docker", "build", "-t", SANDBOX_IMAGE, "-"])
      expect(build.input).toContain("PasswordAuthentication no")
      const run = h.calls.find((c) => c.argv[1] === "run")!.argv
      for (const p of run.filter((a, i) => run[i - 1] === "-p")) expect(p.startsWith("127.0.0.1:")).toBe(true)
      const install = h.calls.find((c) => c.argv[1] === "exec")!
      expect(install.input).toMatch(/^ssh-ed25519 \S+ abdocode-crm\n$/u)
      const pub = install.input!.trim().split(" ")[1]!
      expect(h.calls.every((c) => !c.argv.join(" ").includes(pub))).toBe(true)
      expect(decodeKeyFromVault(h.store.get(keyHandleFor("crm"))!)).toStartWith("-----BEGIN OPENSSH PRIVATE KEY-----")
      expect(findProfile(root, "crm")).toMatchObject({ user: "root", host: "127.0.0.1", port: 2300, path: "/srv/app" })
      expect(h.calls.some((c) => c.argv[0] === "ssh")).toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test("the image is not rebuilt when present; a stopped Docker engine is named, nothing created", async () => {
    const root = mkdtempSync(join(tmpdir(), "abdo-sbx-")), present = harness({ imagePresent: true })
    try {
      expect((await createSandbox(root, "a", present.vault, present.deps, { freePort, sleep: async () => {} })).ok).toBe(true)
      expect(present.calls.some((c) => c.argv[1] === "build")).toBe(false)
      const down = harness({ dockerDown: true })
      const r = await createSandbox(root, "b", down.vault, down.deps, { freePort, sleep: async () => {} })
      expect(r.ok).toBe(false)
      expect(r.text).toContain("Docker")
      expect(down.calls.some((c) => c.argv[1] === "run")).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test("--remove deletes the container and the profile with its key", async () => {
    const root = mkdtempSync(join(tmpdir(), "abdo-sbx-")), h = harness({ imagePresent: true })
    try {
      await createSandbox(root, "crm", h.vault, h.deps, { freePort, sleep: async () => {} })
      const text = await removeSandbox(root, "crm", h.vault, h.deps)
      expect(text).toContain("abdocode-sandbox-crm")
      expect(findProfile(root, "crm")).toBeUndefined()
      expect(h.store.has(keyHandleFor("crm"))).toBe(false)
      expect(h.calls.some((c) => c.argv.join(" ") === "docker rm -f abdocode-sandbox-crm")).toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
