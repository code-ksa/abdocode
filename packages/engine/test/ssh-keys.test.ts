/**
 * 10-08 — المفتاحُ المولَّد داخل العمليّة يقرؤه ssh-keygen الحقيقيّ: `ssh-keygen -y -f` يشتقّ المفتاحَ العامّ نفسَه من الخاصّ.
 * (كان التوليدُ بـssh-keygen يعلق حتى المهلة حين تسقط `-N ""` — مقيس في بروفة النشر.)
 */
import { expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generateOpenSshEd25519, publicKeyFromOpenSsh } from "../src/servers/ssh-keys"

const keygen = process.platform === "win32" ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\OpenSSH\\ssh-keygen.exe` : "ssh-keygen"

test("the generated private key is a valid OpenSSH ed25519 key whose public half ssh-keygen derives identically", () => {
  const key = generateOpenSshEd25519("abdocode-probe")
  expect(key.privateKey.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----\n")).toBe(true)
  expect(key.publicKey).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/=]+ abdocode-probe$/u)
  const dir = mkdtempSync(join(tmpdir(), "abdo-sshkey-"))
  try {
    const file = join(dir, "id")
    writeFileSync(file, key.privateKey, { mode: 0o600 })
    if (process.platform === "win32") {
      const user = process.env.USERNAME ?? ""
      Bun.spawnSync([`${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\icacls.exe`, file, "/inheritance:r", "/grant:r", `${user}:R`], { stdout: "ignore", stderr: "ignore" })
    } else chmodSync(file, 0o600)
    const r = Bun.spawnSync([keygen, "-y", "-f", file], { stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 15_000 })
    expect(r.stderr.toString()).toBe("")
    expect(r.exitCode).toBe(0)
    expect(r.stdout.toString().trim().split(" ").slice(0, 2).join(" ")).toBe(key.publicKey.split(" ").slice(0, 2).join(" "))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("two keys are different (fresh randomness each time)", () => {
  expect(generateOpenSshEd25519("a").publicKey).not.toBe(generateOpenSshEd25519("a").publicKey)
})

// 10-08 — the public half is read from the openssh-key-v1 header, so a "Permission denied (publickey)" reply can repeat the exact line to install.
test("publicKeyFromOpenSsh: the generated key, and an RSA key made by the real ssh-keygen, give their own public lines", () => {
  const made = generateOpenSshEd25519("probe")
  expect(publicKeyFromOpenSsh(made.privateKey, "probe")).toBe(made.publicKey)
  expect(publicKeyFromOpenSsh("not a key")).toBeUndefined()
  const dir = mkdtempSync(join(tmpdir(), "abdo-rsa-"))
  try {
    const file = join(dir, "id")
    const r = Bun.spawnSync([keygen, "-t", "rsa", "-b", "2048", "-N", "", "-C", "c", "-f", file, "-q"], { stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 30_000 })
    expect(r.exitCode).toBe(0)
    const pub = require("node:fs").readFileSync(`${file}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ")
    expect(publicKeyFromOpenSsh(require("node:fs").readFileSync(file, "utf8"))).toBe(pub)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
