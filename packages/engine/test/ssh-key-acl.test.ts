/**
 * 10-08 — بروفة النشر: `server test` ردّ «Bad permissions … UNKNOWN\\UNKNOWN (S-1-5-21-…)»: ملفُّ المفتاح المؤقّت في %TEMP% ورث ACEًا
 * لا يقبلها OpenSSH. القفلُ يُقاس على ملفٍّ حقيقيّ في %TEMP% (الذي يحمل على هذا الجهاز مبادئَ صندوقٍ رمل غريبة) ثمّ يُقرأ بـssh-keygen
 * الحقيقيّ — الحَكَم نفسُه الذي رفض. ورمزُ icacls الفاشل يُسمّى لا يُتجاهل.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addServer, decodeKeyFromVault, defaultDeps, forgetHostKey, keyHandleFor, lockKeyFile } from "../src/servers/remote"
import { generateOpenSshEd25519 } from "../src/servers/ssh-keys"

const win = process.platform === "win32"
const sys = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32`

describe.if(win)("the temporary key file is locked so Windows OpenSSH accepts it", () => {
  test("a key written under %TEMP% is accepted by ssh-keygen after lockKeyFile, and was not before", () => {
    const deps = defaultDeps()
    const dir = mkdtempSync(join(tmpdir(), "abdo-ssh-acl-"))
    const key = generateOpenSshEd25519("acl-probe")
    try {
      const file = join(dir, "id")
      writeFileSync(file, key.privateKey, { mode: 0o600 })
      const before = Bun.spawnSync([`${sys}\\OpenSSH\\ssh-keygen.exe`, "-y", "-f", file], { stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 15_000 })
      expect(lockKeyFile(deps, deps.icacls!, file)).toBeUndefined()
      const after = Bun.spawnSync([`${sys}\\OpenSSH\\ssh-keygen.exe`, "-y", "-f", file], { stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 15_000 })
      expect(after.stderr.toString()).toBe("")
      expect(after.stdout.toString().trim().split(" ").slice(0, 2).join(" ")).toBe(key.publicKey.split(" ").slice(0, 2).join(" "))
      // the twin: unlocked under this %TEMP% it was refused (when %TEMP% grants others — otherwise the guard has nothing to prove here)
      const acl = Bun.spawnSync([deps.icacls!, dir], { stdout: "pipe" }).stdout.toString()
      if (/S-1-5-21-|SandboxUsers/u.test(acl)) expect(before.stderr.toString()).toContain("UNPROTECTED PRIVATE KEY FILE")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  test("one killed icacls (code 124) is retried before refusing", () => {
    const base = defaultDeps()
    let calls = 0
    const deps = { ...base, run: (argv: readonly string[], o?: { readonly timeoutMs?: number }) => (argv.includes("/grant:r") && ++calls === 1 ? { code: 124, stdout: "", stderr: "" } : base.run(argv, o)) }
    const dir = mkdtempSync(join(tmpdir(), "abdo-ssh-retry-"))
    try {
      const file = join(dir, "id"); writeFileSync(file, generateOpenSshEd25519("retry").privateKey)
      expect(lockKeyFile(deps, base.icacls!, file)).toBeUndefined()
      expect(calls).toBe(2)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  test("a failing icacls is named, not ignored", () => {
    const deps = { ...defaultDeps(), run: () => ({ code: 5, stdout: "", stderr: "Access is denied." }) }
    const r = lockKeyFile(deps, "icacls", "C:\\nowhere\\id")
    expect(r).toContain("icacls خرج برمز 5")
    expect(r).toContain("Access is denied.")
  })
})

describe.if(win)("--key-file from a folder with open permissions", () => {
  test("the key is checked as a locked copy, imported, and its public half returned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-keyfile-"))
    const store = new Map<string, string>()
    const vault = { get: async (h: string) => store.get(h), set: async (h: string, v: string) => { if (/[\r\n]/u.test(v)) return false; store.set(h, v); return true }, forget: async (h: string) => { store.delete(h) } }
    const key = generateOpenSshEd25519("imported")
    try {
      const file = join(dir, "test_key"); writeFileSync(file, key.privateKey) // inherits %TEMP%'s ACL — ssh-keygen -y refuses it as is
      writeFileSync(join(dir, "known_hosts"), "[127.0.0.1]:2222 ssh-ed25519 AAAAoldcontainer\n") // the previous container's host key
      const r = await addServer(dir, { name: "imp", target: "root@127.0.0.1:2222", keyFile: file }, vault, defaultDeps())
      expect(readFileSync(join(dir, "known_hosts"), "utf8")).not.toContain("AAAAoldcontainer")
      expect(r.text).toContain(key.publicKey.split(" ").slice(0, 2).join(" "))
      expect(r.ok).toBe(true)
      expect(decodeKeyFromVault(store.get(keyHandleFor("imp"))!)).toBe(key.privateKey)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe("re-adding a server forgets its old host key", () => {
  test("only the lines for that host:port are dropped", () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-kh-"))
    try {
      writeFileSync(join(dir, "known_hosts"), "[127.0.0.1]:2222 ssh-ed25519 AAAAold\nexample.com ssh-ed25519 AAAAkeep\n[127.0.0.1]:2223 ssh-ed25519 AAAAkeep2\n")
      expect(forgetHostKey(dir, "127.0.0.1", 2222)).toBe(1)
      const left = readFileSync(join(dir, "known_hosts"), "utf8")
      expect(left).not.toContain("AAAAold")
      expect(left).toContain("AAAAkeep")
      expect(left).toContain("AAAAkeep2")
      expect(forgetHostKey(dir, "example.com", 22)).toBe(1)
      expect(forgetHostKey(join(dir, "missing"), "x", 22)).toBe(0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
