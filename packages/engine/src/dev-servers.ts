/**
 * خوادمُ التطوير في لوحة المتصفّح — إعداداتُ الإطلاق أزراراً.
 *
 * الحالةُ الفارغةُ للّوحة كانت نصّاً («اكتب رابطاً…»)، والمشغّلُ الذي يريد أن يرى
 * مشروعَه يكتب الأمرَ في المحادثة وينتظر الدور. الصيغةُ الجاهزة موجودةٌ في
 * المشروع نفسِه: `.claude/launch.json` (صيغةُ تطبيق كلود المكتبيّ) تسمّي
 * الخادمَ ومُشغّلَه ومنفذَه. هذا الملفُّ **يقرأها ولا يشغّل شيئاً**: التشغيلُ
 * لِـ`ManagedServers` في المحرّك، والعرضُ للقشرة.
 *
 * ## الفشلُ مغلق
 *
 * ملفٌّ مشوَّه أو غائب = لا إعدادات، لا «نحاول تخمين ما أراد». وكلُّ إعدادٍ
 * يُقبل بأكمله أو يُرفض **بسببٍ مسمّى** يُعاد مع الصفوف كي يراه المشغّل — إعدادٌ
 * يسقط صامتاً يجعله يظنّ أنّ الملفَّ لم يُقرأ أصلاً. والقيودُ مقصودة:
 *
 * - المُشغّل من قائمة سماحٍ مغلقة — الملفُّ في مستودع العميل، وأيُّ أمرٍ فيه
 *   سيُنفَّذ بضغطة زرٍّ بلا بوّابة أدوات؛ `cmd /c rm -rf` ليس «خادمَ تطوير».
 * - المنفذُ 1024–65535: منافذُ الامتياز ليست لخوادم تطوير.
 * - الاسمُ معرّفٌ قصير (≤40) بلا فراغ: يسافر في إطارٍ ويُطابَق باسمه.
 * - ستّةَ عشرَ إعداداً سقفاً: لوحةٌ لا زرًّا فوق زرّ.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { MeasuredServer } from "./managed-server"

export const LAUNCH_CONFIG_PATH = ".claude/launch.json"
export const LAUNCH_CONFIG_CAP = 16
export const LAUNCH_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/u
export const LAUNCH_RUNTIMES: readonly string[] = Object.freeze([
  "npm", "npx", "bun", "bunx", "node", "pnpm", "yarn", "python", "py", "uv", "cargo", "dotnet", "php", "powershell",
])
const ARGS_CAP = 32
const ARG_LENGTH_CAP = 200

export interface LaunchConfig {
  readonly name: string
  readonly port: number
  /** الرابطُ الذي تفتحه اللوحة — الافتراضُ `http://127.0.0.1:<port>`. */
  readonly url: string
  /** `[runtimeExecutable, ...runtimeArgs]` كما يأخذه `ManagedServers.start`. */
  readonly launch: readonly string[]
}

export interface LaunchConfigReading {
  readonly configs: readonly LaunchConfig[]
  /** ما رُفض ولماذا — يُعرض للمشغّل ولا يُبتلع. */
  readonly problems: readonly string[]
}

const EMPTY: LaunchConfigReading = Object.freeze({ configs: Object.freeze([]), problems: Object.freeze([]) })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const validPort = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1024 && value <= 65_535

const cleanArg = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= ARG_LENGTH_CAP && !/[\u0000-\u001f\u007f]/u.test(value)

/** يقرأ إعداداً واحداً أو يقول لِمَ رفضه. */
const readEntry = (raw: unknown, index: number, seen: Set<string>): LaunchConfig | string => {
  const at = `الإعداد #${index + 1}`
  if (!isRecord(raw)) return `${at}: ليس كائناً`
  const name = raw["name"]
  if (typeof name !== "string" || !LAUNCH_NAME_PATTERN.test(name)) return `${at}: الاسم غير صالح (حروف لاتينيّة وأرقام و._- حتى 40 محرفاً)`
  if (seen.has(name)) return `${at}: الاسم «${name}» مكرّر`
  const runtime = raw["runtimeExecutable"]
  if (typeof runtime !== "string" || !LAUNCH_RUNTIMES.includes(runtime.toLowerCase())) {
    return `${at} «${name}»: runtimeExecutable خارج قائمة السماح (${LAUNCH_RUNTIMES.join("، ")})`
  }
  const args = raw["runtimeArgs"] ?? []
  if (!Array.isArray(args) || args.length > ARGS_CAP || !args.every(cleanArg)) return `${at} «${name}»: runtimeArgs يجب أن تكون قائمةَ نصوصٍ قصيرة (≤${ARGS_CAP})`
  const port = raw["port"]
  if (!validPort(port)) return `${at} «${name}»: المنفذ يجب أن يكون عدداً صحيحاً بين 1024 و65535`
  let url = `http://127.0.0.1:${port}`
  if (raw["url"] !== undefined) {
    const given = raw["url"]
    let parsed: URL | undefined
    try { parsed = typeof given === "string" && given.length <= 2_048 ? new URL(given) : undefined } catch { parsed = undefined }
    if (parsed === undefined || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return `${at} «${name}»: url ليس رابط http(s) صالحاً`
    // رابطٌ محلّيّ يجب أن يكون أصلَ الخادم نفسِه على منفذه — لا مساراً ولا منفذاً آخر.
    if (/^(?:localhost|127\.0\.0\.1|\[::1\])$/iu.test(parsed.hostname)) {
      const urlPort = parsed.port === "" ? (parsed.protocol === "https:" ? 443 : 80) : Number.parseInt(parsed.port, 10)
      if (urlPort !== port) return `${at} «${name}»: منفذُ url (${urlPort}) يخالف port (${port})`
      if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") return `${at} «${name}»: url المحلّيّ يكون أصلَ الخادم فقط بلا مسار`
    }
    url = parsed.href
  }
  seen.add(name)
  return Object.freeze({ name, port, url, launch: Object.freeze([runtime.toLowerCase(), ...(args as string[])]) })
}

/**
 * يقرأ `.claude/launch.json` من مجلد المشروع. الغيابُ = لا إعدادات بلا مشكلة
 * (مشروعٌ بلا ملفٍّ حالةٌ عاديّة)، والتشويهُ = لا إعدادات **ومشكلةٌ مسمّاة**.
 */
export function readLaunchConfig(projectDir: string): LaunchConfigReading {
  const file = join(projectDir, LAUNCH_CONFIG_PATH)
  if (!existsSync(file)) return EMPTY
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return Object.freeze({ configs: Object.freeze([]), problems: Object.freeze([`${LAUNCH_CONFIG_PATH}: JSON مشوَّه — ${reason.slice(0, 120)}`]) })
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["configurations"])) {
    return Object.freeze({ configs: Object.freeze([]), problems: Object.freeze([`${LAUNCH_CONFIG_PATH}: يحتاج كائناً فيه قائمة configurations`]) })
  }
  const entries = parsed["configurations"] as unknown[]
  const configs: LaunchConfig[] = []
  const problems: string[] = []
  const seen = new Set<string>()
  for (const [index, raw] of entries.entries()) {
    if (configs.length >= LAUNCH_CONFIG_CAP) { problems.push(`${LAUNCH_CONFIG_PATH}: السقف ${LAUNCH_CONFIG_CAP} إعداداً — تُرك ما بعده`); break }
    const entry = readEntry(raw, index, seen)
    if (typeof entry === "string") problems.push(`${LAUNCH_CONFIG_PATH}: ${entry}`)
    else configs.push(entry)
  }
  return Object.freeze({ configs: Object.freeze(configs), problems: Object.freeze(problems) })
}

/** صفٌّ كما تراه اللوحة — الحالةُ ثلاثيّةٌ كلوح الخوادم: «يُقاس» ليست «متوقّف». */
export interface DevServerRow {
  readonly name: string
  readonly port: number
  readonly url: string
  readonly state: "measuring" | "up" | "down"
  /** المحرّكُ يملك عمليّته (فيُوقفه زرُّ ■ وإغلاقُ التبويب)؛ الخارجيُّ يُفتح ولا يُمَسّ. */
  readonly managed: boolean
  readonly why?: string
}

export interface DevServerLive {
  /** ما يديره المحرّك الآن (قياسُ `ManagedServers.measure`). */
  readonly managed: readonly MeasuredServer[]
  /** إعداداتٌ أجّر لها المحرّكُ منفذاً غيرَ المطلوب (المطلوبُ كان مشغولاً). */
  readonly leased: ReadonlyMap<string, number>
  /** إعداداتٌ طُلب تشغيلُها ولم يُحسم بعد — «يُقاس» بحقّ. */
  readonly starting: ReadonlySet<string>
  /** منافذُ وُجدت مُنصتةً بيدٍ غير يدنا. */
  readonly external: ReadonlySet<number>
}

/** المنفذُ الفعليُّ لإعدادٍ: المؤجَّرُ إن وُجد وإلا المطلوب. */
export const effectivePort = (config: LaunchConfig, leased: ReadonlyMap<string, number>): number =>
  leased.get(config.name) ?? config.port

/** يدمج الإعداداتِ بالقياس الحيّ إلى صفوفٍ — دالّةٌ صافية تُختبر بلا منافذ. */
export function mergeDevServerRows(configs: readonly LaunchConfig[], live: DevServerLive): readonly DevServerRow[] {
  return Object.freeze(configs.map((config) => {
    const port = effectivePort(config, live.leased)
    const url = port === config.port ? config.url : `http://127.0.0.1:${port}`
    const mine = live.managed.find((m) => m.port === port)
    if (mine !== undefined) {
      return Object.freeze({ name: config.name, port, url, state: mine.state, managed: true, ...(mine.why === undefined ? {} : { why: mine.why }) })
    }
    if (live.starting.has(config.name)) return Object.freeze({ name: config.name, port, url, state: "measuring" as const, managed: true })
    if (live.external.has(port)) return Object.freeze({ name: config.name, port, url, state: "up" as const, managed: false, why: "يعمل بيدٍ أخرى" })
    return Object.freeze({ name: config.name, port, url, state: "down" as const, managed: false })
  }))
}
