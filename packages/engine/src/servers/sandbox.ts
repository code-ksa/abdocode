/**
 * 10-09 (مقيس على ثلاثة مشاريع): كلُّ مهمّة نشرٍ بنت خادمَها التجريبيّ بيدها — abdo-router ساعتين، وcrm-pipeline دوراً كاملاً بثمانين أمرَ
 * docker وسبعِ «server add» وخمسِ ssh-keygen، حتى حاول تثبيتَ docker داخل الحاوية. الخادمُ التجريبيّ بنيةٌ ثابتة لا اجتهاد: `server sandbox <اسم>`
 * يبني صورةً واحدة (node:24 + openssh بمفاتيح فقط)، ويشغّل حاويةً مقيّدةً بـ127.0.0.1 على منفذين حرّين، ويولّد المفتاحَ إلى الخزنة ويثبّته
 * بالمدخل القياسيّ (لا في سطر الأمر)، ويسجّل الملفَّ، ثمّ يقيس الاتّصال — في نداءٍ واحد. `--remove` يزيله.
 */
import { addServerReady } from "./sandbox-wait"
import { encodeKeyForVault, forgetHostKey, isServerName, keyHandleFor, listProfiles, removeServer, saveProfile, testServer, type RemoteDeps, type ServerProfile, type VaultAccess } from "./remote"
import { generateOpenSshEd25519 } from "./ssh-keys"

export const SANDBOX_IMAGE = "abdocode-sandbox:node24"
export const sandboxContainer = (name: string): string => `abdocode-sandbox-${name}`

export const SANDBOX_DOCKERFILE = [
  "FROM node:24-bookworm-slim",
  "RUN apt-get update && apt-get install -y --no-install-recommends openssh-server curl ca-certificates && rm -rf /var/lib/apt/lists/* \\",
  " && mkdir -p /run/sshd /root/.ssh /srv/app && chmod 700 /root/.ssh \\",
  " && sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication no/; s/^#\\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config \\",
  " && ssh-keygen -A",
  "EXPOSE 22",
  'CMD ["/usr/sbin/sshd", "-D", "-e"]',
  "",
].join("\n")

export interface SandboxOptions {
  /** The app's port inside the container (default 3000); published on a free 127.0.0.1 port. */
  readonly appPort?: number
  /** Free-port finder — injected for tests. */
  readonly freePort: (from: number) => number | undefined
  readonly sleep?: (ms: number) => Promise<void>
}

export async function createSandbox(stateRoot: string, name: string, vault: VaultAccess, deps: RemoteDeps, options: SandboxOptions): Promise<{ readonly ok: boolean; readonly text: string }> {
  if (!isServerName(name)) return { ok: false, text: `اسمٌ غيرُ صالح «${name}» — حروفٌ لاتينيّة صغيرة وأرقام وشرطة` }
  const docker = "docker"
  const info = deps.run([docker, "info", "--format", "{{.ServerVersion}}"], { timeoutMs: 30_000 })
  if (info.code !== 0) return { ok: false, text: `محرّكُ Docker لا يجيب (docker info خرج برمز ${info.code}) — شغّل Docker Desktop وانتظر حتى يجيب، ثمّ أعد server sandbox ${name}.` }
  if (deps.run([docker, "image", "inspect", SANDBOX_IMAGE], { timeoutMs: 30_000 }).code !== 0) {
    const built = deps.run([docker, "build", "-t", SANDBOX_IMAGE, "-"], { timeoutMs: 900_000, input: SANDBOX_DOCKERFILE })
    if (built.code !== 0) return { ok: false, text: `تعذّر بناءُ صورة الخادم التجريبيّ (docker build خرج برمز ${built.code}): ${(built.stderr || built.stdout).trim().slice(-600)}` }
  }
  const container = sandboxContainer(name)
  deps.run([docker, "rm", "-f", container], { timeoutMs: 60_000 })
  const sshPort = options.freePort(2300)
  const appPort = options.appPort ?? 3000
  const hostAppPort = sshPort === undefined ? undefined : options.freePort(Math.max(3100, sshPort + 1))
  if (sshPort === undefined || hostAppPort === undefined) return { ok: false, text: "لا منفذَ حرّاً على 127.0.0.1 للخادم التجريبيّ (2300+ و3100+)." }
  const key = generateOpenSshEd25519(`abdocode-${name}`)
  const handle = keyHandleFor(name)
  if (!(await vault.set(handle, encodeKeyForVault(key.privateKey)))) return { ok: false, text: "الخزنة رفضت حفظ المفتاح" }
  const started = deps.run([docker, "run", "-d", "--name", container, "--label", `abdocode.sandbox=${name}`, "-p", `127.0.0.1:${sshPort}:22`, "-p", `127.0.0.1:${hostAppPort}:${appPort}`, SANDBOX_IMAGE], { timeoutMs: 120_000 })
  if (started.code !== 0) return { ok: false, text: `تعذّر تشغيلُ الحاوية (docker run خرج برمز ${started.code}): ${(started.stderr || started.stdout).trim().slice(-600)}` }
  const installed = deps.run([docker, "exec", "-i", container, "sh", "-c", "cat >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys"], { timeoutMs: 60_000, input: `${key.publicKey}\n` })
  if (installed.code !== 0) return { ok: false, text: `تعذّر تثبيتُ المفتاح في الحاوية (رمز ${installed.code}): ${(installed.stderr || installed.stdout).trim().slice(-300)}` }
  const profile: ServerProfile = { name, user: "root", host: "127.0.0.1", port: sshPort, path: "/srv/app", keyHandle: handle, addedAt: (deps.now?.() ?? new Date()).toISOString() }
  forgetHostKey(stateRoot, "127.0.0.1", sshPort)
  saveProfile(stateRoot, profile)
  const ready = await addServerReady(() => testServer(stateRoot, profile, vault, deps), options.sleep)
  if (!ready.ok) return { ok: false, text: `بُنيت الحاوية وسُجّل الخادم «${name}» ولم يُجب ssh بعد: ${ready.text.slice(0, 400)}` }
  return {
    ok: true,
    text: `✓ خادمٌ تجريبيّ جاهز «${name}»: root@127.0.0.1:${sshPort} (حاوية ${container}، منافذُها على 127.0.0.1 وحدها، المفتاحُ في الخزنة ومثبَّت).\n` +
      `منفذُ التطبيق ${appPort} داخل الحاوية ⇦ http://127.0.0.1:${hostAppPort} من هذا الجهاز.\n` +
      `انشر: deploy ${name} --env --build "npm ci && npm run build" --start "npm start" --check http://127.0.0.1:${appPort}/api/health\n` +
      `أزِله بعد القياس: server sandbox ${name} --remove`,
  }
}

export async function removeSandbox(stateRoot: string, name: string, vault: VaultAccess, deps: RemoteDeps): Promise<string> {
  if (!isServerName(name)) return `اسمٌ غيرُ صالح «${name}»`
  const r = deps.run(["docker", "rm", "-f", sandboxContainer(name)], { timeoutMs: 60_000 })
  const hadProfile = listProfiles(stateRoot).some((s) => s.name === name)
  const profileText = hadProfile ? await removeServer(stateRoot, name, vault) : "لا ملفَّ خادمٍ بهذا الاسم"
  return `${r.code === 0 ? `أُزيلت الحاوية ${sandboxContainer(name)}` : `لا حاويةَ ${sandboxContainer(name)} (أو تعذّرت إزالتُها)`} — ${profileText}`
}
