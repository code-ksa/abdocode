/** خادم المشروع المُدار — النواة تملك دورة حياته لا النموذج.
 *
 * الحادثة المقيسة (2026-08-30، جولة `e2e-1788082597119`): النموذج شغّل
 * `npm start` بأداة run ذات مهلة 120 ثانية، فحجب الأمر مهلته كاملة ثم
 * نجت شجرة العملية (npm ← next :3000) من نهاية الدور، وأمسك stdio
 * الموروث فعلّق الهارنس 63 دقيقة بلا EOF — واضطر النموذج قبلها إلى
 * `Stop-Process -Name node` الأعمى الذي يقتل عمليات جلسات أخرى.
 *
 * العلاج: أمرُ تشغيل خادمٍ يُتبنّى — تُنشئه النواة بلا وراثة stdio،
 * تسجّل رقمه، تنتظر إنصات منفذه، وتعيد إيصالاً يسمّي المنفذ. وعند
 * نهاية الدور تُقتل الشجرة كلها حتماً (taskkill /T). الفحص بعدها
 * بأدوات HTTP العادية.
 */

import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { systemTool } from "./system-tools"
import { stripChildEnv } from "@abdo/tools/env-strip"

export interface ServerCommand {
  readonly launch: readonly string[]
  readonly port: number
}

// مرشّح مساحة العمل في المستودعات متعددة الحزم (إيدو جلوبال، 2026-09-02):
// `pnpm --filter @scope/web dev` أو `pnpm -F web start` أو `npm -w web run dev`
// خادمٌ طويل العمر بقدر `npm start` — لو مرّ من أداة run حجبها مهلتها كاملة
// ونجت شجرته (الحادثة المؤسِّسة أعلاه بعينها). المرشّح يسبق السكربت ويُحفظ
// كما هو في الإطلاق؛ الإيجار يُلحق `-- -p` بعده كالمعتاد.
const WORKSPACE_FILTER = String.raw`(?:(?:--filter|-F|--workspace|-w)(?:=\S+|\s+\S+)\s+)*`
const SERVER_SHAPES: readonly { readonly pattern: RegExp; readonly defaultPort: number }[] = [
  { pattern: new RegExp(String.raw`^(?:npm|pnpm|yarn|bun)\s+${WORKSPACE_FILTER}(?:run\s+)?start\b`, "iu"), defaultPort: 3000 },
  { pattern: new RegExp(String.raw`^(?:npm|pnpm|yarn|bun)\s+${WORKSPACE_FILTER}(?:run\s+)?dev\b`, "iu"), defaultPort: 3000 },
  // turbo يشغّل خوادم عدة معاً؛ إدارته أفضل من تعليق run عليه عشر دقائق.
  { pattern: /^(?:npx\s+)?turbo\s+(?:run\s+)?(?:dev|start)\b/iu, defaultPort: 3000 },
  { pattern: /^(?:npx\s+)?next\s+(?:start|dev)\b/iu, defaultPort: 3000 },
  { pattern: /^node\s+(?:\.\/)?server(?:\.[cm]?js)?\b/iu, defaultPort: 3000 },
]

/**
 * الغلاف يفلت من الإدارة: النموذج لفّ `npm start` داخل
 * `powershell -Command "..."` فذهب للمسار العادي (مهلة 120ث)، نجت شجرته
 * من نهاية الدور، قعدت على 3000 طوال الجولة، وعلّقت الهارنس ثانيةً —
 * قيس حيّاً في `e2e-1788089398170`. الغلاف يُرَدّ بسببٍ مسمّى: التشغيل
 * المباشر هو ما تديره النواة.
 */
export function wrappedServerViolation(cmd: string): string | undefined {
  const wrapped = /(?:powershell|pwsh|cmd)\b[\s\S]*?\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:start|dev)|(?:npx\s+)?next\s+(?:start|dev)|Start-Process\b[\s\S]*?(?:npm|node|next))\b/iu
  if (!wrapped.test(cmd)) return undefined
  return (
    "رُفض تشغيل الخادم داخل غلاف powershell: الغلاف يفلت من إدارة النواة فيصير الخادم يتيماً يشغل المنفذ ويعلّق النظام. " +
    "شغّله أمراً مباشراً — `npm start` وحدها — والنواة تديره: تؤجّر منفذه وتسمّيه في الإيصال وتوقفه عند نهاية الدور."
  )
}

/** يميّز أمرَ تشغيل خادمٍ طويل العمر عن أمرٍ عابر. `undefined` = عابر. */
/**
 * منفذُ dev الافتراضيّ من الكومة لا من العادة (مقيس 2026-09-13: «npm run dev» لمشروع Vite انتظر 3000 ثلاثين ثانية ثمّ قتل الخادمَ
 * وهو يستمع على 5173). يُقرأ سكربتُ dev/start في package.json وملفّاتُ الإعداد؛ ما لم يُعرف يبقى 3000.
 */
export function devPortHint(projectDir: string | undefined): number | undefined {
  if (projectDir === undefined) return undefined
  try {
    const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8")) as { scripts?: Record<string, string> }
    const script = `${pkg.scripts?.dev ?? ""} ${pkg.scripts?.start ?? ""}`.toLowerCase()
    if (/\bvite\b/u.test(script)) return 5173
    if (/\bastro\b/u.test(script)) return 4321
    if (/\bnext\b|\bremix\b|\bnuxt\b/u.test(script)) return 3000
  } catch { /* لا package.json — نقرأ ملفّات الإعداد */ }
  if (["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.mts"].some((f) => existsSync(join(projectDir, f)))) return 5173
  if (["astro.config.mjs", "astro.config.ts"].some((f) => existsSync(join(projectDir, f)))) return 4321
  return undefined
}

export function parseServerCommand(cmd: string, projectDir?: string): ServerCommand | undefined {
  const trimmed = cmd.trim()
  // أمرٌ مركّب (فاصلة منطقية/أنبوب) ليس تشغيل خادم صافياً — يُترك للمسار العادي.
  if (/[;|&]/.test(trimmed)) return undefined
  const shape = SERVER_SHAPES.find((s) => s.pattern.test(trimmed))
  if (shape === undefined) return undefined
  const port = trimmed.match(/(?:^|\s)(?:-p|--port)[\s=]+(\d{2,5})\b/u)?.[1]
  return {
    launch: trimmed.split(/\s+/),
    port: port !== undefined ? Number.parseInt(port, 10) : (devPortHint(projectDir) ?? shape.defaultPort),
  }
}

interface ManagedProcess {
  readonly proc: ReturnType<typeof Bun.spawn>
  readonly port: number
  readonly display: string
  /** رقم المُنصت الفعلي على المنفذ — يُقاس بعد الجاهزية، لأن سلسلة
   * npm.cmd ← node ← next تنقطع على ويندوز فلا يصل قتل الشجرة بالنسب
   * إلى الأحفاد المنبتّين (قيس حياً: أبوا الناجين ميتان). */
  listenerPid?: number
}

/** مَن يُنصت على المنفذ فعلاً — ملكية بالقياس لا بالنسب. */
const listenerOf = (port: number): number | undefined => {
  try {
    const netstat = Bun.spawnSync([systemTool("netstat"), "-ano", "-p", "tcp"], { stdout: "pipe", stderr: "ignore" })
    for (const line of netstat.stdout.toString().split("\n")) {
      const m = line.match(/TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/u)
      if (m !== null && Number.parseInt(m[1], 10) === port) return Number.parseInt(m[2], 10)
    }
  } catch { /* قياس متعذر — يبقى قتل النسب وحده */ }
  return undefined
}

const listening = async (port: number): Promise<boolean> => {
  try {
    const probe = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) })
    void probe.arrayBuffer().catch(() => {})
    return true
  } catch {
    return false
  }
}

/** فحص شغور المنفذ بربطٍ حقيقيّ لا بتخمين HTTP — خادمٌ غير HTTP يشغل المنفذ أيضاً. */
const portFree = (port: number): boolean => {
  try {
    const probe = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() { /* فحص فقط */ } } })
    probe.stop(true)
    return true
  } catch {
    return false
  }
}

/** إيجار منفذ محلي: أول منفذ حر بعد المطلوب — قرار النواة لا تخمين النموذج. */
const leaseFreePort = (from: number): number | undefined => {
  for (let candidate = from; candidate < from + 60; candidate += 1) {
    if (portFree(candidate)) return candidate
  }
  return undefined
}

/** يبني أمر الإطلاق على المنفذ المؤجَّر بحسب شكل الأمر — وPORT في البيئة تغطي الباقي. */
const withPort = (launch: readonly string[], port: number): readonly string[] => {
  const head = launch[0]?.toLowerCase()
  const stripped: string[] = []
  for (let i = 0; i < launch.length; i += 1) {
    if (/^(?:-p|--port)$/iu.test(launch[i]) && i + 1 < launch.length) { i += 1; continue }
    if (/^--port=/iu.test(launch[i])) continue
    stripped.push(launch[i])
  }
  if (head === "npm" || head === "pnpm" || head === "yarn" || head === "bun") {
    const separated = stripped.includes("--") ? stripped : [...stripped, "--"]
    return [...separated, "-p", String(port)]
  }
  if (head === "next" || head === "npx") return [...stripped, "-p", String(port)]
  return stripped // خادم عام: PORT في البيئة هي القناة
}

// ⚠️ «taskkill» العارية فشلت صامتةً في بيئةٍ لا تحملها في PATH وابتلعها
// catch — فبقي الخادم حياً بعد «القتل» (صنف الفشل المفتوح). المسار المطلق
// من system-tools (كتالوج 6.3)، وقتل الابن المباشر دائماً احتياطاً.
const killTree = (managed: ManagedProcess): void => {
  try {
    Bun.spawnSync([systemTool("taskkill"), "/PID", String(managed.proc.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" })
  } catch { /* تُغطّى بالقتل المباشر أدناه */ }
  try { managed.proc.kill() } catch { /* ماتت قبلنا — الغاية حاصلة */ }
  // المُنصت المقيس: يصل حيث ينقطع النسب (npm.cmd يموت وتبقى أحفاده).
  if (managed.listenerPid !== undefined && managed.listenerPid !== managed.proc.pid) {
    try {
      Bun.spawnSync([systemTool("taskkill"), "/PID", String(managed.listenerPid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" })
    } catch { /* ماتت قبلنا */ }
  }
}

/** يحلّ مُشغّل الخادم (npm/npx/pnpm/yarn/node/bun/next) إلى مسارٍ مطلق.
 *
 * قيس حيّاً (جولة qwen3.8-max 2026-09-02، الدور e2e-1788296470333):
 * `Bun.spawn(["npm", "start"])` رمى `ENOENT uv_spawn 'npm'` فأسقط
 * الدور كله — بينما `run npm install` نجح لأنه يمرّ عبر powershell الذي
 * يحلّ npm.cmd. الاسم العاري يعتمد حلّ PATH×PATHEXT الضمني وهو هشّ في بيئة
 * المحرك (نفس درس system-tools 6.3: «العارية خارج PATH تفشل صامتة»).
 * نحلّه هنا صراحةً بفحص المواضع القانونية أولاً؛ والغياب يُترك للنظام
 * فتلتقط `start` فشله إيصالاً لا رمية. غير ويندوز: يُترك كما هو. */
const launcherCache = new Map<string, string>()
export function resolveLauncher(name: string): string {
  if (process.platform !== "win32") return name
  if (name.includes("/") || name.includes("\\") || isAbsolute(name)) return name
  if (/\.(?:exe|cmd|bat)$/iu.test(name)) return name
  const cached = launcherCache.get(name)
  if (cached !== undefined) return cached
  const pf = process.env["ProgramFiles"] ?? "C:/Program Files"
  const dirs = [`${pf}/nodejs`, ...(process.env.PATH ?? "").split(";")]
  const appdata = process.env["APPDATA"]
  if (appdata !== undefined) dirs.push(`${appdata}/npm`)
  for (const raw of dirs) {
    const dir = raw.trim().replace(/\\/g, "/").replace(/\/+$/, "")
    if (dir.length === 0) continue
    for (const ext of [".cmd", ".exe", ".bat"]) {
      const candidate = `${dir}/${name}${ext}`
      if (existsSync(candidate)) { launcherCache.set(name, candidate); return candidate }
    }
  }
  return name
}

/** صفٌّ مقيس — ما يعرفه المحرّك، بلا حقلٍ تشتقّه القشرة. */
export interface MeasuredServer {
  readonly name: string
  readonly port: number
  readonly state: "up" | "down"
  readonly why?: string
  readonly pid?: number
}

export class ManagedServers {
  #running: ManagedProcess[] = []

  /** يشغّل خادماً مملوكاً للنواة ويعيد إيصالاً بعد قياس الإنصات. */
  async start(command: ServerCommand, cwd: string): Promise<string> {
    // خادمُنا نحن يعمل على المنفذ فعلاً؟ الإيصال يقول ذلك — لا رفضٌ يكذب.
    // (قيس حيّاً: رفضنا منفذاً يملكه الدور نفسه بعبارة «ليست من هذا الدور»
    // فأضاع النموذج حقباً في التفاوض مع رسالة خاطئة.)
    const ours = this.#running.find((p) => p.port === command.port)
    if (ours !== undefined) {
      if (await listening(command.port)) {
        return `⚙ خادمك يعمل فعلاً تحت إدارة النواة: «${ours.display}» على http://127.0.0.1:${ours.port} (pid ${ours.proc.pid}). افحصه مباشرة — لا حاجة لإعادة تشغيله.`
      }
      // ب10 — **«لا يُنصت» ليس «ميت»**: وضعُ «أوقاتٍ» يشغّل حتى اثني عشر أخاً متوازياً، فطلبُ أخٍ للمنفذ نفسِه كان
      // يقتل خادمَ أخيه **وهو في طور الإقلاع** ثمّ يشغّل مكانه ويحكم على ما قتله. القتلُ لِما مات وحده؛ والحيُّ
      // يُنتظر قليلاً، فإن لم يُنصت قيل ذلك ولم يُمَسّ — «قتلُها قرارُها لا قرارُك».
      const alive = ours.proc.exitCode === null && ours.proc.signalCode === null
      if (alive) {
        for (let i = 0; i < 24 && !(await listening(command.port)); i += 1) await Bun.sleep(250)
        if (await listening(command.port)) {
          return `⚙ خادمك يعمل فعلاً تحت إدارة النواة: «${ours.display}» على http://127.0.0.1:${ours.port} (pid ${ours.proc.pid}). افحصه مباشرة — لا حاجة لإعادة تشغيله.`
        }
        return `⏳ خادمٌ آخر في هذا الدور يقلع على المنفذ ${command.port} («${ours.display}»، pid ${ours.proc.pid}) ولم يُنصت بعد — انتظره أو أوقفه صراحةً؛ لم أقتله لأنّه ليس لي.`
      }
      killTree(ours)
      this.#running = this.#running.filter((p) => p !== ours)
    }
    // منفذٌ يشغله غيرنا: النواة تؤجّر أول منفذ حر — «اسأل الأداة ولا تختر».
    let port = command.port
    let leaseNote = ""
    if (!portFree(port)) {
      const leased = leaseFreePort(port + 1)
      if (leased === undefined) return `تعذّر التشغيل: لا منفذ حراً في المدى ${port}–${port + 60}. أوقف ما تملكه من خوادم أولاً.`
      leaseNote = `\n(المنفذ ${port} يشغله طرف خارجي — أجّرت لك النواة ${leased} بدلاً منه؛ لا توقف عمليات لا تملكها.)`
      port = leased
    }
    const launch = port === command.port ? command.launch : withPort(command.launch, port)
    const display = launch.join(" ")
    // المُشغّل بمسارٍ مطلق (resolveLauncher) لا اسماً عارياً هشّاً في PATH.
    const spawnArgv = [resolveLauncher(launch[0] ?? ""), ...launch.slice(1)]
    let proc: ReturnType<typeof Bun.spawn>
    try {
      proc = Bun.spawn([...spawnArgv], {
        cwd,
        // لا وراثة stdio: الوراثة هي ما علّق الهارنس 63 دقيقة بلا EOF.
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        // خادمُ التطوير كودُ المستخدم: يرث بيئةً منزوعةَ الاعتمادات كما يرثها
        // أيُّ أمرٍ يُنفَّذ. كان يرث `process.env` كاملاً — ومنه رمزُ القشرة.
        env: { ...stripChildEnv(process.env).env, PORT: String(port) },
      })
    } catch (error) {
      // فشل الإطلاق إيصالٌ لا رمية: رميةٌ هنا تفلت إلى catch الدور فتُسقط
      // الجولة كلها (قيس: ENOENT على npm العارية أسقط جولة 2026-09-02).
      const reason = error instanceof Error ? error.message : String(error)
      return `فشل تشغيل الخادم «${display}»: تعذّر إطلاقه — ${reason}. تحقّق من توفّر «${launch[0] ?? ""}» في المسار ثم أعد المحاولة.`
    }
    const managed: ManagedProcess = { proc, port, display }
    this.#running.push(managed)
    // ٩٠ ثانية لا ٣٠ (مقيس 2026-09-13): أوّلُ تشغيلٍ لـVite يُجهّز الاعتمادات (optimizeDeps) فيتجاوز ٣٠ ثانية، فقُتل الخادمُ وهو يقوم؛
    // الخروجُ المبكّر يبقى فوريّاً — الانتظارُ الطويل للحيّ البطيء لا للميّت.
    for (let i = 0; i < 120; i += 1) {
      await Bun.sleep(750)
      if (await listening(port)) {
        // ملكية المُنصت تُقاس لحظة الجاهزية — بعدها قد يموت الوسيط npm.cmd.
        managed.listenerPid = listenerOf(port)
        return (
          `⚙ الخادم يعمل تحت إدارة النواة: «${display}» على http://127.0.0.1:${port} (pid ${managed.listenerPid ?? proc.pid}).${leaseNote}\n` +
          `افحصه الآن بـInvoke-WebRequest -UseBasicParsing. سيُوقف تلقائياً عند نهاية الدور — لا توقفه بـStop-Process الأعمى.`
        )
      }
      if (proc.exitCode !== null) {
        // سلسلةُ npm.cmd: الوسيطُ يخرج 0 والمُنصتُ (node) يقوم بعده — مهلةُ ٦ ثوانٍ قبل الحكم بالفشل؛ خروجٌ بغير 0 فشلٌ فوريّ.
        if (proc.exitCode === 0 && i < 8) continue
        // انتهت المهلةُ والوسيطُ خارجٌ بصفر بلا مُنصت: الحكمُ الصادق «خرج قبل الإنصات» فوراً لا انتظارُ ٩٠ ثانية لتشخيصٍ خاطئ.
        this.#running = this.#running.filter((p) => p.proc.pid !== proc.pid)
        return `فشل تشغيل الخادم «${display}»: خرج برمز ${proc.exitCode} قبل الإنصات على ${port}. افحص سبب الفشل (البناء أو الإعداد) قبل إعادة المحاولة.`
      }
    }
    killTree(managed)
    this.#running = this.#running.filter((p) => p.proc.pid !== proc.pid)
    return `فشل تشغيل الخادم «${display}»: لم يُنصت على ${port} خلال 90 ثانية — أُوقفت شجرته. تحقّق من المنفذ والسكربت.`
  }

  /** لوحةُ المهامّ الخلفيّة (09-14): الخوادمُ المُدارة الحيّة بمنفذها — قراءةٌ لا أثر. */
  snapshot(): readonly { readonly display: string; readonly port: number; readonly pid: number | undefined; readonly alive: boolean }[] {
    return this.#running.map((p) => ({ display: p.display, port: p.port, pid: p.listenerPid ?? p.proc.pid, alive: p.proc.exitCode === null }))
  }

  /** نهاية الدور: الشجرات كلها تُقتل حتماً — لا يتيم يعلّق أحداً. */
  stopAll(): string | undefined {
    if (this.#running.length === 0) return undefined
    const stopped = this.#running.map((p) => `${p.display} (:${p.port})`)
    for (const p of this.#running) killTree(p)
    this.#running = []
    return `أوقفت النواة خوادم الدور المدارة: ${stopped.join("، ")}`
  }

  get active(): number {
    return this.#running.length
  }

  /**
   * ما تديره النواةُ الآن — **بقياسٍ لحظةَ السؤال لا بذاكرة**.
   *
   * كان الصنفُ يعرف ما شغّله ولا يُخبر أحداً: لا جردَ ولا إعادةَ قياس، وملكيّةُ
   * المُنصت تُلتقط مرّةً عند الجاهزيّة ثمّ لا تُراجَع. فلوحةٌ تبني على ذلك
   * تعرض حالةً عمرُها من لحظةِ الإقلاع وتسمّيها حاضرة.
   *
   * والحالةُ **ثلاثيّة** عمداً: `up` و`down` حكمان مقيسان، ولا يُخترع ثالثٌ
   * هنا — «يُقاس» حالةُ القشرة قبل وصول الجواب لا حالةُ المحرّك.
   */
  async measure(): Promise<readonly MeasuredServer[]> {
    const rows: MeasuredServer[] = []
    for (const p of this.#running) {
      const up = await listening(p.port)
      rows.push(Object.freeze({
        name: p.display,
        port: p.port,
        state: up ? "up" : "down",
        // السببُ يُقال حين يُعرف: عمليةٌ خرجت ليست منفذاً لا يستجيب.
        ...(up ? {} : { why: p.proc.exitCode !== null ? `خرجت برمز ${p.proc.exitCode}` : "لا يستجيب على منفذه" }),
        ...(up ? { pid: listenerOf(p.port) ?? p.proc.pid } : {}),
      }) as MeasuredServer)
    }
    return Object.freeze(rows)
  }

  /** إيقافُ خادمٍ بعينه بأمر المشغّل — الدَّينُ الذي يقابل بقاءَها بين الأدوار. */
  stop(port: number): string | undefined {
    const target = this.#running.find((p) => p.port === port)
    if (target === undefined) return undefined
    killTree(target)
    this.#running = this.#running.filter((p) => p !== target)
    return `أُوقف «${target.display}» على المنفذ ${port}`
  }
}
