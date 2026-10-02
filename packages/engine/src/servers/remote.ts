/**
 * Servers and deployment for the agent. A server profile holds no secret (name, user, host, port, deploy path); its SSH key
 * lives in the vault under `custom-server-<name>-key` and is written to a private temporary file only for the length of one
 * ssh/scp call. Host keys are pinned on first contact in AbdoCode's own known_hosts (accept-new), never the user's.
 *
 * deploy = pack the project (no node_modules, .git, build output or .env files) → upload → extract into releases/<stamp> →
 * point `current` at it → optional build and start commands inside `current` → optional URL check. The previous release is
 * kept, so `rollback` points `current` back. Five releases are kept; older ones are removed (said in the receipt).
 *
 * Process creation for this feature lives here (the composition gate keeps it out of cli.ts); the binaries are injectable
 * so the whole flow is testable without a real server.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface ServerProfile {
  readonly name: string
  readonly user: string
  readonly host: string
  readonly port: number
  readonly path: string
  readonly keyHandle: string
  readonly addedAt: string
}

export interface RunResult { readonly code: number; readonly stdout: string; readonly stderr: string }

export interface RemoteDeps {
  readonly ssh: string
  readonly scp: string
  readonly keygen: string
  readonly tar: string
  /** Windows only: restrict the temporary key file to the current user (OpenSSH refuses a key others can read). */
  readonly icacls?: string
  readonly run: (argv: readonly string[], options?: { readonly cwd?: string; readonly timeoutMs?: number }) => RunResult
  readonly now?: () => Date
}

export interface VaultAccess {
  readonly get: (handle: string) => Promise<string | undefined>
  readonly set: (handle: string, value: string) => Promise<boolean>
  readonly forget: (handle: string) => Promise<void>
}

const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/u
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u
const USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/u
const UNIX_PATH = /^\/[A-Za-z0-9._/-]{0,200}$/u

export const keyHandleFor = (name: string): string => `custom-server-${name}-key`

/** `user@host[:port]` ⇒ parts, or a named reason. */
export function parseTarget(target: string): { readonly user: string; readonly host: string; readonly port: number } | { readonly error: string } {
  const m = /^([^@\s]+)@([^:\s]+)(?::(\d{1,5}))?$/u.exec(target.trim())
  if (m === null) return { error: "الصيغة: user@host أو user@host:port" }
  const [, user, host, port] = m
  if (!USER.test(user!)) return { error: `اسمُ مستخدمٍ غيرُ صالح: ${user}` }
  if (!HOST.test(host!)) return { error: `عنوانُ خادمٍ غيرُ صالح: ${host}` }
  const p = port === undefined ? 22 : Number(port)
  if (!Number.isInteger(p) || p < 1 || p > 65535) return { error: `منفذٌ غيرُ صالح: ${port}` }
  return { user: user!, host: host!, port: p }
}

/** POSIX single-quote escaping for the remote shell. */
export const shq = (s: string): string => `'${s.replace(/'/gu, `'\\''`)}'`

const profilesFile = (stateRoot: string): string => join(stateRoot, "servers.json")

export function listProfiles(stateRoot: string): ServerProfile[] {
  try {
    const parsed = JSON.parse(readFileSync(profilesFile(stateRoot), "utf8")) as { servers?: ServerProfile[] }
    return Array.isArray(parsed.servers) ? parsed.servers.filter((s) => NAME.test(s.name)) : []
  } catch { return [] }
}

function saveProfiles(stateRoot: string, servers: readonly ServerProfile[]): void {
  mkdirSync(stateRoot, { recursive: true })
  writeFileSync(profilesFile(stateRoot), JSON.stringify({ servers }, null, 2))
}

export function findProfile(stateRoot: string, name: string): ServerProfile | undefined {
  return listProfiles(stateRoot).find((s) => s.name === name)
}

export function renderProfiles(servers: readonly ServerProfile[]): string {
  if (servers.length === 0) return "لا خوادمَ محفوظة. أضف واحداً: server add <اسم> user@host[:port] [--path /var/www/app]"
  return `الخوادم (${servers.length}):\n${servers.map((s) => `• ${s.name}: ${s.user}@${s.host}:${s.port} → ${s.path} (المفتاح في الخزنة: ${s.keyHandle})`).join("\n")}`
}

/** The private key from the vault, written to a temporary file readable only by this user, for the length of `fn`. */
async function withKey<T>(profile: ServerProfile, vault: VaultAccess, deps: RemoteDeps, fn: (keyPath: string) => Promise<T> | T): Promise<T | { readonly error: string }> {
  const key = await vault.get(profile.keyHandle)
  if (key === undefined) return { error: `مفتاحُ «${profile.name}» غائبٌ عن الخزنة (${profile.keyHandle}) — أعد server add أو server key ${profile.name} --key-file <ملفّ>` }
  const dir = mkdtempSync(join(tmpdir(), "abdo-ssh-"))
  const keyPath = join(dir, "id")
  try {
    writeFileSync(keyPath, key.endsWith("\n") ? key : `${key}\n`, { mode: 0o600 })
    if (deps.icacls !== undefined) {
      const user = process.env.USERNAME ?? ""
      if (user.length > 0) deps.run([deps.icacls, keyPath, "/inheritance:r", "/grant:r", `${user}:R`])
    }
    return await fn(keyPath)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function sshOptions(profile: ServerProfile, keyPath: string, stateRoot: string, portFlag: "-p" | "-P"): string[] {
  return [
    "-i", keyPath, portFlag, String(profile.port),
    "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=15",
    "-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile="${join(stateRoot, "known_hosts")}"`,
  ]
}

const clip = (s: string, n = 4000): string => (s.length > n ? `${s.slice(0, n)}\n…[قُصّ: ${s.length - n} حرفاً]` : s)

function remote(profile: ServerProfile, keyPath: string, stateRoot: string, deps: RemoteDeps, command: string, timeoutMs = 120_000): RunResult {
  return deps.run([deps.ssh, ...sshOptions(profile, keyPath, stateRoot, "-p"), `${profile.user}@${profile.host}`, command], { timeoutMs })
}

const stamp = (d: Date): string => d.toISOString().replace(/[-:]/gu, "").replace("T", "-").slice(0, 15)

export interface AddInput { readonly name: string; readonly target: string; readonly path?: string; readonly keyFile?: string }

/** Saves the profile and its key: imports `--key-file`, or generates an ed25519 pair and returns the public key to install. */
export async function addServer(stateRoot: string, input: AddInput, vault: VaultAccess, deps: RemoteDeps): Promise<{ readonly ok: boolean; readonly text: string }> {
  if (!NAME.test(input.name)) return { ok: false, text: `اسمٌ غيرُ صالح «${input.name}» — حروفٌ لاتينيّة صغيرة وأرقام وشرطة` }
  const target = parseTarget(input.target)
  if ("error" in target) return { ok: false, text: target.error }
  const path = input.path ?? `/home/${target.user}/apps/${input.name}`
  if (!UNIX_PATH.test(path)) return { ok: false, text: `مسارُ النشر يجب أن يكون مطلقاً على الخادم: ${path}` }
  const handle = keyHandleFor(input.name)
  let publicKey: string
  if (input.keyFile !== undefined) {
    if (!existsSync(input.keyFile)) return { ok: false, text: `ملفُّ المفتاح غيرُ موجود: ${input.keyFile}` }
    const derived = deps.run([deps.keygen, "-y", "-f", input.keyFile])
    if (derived.code !== 0) return { ok: false, text: `ليس مفتاحاً خاصّاً يقبله ssh-keygen (أو محميٌّ بعبارة مرور): ${clip(derived.stderr, 300)}` }
    if (!(await vault.set(handle, readFileSync(input.keyFile, "utf8")))) return { ok: false, text: "الخزنة رفضت حفظ المفتاح" }
    publicKey = derived.stdout.trim()
  } else {
    const dir = mkdtempSync(join(tmpdir(), "abdo-keygen-"))
    try {
      const made = deps.run([deps.keygen, "-t", "ed25519", "-N", "", "-C", `abdocode-${input.name}`, "-f", join(dir, "id"), "-q"])
      if (made.code !== 0) return { ok: false, text: `تعذّر توليدُ المفتاح: ${clip(made.stderr, 300)}` }
      if (!(await vault.set(handle, readFileSync(join(dir, "id"), "utf8")))) return { ok: false, text: "الخزنة رفضت حفظ المفتاح" }
      publicKey = readFileSync(join(dir, "id.pub"), "utf8").trim()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
  const profile: ServerProfile = { name: input.name, user: target.user, host: target.host, port: target.port, path, keyHandle: handle, addedAt: (deps.now?.() ?? new Date()).toISOString() }
  saveProfiles(stateRoot, [...listProfiles(stateRoot).filter((s) => s.name !== input.name), profile])
  return {
    ok: true,
    text: `حُفظ الخادم «${input.name}»: ${target.user}@${target.host}:${target.port} → ${path}. المفتاحُ الخاصّ في الخزنة (${handle}) لا في الإعدادات.\n` +
      (input.keyFile !== undefined ? "استُورد مفتاحُك؛ إن كان مضافاً على الخادم فجرّب: server test " + input.name
        : `أضف هذا المفتاحَ العامّ مرّةً واحدة إلى ~/.ssh/authorized_keys على الخادم (أو من لوحة الاستضافة ← SSH keys)، ثمّ: server test ${input.name}\n${publicKey}`),
  }
}

export async function removeServer(stateRoot: string, name: string, vault: VaultAccess): Promise<string> {
  const p = findProfile(stateRoot, name)
  if (p === undefined) return `لا خادمَ باسم «${name}»`
  await vault.forget(p.keyHandle)
  saveProfiles(stateRoot, listProfiles(stateRoot).filter((s) => s.name !== name))
  return `أُزيل «${name}» ومفتاحُه من الخزنة (الخادمُ نفسُه لم يُمسّ).`
}

export async function testServer(stateRoot: string, profile: ServerProfile, vault: VaultAccess, deps: RemoteDeps): Promise<{ readonly ok: boolean; readonly text: string }> {
  const r = await withKey(profile, vault, deps, (key) => remote(profile, key, stateRoot, deps,
    `echo "system: $(uname -sm)"; echo "user: $(whoami)"; echo "node: $(command -v node >/dev/null && node -v || echo none)"; echo "pm2: $(command -v pm2 >/dev/null && echo yes || echo no)"; echo "docker: $(command -v docker >/dev/null && echo yes || echo no)"; mkdir -p ${shq(profile.path)} && echo "deploy path: ${profile.path} (writable)"; df -h ${shq(profile.path)} | tail -1`, 30_000))
  if ("error" in r) return { ok: false, text: r.error }
  if (r.code !== 0) return { ok: false, text: `تعذّر الاتّصال بـ«${profile.name}» (${profile.user}@${profile.host}:${profile.port}): ${clip(r.stderr || r.stdout, 600)}${/Permission denied/u.test(r.stderr) ? "\nالمفتاحُ العامّ غيرُ مضافٍ على الخادم بعد — أضفه إلى ~/.ssh/authorized_keys ثمّ أعد server test." : ""}` }
  return { ok: true, text: `متّصلٌ بـ«${profile.name}»:\n${clip(r.stdout.trim(), 1500)}` }
}

export async function runOnServer(stateRoot: string, profile: ServerProfile, command: string, vault: VaultAccess, deps: RemoteDeps): Promise<{ readonly ok: boolean; readonly text: string }> {
  const r = await withKey(profile, vault, deps, (key) => remote(profile, key, stateRoot, deps, command, 300_000))
  if ("error" in r) return { ok: false, text: r.error }
  const body = `${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`.trim()
  return { ok: r.code === 0, text: `«${profile.name}» $ ${command}\n${clip(body)}\n(الخروج ${r.code})` }
}

/** What leaves the machine: never dependencies, VCS, build output, logs or env files. */
export const DEPLOY_EXCLUDES: readonly string[] = ["node_modules", ".git", ".next", "dist", "build", "out", ".turbo", ".cache", "coverage", ".env", ".env.*", "*.log", ".abdo*"]

export interface DeployOptions { readonly build?: string; readonly start?: string; readonly check?: string }
export interface DeployStep { readonly step: string; readonly ok: boolean; readonly detail: string }

export async function deploy(stateRoot: string, projectDir: string, profile: ServerProfile, options: DeployOptions, vault: VaultAccess, deps: RemoteDeps, checkUrl?: (url: string) => Promise<number>): Promise<{ readonly ok: boolean; readonly steps: readonly DeployStep[]; readonly release?: string }> {
  const steps: DeployStep[] = []
  const release = stamp(deps.now?.() ?? new Date())
  const work = mkdtempSync(join(tmpdir(), "abdo-deploy-"))
  const archive = join(work, `${release}.tgz`)
  try {
    const packed = deps.run([deps.tar, "-czf", archive, ...DEPLOY_EXCLUDES.flatMap((e) => ["--exclude", e]), "-C", projectDir, "."], { timeoutMs: 300_000 })
    steps.push({ step: "pack", ok: packed.code === 0, detail: packed.code === 0 ? `حُزم المشروع بلا: ${DEPLOY_EXCLUDES.join(" ")}` : clip(packed.stderr, 600) })
    if (packed.code !== 0) return { ok: false, steps }
    const out = await withKey(profile, vault, deps, async (key) => {
      const base = profile.path, rel = `${base}/releases/${release}`
      const prep = remote(profile, key, stateRoot, deps, `set -e; mkdir -p ${shq(`${base}/releases`)}`)
      steps.push({ step: "prepare", ok: prep.code === 0, detail: prep.code === 0 ? `${base}/releases` : clip(prep.stderr, 600) })
      if (prep.code !== 0) return false
      const up = deps.run([deps.scp, ...sshOptions(profile, key, stateRoot, "-P"), archive, `${profile.user}@${profile.host}:${base}/releases/${release}.tgz`], { timeoutMs: 600_000 })
      steps.push({ step: "upload", ok: up.code === 0, detail: up.code === 0 ? `${release}.tgz` : clip(up.stderr, 600) })
      if (up.code !== 0) return false
      const ex = remote(profile, key, stateRoot, deps, `set -e; mkdir -p ${shq(rel)}; tar -xzf ${shq(`${rel}.tgz`)} -C ${shq(rel)}; rm -f ${shq(`${rel}.tgz`)}; ln -sfn ${shq(rel)} ${shq(`${base}/current`)}; cd ${shq(`${base}/releases`)}; ls -1 | grep -v '\\.tgz$' | sort -r | tail -n +6 | while read old; do rm -rf -- "$old"; echo "removed old release $old"; done`)
      steps.push({ step: "release", ok: ex.code === 0, detail: ex.code === 0 ? `current ⇦ releases/${release}${ex.stdout.trim() ? `\n${ex.stdout.trim()}` : ""}` : clip(ex.stderr, 600) })
      if (ex.code !== 0) return false
      for (const [name, command] of [["build", options.build], ["start", options.start]] as const) {
        if (command === undefined || command.trim() === "") continue
        const r = remote(profile, key, stateRoot, deps, `cd ${shq(`${base}/current`)} && ${command}`, 900_000)
        steps.push({ step: name, ok: r.code === 0, detail: `$ ${command}\n${clip(`${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.trim(), 2500)}` })
        if (r.code !== 0) return false
      }
      return true
    })
    if (typeof out === "object") { steps.push({ step: "key", ok: false, detail: out.error }); return { ok: false, steps } }
    if (!out) return { ok: false, steps, release }
    if (options.check !== undefined && checkUrl !== undefined) {
      let status = 0
      try { status = await checkUrl(options.check) } catch { status = 0 }
      steps.push({ step: "check", ok: status >= 200 && status < 400, detail: `${options.check} → ${status || "لا ردّ"}` })
      if (!(status >= 200 && status < 400)) return { ok: false, steps, release }
    }
    return { ok: true, steps, release }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

export async function rollback(stateRoot: string, profile: ServerProfile, start: string | undefined, vault: VaultAccess, deps: RemoteDeps): Promise<{ readonly ok: boolean; readonly text: string }> {
  const base = profile.path
  const r = await withKey(profile, vault, deps, (key) => {
    const back = remote(profile, key, stateRoot, deps, `set -e; cd ${shq(`${base}/releases`)}; prev=$(ls -1 | grep -v '\\.tgz$' | sort -r | sed -n 2p); test -n "$prev" || { echo "no previous release" >&2; exit 3; }; ln -sfn ${shq(`${base}/releases`)}/"$prev" ${shq(`${base}/current`)}; echo "$prev"`)
    if (back.code !== 0 || start === undefined) return back
    const s = remote(profile, key, stateRoot, deps, `cd ${shq(`${base}/current`)} && ${start}`, 300_000)
    return { code: s.code, stdout: `${back.stdout}${s.stdout}`, stderr: s.stderr }
  })
  if ("error" in r) return { ok: false, text: r.error }
  return r.code === 0 ? { ok: true, text: `«${profile.name}»: current ⇦ releases/${r.stdout.trim().split("\n")[0]}${start ? ` ثمّ $ ${start}` : ""}` } : { ok: false, text: `تعذّر الرجوع: ${clip(r.stderr || r.stdout, 600)}` }
}

export const renderDeploy = (profile: ServerProfile, result: { readonly ok: boolean; readonly steps: readonly DeployStep[]; readonly release?: string }): string =>
  `${result.ok ? "✓ نُشر" : "✕ لم يكتمل النشر"} إلى «${profile.name}» (${profile.user}@${profile.host}:${profile.path})${result.release ? ` — الإصدار ${result.release}` : ""}\n` +
  result.steps.map((s) => `${s.ok ? "✓" : "✕"} ${s.step}: ${s.detail}`).join("\n") +
  (result.ok ? `\nللرجوع: deploy ${profile.name} --rollback` : "")

/** Default binaries: Windows OpenSSH and bsdtar from System32; elsewhere the PATH names. `ABDO_SSH_BIN_DIR` overrides (tests). */
export function defaultDeps(): RemoteDeps {
  const override = process.env.ABDO_SSH_BIN_DIR
  const sys = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32`
  const win = process.platform === "win32"
  const bin = (name: string, winPath: string): string => override !== undefined ? join(override, win ? `${name}.cmd` : name) : win ? winPath : name
  return {
    ssh: bin("ssh", `${sys}\\OpenSSH\\ssh.exe`),
    scp: bin("scp", `${sys}\\OpenSSH\\scp.exe`),
    keygen: bin("ssh-keygen", `${sys}\\OpenSSH\\ssh-keygen.exe`),
    tar: bin("tar", `${sys}\\tar.exe`),
    ...(win && override === undefined ? { icacls: `${sys}\\icacls.exe` } : {}),
    run: (argv, options) => {
      const p = Bun.spawnSync([...argv], { cwd: options?.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: options?.timeoutMs ?? 120_000 })
      return { code: p.exitCode ?? (p.signalCode ? 124 : 1), stdout: p.stdout.toString(), stderr: p.stderr.toString() }
    },
  }
}
