/**
 * 10-08 — أسرارُ المشروع من الخزنة إلى النشر بلا أن تظهر قيمة: import يحفظ القيمَ في الخزنة والأسماءَ وحدها على القرص؛
 * وdeploy --env يكتب .env الإصدار عبر stdin لا في سطر أوامر. يُسأل القرصُ والأوامرُ المسجَّلة، لا الدالّة وحدها.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { envFromVault, importSecrets, listSecrets, parseDotenv, projectSlug, secretHandle, SECRETS_FILE } from "../src/project-secrets"
import { deploy, type RemoteDeps, type ServerProfile, type VaultAccess } from "../src/servers/remote"

const SECRET_A = "sk-live-0123456789abcdefSECRET"
const SECRET_B = "postgres://u:p@db:5432/app"

function project() {
  const dir = mkdtempSync(join(tmpdir(), "abdo-psecrets-"))
  writeFileSync(join(dir, ".env"), `# keys\nOPENAI_API_KEY=${SECRET_A}\nexport DATABASE_URL="${SECRET_B}"\nEMPTY=\nbad key=1\n`)
  writeFileSync(join(dir, ".gitignore"), "node_modules\n.env*\n")
  return dir
}
function vaultMap() {
  const store = new Map<string, string>()
  return { store, vault: { get: async (h: string) => store.get(h), set: async (h: string, v: string) => { store.set(h, v); return true } } }
}

describe("project secrets", () => {
  test("dotenv parsing: comments, export, quotes; empty and malformed keys are named, not guessed", () => {
    const p = parseDotenv(`# c\nA=1\nexport B="two words"\nC='x'\nD=v # note\nE=\nbad key=1\n`)
    expect(p.entries).toEqual([{ key: "A", value: "1" }, { key: "B", value: "two words" }, { key: "C", value: "x" }, { key: "D", value: "v" }])
    expect(p.skipped).toEqual(["E", "bad key"])
  })

  test("import stores values in the vault only; the receipt and the manifest carry names, never values", async () => {
    const dir = project()
    try {
      const { store, vault } = vaultMap()
      const r = await importSecrets(dir, ".env", vault)
      expect(r.ok).toBe(true)
      expect(r.text).toContain("OPENAI_API_KEY")
      expect(r.text).not.toContain(SECRET_A)
      expect(r.text).not.toContain("u:p@db")
      const manifest = readFileSync(join(dir, SECRETS_FILE), "utf8")
      expect(JSON.parse(manifest).keys).toEqual(["DATABASE_URL", "OPENAI_API_KEY"])
      expect(manifest).not.toContain(SECRET_A)
      const slug = projectSlug(dir)
      expect(store.get(secretHandle(slug, "OPENAI_API_KEY"))).toBe(SECRET_A)
      expect(store.get(secretHandle(slug, "DATABASE_URL"))).toBe(SECRET_B)
      // الملفُّ المصدر لا يُمسّ — حذفُه قرارُ المستخدم.
      expect(readFileSync(join(dir, ".env"), "utf8")).toContain(SECRET_A)
      expect(await listSecrets(dir, async (h) => store.has(h))).toContain("✓ OPENAI_API_KEY")
      expect(await listSecrets(dir, async (h) => store.has(h))).not.toContain(SECRET_A)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test("a file outside the project is refused; two projects with one folder name do not share handles", async () => {
    const dir = project()
    try {
      const { vault } = vaultMap()
      expect((await importSecrets(dir, "../elsewhere/.env", vault)).text).toContain("خارجَ المشروع")
      expect(projectSlug(join(dir, "a", "app"))).not.toBe(projectSlug(join(dir, "b", "app")))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test("deploy --env writes .env into the release through stdin with umask 077; the value never appears in argv or in the receipt", async () => {
    const dir = project()
    try {
      const { vault } = vaultMap()
      await importSecrets(dir, ".env", vault)
      const env = await envFromVault(dir, vault)
      if ("error" in env) throw Error(env.error)
      expect(env.missing).toEqual([])
      const calls: { argv: string[]; input?: string }[] = []
      const deps: RemoteDeps = {
        ssh: "ssh", scp: "scp", keygen: "ssh-keygen", tar: "tar", now: () => new Date("2026-10-08T12:00:00Z"),
        run: (argv, options) => {
          calls.push({ argv: [...argv], ...(options?.input === undefined ? {} : { input: options.input }) })
          if (argv[0] === "tar") writeFileSync(argv[argv.indexOf("-czf") + 1]!, "archive")
          return { code: 0, stdout: "", stderr: "" }
        },
      }
      const profile: ServerProfile = { name: "test", user: "root", host: "127.0.0.1", port: 2222, path: "/srv/app", keyHandle: "custom-server-test-key", addedAt: "" }
      const keyVault: VaultAccess = { get: async () => "-----BEGIN OPENSSH PRIVATE KEY-----\nk\n-----END OPENSSH PRIVATE KEY-----\n", set: async () => true, forget: async () => {} }
      const result = await deploy(join(dir, ".state"), dir, profile, { env: env.text, envKeys: env.keys, start: "npm start" }, keyVault, deps)
      expect(result.ok).toBe(true)
      const write = calls.find((c) => c.input !== undefined)!
      expect(write.argv[write.argv.length - 1]).toBe("umask 077; cat > '/srv/app/releases/20261008-120000/.env'")
      expect(write.input).toContain(`OPENAI_API_KEY=${JSON.stringify(SECRET_A)}`)
      expect(calls.every((c) => !c.argv.join(" ").includes(SECRET_A))).toBe(true)
      const envStep = result.steps.find((s) => s.step === "env")!
      expect(envStep.detail).toContain("OPENAI_API_KEY")
      expect(envStep.detail).not.toContain(SECRET_A)
      // الترتيب: .env قبل البناء والتشغيل.
      // 10-08: env والبناءُ داخل الإصدار قبل قلب current.
      expect(result.steps.map((s) => s.step)).toEqual(["pack", "prepare", "upload", "unpack", "env", "release", "start"])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test("the twin: without --env no .env is written and nothing travels on stdin", async () => {
    const dir = project()
    try {
      const calls: { input?: string }[] = []
      const deps: RemoteDeps = { ssh: "ssh", scp: "scp", keygen: "ssh-keygen", tar: "tar", run: (argv, options) => { calls.push({ ...(options?.input === undefined ? {} : { input: options.input }) }); if (argv[0] === "tar") writeFileSync(argv[argv.indexOf("-czf") + 1]!, "a"); return { code: 0, stdout: "", stderr: "" } } }
      const profile: ServerProfile = { name: "test", user: "root", host: "127.0.0.1", port: 2222, path: "/srv/app", keyHandle: "k", addedAt: "" }
      const result = await deploy(join(dir, ".state"), dir, profile, {}, { get: async () => "key", set: async () => true, forget: async () => {} }, deps)
      expect(result.steps.some((s) => s.step === "env")).toBe(false)
      expect(calls.every((c) => c.input === undefined)).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
