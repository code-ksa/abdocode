/**
 *
 * المشكلةُ المقيسة: المتصفّحُ المملوك كان يُطلَق بملفٍّ مؤقّتٍ لكلّ تشغيل، فكلُّ إعادةِ فتحٍ للتطبيق خروجٌ من كلّ
 * حساب. الحلُّ طبقتان: ملفُّ متصفّحٍ دائم تحت دليل حالة المحرّك (يملكه المطلِق)، وفوقه **حالةُ تخزينٍ مصدَّرة**
 * لكلّ أصل (كعكاتٌ + مخزنُ الأصل) تُحفظ بعد أوّل تحميلٍ ناجح يلي صفحةَ دخول، وتُستعاد قبل التنقّل حين يخلو
 * الملفُّ من كعكات الأصل. لا كلمةَ سرٍّ تُخزَّن ولا تُكتب هنا أبداً — الدخولُ بيد المستخدم مرّةً واحدة.
 *
 * قيمُ الكعكات لا تغادر القرص: القوائمُ والإيصالاتُ تذكر الأعدادَ والأصولَ والأعمارَ فقط.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export interface SessionCookie {
  readonly name: string
  readonly value: string
  readonly domain: string
  readonly path: string
  readonly expires?: number
  readonly httpOnly?: boolean
  readonly secure?: boolean
  readonly sameSite?: "Strict" | "Lax" | "None"
}

/** حالةُ تخزينِ أصلٍ واحد: كعكاتُه وما في مخزنه المحلّيّ. */
export interface OriginStorageState {
  readonly origin: string
  readonly cookies: readonly SessionCookie[]
  readonly storage: Readonly<Record<string, string>>
}

export interface SessionRecord {
  readonly origin: string
  readonly lastLoginOk: boolean
  readonly lastSeen: number
  readonly loginUrl?: string
  readonly storageStateFile: string
  readonly cookies: number
}

export interface HistoryEntry {
  readonly url: string
  readonly title: string
  readonly at: number
  readonly sessionOrigin?: string
}

export const HISTORY_CAP = 200
export const SESSIONS_DIR = "browser-sessions"
export const HISTORY_FILE = "browser-history.json"
export const PROFILE_DIR = "browser-profile"

const LOGIN_HOSTS = ["accounts.google.com", "login.microsoftonline.com", "auth.openai.com", "auth0.openai.com", "login.live.com", "github.com/login"]
const LOGIN_PATH = /\/(?:login|log-in|signin|sign-in|sign_in|auth|oauth|sso|session\/new)(?:\/|$|\?)/iu
const LOGIN_QUERY = ["callbackUrl", "callbackurl", "returnTo", "return_to", "redirect_uri", "continue", "next"]

/** أصلُ رابطٍ http(s) — وغيرُه لا أصلَ له (about:blank، file:، chrome:). */
export const originOf = (url: string): string | undefined => {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined
    return parsed.origin
  } catch { return undefined }
}

/** بصمةُ الأصل لاسم الملفّ — لا أصلَ خامٌ في أسماء الملفّات (منافذُ ونقاطٌ وحروفُ حالة). */
export const originHash = (origin: string): string => createHash("sha256").update(origin.toLowerCase()).digest("hex").slice(0, 24)

/** صفحةُ دخولٍ من رابطها: مسارٌ معروف، أو استعلامُ عودةٍ بعد الدخول، أو مضيفُ هويّةٍ معروف. */
export const isLoginUrl = (url: string): boolean => {
  let parsed: URL
  try { parsed = new URL(url) } catch { return false }
  const hostPath = `${parsed.hostname}${parsed.pathname}`.toLowerCase()
  if (LOGIN_HOSTS.some((h) => hostPath === h || hostPath.startsWith(`${h}/`))) return true
  if (LOGIN_PATH.test(parsed.pathname)) return true
  for (const key of LOGIN_QUERY) if (parsed.searchParams.has(key)) return true
  return false
}

/** حقلُ كلمةِ سرٍّ في شجرة الصفحة: عقدةُ إدخالٍ موسومةٌ حسّاسةً (النوعُ لا النصّ). */
export const passwordFieldInTree = (nodes: readonly { readonly role: string; readonly sensitive?: boolean; readonly children?: readonly unknown[] }[]): boolean => {
  for (const node of nodes) {
    if (node.sensitive === true && /textbox|input|password/iu.test(node.role)) return true
    if (Array.isArray(node.children) && passwordFieldInTree(node.children as typeof nodes)) return true
  }
  return false
}

export type LoginVerdict = { readonly login: true; readonly why: "url" | "password-field" } | { readonly login: false }

/** حكمُ «صفحةُ دخول»: بالرابط أوّلاً (أرخص)، ثمّ بحقل كلمة السرّ إن قِيس. */
export const loginPageVerdict = (page: { readonly url: string; readonly passwordField?: boolean }): LoginVerdict => {
  if (isLoginUrl(page.url)) return { login: true, why: "url" }
  if (page.passwordField === true) return { login: true, why: "password-field" }
  return { login: false }
}

/** سطرُ الإيصال الذي يراه النموذج حين يحطّ التنقّلُ على صفحة دخول. */
export const loginReceipt = (origin: string, restored: boolean): string =>
  restored ? `جلسةٌ محفوظة لـ ${origin} استُعيدت ⇦ أعد التحميل` : "لا جلسةَ محفوظة — اطلب من المستخدم الدخول مرّةً واحدة ثمّ `sessions save`"

const ageText = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) return "الآن"
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return "الآن"
  if (minutes < 60) return `${minutes} د`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} س`
  return `${Math.floor(hours / 24)} ي`
}

const readJson = <T>(file: string, fallback: T): T => {
  try { return JSON.parse(readFileSync(file, "utf8")) as T } catch { return fallback }
}

const writeJsonAtomic = (file: string, value: unknown): void => {
  const staging = `${file}.${process.pid}.tmp`
  writeFileSync(staging, JSON.stringify(value, null, 2), "utf8")
  renameSync(staging, file)
}

/**
 * مخزنُ الجلسات: فهرسٌ واحد (`index.json`) وملفُّ حالةٍ لكلّ أصل باسم بصمته. الحفظُ ذرّيّ، والنسيانُ يسمّي ما حُذف.
 * «الحملُ الأخير كان دخولاً» يُتتبَّع في الذاكرة لكلّ أصل كي يُحفظ أوّلُ تحميلٍ ناجحٍ بعده.
 */
export class BrowserSessionStore {
  readonly dir: string
  readonly #index: string
  /** الحملُ الأخير في المتصفّح كلِّه كان صفحةَ دخول؟ — عامٌّ لا لكلّ أصل: الدخولُ يقع على accounts.google.com ويحطّ على الأصل المقصود. */
  #lastWasLogin = false
  constructor(stateDir: string, private readonly now: () => number = Date.now) {
    this.dir = join(stateDir, SESSIONS_DIR)
    this.#index = join(this.dir, "index.json")
  }

  #records(): SessionRecord[] {
    const raw = readJson<{ records?: unknown }>(this.#index, {})
    return Array.isArray(raw.records) ? raw.records.filter((r): r is SessionRecord => typeof r === "object" && r !== null && typeof (r as SessionRecord).origin === "string") : []
  }

  #write(records: readonly SessionRecord[]): void {
    mkdirSync(this.dir, { recursive: true })
    writeJsonAtomic(this.#index, { version: 1, records })
  }

  fileFor(origin: string): string { return join(this.dir, `${originHash(origin)}.json`) }

  list(): readonly SessionRecord[] { return this.#records().sort((a, b) => b.lastSeen - a.lastSeen) }

  get(origin: string): SessionRecord | undefined { return this.#records().find((r) => r.origin === origin) }

  /** يحفظ حالةَ الأصل ويعيد مسارَ ملفّها — الفهرسُ يذكر عددَ الكعكات لا قيمَها. */
  save(origin: string, state: OriginStorageState, meta: { readonly loginOk: boolean; readonly loginUrl?: string }): string {
    mkdirSync(this.dir, { recursive: true })
    const file = this.fileFor(origin)
    writeJsonAtomic(file, { version: 1, origin, savedAt: this.now(), cookies: state.cookies, storage: state.storage })
    const record: SessionRecord = { origin, lastLoginOk: meta.loginOk, lastSeen: this.now(), storageStateFile: file, cookies: state.cookies.length, ...(meta.loginUrl !== undefined ? { loginUrl: meta.loginUrl } : {}) }
    this.#write([...this.#records().filter((r) => r.origin !== origin), record])
    this.#lastWasLogin = false
    return file
  }

  /** الحالةُ المحفوظة للأصل — أو لا شيء: حالةٌ فارغة «تُستعاد» وتترك الوكيلَ خارجاً وهو يظنّ أنّه استعاد. */
  stateFor(origin: string): OriginStorageState | undefined {
    const record = this.get(origin)
    if (record === undefined || !existsSync(record.storageStateFile)) return undefined
    const raw = readJson<{ cookies?: unknown; storage?: unknown }>(record.storageStateFile, {})
    const cookies = Array.isArray(raw.cookies) ? (raw.cookies as SessionCookie[]).filter((c) => typeof c?.name === "string" && typeof c.value === "string") : []
    const storage = typeof raw.storage === "object" && raw.storage !== null ? (raw.storage as Record<string, string>) : {}
    if (cookies.length === 0 && Object.keys(storage).length === 0) return undefined
    return { origin, cookies, storage }
  }

  markSeen(origin: string, loginOk: boolean): void {
    const records = this.#records()
    const current = records.find((r) => r.origin === origin)
    if (current === undefined) return
    this.#write([...records.filter((r) => r.origin !== origin), { ...current, lastLoginOk: loginOk, lastSeen: this.now() }])
  }

  /** ينسى الأصلَ: يحذف ملفَّ حالته ويسمّيه، ويُسقطه من الفهرس. الغائبُ يُقال غائباً. */
  forget(origin: string): { readonly ok: boolean; readonly deleted: readonly string[]; readonly why?: string } {
    const record = this.get(origin)
    const file = record?.storageStateFile ?? this.fileFor(origin)
    const deleted: string[] = []
    if (existsSync(file)) { rmSync(file, { force: true }); deleted.push(file) }
    if (record !== undefined) this.#write(this.#records().filter((r) => r.origin !== origin))
    if (record === undefined && deleted.length === 0) return { ok: false, deleted, why: `لا جلسةَ محفوظة لـ ${origin}` }
    return { ok: true, deleted }
  }

  /**
   * حطّ التنقّلُ على صفحة: يعيد «احفظ الآن» حين كان الحملُ السابق (على أيّ أصل) صفحةَ دخول وهذا ليس كذلك —
   * أي أنّ الدخولَ تمّ للتوّ. غيرُ ذلك لا حفظَ تلقائيّاً (الحفظُ الصريح بـ`sessions save`).
   */
  noteLanding(_origin: string, login: boolean): { readonly save: boolean } {
    const previous = this.#lastWasLogin
    this.#lastWasLogin = login
    return { save: previous && !login }
  }

  render(now: number = this.now()): string {
    const rows = this.list()
    if (rows.length === 0) return "لا جلساتٍ محفوظة. بعد دخولٍ ناجح تُحفظ تلقائيّاً، أو اكتب: sessions save <أصل>"
    const lines = rows.map((r, i) => `${i + 1}. ${r.origin} · ${r.lastLoginOk ? "دخولٌ صالح" : "يحتاج دخولاً"} · ${r.cookies} كعكة · منذ ${ageText(now - r.lastSeen)}`)
    return `${rows.length} جلسة محفوظة (الأحدث أوّلاً):\n${lines.join("\n")}\nاستعد بـ«sessions restore <أصل>»، احفظ بـ«sessions save <أصل>»، انسَ بـ«sessions forget <أصل>».`
  }
}

/** تاريخُ التبويبات: آخرُ ٢٠٠ زيارة، الأحدثُ أوّلاً، ملفٌّ واحد تحت دليل الحالة. */
export class BrowserHistory {
  readonly file: string
  #entries: HistoryEntry[] | undefined
  constructor(stateDir: string, private readonly cap: number = HISTORY_CAP) {
    this.file = join(stateDir, HISTORY_FILE)
  }

  #load(): HistoryEntry[] {
    if (this.#entries === undefined) {
      const raw = readJson<{ entries?: unknown }>(this.file, {})
      this.#entries = Array.isArray(raw.entries) ? raw.entries.filter((e): e is HistoryEntry => typeof e === "object" && e !== null && typeof (e as HistoryEntry).url === "string" && typeof (e as HistoryEntry).at === "number") : []
    }
    return this.#entries
  }

  /** يسجّل زيارةً؛ about:blank وغيرُ http لا يُسجَّل؛ تكرارُ آخرِ رابطٍ يحدّث زمنَه وعنوانَه بدل سطرٍ جديد. */
  record(entry: HistoryEntry): void {
    if (originOf(entry.url) === undefined) return
    const entries = this.#load()
    const title = entry.title.slice(0, 200)
    if (entries[0]?.url === entry.url) entries[0] = { ...entries[0], title: title || entries[0].title, at: entry.at }
    else entries.unshift({ ...entry, title })
    if (entries.length > this.cap) entries.length = this.cap
    mkdirSync(join(this.file, ".."), { recursive: true })
    writeJsonAtomic(this.file, { version: 1, entries })
  }

  entries(): readonly HistoryEntry[] { return [...this.#load()] }

  pick(n: number): HistoryEntry | undefined { return Number.isInteger(n) && n >= 1 ? this.#load()[n - 1] : undefined }

  render(limit = 30, now: number = Date.now()): string {
    const entries = this.#load()
    if (entries.length === 0) return "لا تاريخَ بعد — كلُّ تنقّلٍ في متصفّح الوكيل يُسجَّل هنا."
    const shown = entries.slice(0, Math.max(1, limit))
    return `${entries.length} زيارة (الأحدث أوّلاً):\n${shown.map((e, i) => `${i + 1}. ${e.title || "(بلا عنوان)"} — ${e.url} · منذ ${ageText(now - e.at)}`).join("\n")}${entries.length > shown.length ? `\n… و${entries.length - shown.length} غيرها` : ""}\nأعد فتحَ سطرٍ بـ«history open <رقم>».`
  }
}

export type SessionsCommand =
  | { readonly ok: true; readonly verb: "list" }
  | { readonly ok: true; readonly verb: "save" | "forget" | "restore"; readonly origin: string }
  | { readonly ok: false; readonly why: string }

const SESSIONS_USAGE = "الصيغة: sessions [list | save <أصل أو رابط> | forget <أصل> | restore <أصل>]"

/** يُحلّل أمرَ sessions؛ الأصلُ يُطبَّع من أيّ رابط http(s) إلى أصله. */
export const sessionsCommand = (rest: string): SessionsCommand => {
  const [verb = "list", ...more] = rest.trim().split(/\s+/u).filter((w) => w.length > 0)
  if (verb === "" || verb === "list") return { ok: true, verb: "list" }
  if (verb !== "save" && verb !== "forget" && verb !== "restore") return { ok: false, why: SESSIONS_USAGE }
  const raw = more[0] ?? ""
  const origin = originOf(/^https?:\/\//iu.test(raw) ? raw : `https://${raw}`)
  if (raw.length === 0 || origin === undefined) return { ok: false, why: `${SESSIONS_USAGE} — الأصلُ مثل https://chatgpt.com` }
  return { ok: true, verb, origin }
}

export type HistoryCommand = { readonly ok: true; readonly verb: "list" } | { readonly ok: true; readonly verb: "open"; readonly n: number } | { readonly ok: false; readonly why: string }

export const historyCommand = (rest: string): HistoryCommand => {
  const [verb = "list", arg = ""] = rest.trim().split(/\s+/u)
  if (verb === "" || verb === "list") return { ok: true, verb: "list" }
  if (verb === "open") {
    const n = Number.parseInt(arg, 10)
    if (!Number.isInteger(n) || n < 1) return { ok: false, why: "الصيغة: history open <رقم من القائمة>" }
    return { ok: true, verb: "open", n }
  }
  return { ok: false, why: "الصيغة: history [list | open <رقم>]" }
}
