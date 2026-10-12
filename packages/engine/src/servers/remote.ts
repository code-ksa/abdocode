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
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"

import { generateOpenSshEd25519, publicKeyFromOpenSsh } from "./ssh-keys"

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
  readonly run: (argv: readonly string[], options?: { readonly cwd?: string; readonly timeoutMs?: number; readonly input?: string }) => RunResult
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

/**
 * 10-08 (مقيس في بروفة النشر): الخزنةُ تحفظ سطراً واحداً (vaultSet يرفض \r\n) والمفتاحُ الخاصّ أسطر — فكان `server add` يعود
 * «الخزنة رفضت حفظ المفتاح» في كلّ مرّة؛ والاختبارُ لم يره لأنّ خزنته الوهميّة تقبل أيَّ شيء. المفتاحُ يُحفظ base64 ببادئةٍ ويُفكّ عند الاستعمال.
 */
const KEY_B64 = "openssh-b64:"
export const encodeKeyForVault = (pem: string): string => `${KEY_B64}${Buffer.from(pem, "utf8").toString("base64")}`
export const decodeKeyFromVault = (stored: string): string => (stored.startsWith(KEY_B64) ? Buffer.from(stored.slice(KEY_B64.length), "base64").toString("utf8") : stored)

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

/** Adds or replaces one profile by name (used by `server sandbox`). */
export function saveProfile(stateRoot: string, profile: ServerProfile): void {
  saveProfiles(stateRoot, [...listProfiles(stateRoot).filter((s) => s.name !== profile.name), profile])
}

export const isServerName = (name: string): boolean => NAME.test(name)

export function findProfile(stateRoot: string, name: string): ServerProfile | undefined {
  return listProfiles(stateRoot).find((s) => s.name === name)
}

export function renderProfiles(servers: readonly ServerProfile[]): string {
  if (servers.length === 0) return "لا خوادمَ محفوظة. أضف واحداً: server add <اسم> user@host[:port] [--path /var/www/app]"
  return `الخوادم (${servers.length}):\n${servers.map((s) => `• ${s.name}: ${s.user}@${s.host}:${s.port} → ${s.path} (المفتاح في الخزنة: ${s.keyHandle})`).join("\n")}`
}

/** The private key from the vault, written to a temporary file readable only by this user, for the length of `fn`. */
async function withKey<T>(profile: ServerProfile, vault: VaultAccess, deps: RemoteDeps, fn: (keyPath: string) => Promise<T> | T): Promise<T | { readonly error: string }> {
  const stored = await vault.get(profile.keyHandle)
  const key = stored === undefined ? undefined : decodeKeyFromVault(stored)
  if (key === undefined) return { error: `مفتاحُ «${profile.name}» غائبٌ عن الخزنة (${profile.keyHandle}) — أعد server add أو server key ${profile.name} --key-file <ملفّ>` }
  const dir = mkdtempSync(join(tmpdir(), "abdo-ssh-"))
  const keyPath = join(dir, "id")
  try {
    writeFileSync(keyPath, key.endsWith("\n") ? key : `${key}\n`, { mode: 0o600 })
    if (deps.icacls !== undefined) {
      const locked = lockKeyFile(deps, deps.icacls, keyPath)
      if (locked !== undefined) return { error: locked }
    }
    return await fn(keyPath)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const currentUser = (): string => { const env = process.env.USERNAME ?? ""; if (env.length > 0) return env; try { return userInfo().username } catch { return "" } }

/** Principals icacls lists on the key file other than this user (SYSTEM and Administrators are accepted by Windows OpenSSH). */
const foreignPrincipals = (listing: string, user: string): string[] =>
  listing.split(/\r?\n/u).map((line) => /(\S[^:]*?):\([^)]*\)/u.exec(line.replace(/^.*?\\id\s+/u, ""))?.[1]?.trim()).filter((p): p is string => p !== undefined && p.length > 0)
    .filter((p) => !/^(?:NT AUTHORITY\\SYSTEM|BUILTIN\\Administrators)$/iu.test(p) && p.split("\\").pop()!.toLowerCase() !== user.toLowerCase())

/**
 * 10-08 (مقيس في بروفة النشر): `server test` ردّ «Bad permissions … UNKNOWN\\UNKNOWN (S-1-5-21-…)» — ملفُّ المفتاح المؤقّت ورث ACEًا لا يقبلها
 * OpenSSH، ونداءُ icacls كان يُتجاهل رمزُه (ويُتخطّى بصمتٍ إن غاب USERNAME). الآن: المستخدمُ من userInfo عند غياب المتغيّر، والرمزُ يُفحص،
 * وما بقي من مبادئ غريبة يُزال بالاسم أو المعرّف، والقائمةُ تُقرأ بعد ذلك — وإلّا رُفض بالقائمة نفسها بدل خطأ ssh غامض. `undefined` = مقفول.
 */
export function lockKeyFile(deps: RemoteDeps, icacls: string, keyPath: string): string | undefined {
  const user = currentUser()
  if (user.length === 0) return "تعذّر معرفةُ مستخدم ويندوز الحاليّ (USERNAME غائب) — لا يُقفل ملفُّ المفتاح فلن يقبله ssh"
  // 10-08 (مقيس في بروفة النشر): icacls خرج مرّةً برمز 124 (قُتل بإشارة) ونجح في النداء التالي — مرّةٌ ثانيةٌ قبل الرفض.
  let set = deps.run([icacls, keyPath, "/inheritance:r", "/grant:r", `${user}:F`])
  if (set.code !== 0) { Bun.sleepSync(300); set = deps.run([icacls, keyPath, "/inheritance:r", "/grant:r", `${user}:F`]) }
  if (set.code !== 0) return `تعذّر قفلُ ملفّ المفتاح المؤقّت (icacls خرج برمز ${set.code}): ${clip((set.stderr || set.stdout).trim(), 300)}`
  let foreign = foreignPrincipals(deps.run([icacls, keyPath]).stdout, user)
  for (const principal of foreign) deps.run([icacls, keyPath, "/remove:g", principal.startsWith("S-1-") ? `*${principal}` : principal])
  if (foreign.length > 0) foreign = foreignPrincipals(deps.run([icacls, keyPath]).stdout, user)
  return foreign.length === 0 ? undefined : `ملفُّ المفتاح المؤقّت ما زال يمنح غيرَك صلاحيّةً (${foreign.join("، ")}) فيرفضه ssh — قفلُه فشل`
}

function sshOptions(profile: ServerProfile, keyPath: string, stateRoot: string, portFlag: "-p" | "-P"): string[] {
  return [
    "-i", keyPath, portFlag, String(profile.port),
    "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=15",
    "-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile="${join(stateRoot, "known_hosts")}"`,
  ]
}

const clip = (s: string, n = 4000): string => (s.length > n ? `${s.slice(0, n)}\n…[قُصّ: ${s.length - n} حرفاً]` : s)

function remote(profile: ServerProfile, keyPath: string, stateRoot: string, deps: RemoteDeps, command: string, timeoutMs = 120_000, input?: string): RunResult {
  return deps.run([deps.ssh, ...sshOptions(profile, keyPath, stateRoot, "-p"), `${profile.user}@${profile.host}`, command], { timeoutMs, ...(input === undefined ? {} : { input }) })
}

const stamp = (d: Date): string => d.toISOString().replace(/[-:]/gu, "").replace("T", "-").slice(0, 15)

export interface AddInput { readonly name: string; readonly target: string; readonly path?: string; readonly keyFile?: string }

/**
 * 10-08 (مقيس في بروفة النشر): خادمٌ تجريبيّ أُعيد بناؤه على المنفذ نفسِه له مفتاحُ مضيفٍ جديد، وما ثُبّت في known_hosts للقديم
 * يجعل ssh يرفض «REMOTE HOST IDENTIFICATION HAS CHANGED». تسجيلُ خادمٍ ثقةٌ جديدة: سطورُ هذا المضيف تُزال فيُثبَّت مفتاحُه عند أوّل اتّصال.
 */
export function forgetHostKey(stateRoot: string, host: string, port: number): number {
  const file = join(stateRoot, "known_hosts")
  if (!existsSync(file)) return 0
  const name = port === 22 ? host : `[${host}]:${port}`
  const lines = readFileSync(file, "utf8").split(/\r?\n/u)
  const kept = lines.filter((line) => !line.split(/\s+/u, 1)[0]!.split(",").includes(name))
  if (kept.length !== lines.length) writeFileSync(file, kept.join("\n"))
  return lines.length - kept.length
}

/** Saves the profile and its key: imports `--key-file`, or generates an ed25519 pair and returns the public key to install. */
export async function addServer(stateRoot: string, input: AddInput, vault: VaultAccess, deps: RemoteDeps): Promise<{ readonly ok: boolean; readonly text: string }> {
  if (!NAME.test(input.name)) return { ok: false, text: `اسمٌ غيرُ صالح «${input.name}» — حروفٌ لاتينيّة صغيرة وأرقام وشرطة` }
  const target = parseTarget(input.target)
  if ("error" in target) return { ok: false, text: target.error }
  // 10-08 (مقيس في بروفة النشر): root بيتُه /root لا /home/root.
  const path = input.path ?? `${target.user === "root" ? "/root" : `/home/${target.user}`}/apps/${input.name}`
  if (!UNIX_PATH.test(path)) return { ok: false, text: `مسارُ النشر يجب أن يكون مطلقاً على الخادم: ${path}` }
  const handle = keyHandleFor(input.name)
  // 10-08 (مقيس على abdo-router): إعادةُ «server add» للخادم نفسِه لتغيير المسار وحده ولّدت مفتاحاً جديداً فوق المفتاح العامل —
  // فانقطع الاتّصال («Permission denied (publickey)») وصار تثبيتُه من جديد لازماً. الهدفُ نفسُه (مستخدمٌ ومضيفٌ ومنفذ) ومفتاحُه في الخزنة
  // ⇦ يُحدَّث المسارُ ويبقى المفتاح. هدفٌ مختلف أو --key-file ⇦ مفتاحٌ جديد كما كان.
  const existing = input.keyFile === undefined ? findProfile(stateRoot, input.name) : undefined
  if (existing !== undefined && existing.user === target.user && existing.host === target.host && existing.port === target.port && (await vault.get(existing.keyHandle)) !== undefined) {
    saveProfiles(stateRoot, [...listProfiles(stateRoot).filter((s) => s.name !== input.name), { ...existing, path }])
    return { ok: true, text: `حُدّث «${input.name}»: ${target.user}@${target.host}:${target.port} → ${path}. المفتاحُ القائم في الخزنة (${existing.keyHandle}) أُبقي — المضافُ على الخادم ما زال صالحاً: server test ${input.name}. (لمفتاحٍ جديد: server remove ${input.name} ثمّ server add.)` }
  }
  let publicKey: string
  if (input.keyFile !== undefined) {
    if (!existsSync(input.keyFile)) return { ok: false, text: `ملفُّ المفتاح غيرُ موجود: ${input.keyFile}` }
    const body = readFileSync(input.keyFile, "utf8")
    // 10-08 (مقيس في بروفة النشر): ssh-keygen -y يرفض ملفّاً صلاحيّاتُه مفتوحة (ورث %TEMP% أو المشروع) فعاد الرفضُ فارغاً —
    // يُفحص نسخةً مقفولةً مؤقّتة، والخرجان كلاهما يُسمّيان السبب.
    const dir = mkdtempSync(join(tmpdir(), "abdo-keyimport-"))
    let derived: RunResult
    try {
      const copy = join(dir, "id")
      writeFileSync(copy, body.endsWith("\n") ? body : `${body}\n`, { mode: 0o600 })
      const locked = deps.icacls === undefined ? undefined : lockKeyFile(deps, deps.icacls, copy)
      if (locked !== undefined) return { ok: false, text: locked }
      derived = deps.run([deps.keygen, "-y", "-f", copy])
    } finally { rmSync(dir, { recursive: true, force: true }) }
    if (derived.code !== 0) return { ok: false, text: `ليس مفتاحاً خاصّاً يقبله ssh-keygen (أو محميٌّ بعبارة مرور): ${clip((derived.stderr.trim() || derived.stdout.trim() || `رمز ${derived.code} بلا خرج`), 300)}` }
    if (!(await vault.set(handle, encodeKeyForVault(body)))) return { ok: false, text: "الخزنة رفضت حفظ المفتاح" }
    publicKey = derived.stdout.trim()
  } else {
    // 10-08: المفتاحُ يُولَّد داخل العمليّة بصيغة OpenSSH (ssh-keys.ts) — ssh-keygen كان يعلق حتى المهلة حين تسقط `-N ""`.
    const made = generateOpenSshEd25519(`abdocode-${input.name}`)
    if (!(await vault.set(handle, encodeKeyForVault(made.privateKey)))) return { ok: false, text: "الخزنة رفضت حفظ المفتاح" }
    publicKey = made.publicKey
  }
  const profile: ServerProfile = { name: input.name, user: target.user, host: target.host, port: target.port, path, keyHandle: handle, addedAt: (deps.now?.() ?? new Date()).toISOString() }
  forgetHostKey(stateRoot, target.host, target.port)
  saveProfiles(stateRoot, [...listProfiles(stateRoot).filter((s) => s.name !== input.name), profile])
  return {
    ok: true,
    text: `حُفظ الخادم «${input.name}»: ${target.user}@${target.host}:${target.port} → ${path}. المفتاحُ الخاصّ في الخزنة (${handle}) لا في الإعدادات.\n` +
      (input.keyFile !== undefined ? `استُورد مفتاحُك؛ إن كان مضافاً على الخادم فجرّب: server test ${input.name} — وإلّا أضف مفتاحَه العامّ إلى ~/.ssh/authorized_keys:\n${publicKey}`
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
  if (r.code !== 0 && /Permission denied \(publickey/u.test(`${r.stderr}${r.stdout}`)) {
    // 10-08: المفتاحُ العامّ نفسُه يُعاد في الرفض — بلاه ثبّت النموذجُ مفتاحاً آخر (مقيس على abdo-router).
    const stored = await vault.get(profile.keyHandle)
    const pub = stored === undefined ? undefined : publicKeyFromOpenSsh(decodeKeyFromVault(stored), `abdocode-${profile.name}`)
    if (pub !== undefined) return { ok: false, text: `تعذّر الاتّصال بـ«${profile.name}» (${profile.user}@${profile.host}:${profile.port}): Permission denied (publickey) — الخادمُ لا يعرف مفتاحَ هذا الملفّ. أضف **هذا السطرَ بعينه** إلى ~/.ssh/authorized_keys لـ${profile.user} على الخادم (لا مفتاحاً آخر)، ثمّ أعد server test ${profile.name}:\n${pub}` }
  }
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

/** `env`: نصُّ .env من الخزنة (project-secrets.envFromVault) يُكتب في الإصدار عبر stdin — لا في سطر أوامر ولا في سجلّ؛ `envKeys` أسماؤه للإيصال. */
export interface DeployOptions { readonly build?: string; readonly start?: string; readonly check?: string; readonly env?: string; readonly envKeys?: readonly string[] }
export interface DeployStep { readonly step: string; readonly ok: boolean; readonly detail: string }

/**
 * 10-08 (مقيس في بروفة النشر): `--start "node server.js"` جرى في المقدّمة عبر ssh فطبع «listening on 3000» وعلّق حتى مهلة الـ900 ثانية
 * ثمّ حُسب فاشلاً. أمرُ تشغيلٍ لا يُدير نفسَه (ليس pm2/systemctl/service/docker…/compose up -d) يُشغَّل في الخلفيّة بـnohup وسجلٍّ وملفِّ pid:
 * السابقُ يُوقف أوّلاً (فلا يبقى المنفذُ محجوزاً)، ثمّ يُنتظر ثوانٍ ويُفحص أنّه حيّ، ويُعاد ذيلُ سجلّه.
 */
const SELF_MANAGED_START = /^\s*(?:sudo\s+)?(?:pm2|systemctl|service|supervisorctl|forever|docker(?:-compose)?|podman|screen|tmux|start-stop-daemon)\b|\bup\s+(?:-d|--detach)\b/iu

export function startScript(base: string, start: string): string {
  // 10-08 (مقيس بـgpt-6.1-sol): «nohup node … > app.log 2>&1 < /dev/null &» صار «cd current && nohup … &» — و«&» تُخلِّف السلسلةَ كلَّها
  // في صدفةٍ فرعيّة تمسك مخرجَ ssh، فعلّق ٣٠٠ ثانية ورُدّ فاشلاً. «&» في الذيل تُنزع ويمرّ الأمرُ بمسار التشغيل المُدار (pid، فحصُ الحياة).
  // ونـohup/setsid بلا «&» يجريان في المقدّمة فيعلّقان كذلك — ليسا مديرَين ذاتيّين؛ يُنزعان ويُدار التشغيل.
  start = start.replace(/\s&\s*$/u, "").replace(/^\s*(?:nohup|setsid)\s+/u, "")
  if (SELF_MANAGED_START.test(start)) return `cd ${shq(`${base}/current`)} && ${start}`
  const pid = shq(`${base}/app.pid`), log = shq(`${base}/app.log`)
  return [
    `cd ${shq(`${base}/current`)}`,
    // السابقُ يُوقف بمجموعته (setsid جعله قائدَها) كي لا يبقى ابنٌ يحجز المنفذ، ثمّ بنفسه إن لم تكن مجموعة.
    `if [ -f ${pid} ]; then old=$(cat ${pid}); if kill -TERM -- "-$old" 2>/dev/null || kill "$old" 2>/dev/null; then for i in 1 2 3 4 5; do kill -0 "$old" 2>/dev/null || break; sleep 1; done; kill -9 -- "-$old" 2>/dev/null; kill -9 "$old" 2>/dev/null; echo "stopped previous $old"; fi; fi`,
    // «&» يفصل بنفسه — «&;» خطأُ صياغةٍ في sh (مقيس: خرج برمز 2).
    `if command -v setsid >/dev/null 2>&1; then nohup setsid sh -c ${shq(start)} > ${log} 2>&1 < /dev/null & else nohup sh -c ${shq(start)} > ${log} 2>&1 < /dev/null & fi; echo $! > ${pid}`,
    `sleep 3`,
    `if kill -0 "$(cat ${pid})" 2>/dev/null; then echo "running pid $(cat ${pid}) (log: ${base}/app.log)"; tail -n 20 ${log}; else echo "exited right after start:" >&2; tail -n 40 ${log} >&2; exit 1; fi`,
  ].join("; ")
}

/** رابطُ فحصٍ على حلقة الخادم (localhost/127.0.0.1/[::1]) — يُفحص على الخادم لا من جهاز المطوّر. */
export const isLoopbackUrl = (url: string): boolean => /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/iu.test(url.trim())

export function loopbackCheckScript(url: string): string {
  const u = shq(url)
  const probe = `if command -v curl >/dev/null 2>&1; then code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 ${u}); else code=$(node -e "fetch(process.argv[1],{signal:AbortSignal.timeout(5000)}).then(r=>console.log(r.status)).catch(()=>console.log(0))" ${u}); fi`
  return `for i in 1 2 3 4 5 6 7 8 9 10; do ${probe}; case "$code" in 2??|3??) break;; esac; sleep 2; done; echo "HTTP_STATUS=$code"`
}

export async function deploy(stateRoot: string, projectDir: string, profile: ServerProfile, options: DeployOptions, vault: VaultAccess, deps: RemoteDeps, checkUrl?: (url: string) => Promise<number>): Promise<{ readonly ok: boolean; readonly steps: readonly DeployStep[]; readonly release?: string }> {
  const steps: DeployStep[] = []
  const release = stamp(deps.now?.() ?? new Date())
  const work = mkdtempSync(join(tmpdir(), "abdo-deploy-"))
  const archive = join(work, `${release}.tgz`)
  try {
    const packed = deps.run([deps.tar, "-czf", archive, ...DEPLOY_EXCLUDES.flatMap((e) => ["--exclude", e]), "-C", projectDir, "."], { timeoutMs: 300_000 })
    // 10-08 (مقيس على abdo-router): «✕ pack:» بلا كلمة — tar خرج بغير صفرٍ وخطؤه فارغ، فلم يعرف النموذجُ ما يصلح. الرمزُ والخرجان يُسمّيان السبب
    // (ملفٌّ يمسكه خادمٌ حيّ — قاعدةُ SQLite أو سجلّ — هو الأشيع: أوقف الخادم أو استبعد الملفّ ثمّ أعد).
    steps.push({ step: "pack", ok: packed.code === 0, detail: packed.code === 0 ? `حُزم المشروع بلا: ${DEPLOY_EXCLUDES.join(" ")}` : `tar خرج برمز ${packed.code}${packed.code === 124 ? " (انتهت المهلة)" : ""}: ${clip((packed.stderr.trim() || packed.stdout.trim() || "بلا خرج — غالباً ملفٌّ يمسكه خادمٌ حيّ (قاعدة SQLite أو سجلّ): أوقف الخادم المحلّيّ ثمّ أعد النشر"), 600)}` })
    if (packed.code !== 0) return { ok: false, steps }
    const out = await withKey(profile, vault, deps, async (key) => {
      const base = profile.path, rel = `${base}/releases/${release}`
      const prep = remote(profile, key, stateRoot, deps, `set -e; mkdir -p ${shq(`${base}/releases`)}`)
      steps.push({ step: "prepare", ok: prep.code === 0, detail: prep.code === 0 ? `${base}/releases` : clip(prep.stderr, 600) })
      if (prep.code !== 0) return false
      const up = deps.run([deps.scp, ...sshOptions(profile, key, stateRoot, "-P"), archive, `${profile.user}@${profile.host}:${base}/releases/${release}.tgz`], { timeoutMs: 600_000 })
      steps.push({ step: "upload", ok: up.code === 0, detail: up.code === 0 ? `${release}.tgz` : clip(up.stderr, 600) })
      if (up.code !== 0) return false
      // 10-08 (مقيس في بروفة النشر): `current` كان يُقلب قبل البناء — فبناءٌ فاشل (npm ci بلا lockfile) ترك current على إصدارٍ مكسور،
      // وصار هدفَ --rollback التالي. الترتيبُ الآن: فكٌّ وenv وبناءٌ داخل الإصدار نفسِه ⇦ القلبُ وتقليمُ القديم ⇦ التشغيل؛ والإصدارُ الفاشلُ قبل القلب يُحذف.
      const ex = remote(profile, key, stateRoot, deps, `set -e; mkdir -p ${shq(rel)}; tar -xzf ${shq(`${rel}.tgz`)} -C ${shq(rel)}; rm -f ${shq(`${rel}.tgz`)}`)
      steps.push({ step: "unpack", ok: ex.code === 0, detail: ex.code === 0 ? `releases/${release}` : clip(ex.stderr, 600) })
      const discard = (): void => { remote(profile, key, stateRoot, deps, `rm -rf -- ${shq(rel)} ${shq(`${rel}.tgz`)}`) }
      if (ex.code !== 0) { discard(); return false }
      if (options.env !== undefined) {
        const w = remote(profile, key, stateRoot, deps, `umask 077; cat > ${shq(`${rel}/.env`)}`, 60_000, options.env)
        steps.push({ step: "env", ok: w.code === 0, detail: w.code === 0 ? `كُتب .env (${options.envKeys?.length ?? 0} مفتاحاً: ${(options.envKeys ?? []).join("، ")}) من الخزنة — القيمُ لم تُعرض` : clip(w.stderr, 600) })
        if (w.code !== 0) { discard(); return false }
      }
      if (options.build !== undefined && options.build.trim() !== "") {
        const b = remote(profile, key, stateRoot, deps, `cd ${shq(rel)} && ${options.build}`, 900_000)
        steps.push({ step: "build", ok: b.code === 0, detail: `$ ${options.build}\n${clip(`${b.stdout}${b.stderr ? `\n${b.stderr}` : ""}`.trim(), 2500)}${b.code === 0 ? "" : "\n(current لم يُقلب — الإصدارُ الحيّ كما كان، والفاشلُ حُذف)"}` })
        if (b.code !== 0) { discard(); return false }
      }
      const sw = remote(profile, key, stateRoot, deps, `set -e; ln -sfn ${shq(rel)} ${shq(`${base}/current`)}; cd ${shq(`${base}/releases`)}; ls -1 | grep -v '\\.tgz$' | sort -r | tail -n +6 | while read old; do rm -rf -- "$old"; echo "removed old release $old"; done`)
      steps.push({ step: "release", ok: sw.code === 0, detail: sw.code === 0 ? `current ⇦ releases/${release}${sw.stdout.trim() ? `\n${sw.stdout.trim()}` : ""}` : clip(sw.stderr, 600) })
      if (sw.code !== 0) return false
      if (options.start !== undefined && options.start.trim() !== "") {
        const r = remote(profile, key, stateRoot, deps, startScript(base, options.start), 300_000)
        steps.push({ step: "start", ok: r.code === 0, detail: `$ ${options.start}\n${clip(`${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.trim(), 2500)}${r.code === 0 ? "" : `\nللرجوع إلى الإصدار السابق: deploy ${profile.name} --rollback`}` })
        if (r.code !== 0) return false
      }
      return true
    })
    if (typeof out === "object") { steps.push({ step: "key", ok: false, detail: out.error }); return { ok: false, steps } }
    if (!out) return { ok: false, steps, release }
    if (options.check !== undefined && (checkUrl !== undefined || isLoopbackUrl(options.check))) {
      let status = 0
      let where = ""
      if (isLoopbackUrl(options.check)) {
        // 10-08 (مقيس على abdo-router): «--check http://127.0.0.1:3000/api/health» فُحص من هذا الجهاز فردّ «لا ردّ» والتطبيقُ حيٌّ في الحاوية —
        // 127.0.0.1 في الرابط هو حلقةُ الخادم نفسِه. فالفحصُ يجري هناك عبر ssh (curl أو node)، بإعادةٍ قصيرة ريثما يقوم التطبيق.
        const r = await withKey(profile, vault, deps, (key) => remote(profile, key, stateRoot, deps, loopbackCheckScript(options.check!), 90_000))
        if (!("error" in r)) { const m = /HTTP_STATUS=(\d{3})/u.exec(r.stdout); status = m === null ? 0 : Number(m[1]) }
        where = " (من الخادم نفسِه)"
      } else {
        try { status = await checkUrl!(options.check) } catch { status = 0 }
      }
      steps.push({ step: "check", ok: status >= 200 && status < 400, detail: `${options.check}${where} → ${status || "لا ردّ"}` })
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
    const s = remote(profile, key, stateRoot, deps, startScript(base, start), 300_000)
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
      const p = Bun.spawnSync([...argv], { cwd: options?.cwd, stdout: "pipe", stderr: "pipe", stdin: options?.input === undefined ? "ignore" : new TextEncoder().encode(options.input), timeout: options?.timeoutMs ?? 120_000 })
      return { code: p.exitCode ?? (p.signalCode ? 124 : 1), stdout: p.stdout.toString(), stderr: p.stderr.toString() }
    },
  }
}
