/**
 * ب7 — جسرُ كروم: خادمُ MCP مدمج (JSON-RPC على stdio كإخوته) يُطلقه المحرّكُ كمزوّدٍ خارجيّ، ومن الجهة الأخرى
 * مقبسُ WebSocket محلّيّ (127.0.0.1) برمزٍ لا يعرفه إلا المستخدم، تتّصل به **إضافةُ كروم** في متصفّح المستخدم
 * الحقيقيّ (`packages/browser-bridge/extension`). كلُّ أداةٍ يستدعيها النموذجُ تمرّ: المحرّك ⇦ MCP ⇦ هذا الجسر ⇦
 * الإضافة ⇦ الصفحة، ويعود الجوابُ الطريقَ نفسَه.
 *
 * ═══ لماذا جسرٌ لا وصلُ CDP بكروم المستخدم ═══
 * كرومُ المستخدم الجاري بلا منفذِ تنقيح، وإعادةُ إطلاقه بمنفذٍ يجعل ملفَّه كلَّه (جلساتُه، كوكيزُه) سطحَ وكيل.
 * الإضافةُ تعمل داخل نموذج أذونات كروم نفسِه: المستخدمُ يثبّتها ويرى شارةَ «يجري تنقيحُ هذا التبويب» عند كلّ
 * حدثِ إدخال، ويعزلها بنقرة.
 *
 * ═══ ما يُحرَس هنا لا في الإضافة ═══
 * - حقولُ الاعتماد (كلمة مرور/بطاقة/OTP/كابتشا): الحارسُ نفسُه `Surface.judge` — لا يُكتب فيها حرفٌ ولا يُطلب
 *   من الإضافة أن تكتب؛ الجوابُ يدلّ على التسليم للمستخدم.
 * - سياسةُ المواقع المحفوظة (`workspace-v1.json`) تُفرض على `open` قبل أن يصل الطلبُ الإضافةَ.
 * - لا إضافةَ موصولة ⇒ خطأٌ مسمّى لا صمت؛ رمزٌ خاطئ ⇒ إغلاقُ المقبس قبل أوّل رسالة.
 * - الردودُ نصٌّ فقط للنموذج (عقدُ MCP عندنا)؛ اللقطةُ تُحفظ ملفّاً على قرص المستخدم ويُعاد مسارُها — لا تُرسل.
 */
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, basename, join, resolve } from "node:path"
import { browserSiteAllowed } from "../browser-site-policy"
import { judge } from "../mind/surface"

export const CHROME_BRIDGE_PROTOCOL = "2025-11-25"
export const DEFAULT_BRIDGE_PORT = 9367
export const CALL_TIMEOUT_MS = 20_000
/** ن3 — ما لا يُرفع بالنيابة عن أحد مهما كان الطلب (نسخةُ الجسر من قاعدة المحرّك). */
export const UPLOAD_SECRET_FILE = /(^|[\\/])(\.env(\..*)?|\.npmrc|\.netrc|id_(rsa|ed25519|ecdsa)(\.pub)?|.*\.(pem|key|p12|pfx|kdbx)|secrets?\.(json|ya?ml|toml)|credentials(\.json)?)$/iu

type RpcId = string | number | null
type RpcRequest = { jsonrpc?: string; id?: RpcId; method?: string; params?: Record<string, unknown> }

export interface PageNode { readonly ref: string; readonly role: string; readonly name: string }

/** الأدواتُ كما تُعلَن للمحرّك — يسمّيها `chrome.<اسم>` بعد التطبيع. */
export const BRIDGE_TOOLS = Object.freeze([
  { name: "page", description: "قراءةُ الصفحة الفعّالة في كروم المستخدم شجرةً نصّيةً بمراجع (r1, r2…)", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "open", description: "فتحُ رابط http/https في التبويب الفعّال — يخضع لسياسة المواقع المحفوظة", inputSchema: { type: "object", properties: { url: { type: "string", minLength: 8, maxLength: 2048 } }, required: ["url"], additionalProperties: false } },
  { name: "look", description: "نصُّ الصفحة أو عنصرٍ بمرجعه مع أنماطه المحسوبة وحالةِ تركيزه", inputSchema: { type: "object", properties: { ref: { type: "string", maxLength: 12 } }, additionalProperties: false } },
  { name: "tap", description: "نقرةٌ موثوقة على عنصرٍ بمرجعه (عبر منقّح كروم — يرى المستخدم الشارة)", inputSchema: { type: "object", properties: { ref: { type: "string", minLength: 2, maxLength: 12 } }, required: ["ref"], additionalProperties: false } },
  { name: "fill", description: "كتابةٌ موثوقة في حقلٍ بمرجعه — حقولُ الاعتماد مرفوضةٌ وتُسلَّم للمستخدم", inputSchema: { type: "object", properties: { ref: { type: "string", minLength: 2, maxLength: 12 }, text: { type: "string", maxLength: 2000 } }, required: ["ref", "text"], additionalProperties: false } },
  { name: "key", description: "ضغطةُ مفتاحٍ باسمه (Enter, Tab, Escape, ArrowDown…)", inputSchema: { type: "object", properties: { key: { type: "string", minLength: 1, maxLength: 16 } }, required: ["key"], additionalProperties: false } },
  // ن3 (09-15) — قائمةٌ منسدلة ورفعُ ملفّ وسحبٌ في تبويب المستخدم؛ المسارُ المرفوع مطلقٌ حُكم في المحرّك (داخل المشروع، ليس سرّاً) ويُعاد فحصُه هنا.
  { name: "select", description: "اختيارُ خيارٍ في قائمةٍ منسدلة (select) بمرجعها: بالنصّ أو القيمة؛ يُقرأ ما استقرّ", inputSchema: { type: "object", properties: { ref: { type: "string", minLength: 2, maxLength: 12 }, text: { type: "string", minLength: 1, maxLength: 200 } }, required: ["ref", "text"], additionalProperties: false } },
  { name: "upload", description: "رفعُ ملفٍّ من قرص المستخدم إلى حقل ملفّ (input type=file) بمرجعه — مسارٌ مطلقٌ داخل المشروع، لا ملفّاتِ اعتماد", inputSchema: { type: "object", properties: { ref: { type: "string", minLength: 2, maxLength: 12 }, path: { type: "string", minLength: 1, maxLength: 1024 } }, required: ["ref", "path"], additionalProperties: false } },
  { name: "drag", description: "سحبُ عنصرٍ بمرجعه وإفلاتُه على عنصرٍ آخر بمرجعه (ماوسٌ موثوق + أحداثُ سحب HTML5)", inputSchema: { type: "object", properties: { from: { type: "string", minLength: 2, maxLength: 12 }, to: { type: "string", minLength: 2, maxLength: 12 } }, required: ["from", "to"], additionalProperties: false } },
  { name: "scroll", description: "تمريرٌ في الصفحة: up أو down بعدد شاشات", inputSchema: { type: "object", properties: { direction: { type: "string", enum: ["up", "down"] }, count: { type: "integer", minimum: 1, maximum: 10 } }, required: ["direction"], additionalProperties: false } },
  { name: "shot", description: "لقطةُ التبويب الفعّال تُحفظ PNG على قرص المستخدم ويُعاد مسارُها", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  // 2026-09-14 — تكافؤُ أدوات الفحص مع المتصفّح المملوك: تصميمُ الصفحة بالأرقام، عنصرٌ بمرجعه، قواعدُ CSS لمحدِّد، الأصول.
  { name: "inspect", description: "فحصُ الصفحة الفعّالة: styles (التصميم بالأرقام) | dom <ref> | css <selector> | assets — قراءةٌ بلا أثر", inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["styles", "dom", "css", "assets"] }, target: { type: "string", maxLength: 120 } }, required: ["mode"], additionalProperties: false } },
])

export interface BridgeOptions {
  readonly port?: number
  readonly token?: string
  /** ملفُّ الإعدادات — منه تُقرأ سياسةُ المواقع؛ غيابُه = لا سياسةَ محفوظة فيُفتح http/https فقط. */
  readonly settingsFile?: string
  /** مجلّدُ الحالة على قرص المستخدم: فيه `chrome-bridge.json` (المنفذُ والرمز) واللقطات. */
  readonly stateDir?: string
  /** أين تُحفظ اللقطات (الافتراض: `<stateDir>/chrome-shots`). */
  readonly shotsDir?: string
  readonly announce?: (line: string) => void
  /**
   * ب8 (أمرُ المالك 09-14: الاقترانُ آليّاً حين تكون الإضافةُ وعبدو كود مثبَّتين): نافذةُ اقترانٍ تُفتح عند الإقلاع
   * لهذه المدّة (الافتراض دقيقتان؛ 0 = لا تُفتح) وعند الطلب من المحرّك (`POST /pair/open` بالرمز). أثناءها يعطي
   * `GET /pair` المنفذَ والرمزَ لمن يطلبهما على 127.0.0.1 — الإضافةُ غيرُ المقترنة تسأل كلَّ ثوانٍ فتقترن بلا لصقٍ يدويّ.
   * خارجَها 423. النافذةُ محدودةٌ زمناً لأنّ أيَّ عمليّةٍ محلّيّة تستطيع السؤال؛ وكلُّ تسليمٍ يُعلَن باسم السائل.
   */
  readonly pairingWindowMs?: number
  /** بلا نبضٍ من الإضافة خلال هذه المدّة يُعدّ المقبسُ ميتاً ويُغلق (الافتراض ٤٥ ث؛ الإضافةُ تنبض كلَّ ٢٠ ث). */
  readonly staleMs?: number
}

interface Pending { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void; readonly timer: ReturnType<typeof setTimeout> }

/** الجسر: مقبسٌ للإضافة ونداءاتٌ مرقّمة بمهلة. لا يعرف MCP — تلك حلقةُ `serveChromeBridge`. */
export class ChromeBridge {
  readonly token: string
  readonly port: number
  #server: ReturnType<typeof Bun.serve> | undefined
  #socket: { send(data: string): void; close(): void } | undefined
  #pending = new Map<number, Pending>()
  #seq = 0
  #refs: readonly PageNode[] = []
  #generation = 1
  readonly #settingsFile: string | undefined
  readonly #stateDir: string
  readonly #shotsDir: string
  readonly #announce: (line: string) => void
  readonly #pairingWindowMs: number
  #pairingUntil = 0
  // ب8د (مقيس 09-15 على جهاز المالك): المقبسُ «مفتوحٌ» والإضافةُ ميتة (عاملُ الخدمة MV3 أُوقف) ⇦ `open` انتظر ٢٠ ث بلا ردّ و«connected» كذب.
  // النبضُ كلَّ ٢٠ ث من الإضافة يُبقي عاملَها حيّاً (كروم ≥116) ويجعل «متّصل» قياساً: بلا نبضٍ خلال staleMs المقبسُ ميتٌ ويُغلق.
  readonly #staleMs: number
  #lastSeen = 0

  constructor(options: BridgeOptions = {}) {
    this.port = options.port ?? DEFAULT_BRIDGE_PORT
    this.#pairingWindowMs = options.pairingWindowMs ?? 120_000
    this.#staleMs = options.staleMs ?? 45_000
    this.#settingsFile = options.settingsFile
    // الافتراضُ مجلّدُ المستخدم لا مجلّدُ العمل: ملفُّ الرمز لا يُكتب في جذر مستودعٍ أبداً (قيس: أثرُ اختبارٍ وصل التراكبَ فأُزيل).
    this.#stateDir = resolve(options.stateDir ?? process.env.ABDO_CODE_STATE_DIR ?? join(homedir(), ".abdo"))
    // الرمزُ ثابتٌ بين التشغيلات: يُقرأ من ملفّ الحالة إن وُجد صالحاً، فالمستخدمُ يقرن الإضافةَ مرّةً لا في كلّ جلسة.
    this.token = options.token ?? persistedToken(this.#stateDir) ?? randomBytes(18).toString("base64url")
    this.#shotsDir = options.shotsDir ?? join(this.#stateDir, "chrome-shots")
    this.#announce = options.announce ?? ((line) => process.stderr.write(`${line}\n`))
  }

  /** يفتح المقبس. الرمزُ يُفحص عند الترقية وحدها — لا رسالةَ تصل قبل مطابقته. */
  start(): number {
    const bridge = this
    this.#server = Bun.serve<{ ok: true }>({
      hostname: "127.0.0.1",
      port: this.port,
      fetch(request, server) {
        const url = new URL(request.url)
        if (url.pathname === "/health") return Response.json({ ok: true, connected: bridge.#socket !== undefined, pairing: bridge.pairingOpen })
        // ب8 — الاقترانُ الآليّ: داخل النافذة يُسلَّم المنفذُ والرمزُ لمن يسأل على 127.0.0.1 ويُعلَن التسليمُ باسم السائل؛ خارجَها 423 بلا تسريب.
        if (url.pathname === "/pair" && request.method === "GET") {
          if (!bridge.pairingOpen) return Response.json({ error: "pairing closed" }, { status: 423 })
          bridge.#announce(`chrome-bridge: pairing token handed to ${(request.headers.get("user-agent") ?? "unknown").slice(0, 120)}`)
          return Response.json({ port: bridge.#server?.port ?? bridge.port, token: bridge.token })
        }
        const presented = request.headers.get("x-abdo-bridge-token") ?? url.searchParams.get("token") ?? ""
        if (presented.length === 0 || presented.length !== bridge.token.length || !timingSafeEqualText(presented, bridge.token)) return new Response("forbidden", { status: 403 })
        if (url.pathname === "/pair/open" && request.method === "POST") { const until = bridge.openPairing(); return Response.json({ ok: true, until }) }
        if (bridge.#socket !== undefined) return new Response("an extension is already connected", { status: 409 })
        if (server.upgrade(request, { data: { ok: true } })) return
        return new Response("upgrade required", { status: 426 })
      },
      websocket: {
        open(socket) { bridge.#socket = socket; bridge.#lastSeen = Date.now(); bridge.#announce("chrome-bridge: extension connected") },
        message(_socket, raw) { bridge.#onMessage(String(raw)) },
        close() { bridge.#socket = undefined; bridge.#failAll(new Error("extension disconnected")); bridge.#announce("chrome-bridge: extension disconnected") },
      },
    })
    const port = this.#server.port ?? this.port
    if (this.#pairingWindowMs > 0) this.openPairing(this.#pairingWindowMs)
    // الرمزُ يصل المستخدمَ من ملفٍّ على قرصه لا من stderr (المحرّكُ يُهمل stderr خادمِ MCP): النافذةُ المنبثقة للإضافة
    // تطلب لصقَه، ولوحةُ الإعدادات تقرؤه من هنا. الملفُّ في مجلّد الحالة وحده.
    try {
      mkdirSync(this.#stateDir, { recursive: true })
      writeFileSync(join(this.#stateDir, "chrome-bridge.json"), `${JSON.stringify({ version: 1, port, token: this.token, pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`, "utf8")
    } catch { /* الملفُّ مساعِد: غيابُه لا يمنع الجسر، والمستخدمُ يرى الرمز في stderr إن شغّله بيده */ }
    this.#announce(`chrome-bridge: listening on ws://127.0.0.1:${port} — token ${this.token} (also in chrome-bridge.json)`)
    return port
  }

  stop(): void {
    this.#failAll(new Error("bridge stopped"))
    this.#socket?.close()
    this.#server?.stop(true)
    this.#server = undefined
  }

  /** «متّصل» قياسٌ لا حالة: مقبسٌ مفتوح **ونبضٌ حديث**؛ المقبسُ الذي صمت أطولَ من staleMs يُغلق ويُعدّ غيرَ متّصل. */
  get connected(): boolean {
    if (this.#socket === undefined) return false
    if (Date.now() - this.#lastSeen <= this.#staleMs) return true
    this.#announce(`chrome-bridge: extension silent for ${Math.round((Date.now() - this.#lastSeen) / 1000)}s — socket dropped`)
    try { this.#socket.close() } catch { /* ميتٌ أصلاً */ }
    this.#socket = undefined
    this.#failAll(new Error("extension stale"))
    return false
  }
  get refs(): readonly PageNode[] { return this.#refs }
  get pairingOpen(): boolean { return Date.now() < this.#pairingUntil }
  /** يفتح نافذةَ الاقتران (أو يمدّها) ويعيد لحظةَ إغلاقها. */
  openPairing(ms = 120_000): number { this.#pairingUntil = Date.now() + Math.max(0, ms); this.#announce(`chrome-bridge: pairing window open for ${Math.round(Math.max(0, ms) / 1000)}s`); return this.#pairingUntil }

  #onMessage(raw: string): void {
    let message: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown; kind?: unknown }
    try { message = JSON.parse(raw) } catch { return }
    this.#lastSeen = Date.now()
    if (message.kind === "ping") { try { this.#socket?.send(JSON.stringify({ kind: "pong", at: this.#lastSeen })) } catch { /* المقبسُ يُغلق */ } return }
    if (typeof message.id !== "number") return
    const pending = this.#pending.get(message.id)
    if (pending === undefined) return
    this.#pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.ok === true) pending.resolve(message.result)
    else pending.reject(new Error(typeof message.error === "string" ? message.error.slice(0, 300) : "extension error"))
  }

  #failAll(error: Error): void {
    for (const [id, p] of this.#pending) { clearTimeout(p.timer); p.reject(error); this.#pending.delete(id) }
  }

  /** نداءٌ خامّ إلى الإضافة — بلا حراسة؛ الحراسةُ في `run`. */
  send(action: string, args: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    // الاتّصالُ يُقاس لحظةَ الإرسال (النبض): مقبسٌ صامتٌ يُغلق هنا فيسمّى الخطأُ بدل انتظارٍ ٢٠ ث بلا ردّ.
    const socket = this.connected ? this.#socket : undefined
    if (socket === undefined) return Promise.reject(new Error("لا إضافةَ موصولة (أو صمتت أطولَ من المهلة) — افتح المتصفّح وسينبض عاملُ الإضافة ويعود، أو نفّذ: bridge pair"))
    const id = ++this.#seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.#pending.delete(id)) reject(new Error(`الإضافة لم تُجب ${action} خلال ${timeoutMs}ms`)) }, timeoutMs)
      timer.unref?.()
      this.#pending.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ id, action, args }))
    })
  }

  /** الأداةُ المحروسة: الحارسُ والسياسةُ هنا، والإضافةُ تنفّذ فقط. يعود نصّاً للنموذج. */
  async run(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case "page": {
        const nodes = await this.send("page", {})
        this.#refs = Array.isArray(nodes) ? nodes.filter(isNode).slice(0, 200) : []
        this.#generation += 1
        return this.#refs.length === 0 ? "صفحةٌ بلا عناصر قابلة للقيادة" : `جيل ${this.#generation} — ${this.#refs.length} عنصراً:\n${this.#refs.map((n) => `[${n.ref}] ${n.role}${n.name ? `: ${n.name}` : ""}`).join("\n")}`
      }
      case "open": {
        const url = String(args.url ?? "")
        const verdict = judge({ generation: this.#generation }, { kind: "navigate", url, origin: "operator" })
        if (!verdict.ok) return `العقد رفض: ${verdict.why}`
        if (this.#settingsFile !== undefined && !browserSiteAllowed(this.#settingsFile, url)) return "Navigation blocked by saved site permissions"
        await this.send("open", { url })
        this.#refs = []
        this.#generation += 1
        return `انتقلتُ في كروم المستخدم — الجيل ${this.#generation}، والمراجعُ القديمة بطلت. استعمل chrome.page لقراءة الصفحة.`
      }
      case "look": {
        const ref = typeof args.ref === "string" ? args.ref : ""
        if (ref.length > 0 && this.#node(ref) === undefined) return `مرجعٌ غير معروف «${ref}» — اقرأ الصفحة بـchrome.page أوّلاً`
        const text = await this.send("look", ref.length > 0 ? { ref } : {})
        return typeof text === "string" ? text.slice(0, 8000) : JSON.stringify(text).slice(0, 8000)
      }
      case "tap": {
        const ref = String(args.ref ?? ""); const node = this.#node(ref)
        if (node === undefined) return `مرجعٌ غير معروف «${ref}» — اقرأ الصفحة بـchrome.page أوّلاً`
        const verdict = judge({ generation: this.#generation }, { kind: "click", ref, generation: this.#generation })
        if (!verdict.ok) return `العقد رفض: ${verdict.why}`
        const tapped = await this.send("tap", { ref })
        return `نقرتُ «${node.name || node.role}» في متصفّح المستخدم ${inputMode(tapped)}.`
      }
      case "fill": {
        const ref = String(args.ref ?? ""); const node = this.#node(ref); const text = String(args.text ?? "")
        if (node === undefined) return `مرجعٌ غير معروف «${ref}» — اقرأ الصفحة بـchrome.page أوّلاً`
        const verdict = judge({ generation: this.#generation }, { kind: "type", ref, generation: this.#generation, text, field: `${node.name} ${node.role}` })
        // الحارسُ قبل الإرسال: حقلُ اعتمادٍ لا يصل الإضافةَ أصلاً.
        if (!verdict.ok) return `العقد رفض: ${verdict.why} — اطلب من المستخدم أن يكتبه بيده في كروم ثم يخبرك.`
        const filled = await this.send("fill", { ref, text })
        return `كتبتُ في «${node.name || node.role}» في متصفّح المستخدم ${inputMode(filled)}.`
      }
      case "key": {
        const key = String(args.key ?? "")
        if (!/^[A-Za-z]{1,16}$/.test(key)) return "الصيغة: key <Enter|Tab|Escape|…>"
        const pressed = await this.send("key", { key })
        return `ضغطتُ ${key} في متصفّح المستخدم ${inputMode(pressed)}.`
      }
      case "select": {
        const ref = String(args.ref ?? ""); const node = this.#node(ref); const text = String(args.text ?? "").trim()
        if (node === undefined) return `مرجعٌ غير معروف «${ref}» — اقرأ الصفحة بـchrome.page أوّلاً`
        if (text.length === 0) return "الصيغة: select {ref, text}"
        const verdict = judge({ generation: this.#generation }, { kind: "select", ref, generation: this.#generation, choice: text })
        if (!verdict.ok) return `العقد رفض: ${verdict.why}`
        const r = await this.send("select", { ref, text }) as { ok?: boolean; why?: string; picked?: string; value?: string; options?: string[] } | null
        if (r === null || r === undefined) return `تعذّر الاختيارُ في «${node.name || node.role}» — العنصرُ لم يعد في الصفحة؛ أعد chrome.page`
        if (r.ok !== true && r.why === "not-select") return `«${node.name || node.role}» ليس قائمةً منسدلةً أصليّة — افتحها بـtap ثمّ اختر الظاهرَ بـtap أو key`
        if (r.ok !== true) return `لا خيارَ يطابق «${text.slice(0, 40)}» في «${node.name || node.role}». الخياراتُ: ${(r.options ?? []).slice(0, 20).join(" | ")}`
        return `اخترتُ «${r.picked ?? ""}» (القيمة «${String(r.value ?? "").slice(0, 40)}») في «${node.name || node.role}» في متصفّح المستخدم وقرأتُ القائمةَ بعدها.`
      }
      case "upload": {
        const ref = String(args.ref ?? ""); const node = this.#node(ref); const path = String(args.path ?? "")
        if (node === undefined) return `مرجعٌ غير معروف «${ref}» — اقرأ الصفحة بـchrome.page أوّلاً`
        if (!isAbsolute(path) || !existsSync(path) || UPLOAD_SECRET_FILE.test(path)) return `رُفض الرفع: المسارُ ليس مطلقاً موجوداً غيرَ سرّيّ — ${path.slice(0, 120)}`
        const verdict = judge({ generation: this.#generation }, { kind: "upload", ref, generation: this.#generation, file: basename(path) })
        if (!verdict.ok) return `العقد رفض: ${verdict.why}`
        const r = await this.send("upload", { ref, path }) as { ok?: boolean; why?: string; files?: string[] } | null
        if (r === null || r === undefined) return `تعذّر الرفعُ إلى «${node.name || node.role}» — العنصرُ لم يعد في الصفحة؛ أعد chrome.page`
        if (r.ok !== true) return r.why === "not-file" ? `«${node.name || node.role}» ليس حقلَ ملفّ (input type=file)` : `تعذّر الرفع: ${r.why ?? ""}`
        return `رفعتُ «${basename(path)}» إلى «${node.name || node.role}» في متصفّح المستخدم وقرأتُ الحقلَ بعدها: ${(r.files ?? []).join("، ")}.`
      }
      case "drag": {
        const from = String(args.from ?? ""); const to = String(args.to ?? ""); const a = this.#node(from); const b = this.#node(to)
        if (a === undefined || b === undefined) return `مرجعٌ غير معروف «${a === undefined ? from : to}» — اقرأ الصفحة بـchrome.page أوّلاً`
        const verdict = judge({ generation: this.#generation }, { kind: "drag", ref: from, to, generation: this.#generation })
        if (!verdict.ok) return `العقد رفض: ${verdict.why}`
        const r = await this.send("drag", { from, to })
        return `سحبتُ «${a.name || a.role}» وأفلتُّه على «${b.name || b.role}» في متصفّح المستخدم ${inputMode(r)}.`
      }
      case "scroll": {
        const direction = args.direction === "up" ? "up" : "down"
        const count = Math.min(10, Math.max(1, Number(args.count) || 1))
        await this.send("scroll", { direction, count })
        return `مرّرتُ ${direction} ×${count} في كروم المستخدم.`
      }
      case "inspect": {
        const mode = String(args.mode ?? "styles")
        if (!["styles", "dom", "css", "assets"].includes(mode)) return "الصيغة: inspect {mode: styles|dom|css|assets, target?}"
        const target = typeof args.target === "string" ? args.target.slice(0, 120) : ""
        if (mode === "dom" && this.#node(target) === undefined) return `مرجعٌ غير معروف «${target}» — اقرأ الصفحة بـchrome.page أوّلاً`
        const raw = await this.send("inspect", { mode, target })
        const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? "")
        const label = mode === "styles" ? "تصميمُ الصفحة" : mode === "dom" ? `عنصرُ ${target}` : mode === "css" ? "قواعدُ CSS المطابقة" : "أصولُ الصفحة"
        return text.length === 0 ? `${label}: لا شيء — ${mode === "dom" ? "المرجعُ لم يعد في الصفحة" : "الصفحةُ لم تُعطِ شيئاً"}` : `${label} (تبويبُ المستخدم، جيل ${this.#generation}):\n${text.slice(0, 7000)}`
      }
      case "shot": {
        const dataUrl = await this.send("shot", {})
        const data = typeof dataUrl === "string" && dataUrl.startsWith("data:image/png;base64,") ? dataUrl.slice("data:image/png;base64,".length) : ""
        if (data.length === 0) return "تعذّرت اللقطة — الإضافة لم تُعطِ صورة"
        mkdirSync(this.#shotsDir, { recursive: true })
        const file = join(this.#shotsDir, `chrome-${Date.now()}.png`)
        writeFileSync(file, Buffer.from(data, "base64"))
        return `حُفظت لقطةُ التبويب على قرصك: ${file} (${Math.round(data.length * 3 / 4)} بايت) — لا تُرسل إلى أحد.`
      }
      default:
        return `أداةُ جسرٍ مجهولة: ${name}`
    }
  }

  #node(ref: string): PageNode | undefined { return this.#refs.find((n) => n.ref === ref) }
}

/** رمزُ اقترانٍ سابق من `chrome-bridge.json` — نصٌّ base64url بطول ٢٤ فأكثر، وإلا لا شيء. */
export function persistedToken(stateDir: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, "chrome-bridge.json"), "utf8")) as { token?: unknown }
    return typeof parsed.token === "string" && /^[A-Za-z0-9_-]{24,64}$/.test(parsed.token) ? parsed.token : undefined
  } catch { return undefined }
}

/** ما تعرضه لوحةُ الإعدادات: المنفذُ والرمزُ من ملفّ الحالة — أو لا شيء إن لم يُشغَّل الجسر بعد. */
export function readBridgePairing(stateDir: string): { port: number; token: string; startedAt: string } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, "chrome-bridge.json"), "utf8")) as { port?: unknown; token?: unknown; startedAt?: unknown }
    if (typeof parsed.port !== "number" || typeof parsed.token !== "string") return undefined
    return { port: parsed.port, token: parsed.token, startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "" }
  } catch { return undefined }
}

/** الإضافةُ تعلن كيف أُدخل الفعل: `trusted` عبر المنقّح (كروم/إيدج) أو `synthetic` بأحداث DOM (سفاري) — والنموذجُ يُخبَر بالفرق. */
const inputMode = (reply: unknown): string => {
  const mode = typeof reply === "object" && reply !== null ? (reply as { mode?: unknown }).mode : undefined
  return mode === "synthetic" ? "بأحداثٍ اصطناعية (سفاري — قد لا تراها بعضُ الصفحات)" : "بإدخالٍ موثوق"
}

const isNode = (v: unknown): v is PageNode => typeof v === "object" && v !== null && typeof (v as PageNode).ref === "string" && typeof (v as PageNode).role === "string" && typeof (v as PageNode).name === "string"

function timingSafeEqualText(a: string, b: string): boolean {
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** حلقةُ MCP على stdio — كإخوتها: initialize، tools/list، tools/call، ping. تعود برمز الخروج. */
export async function serveChromeBridge(options: BridgeOptions = {}, input: AsyncIterable<string> = console, output: (line: string) => void = (line) => console.log(line)): Promise<number> {
  const bridge = new ChromeBridge(options)
  try { bridge.start() } catch (error) { process.stderr.write(`chrome-bridge: ${String(error)}\n`); return 2 }
  const emit = (value: object) => output(JSON.stringify(value))
  const result = (id: RpcId, value: unknown) => emit({ jsonrpc: "2.0", id, result: value })
  const failure = (id: RpcId, code: number, message: string) => emit({ jsonrpc: "2.0", id, error: { code, message } })
  try {
    for await (const line of input) {
      if (line.trim().length === 0) continue
      let request: RpcRequest
      try { request = JSON.parse(line) } catch { failure(null, -32700, "Parse error"); continue }
      if (request.jsonrpc !== "2.0" || typeof request.method !== "string") { if (request.id !== undefined) failure(request.id, -32600, "Invalid Request"); continue }
      if (request.method === "notifications/initialized") continue
      const id = request.id ?? null
      if (request.method === "initialize") {
        const requested = (request.params as { protocolVersion?: unknown } | undefined)?.protocolVersion
        result(id, { protocolVersion: typeof requested === "string" ? requested : CHROME_BRIDGE_PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "abdocode-chrome-bridge", version: "0.1.0" } })
        continue
      }
      if (request.method === "tools/list") { result(id, { tools: BRIDGE_TOOLS }); continue }
      if (request.method === "ping") { result(id, {}); continue }
      if (request.method !== "tools/call") { failure(id, -32601, "Method not found"); continue }
      const name = request.params?.name
      const args = (request.params?.arguments ?? {}) as Record<string, unknown>
      if (typeof name !== "string" || !BRIDGE_TOOLS.some((t) => t.name === name)) { failure(id, -32602, "Invalid tool arguments"); continue }
      try {
        result(id, { content: [{ type: "text", text: await bridge.run(name, args) }] })
      } catch (cause) {
        result(id, { isError: true, content: [{ type: "text", text: String(cause instanceof Error ? cause.message : cause) }] })
      }
    }
    return 0
  } finally {
    bridge.stop()
  }
}

/** الوسيطان: مجلّدُ الحالة ثم المنفذ — كي لا يعتمد الإطلاقُ على بيئةٍ لا يمرّرها عميلُ MCP. */
export function bridgeOptionsFromArgs(args: readonly string[], env: Record<string, string | undefined> = process.env): BridgeOptions {
  const stateDir = args[0] && args[0].length > 0 ? args[0] : env.ABDO_CODE_STATE_DIR
  const portText = args[1] ?? env.ABDO_CHROME_BRIDGE_PORT
  const port = Number(portText ?? DEFAULT_BRIDGE_PORT)
  return { port: Number.isInteger(port) && port >= 0 && port <= 65535 ? port : DEFAULT_BRIDGE_PORT, token: env.ABDO_CHROME_BRIDGE_TOKEN, settingsFile: env.ABDO_CODE_SETTINGS, ...(stateDir === undefined ? {} : { stateDir }) }
}

if (import.meta.main) {
  process.exitCode = await serveChromeBridge(bridgeOptionsFromArgs(process.argv.slice(2)))
}
