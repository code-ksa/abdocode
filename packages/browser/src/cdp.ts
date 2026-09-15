
/**
 * T16 — موفّر المتصفّح عبر CDP.
 *
 * المرجع `webview-cdp-diagnostics`: قناةٌ تقرأ الصفحة الحيّة وتشغّل JS من
 * ويندوز، بلا لقطاتٍ أولاً وبلا بابٍ خلفيّ في المنتج. الموفّر هنا يملأ عقد
 * T15 ولا يقرّر شيئاً: القرارُ في `Surface.judge`، والتنفيذُ هنا.
 *
 * القراءة **شجرةٌ نصّية أولاً** لا صورة: أرخص للنموذج، وأدقّ للمرجع،
 * وتُبقي الإحداثيات آخر الملاذات (نصّ الوعي: الرؤية والإحداثيات المحدودة
 * ملاذٌ أخير).
 */

import { stripChildEnv } from "@abdo/tools/env-strip"

/** رسالةُ طرفيّةٍ من الصفحة كما وصلت — بلا تفسير: المستوى والنصّ ومصدرُه وزمنُه. */
export interface CdpConsoleMessage {
  readonly level: string
  readonly text: string
  readonly source: string
  readonly at: number
}

/** سقفُ حلقة الرسائل: الصفحاتُ الثرثارة تملأ الذاكرة، والأحدثُ هو المفيد. */
const CONSOLE_BUFFER = 200

/**
 * ذ9ز — طلبُ شبكةٍ كما وقع: **بلا ترويسةٍ ولا جسم**. سياسةُ التنقّل في هذا الملفّ لا تنقل الترويسات ولا الحمولات،
 * وقراءةُ الطلبات لا تنقض ذلك: طريقةٌ ورابطٌ وحالةٌ (أو سببُ فشل) ونوعٌ وزمن — يكفي لتشخيص «لماذا لا تظهر البيانات».
 */
export interface CdpNetworkEvent {
  readonly method: string
  readonly url: string
  readonly type: string
  readonly status?: number
  readonly failure?: string
  readonly at: number
}

const NETWORK_BUFFER = 200

export interface CdpPageNode {
  readonly ref: string
  readonly role: string
  readonly name: string
  /** ب9 — حقلُ اعتمادٍ معروفٌ من نوعه لا من نصّه (password/one-time-code/cc-*): قيمتُه **لا تُقرأ أصلاً**. */
  readonly sensitive?: boolean
  readonly children?: readonly CdpPageNode[]
}

/**
 * ب9 — موضعُ مرجعٍ **مع هويّته**: الإحداثيّتان وحدهما كانتا تكذبان — عنصرٌ انطوى يعطي (0,0) فتقع نقرةٌ موثوقةٌ
 * في زاوية الصفحة، وعنصرٌ يغطّيه آخر يعطي موضعاً صحيحاً لعنصرٍ خاطئ. فيعود معهما: المقاسُ (صفرٌ = لم يعد ظاهراً)،
 * وهل مركزُه داخل العرض، وهل ما تحت النقطة هو هو (`elementFromPoint`)، ودورُه واسمُه ليُقارَنا بما وافق عليه المستخدم.
 */
export interface CdpRefLocation {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly inView: boolean
  readonly hit: boolean
  readonly role: string
  readonly name: string
  readonly sensitive: boolean
}

/** ن3 — نتيجةُ اختيار خيارٍ في قائمةٍ منسدلة: ما اختير فعلاً كما تقرؤه الصفحة، أو سببُ الرفض مع الخيارات المتاحة. */
export type CdpSelectResult =
  | { readonly ok: true; readonly picked: string; readonly value: string; readonly index: number; readonly total: number }
  | { readonly ok: false; readonly why: "not-select" | "no-option"; readonly role: string; readonly options: readonly string[] }

/** ن3 — نتيجةُ رفع ملفّ: أسماءُ ما استقرّ في الحقل كما تقرؤه الصفحة، أو سببُ الرفض. */
export type CdpUploadResult = { readonly ok: true; readonly files: readonly string[] } | { readonly ok: false; readonly why: "not-file" | "missing" }
interface CdpTarget {
  id: string
  webSocketDebuggerUrl: string
  url: string
  type: string
}

/** Start the concrete browser adapter. Process creation is owned here, not by
 * the engine shell, so there is one browser implementation and one launch
 * boundary. The caller still supplies the approved executable and arguments. */
export function launchBrowserProcess(executable: string, args: readonly string[]): number {
  // حدُّ التشغيل يملك خلقَ العمليّة، فيملك تجريدَ بيئتها. متصفّحٌ يرث
  // `ABDO_SHELL_TOKEN` يسلّمه لكلّ إضافةٍ تقرأ بيئتها. (مقيس 2026-09-04.)
  const child = Bun.spawn([executable, ...args], {
    stdout: "ignore", stderr: "ignore",
    env: stripChildEnv(process.env).env,
  })
  child.unref()
  return child.pid
}

/** ب3 — أكوادُ المفاتيح المدعومة (Windows virtual-key): ما ليس هنا لا يُرسل. */
const KEY_CODES: Readonly<Record<string, number>> = Object.freeze({
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Space: 32, Home: 36, End: 35, PageUp: 33, PageDown: 34,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
})

/**
 * ب9 — الدوالُّ المشتركة بين قراءة الشجرة وتحديد الموضع: **تعريفٌ واحد** كي لا يفترق ما يراه النموذج عمّا يُنقر.
 *
 * وفيها القاعدةُ التي لم تكن: **حقلُ الاعتماد يُعرف من نوعه لا من نصّه** (`type=password`، و`autocomplete`
 * من عائلة كلمة المرور والرمز والبطاقة) — وقيمتُه **لا تُقرأ أصلاً**، فلا تصل النموذجَ ولا السجلّ ولا المزوّد.
 * كان `label()` يبدأ بـ`el.value`، فكلمةُ المرور التي كتبها المستخدم بيده عبر `handoff` كانت تعود إلينا في أوّل `page`.
 */
const TREE_HELPERS = `
  const secret = (el) => {
    const t = ((el.type || "") + "").toLowerCase()
    const ac = ((el.getAttribute && el.getAttribute("autocomplete")) || "").toLowerCase()
    return t === "password" || /(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp|cc-name)/.test(ac)
  }
  const named = (el) => (el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name"))) || ""
  const label = (el) => {
    if (secret(el)) return (named(el) || "حقلٌ سرّيّ") + ((el.value || "").length > 0 ? " ••• (مملوء)" : " (فارغ)")
    const typed = (el.value || "").trim()
    if (typed) return typed.slice(0, 80)
    return named(el) || (el.innerText || "").trim().slice(0, 80)
  }
  const role = (el) => {
    const t = el.tagName.toLowerCase()
    if (t === "a") return "link"
    if (t === "button" || (t === "input" && el.type === "button")) return "button"
    if (t === "input") return "textbox:" + (el.type || "text")
    if (t === "textarea") return "textbox"
    if (t === "select") return "combobox"
    if (/^h[1-6]$/.test(t)) return "heading"
    return t
  }
`

/**
 * يقرأ شجرة الوصول من الصفحة عبر JS — أرخص من بروتوكول a11y وكافٍ لنا.
 *
 * ب9 — **المرجعُ ثابتٌ ما دام العنصر حيّاً**: كان كلُّ قراءةٍ تعيد الترقيم من الصفر وتختم العناصرَ من جديد، فقراءةٌ
 * ثانية (`find` مثلاً) تنقل الرقمَ من عنصرٍ إلى آخر بينما الموافقةُ تحمل الاسمَ القديم — يوافق المستخدم على «تعديل»
 * فتقع النقرةُ على «حذف الحساب». الآن: من له ختمٌ يحتفظ به، والجديدُ وحده يأخذ رقماً من عدّادٍ متصاعدٍ على الوثيقة.
 */
const READ_TREE = `(() => {
  const out = []
  let n = 0
${TREE_HELPERS}
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  let seq = Number(document.documentElement.getAttribute("data-abdo-seq") || 0)
  for (const el of document.querySelectorAll("a,button,input,textarea,select,h1,h2,h3,h4,h5,h6,[role]")) {
    if (!visible(el)) continue
    let ref = el.getAttribute("data-abdo-ref")
    if (!ref) { seq += 1; ref = "r" + seq; el.setAttribute("data-abdo-ref", ref) }
    const node = { ref, role: role(el), name: label(el) }
    if (secret(el)) node.sensitive = true
    out.push(node)
    n += 1
    if (n >= 200) break
  }
  document.documentElement.setAttribute("data-abdo-seq", String(seq))
  return JSON.stringify(out)
})()`

export class CdpBrowser {
  readonly id = "browser"
  #ws: WebSocket | undefined
  #seq = 0
  #pageSession: string | undefined
  #pageTarget: string | undefined
  #attached: { resolve: () => void; reject: (error: Error) => void } | undefined
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  /** ذ9هـ — حلقةُ رسائل الطرفيّة: تُملأ من أحداث CDP ولا تُقرأ إلا حين يطلبها النموذج. الوسمُ بالجلسة (ب9) كي لا تُنسب رسالةُ لسانٍ آخر إلى صفحتك. */
  #console: (CdpConsoleMessage & { session: string })[] = []
  /** ذ9ز — حلقةُ طلبات الشبكة بمفتاح `requestId`: الطلبُ يُسجَّل عند إرساله ثمّ يُكمَّل بحالته أو فشله. */
  #network = new Map<string, CdpNetworkEvent & { session: string }>()

  constructor(private readonly port: number, private readonly navigationAllowed?: (url: string) => boolean, private readonly ownsBrowser?: (endpoint: string) => boolean) {}

  #allowed(url: string): boolean {
    try { return url === "about:blank" || this.navigationAllowed?.(url) !== false } catch { return false }
  }

  async #guardCurrentPage(): Promise<void> {
    if (this.navigationAllowed && !this.#allowed(await this.#eval("location.href"))) throw new Error("Page access blocked by saved site permissions")
  }

  /** يعثر على صفحةٍ قابلةٍ للقيادة على المنفذ، أو يفشل باسمه. */
  async attach(match?: RegExp): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${this.port}/json`, { signal: AbortSignal.timeout(4000) })
    const targets = (await res.json()) as CdpTarget[]
    const page = targets.find((t) => t.type === "page" && (match === undefined || match.test(t.url)))
    if (page === undefined) throw new Error(`لا صفحةً قابلةً للقيادة على المنفذ ${this.port}`)
    if (page.url !== "about:blank" && !this.#allowed(page.url)) throw new Error("Page access blocked by saved site permissions")
    this.#pageTarget = page.id
    let endpoint = page.webSocketDebuggerUrl
    let owned = false
    if (this.navigationAllowed) {
      const version = await (await fetch(`http://127.0.0.1:${this.port}/json/version`, { signal: AbortSignal.timeout(4000) })).json() as { webSocketDebuggerUrl?: string }
      if (!version.webSocketDebuggerUrl) throw new Error("Browser navigation policy endpoint is unavailable")
      endpoint = version.webSocketDebuggerUrl
      owned = this.ownsBrowser?.(endpoint) === true
      if (this.ownsBrowser && !owned) throw new Error("Controlled browser ownership could not be verified; reopen it from browser settings")
    }
    const socket = new WebSocket(endpoint)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error("مهلة فتح قناة CDP")) }, 5000)
      socket.addEventListener("open", () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("تعذّر فتح قناة CDP")) }, { once: true })
    })
    socket.addEventListener("message", (event) => {
      try {
        const frame = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: unknown; method?: string; sessionId?: string; params?: { sessionId?: string; targetInfo?: { targetId?: string; type?: string }; requestId?: string; request?: { url?: string } } }
        if (typeof frame.id === "number") {
          const pending = this.#pending.get(frame.id)
          if (pending) {
            this.#pending.delete(frame.id)
            clearTimeout(pending.timer)
            if (frame.error) pending.reject(new Error("Browser control command was refused"))
            else pending.resolve(frame.result)
          }
        } else if (frame.method === "Target.attachedToTarget" && typeof frame.params?.sessionId === "string") {
          const session = frame.params.sessionId, target = frame.params.targetInfo
          void (async () => {
            await this.#installNavigationPolicy(session)
            await this.#send("Runtime.runIfWaitingForDebugger", {}, session)
            if (target?.targetId === this.#pageTarget) { this.#pageSession = session; this.#attached?.resolve() }
          })().catch(error => { this.#attached?.reject(error); this.close() })
        } else if (frame.method === "Runtime.consoleAPICalled" || frame.method === "Log.entryAdded" || frame.method === "Runtime.exceptionThrown") {
          // ثلاثةُ مصادرَ لرسالةٍ واحدة: نداءُ console.*، وسجلُّ المتصفّح، والاستثناءُ غيرُ الملتقَط. تُوحَّد شكلاً وتُسقف نصّاً.
          const params = frame.params as unknown as { type?: string; args?: { value?: unknown; description?: string }[]; entry?: { level?: string; text?: string; source?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } }
          const entry = params.entry
          const level = frame.method === "Runtime.exceptionThrown" ? "error" : String(entry?.level ?? params.type ?? "log")
          const text = frame.method === "Runtime.exceptionThrown"
            ? String(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? "uncaught error")
            : entry?.text ?? (params.args ?? []).map((a) => String(a?.value ?? a?.description ?? "")).filter(Boolean).join(" ")
          const source = frame.method === "Log.entryAdded" ? String(entry?.source ?? "log") : frame.method === "Runtime.exceptionThrown" ? "exception" : "console"
          if (text.length > 0) {
            this.#console.push({ level, text: text.slice(0, 500), source, at: Date.now(), session: String(frame.sessionId ?? "") })
            if (this.#console.length > CONSOLE_BUFFER) this.#console.splice(0, this.#console.length - CONSOLE_BUFFER)
          }
        } else if ((frame.method === "Network.requestWillBeSent" || frame.method === "Network.responseReceived" || frame.method === "Network.loadingFailed") && typeof frame.params?.requestId === "string") {
          // ثلاثةُ أحداثٍ لطلبٍ واحد: الإرسالُ يفتح السطر، والردُّ أو الفشلُ يُتمّه. لا ترويسةَ ولا جسمَ يُقرأ أصلاً.
          const id = frame.params.requestId
          const p = frame.params as unknown as { request?: { url?: string; method?: string }; type?: string; response?: { status?: number; url?: string }; errorText?: string; canceled?: boolean }
          const existing = this.#network.get(id)
          if (frame.method === "Network.requestWillBeSent") {
            this.#network.set(id, { method: String(p.request?.method ?? "GET"), url: String(p.request?.url ?? "").slice(0, 300), type: String(p.type ?? "Other"), at: Date.now(), session: String(frame.sessionId ?? "") })
          } else if (existing !== undefined) {
            this.#network.set(id, frame.method === "Network.responseReceived"
              ? { ...existing, status: Number(p.response?.status ?? 0) }
              : { ...existing, failure: p.canceled === true ? "canceled" : String(p.errorText ?? "failed").slice(0, 120) })
          }
          if (this.#network.size > NETWORK_BUFFER) {
            for (const key of [...this.#network.keys()].slice(0, this.#network.size - NETWORK_BUFFER)) this.#network.delete(key)
          }
        } else if (frame.method === "Fetch.requestPaused" && typeof frame.params?.requestId === "string") {
          // Document requests include link/form navigation, frames and each redirect.
          // Decide before the network request; never forward request headers or bodies.
          const requestId = frame.params.requestId
          const allowed = typeof frame.params.request?.url === "string" && this.#allowed(frame.params.request.url)
          void this.#send(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", allowed ? { requestId } : { requestId, errorReason: "BlockedByClient" }, frame.sessionId).catch(() => this.close())
        }
      } catch { /* إطارٌ غير متوقّع — يُتخطّى */ }
    })
    this.#ws = socket
    socket.addEventListener("close", () => { if (this.#ws === socket) this.close() }, { once: true })
    if (this.navigationAllowed) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const attached = new Promise<void>((resolve, reject) => {
        this.#attached = { resolve, reject }
        timer = setTimeout(() => reject(new Error("Browser navigation policy installation timed out")), 5000)
      })
      // Whole-browser attachment is limited to a verified app-owned process.
      // Existing/personal browsers retain selected-page attachment only.
      const filter = [{ type: "page" }, { type: "iframe" }, { exclude: true }]
      const setup = owned
        ? this.#send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter }, null)
        : this.#send("Target.autoAttachRelated", { targetId: page.id, waitForDebuggerOnStart: true, filter }, null)
      try { await Promise.all([setup, attached]) }
      catch (error) { this.close(); throw error }
      finally { clearTimeout(timer); this.#attached = undefined }
    }
    // ذ٩هـ — التقاطُ الطرفيّة في المسارَين: بسياسةٍ (جلسةٌ مُلحقة) أو بلا سياسة (قناةُ الصفحة مباشرة)؛ وفشلُ التفعيل لا يُسقِط الوصل.
    await this.#send("Runtime.enable", {}, this.#pageSession ?? null).catch(() => undefined)
    await this.#send("Log.enable", {}, this.#pageSession ?? null).catch(() => undefined)
    // ذ9ز — المخازنُ صفرٌ عمداً: نريد الأحداثَ لا الحمولات، فلا يحتفظ المتصفّحُ بأجسادِ الردود لأجلنا.
    await this.#send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }, this.#pageSession ?? null).catch(() => undefined)
  }

  async #installNavigationPolicy(session: string): Promise<void> {
    await this.#send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] }, session)
    // ذ9هـ — التقاطُ الطرفيّة يبدأ مع الجلسة: رسالةٌ سبقت التفعيل لا تُستعاد، فالتفعيلُ في أوّل نقطةٍ تملكها الجلسة.
    // وفشلُ التفعيل لا يُسقط الوصل: القيادةُ أهمّ من السجلّ، والغيابُ يُقال عند الطلب لا يُخترع.
    await this.#send("Runtime.enable", {}, session).catch(() => undefined)
    await this.#send("Log.enable", {}, session).catch(() => undefined)
    await this.#send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }, session).catch(() => undefined)
    // Cross-process frames are separate CDP sessions. Install before resuming.
    await this.#send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "iframe" }, { exclude: true }] }, session)
  }

  #send(method: string, params: object, sessionId: string | null | undefined = this.#pageSession): Promise<unknown> {
    const socket = this.#ws
    if (socket === undefined) return Promise.reject(new Error("القناة مغلقة"))
    this.#seq += 1
    const id = this.#seq
    const done = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error("Browser control command timed out"))
      }, 15_000)
      timer.unref?.()
      this.#pending.set(id, { resolve, reject, timer })
      try { socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })) }
      catch { this.#pending.delete(id); clearTimeout(timer); reject(new Error("Browser control channel is closed")) }
    })
    return done
  }

  async #eval(expression: string): Promise<string> {
    const result = (await this.#send("Runtime.evaluate", { expression, returnByValue: true })) as {
      result?: { value?: unknown }
    }
    return String(result?.result?.value ?? "")
  }

  /**
   * آخرُ رسائل الطرفيّة (الأحدثُ آخراً)، حتى `limit`. الفارغةُ فارغةٌ حقّاً — لا تُخمَّن ولا تُملأ.
   * ب9 — **من صفحتك وحدها**: الحلقةُ تجمع من كلّ لسانٍ متّصل، فتُرشَّح بجلسة الصفحة المقودة قبل أن تُقال «طرفيّةُ صفحتك».
   */
  consoleTail(limit = 30): readonly CdpConsoleMessage[] {
    const mine = this.#console.filter((m) => m.session === (this.#pageSession ?? ""))
    return mine.slice(-Math.max(1, Math.min(limit, CONSOLE_BUFFER))).map(({ session: _s, ...rest }) => rest)
  }

  /** آخرُ طلبات الشبكة منذ الوصل (الأحدثُ آخراً). الفارغةُ فارغةٌ حقّاً — والملتقَطُ بلا ترويسةٍ ولا جسم — ومن جلسة صفحتك وحدها (ب9). */
  networkTail(limit = 30): readonly CdpNetworkEvent[] {
    const mine = [...this.#network.values()].filter((r) => r.session === (this.#pageSession ?? ""))
    return mine.slice(-Math.max(1, Math.min(limit, NETWORK_BUFFER))).map(({ session: _s, ...rest }) => rest)
  }

  async readPage(): Promise<readonly CdpPageNode[]> {
    await this.#guardCurrentPage()
    const json = await this.#eval(READ_TREE)
    try {
      return JSON.parse(json) as CdpPageNode[]
    } catch {
      return []
    }
  }

  async navigate(url: string): Promise<void> {
    if (!this.#allowed(url)) throw new Error("Navigation blocked by saved site permissions")
    // ب9 — الحلقتان تُفرَغان **قبل** التنقّل: «طلباتُ هذه الصفحة» يجب أن تعني هذه الصفحة، لا ما سبقها.
    this.#console = []
    this.#network.clear()
    const result = await this.#send("Page.navigate", { url }) as { errorText?: unknown; isDownload?: boolean }
    if (result?.errorText || result?.isDownload) throw new Error("Browser navigation failed or was blocked")
    await Bun.sleep(600)
  }

  async click(ref: string): Promise<void> {
    await this.#guardCurrentPage()
    await this.#eval(`(() => { const el = document.querySelector('[data-abdo-ref="${ref}"]'); if (el) el.click(); return !!el })()`)
  }

  async type(ref: string, text: string): Promise<void> {
    await this.#guardCurrentPage()
    const safe = text.replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll("\n", " ")
    await this.#eval(
      `(() => { const el = document.querySelector('[data-abdo-ref="${ref}"]'); if (!el) return false;` +
        ` el.focus(); el.value = '${safe}'; el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`,
    )
  }

  async title(): Promise<string> {
    return this.#eval("document.title")
  }

  /**
   * لقطةُ PNG من سطح الصفحة — **للعرض على المشغّل لا لقيادة الوكيل**.
   *
   * ترتيب هذه الحزمة مقصود: الوكيل يقود بشجرة الوصول، والصورة آخر درجة.
   * لوحة «المتصفّح الحيّ» في القشرة تحتاج أن يرى الإنسان ما يفعله الوكيل،
   * وهذه حاجةُ عرضٍ لا حاجةُ استدلال — فلا تُمرَّر إلى سياق النموذج.
   * يعود بسلسلة base64، والفراغ يعني «لا لقطة» لا «صفحة فارغة».
   */
  async captureScreenshot(options: { readonly format?: "png" | "jpeg"; readonly quality?: number; readonly scale?: number } = {}): Promise<string> {
    await this.#guardCurrentPage()
    const format = options.format ?? "png"
    // مقياسٌ أصغر = قصٌّ بالمساحة المرئيّة نفسِها مضروباً في scale (Page.getLayoutMetrics) — لا اقتصاصٌ للمحتوى.
    let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined
    if (options.scale !== undefined && options.scale > 0 && options.scale < 1) {
      const metrics = (await this.#send("Page.getLayoutMetrics", {})) as { cssVisualViewport?: { clientWidth?: number; clientHeight?: number } }
      const w = metrics?.cssVisualViewport?.clientWidth, h = metrics?.cssVisualViewport?.clientHeight
      if (typeof w === "number" && typeof h === "number" && w > 0 && h > 0) clip = { x: 0, y: 0, width: w, height: h, scale: options.scale }
    }
    const result = (await this.#send("Page.captureScreenshot", {
      format,
      ...(format === "jpeg" ? { quality: Math.min(100, Math.max(1, Math.round(options.quality ?? 70))) } : {}),
      ...(clip === undefined ? {} : { clip }),
      fromSurface: true,
      captureBeyondViewport: false,
    })) as { data?: unknown }
    return typeof result?.data === "string" ? result.data : ""
  }

  /**
   * قراءةُ تعبيرٍ للفحص فقط. مُعلَنٌ لا مخفيّ: الدخان يحتاج أن يسأل الصفحة
   * «أكان الحدث موثوقاً؟»، والمحرّك لا يستدعيه — العقد لا يمنح النموذج
   * تنفيذَ JS عشوائيّ.
   */
  evalForTest(expression: string): Promise<string> {
    return this.#eval(expression)
  }

  /**
   * T17 — الإدخال الحقيقيّ: أحداث CDP لا JS مزروع.
   *
   * الفرق ليس تجميلاً: `el.click()` حدثٌ صناعيّ لا يمرّ بطبقة الإدخال،
   * فصفحةٌ تتحقّق من `isTrusted` تراه زائفاً. `Input.dispatchMouseEvent`
   * يمرّ بالطبقة نفسها التي يمرّ بها إصبع المشغّل — ولهذا صنفُه
   * `outside-workspace` في العقد: أثرٌ على عالمٍ لا يملك تراجعاً.
   */
  async clickAt(x: number, y: number): Promise<void> {
    await this.#guardCurrentPage()
    await this.#send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 })
    await this.#send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 })
  }

  /**
   * موضع عنصرٍ بمرجعه **مع هويّته وحالته** — لتحويل مرجعٍ إلى إحداثيّاتٍ لا تكذب.
   *
   * ب9: يُحضَر العنصرُ إلى العرض إن كان خارجه (كما يفعل المستخدم قبل نقره)، ثمّ يُقاس مستطيلُه بعد الإحضار،
   * ويُسأل `elementFromPoint` **من تحت النقطة**: عنصرٌ يغطّيه حوارٌ أو شريطُ إعلانٍ لا يُنقر بالنيابة عنه.
   * والمرجعُ المجهول يعود `undefined` — والفرقُ بينه وبين «موجودٌ لكنّه انطوى» يُقال في `width/height`.
   */
  async locate(ref: string): Promise<CdpRefLocation | undefined> {
    if (!/^r\d{1,6}$/.test(ref)) return undefined
    const json = await this.#eval(
      `(() => { const el = document.querySelector('[data-abdo-ref="${ref}"]'); if (!el) return "";
${TREE_HELPERS}
  let r = el.getBoundingClientRect()
  const centred = () => { const c = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; return c }
  let c = centred()
  if (r.width > 0 && r.height > 0 && (c.x < 0 || c.y < 0 || c.x >= innerWidth || c.y >= innerHeight)) {
    try { el.scrollIntoView({ block: "center", inline: "center" }) } catch (e) { }
    r = el.getBoundingClientRect(); c = centred()
  }
  const inView = c.x >= 0 && c.y >= 0 && c.x < innerWidth && c.y < innerHeight
  let hit = false
  if (inView && r.width > 0 && r.height > 0) { const top = document.elementFromPoint(c.x, c.y); hit = !!top && (top === el || el.contains(top) || top.contains(el)) }
  return JSON.stringify({ x: c.x, y: c.y, width: Math.round(r.width), height: Math.round(r.height), inView, hit, role: role(el), name: label(el), sensitive: secret(el) }) })()`,
    )
    try {
      return json ? (JSON.parse(json) as CdpRefLocation) : undefined
    } catch {
      return undefined
    }
  }

  /** ب9 — تحديدُ محتوى حقلٍ قبل الكتابة: الكتابةُ تُبدِل القيمة لا تُذيَّل عليها (فلا يصير «١٢٣» «٤٥٦١٢٣»). */
  async selectRef(ref: string): Promise<boolean> {
    await this.#guardCurrentPage()
    if (!/^r\d{1,6}$/.test(ref)) return false
    const ok = await this.#eval(`(() => { const el = document.querySelector('[data-abdo-ref="${ref}"]'); if (!el) return "no"; el.focus(); if (el.select) el.select(); return document.activeElement === el ? "yes" : "no" })()`)
    return ok === "yes"
  }

  /**
   * ب9 — قراءةُ ما استقرّ في الحقل بعد الكتابة: «كتبتُ» ادّعاءٌ حتى يُقرأ ما في الحقل.
   * وحقلُ الاعتماد **لا تُقرأ قيمتُه**: يعود طولُها وحده — فلا تعود كلمةُ مرورٍ إلينا حتى في التحقّق.
   */
  async readValue(ref: string): Promise<{ readonly value?: string; readonly length: number; readonly sensitive: boolean } | undefined> {
    await this.#guardCurrentPage()
    if (!/^r\d{1,6}$/.test(ref)) return undefined
    const json = await this.#eval(
      `(() => { const el = document.querySelector('[data-abdo-ref="${ref}"]'); if (!el) return "";
${TREE_HELPERS}
  const v = (el.value !== undefined && el.value !== null) ? String(el.value) : ((el.innerText || "") + "")
  return JSON.stringify(secret(el) ? { length: v.length, sensitive: true } : { value: v.slice(0, 2000), length: v.length, sensitive: false }) })()`,
    )
    try {
      return json ? (JSON.parse(json) as { value?: string; length: number; sensitive: boolean }) : undefined
    } catch {
      return undefined
    }
  }

  /** كتابةٌ بأحداث لوحة مفاتيحٍ حقيقيّة — محرفاً محرفاً كما يكتب المشغّل. */
  async typeKeys(text: string): Promise<void> {
    await this.#guardCurrentPage()
    for (const ch of text) {
      await this.#send("Input.dispatchKeyEvent", { type: "keyDown", text: ch })
      await this.#send("Input.dispatchKeyEvent", { type: "keyUp", text: ch })
    }
  }

  async pressKey(key: string): Promise<void> {
    await this.#guardCurrentPage()
    // ب3 — مفاتيحُ التنقّل والتحرير بأكوادها الحقيقية؛ المجهولُ يُرفض قبل الإرسال لا يُرسل بصفر.
    const vk = KEY_CODES[key]
    if (vk === undefined) throw new Error(`Unsupported key: ${key}`)
    await this.#send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, windowsVirtualKeyCode: vk, ...(key === "Space" ? { text: " " } : {}) })
    await this.#send("Input.dispatchKeyEvent", { type: "keyUp", key, windowsVirtualKeyCode: vk })
  }

  /** ب3 — تمريرٌ بعجلة الماوس في وسط العرض: حدثُ إدخالٍ حقيقيّ لا window.scrollBy المزروع. */
  async scrollBy(deltaY: number): Promise<{ x: number; y: number }> {
    await this.#guardCurrentPage()
    const center = await this.#eval("JSON.stringify({ x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) })")
    let at = { x: 400, y: 300 }
    try { at = JSON.parse(center) as { x: number; y: number } } catch { /* افتراضٌ آمن */ }
    await this.#send("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 0, deltaY })
    return at
  }

  /** أبعادُ الصفحة للتمرير الكامل: ارتفاعُ المنفذ، ارتفاعُ الوثيقة، وموضعُ التمرير الحاليّ. */
  async pageMetrics(): Promise<{ readonly viewportHeight: number; readonly scrollHeight: number; readonly scrollY: number }> {
    await this.#guardCurrentPage()
    const raw = await this.#eval("JSON.stringify({ viewportHeight: innerHeight, scrollHeight: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0), scrollY: Math.round(scrollY) })")
    try { const m = JSON.parse(raw) as { viewportHeight: number; scrollHeight: number; scrollY: number }; return { viewportHeight: Math.max(1, m.viewportHeight | 0), scrollHeight: Math.max(1, m.scrollHeight | 0), scrollY: Math.max(0, m.scrollY | 0) } } catch { return { viewportHeight: 900, scrollHeight: 900, scrollY: 0 } }
  }

  /** تمريرٌ إلى موضعٍ عموديّ محدّد (للقطة الصفحة الكاملة بلاطةً بلاطة) — قراءةٌ لا أثر. */
  async scrollTo(y: number): Promise<void> {
    await this.#guardCurrentPage()
    await this.#eval("window.scrollTo(0, " + Math.max(0, Math.round(y)) + ")")
  }

  /**
   * استخراجُ التصميم من الصفحة الحيّة بتعبيرٍ ثابت (لا JS من النموذج): متغيّراتُ الجذر اللونيّة، الألوانُ الأكثر
   * استعمالاً (لون/خلفية/حدود) بمساحتها، التدرّجاتُ، عائلاتُ الخطوط، وأنماطُ العناوين والأزرار. مقيسٌ 2026-09-13:
   * الوكيلُ نسخ بنيةَ مبرمج بألوانه الافتراضيّة لأنّ الشجرةَ النصّيّة لا تحمل لوناً — هذه تحمله بالأرقام.
   */
  async readDesign(): Promise<string> {
    await this.#guardCurrentPage()
    return this.#eval(
      "(() => { const out = { url: location.href, dir: document.documentElement.dir || getComputedStyle(document.body).direction, rootVars: {}, colors: [], gradients: [], fonts: [], headings: [], buttons: [], body: {} };" +
        " const rs = getComputedStyle(document.documentElement); for (const sheet of document.styleSheets) { let rules; try { rules = sheet.cssRules } catch { continue } for (const r of rules) { if (!r.style || !/^(:root|html|body)$/.test(r.selectorText || \"\")) continue; for (const p of r.style) { if (!p.startsWith(\"--\")) continue; const v = rs.getPropertyValue(p).trim(); if (/#|rgb|hsl|gradient|serif|sans|font/i.test(v) && Object.keys(out.rootVars).length < 40) out.rootVars[p] = v.slice(0, 80) } } }" +
        " const tally = new Map(), grads = new Map(), fonts = new Map(); for (const el of document.querySelectorAll(\"body *\")) { const r = el.getBoundingClientRect(); const area = r.width * r.height; if (area < 400 || r.width === 0) continue; const cs = getComputedStyle(el); if (cs.visibility === \"hidden\" || cs.display === \"none\") continue;" +
        " const add = (m, k, w) => { if (!k || k === \"rgba(0, 0, 0, 0)\" || k === \"transparent\") return; m.set(k, (m.get(k) || 0) + w) }; add(tally, \"text \" + cs.color, area); add(tally, \"bg \" + cs.backgroundColor, area); if (cs.borderTopWidth !== \"0px\") add(tally, \"border \" + cs.borderTopColor, area / 4); if (cs.backgroundImage && cs.backgroundImage.includes(\"gradient\")) add(grads, cs.backgroundImage.slice(0, 160), area); add(fonts, cs.fontFamily.split(\",\")[0].replace(/[\"\x27]/g, \"\").trim(), area) }" +
        " out.colors = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => k + \" · \" + Math.round(v / 1000) + \"k px²\"); out.gradients = [...grads].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k); out.fonts = [...fonts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);" +
        " const pick = (sel, n) => [...document.querySelectorAll(sel)].slice(0, n).map((el) => { const cs = getComputedStyle(el); return { text: (el.innerText || \"\").trim().slice(0, 60), fontSize: cs.fontSize, fontWeight: cs.fontWeight, color: cs.color, background: cs.backgroundImage.includes(\"gradient\") ? cs.backgroundImage.slice(0, 120) : cs.backgroundColor, radius: cs.borderRadius, padding: cs.padding } });" +
        " out.headings = pick(\"h1, h2\", 6); out.buttons = pick(\"button, a.btn, [class*=btn], [role=button]\", 6); const bs = getComputedStyle(document.body); const c = document.querySelector(\"main, .container, [class*=container]\"); out.body = { background: bs.backgroundColor, color: bs.color, font: bs.fontFamily.slice(0, 80), fontSize: bs.fontSize, maxWidth: c ? getComputedStyle(c).maxWidth : \"\" }; return JSON.stringify(out) })()"
    )
  }

  /** م2 (2026-09-14) — فحصُ عنصرٍ بمرجعه: HTML الخارجيّ (مقصوص)، الأنماطُ المحسوبة المهمّة، الصندوق. للنسخ بالأرقام لا بالانطباع. */
  async readDom(ref: string): Promise<string> {
    await this.#guardCurrentPage()
    if (!/^r\d{1,6}$/u.test(ref)) return ""
    return this.#eval(
      `(() => { const el = document.querySelector('[data-abdo-ref="${ref}"]'); if (!el) return ""; const cs = getComputedStyle(el); const r = el.getBoundingClientRect();` +
        " const keys = [\"display\",\"position\",\"width\",\"height\",\"padding\",\"margin\",\"gap\",\"color\",\"backgroundColor\",\"backgroundImage\",\"fontFamily\",\"fontSize\",\"fontWeight\",\"lineHeight\",\"letterSpacing\",\"textAlign\",\"borderRadius\",\"border\",\"boxShadow\",\"flexDirection\",\"justifyContent\",\"alignItems\",\"gridTemplateColumns\",\"opacity\"];" +
        " const styles = {}; for (const k of keys) { const v = cs[k]; if (v && v !== \"none\" && v !== \"normal\" && v !== \"auto\" && v !== \"0px\" && v !== \"rgba(0, 0, 0, 0)\") styles[k] = String(v).slice(0, 120) }" +
        " const clone = el.cloneNode(true); for (const s of clone.querySelectorAll(\"script,style,svg path\")) s.remove(); for (const n of clone.querySelectorAll(\"*\")) n.removeAttribute(\"data-abdo-ref\");" +
        " return JSON.stringify({ tag: el.tagName.toLowerCase(), id: el.id || undefined, classes: [...el.classList].slice(0, 12), box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, children: el.children.length, styles, html: clone.outerHTML.slice(0, 4000) }) })()",
    )
  }

  /** م2 — قواعدُ CSS المطابقة لمحدِّدٍ (أوراقُ الأصل نفسِه فقط؛ الغريبةُ تُعدّ بلا نصّ) + خطوطُ @font-face. */
  async matchedCss(selector: string): Promise<string> {
    await this.#guardCurrentPage()
    const needle = selector.replace(/[\\"`]/gu, "").slice(0, 120)
    return this.#eval(
      `(() => { const needle = ${JSON.stringify(needle)}.toLowerCase(); const rules = []; const fonts = []; let foreign = 0;` +
        // مراجعة 09-14 (#25ج): قواعدُ @media/@layer/@supports/@container كانت غيرَ مرئيّة — تُمشى بعمقٍ ويُسبق المحدِّدُ بسياقه.
        " const walk = (list, ctx, sheetName) => { for (const r of list) { if (rules.length >= 30) return; if (r.type === 5 && fonts.length < 12) { fonts.push(String(r.cssText).slice(0, 200)); continue } if (r.cssRules && r.cssRules.length > 0 && !r.selectorText) { const head = r.type === 4 ? \"@media \" + r.media.mediaText : r.type === 12 ? \"@supports \" + r.conditionText : (r.constructor && r.constructor.name === \"CSSLayerBlockRule\") ? \"@layer \" + r.name : (r.constructor && r.constructor.name === \"CSSContainerRule\") ? \"@container \" + r.conditionText : \"\"; if (head) { walk(r.cssRules, ctx + head + \" { \", sheetName); continue } } const sel = r.selectorText; if (!sel) continue; if (needle.length === 0 || sel.toLowerCase().includes(needle)) rules.push({ selector: (ctx + sel).slice(0, 200), css: String(r.style ? r.style.cssText : r.cssText).slice(0, 400), sheet: sheetName }) } };" +
        " for (const sheet of document.styleSheets) { let list; try { list = sheet.cssRules } catch { foreign += 1; continue } walk(list, \"\", (sheet.href || \"inline\").slice(-60)); if (rules.length >= 30) break }" +
        " return JSON.stringify({ needle, matched: rules.length, foreignSheets: foreign, rules, fontFaces: fonts }) })()",
    )
  }

  /** م2 — أصولُ الصفحة: صورٌ (بأبعادها)، أيقونات، أوراقُ أنماط، خطوطٌ محمَّلة — ليعرف النموذجُ ما يعيد بناءه ومن أين. */
  async readAssets(): Promise<string> {
    await this.#guardCurrentPage()
    return this.#eval(
      "(() => { const abs = (u) => { try { return new URL(u, location.href).href } catch { return u } };" +
        " const images = [...document.images].filter((i) => i.naturalWidth > 24).slice(0, 24).map((i) => ({ src: abs(i.currentSrc || i.src).slice(0, 200), alt: (i.alt || \"\").slice(0, 60), natural: i.naturalWidth + \"x\" + i.naturalHeight, shown: Math.round(i.getBoundingClientRect().width) + \"x\" + Math.round(i.getBoundingClientRect().height) }));" +
        " const icons = [...document.querySelectorAll(\"link[rel~=icon], link[rel=apple-touch-icon]\")].map((l) => abs(l.href).slice(0, 200)).slice(0, 6);" +
        " const sheets = [...document.styleSheets].map((s) => s.href ? abs(s.href).slice(0, 200) : \"inline(\" + (s.ownerNode && s.ownerNode.textContent ? s.ownerNode.textContent.length : 0) + \")\").slice(0, 12);" +
        " const fonts = []; try { for (const f of document.fonts) { if (fonts.length >= 20) break; fonts.push(f.family + \" \" + f.weight + \" \" + f.style + \" \" + f.status) } } catch {}" +
        " const bg = []; for (const el of document.querySelectorAll(\"body *\")) { if (bg.length >= 10) break; const v = getComputedStyle(el).backgroundImage; if (v && v.startsWith(\"url(\")) bg.push(v.slice(0, 200)) }" +
        " return JSON.stringify({ url: location.href, title: document.title.slice(0, 120), images, backgroundImages: bg, icons, stylesheets: sheets, fonts, svgInline: document.querySelectorAll(\"svg\").length }) })()"
    )
  }

  /** ب5 — تركيزُ حقلٍ بمرجعه (بلا كتابة) وإحضارُ نافذة المتصفّح إلى المقدّمة: تسليمٌ للمستخدم ليكتب بيده. */
  async focusRef(ref: string): Promise<boolean> {
    await this.#guardCurrentPage()
    const ok = await this.#eval(`(() => { const el = document.querySelector('[data-abdo-ref="${ref}"]'); if (!el) return "no"; el.focus(); return document.activeElement === el ? "yes" : "no" })()`)
    try { await this.#send("Page.bringToFront", {}) } catch { /* بلا رأسٍ أو بلا نافذة: التركيزُ وحده يكفي */ }
    return ok === "yes"
  }

  /**
   * ن3 — اختيارُ خيارٍ في <select> بمرجعه: بالنصّ أو القيمة (تامّةً ثمّ بادئةً ثمّ احتواءً، بلا حساسيةٍ للحالة)، ثمّ يُبثّ
   * input وchange كما يفعل المتصفّح كي تراه أُطرُ الواجهة. ما ليس <select> (قائمةٌ مبنيّةٌ بـdiv) يُقال باسمه: يُفتح بـtap ويُختار بـtap/key.
   */
  async selectOption(ref: string, choice: string): Promise<CdpSelectResult | undefined> {
    await this.#guardCurrentPage()
    if (!/^r\d{1,6}$/.test(ref)) return undefined
    const json = await this.#eval(
      `(() => { const el = document.querySelector('[data-abdo-ref="${ref}"]'); if (!el) return "";
  const want = ${JSON.stringify(choice)}
  const norm = (s) => String(s == null ? "" : s).trim().toLowerCase().replace(/\\s+/g, " ")
  if (el.tagName !== "SELECT") return JSON.stringify({ ok: false, why: "not-select", role: el.tagName.toLowerCase() + (el.getAttribute("role") ? "[" + el.getAttribute("role") + "]" : ""), options: [] })
  const opts = Array.from(el.options)
  const texts = opts.map((o) => o.text.trim())
  const w = norm(want)
  const byExact = opts.findIndex((o) => norm(o.text) === w || norm(o.value) === w || norm(o.label) === w)
  const byPrefix = byExact >= 0 ? byExact : opts.findIndex((o) => norm(o.text).startsWith(w))
  const idx = byPrefix >= 0 ? byPrefix : opts.findIndex((o) => norm(o.text).includes(w))
  if (idx < 0) return JSON.stringify({ ok: false, why: "no-option", role: "combobox", options: texts.slice(0, 40) })
  el.selectedIndex = idx
  el.dispatchEvent(new Event("input", { bubbles: true }))
  el.dispatchEvent(new Event("change", { bubbles: true }))
  const picked = el.options[el.selectedIndex]
  return JSON.stringify({ ok: true, picked: picked ? picked.text.trim() : "", value: picked ? String(picked.value) : "", index: el.selectedIndex, total: opts.length }) })()`,
    )
    try { return json ? (JSON.parse(json) as CdpSelectResult) : undefined } catch { return undefined }
  }

  /**
   * ن3 — رفعُ ملفّاتٍ إلى <input type=file> بمرجعه عبر DOM.setFileInputFiles (المسارُ الذي يفتحه المتصفّح نفسُه، لا نقرٌ على حوار
   * النظام). المسارُ حُكم قبل الوصول هنا (داخل المشروع، ليس سرّاً)؛ وما استقرّ يُقرأ من الحقل بعدها — «رفعتُ» ادّعاءٌ حتى تُقرأ الأسماء.
   */
  async setFiles(ref: string, files: readonly string[]): Promise<CdpUploadResult | undefined> {
    await this.#guardCurrentPage()
    if (!/^r\d{1,6}$/.test(ref) || files.length === 0) return undefined
    const kind = await this.#eval(`(() => { const el = document.querySelector('[data-abdo-ref="${ref}"]'); if (!el) return "missing"; return el.tagName === "INPUT" && (el.type || "").toLowerCase() === "file" ? "file" : "other" })()`)
    if (kind === "missing") return { ok: false, why: "missing" }
    if (kind !== "file") return { ok: false, why: "not-file" }
    const handle = (await this.#send("Runtime.evaluate", { expression: `document.querySelector('[data-abdo-ref="${ref}"]')`, returnByValue: false })) as { result?: { objectId?: string; subtype?: string } }
    const objectId = handle?.result?.objectId
    if (objectId === undefined || handle?.result?.subtype === "null") return { ok: false, why: "missing" }
    await this.#send("DOM.enable", {}).catch(() => undefined)
    await this.#send("DOM.setFileInputFiles", { files: [...files], objectId })
    await this.#send("Runtime.releaseObject", { objectId }).catch(() => undefined)
    const names = await this.#eval(`(() => { const el = document.querySelector('[data-abdo-ref="${ref}"]'); if (!el || !el.files) return "[]"; return JSON.stringify(Array.from(el.files).map((f) => f.name + " (" + f.size + " بايت)")) })()`)
    try { return { ok: true, files: JSON.parse(names || "[]") as string[] } } catch { return { ok: true, files: [] } }
  }

  /** ن3 — سحبٌ بالماوس الموثوق: ضغطٌ عند المصدر، حركةٌ على خطواتٍ، إفلاتٌ عند الهدف — كما يفعل إصبع المشغّل (يخدم السحبَ المبنيّ على أحداث المؤشّر). */
  async dragTo(from: { readonly x: number; readonly y: number }, to: { readonly x: number; readonly y: number }): Promise<void> {
    await this.#guardCurrentPage()
    await this.#send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y })
    await this.#send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 })
    const steps = 8
    for (let i = 1; i <= steps; i += 1) {
      const x = Math.round(from.x + ((to.x - from.x) * i) / steps), y = Math.round(from.y + ((to.y - from.y) * i) / steps)
      await this.#send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 })
    }
    await this.#send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 })
  }

  /** ن3 — سحبُ HTML5 (draggable/ondrop) بأحداث DragEvent وDataTransfer مشترَك بين المصدر والهدف — تكملةٌ للماوس حين تعتمد الصفحةُ على واجهة السحب لا على المؤشّر. */
  async dragHtml5(fromRef: string, toRef: string): Promise<boolean> {
    await this.#guardCurrentPage()
    if (!/^r\d{1,6}$/.test(fromRef) || !/^r\d{1,6}$/.test(toRef)) return false
    const ok = await this.#eval(`(() => { const a = document.querySelector('[data-abdo-ref="${fromRef}"]'), b = document.querySelector('[data-abdo-ref="${toRef}"]'); if (!a || !b) return "no";
  const dt = new DataTransfer(); const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
  fire(a, "dragstart"); fire(b, "dragenter"); fire(b, "dragover"); fire(b, "drop"); fire(a, "dragend"); return "yes" })()`)
    return ok === "yes"
  }
  /** ب3 — تحويمٌ فوق موضع: يُظهر القوائمَ والتلميحات كما يفعل المؤشّر. */
  async hoverAt(x: number, y: number): Promise<void> {
    await this.#guardCurrentPage()
    await this.#send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y })
  }

  /**
   * ب3 — نصُّ عنصرٍ (أو الصفحة) وأنماطُه المحسوبة — لحلقة إصلاح التصميم. تعبيرٌ ثابتٌ لا JS من النموذج.
   */
  async readText(ref?: string): Promise<string> {
    await this.#guardCurrentPage()
    const selector = ref === undefined ? "document.body" : `document.querySelector('[data-abdo-ref="${ref}"]')`
    return this.#eval(
      `(() => { const el = ${selector}; if (!el) return "";` +
        ` const cs = getComputedStyle(el); const keys = ["display","color","background-color","font-size","font-family","font-weight","width","height","margin","padding","border","text-align","direction"];` +
        ` const styles = {}; for (const k of keys) styles[k] = cs.getPropertyValue(k);` +
        ` return JSON.stringify({ title: document.title, url: location.href, focused: document.activeElement === el, text: (el.innerText || "").trim().slice(0, ${ref === undefined ? 6000 : 2000}), styles }) })()`,
    )
  }

  close(): void {
    this.#ws?.close()
    this.#ws = undefined
    this.#pageSession = undefined
    this.#attached?.reject(new Error("Browser control channel is closed"))
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Browser control channel is closed")) }
    this.#pending.clear()
  }
}
