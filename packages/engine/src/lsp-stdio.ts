/**
 * ذ9ج — نقلُ LSP على stdio: الحاملُ الذي تحتاجه `@abdo/lsp` ولا تملكه (الحزمةُ لا تُطلق عمليّةً بالتصميم؛ المضيفُ يطلقها).
 * JSON-RPC بترويسة Content-Length كما في مواصفة LSP، تشغيلٌ بـBun.spawn داخل مجلّد المشروع، وموتُ الخادم يُرى (exited) لا يُخمَّن.
 * لا اعتمادَ يُنزَّل: خادمُ اللغة يُلتقط من `node_modules/.bin` في المشروع أو من PATH، وغيابُه «غيرُ متاح» بسببٍ لا سكوت.
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { LspDiagnostic, LspTransport } from "@abdo/lsp"

type Pending = { readonly resolve: (v: unknown) => void; readonly reject: (e: Error) => void }

export interface StdioTransportOptions { readonly command: readonly string[]; readonly cwd: string; readonly onStderr?: (line: string) => void }

/** يبحث عن أمرِ الخادم: `node_modules/.bin/<name>(.cmd)` في المشروع أوّلاً ثمّ الاسمُ كما هو (PATH). يعود undefined إن لم يوجد محلّياً ولم يُطلب PATH. */
export function locateServer(command: readonly string[], projectDir: string, allowPath = true): readonly string[] | undefined {
  const [head, ...rest] = command
  if (head === undefined) return undefined
  for (const candidate of [join(projectDir, "node_modules", ".bin", `${head}.cmd`), join(projectDir, "node_modules", ".bin", head)]) if (existsSync(candidate)) return [candidate, ...rest]
  return allowPath ? command : undefined
}

export class StdioLspTransport implements LspTransport {
  readonly #child: ReturnType<typeof Bun.spawn>
  readonly #pending = new Map<number, Pending>()
  readonly #exit: Promise<{ code: number | null; signal?: string }>
  #seq = 0
  #buffer = new Uint8Array(0)
  #diagnostics: ((params: { uri: string; diagnostics: readonly LspDiagnostic[] }) => void) | undefined
  /** ما فُتح: الصورةُ الموحَّدة ⇦ الصورةُ التي فُتح بها (الخادمُ قد يعيد URI بترميزٍ آخر: `c%3A`، حرفُ سواقةٍ صغير). */
  readonly #opened = new Map<string, string>()
  /** عددُ نشرات التشخيص لكلّ ملفّ (بصورته الموحَّدة) — «أجاب» يُقال بعدّادٍ يزيد لا بمصفوفةٍ فارغة. */
  readonly #publishes = new Map<string, number>()
  #dead: Error | undefined

  constructor(options: StdioTransportOptions) {
    const cmd = [...options.command]
    // ملفّاتُ .cmd على ويندوز تحتاج cmd.exe؛ Bun.spawn لا يفتحها مباشرة.
    // cmd.exe بمساره من ComSpec لا بالاسم: بحثُ PATH عنه يفشل تحت بعض الأصداف (Git Bash) بينما المسارُ المطلق ثابت.
    const comspec = process.env.ComSpec ?? process.env.COMSPEC ?? join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "cmd.exe")
    const argv = /\.cmd$/i.test(cmd[0] ?? "") ? [comspec, "/c", ...cmd] : cmd
    const child = Bun.spawn(argv, { cwd: options.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true })
    this.#child = child
    this.#exit = child.exited.then((code) => { this.#dead = new Error(`language server exited (${code})`); for (const p of this.#pending.values()) p.reject(this.#dead); this.#pending.clear(); return { code } })
    void this.#readLoop()
    void (async () => { try { for await (const chunk of child.stderr as ReadableStream<Uint8Array>) for (const line of new TextDecoder().decode(chunk).split(/\r?\n/)) if (line.trim()) options.onStderr?.(line) } catch { /* أُغلق */ } })()
  }

  async #readLoop(): Promise<void> {
    const decoder = new TextDecoder()
    try {
      for await (const chunk of this.#child.stdout as ReadableStream<Uint8Array>) {
        const merged = new Uint8Array(this.#buffer.length + chunk.length); merged.set(this.#buffer); merged.set(chunk, this.#buffer.length); this.#buffer = merged
        for (;;) {
          const headerEnd = indexOfSeq(this.#buffer, "\r\n\r\n")
          if (headerEnd < 0) break
          const header = decoder.decode(this.#buffer.subarray(0, headerEnd))
          const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1] ?? NaN)
          if (!Number.isFinite(length)) { this.#buffer = this.#buffer.subarray(headerEnd + 4); continue }
          const total = headerEnd + 4 + length
          if (this.#buffer.length < total) break
          const body = decoder.decode(this.#buffer.subarray(headerEnd + 4, total))
          this.#buffer = this.#buffer.subarray(total)
          this.#onMessage(body)
        }
      }
    } catch { /* الخادمُ مات؛ exited يقولها */ }
  }

  #onMessage(body: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: unknown }
    try { message = JSON.parse(body) } catch { return }
    if (typeof message.id === "number" && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.#pending.get(message.id)
      if (pending === undefined) return
      this.#pending.delete(message.id)
      if (message.error !== undefined) pending.reject(new Error(String(message.error.message ?? "lsp error")))
      else pending.resolve(message.result)
      return
    }
    if (message.method === "textDocument/publishDiagnostics" && this.#diagnostics !== undefined) {
      // السلكُ يحمل الشدّةَ رقماً (1 خطأ … 4 تلميح) والعقدُ يريدها اسماً؛ وuri الملفّ يُلحق بكلّ تشخيصٍ كما يطلب العقد.
      const raw = message.params as { uri: string; diagnostics: readonly (Omit<LspDiagnostic, "severity" | "uri"> & { severity?: number | LspDiagnostic["severity"] })[] }
      const names: readonly LspDiagnostic["severity"][] = ["error", "warning", "information", "hint"]
      // يُردّ إلى الصورة التي فُتح بها الملفّ كي يطابق مفتاحَ العميل، ويُعدّ النشرُ لهذه الصورة.
      const canon = canonicalUri(raw.uri)
      const uri = this.#opened.get(canon) ?? raw.uri
      this.#publishes.set(canon, (this.#publishes.get(canon) ?? 0) + 1)
      this.#diagnostics({ uri, diagnostics: raw.diagnostics.map((d) => ({ ...d, uri, severity: typeof d.severity === "number" ? names[d.severity - 1] ?? "error" : d.severity ?? "error" })) })
    }
    // طلباتُ الخادم للعميل (window/workDoneProgress/create…) تُجاب بفراغٍ كي لا يتعلّق.
    if (typeof message.id === "number" && message.method !== undefined) this.#write({ jsonrpc: "2.0", id: message.id, result: null })
  }

  #write(value: object): void {
    if (this.#dead !== undefined) return
    const body = JSON.stringify(value)
    const bytes = new TextEncoder().encode(body)
    const head = new TextEncoder().encode(`Content-Length: ${bytes.length}\r\n\r\n`)
    const frame = new Uint8Array(head.length + bytes.length); frame.set(head); frame.set(bytes, head.length)
    const stdin = this.#child.stdin as { write(data: Uint8Array): unknown; flush?(): unknown }
    stdin.write(frame); stdin.flush?.()
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.#dead !== undefined) return Promise.reject(this.#dead)
    const id = ++this.#seq
    return new Promise((resolve, reject) => { this.#pending.set(id, { resolve, reject }); this.#write({ jsonrpc: "2.0", id, method, params }) })
  }
  notify(method: string, params: unknown): void {
    if (method === "textDocument/didOpen") { const uri = (params as { textDocument?: { uri?: string } }).textDocument?.uri; if (typeof uri === "string") this.#opened.set(canonicalUri(uri), uri) }
    this.#write({ jsonrpc: "2.0", method, params })
  }
  /** كم مرّةً نشر الخادمُ تشخيصاتٍ لهذا الملفّ (بأيّ ترميزٍ أعاده). */
  publishCount(uri: string): number { return this.#publishes.get(canonicalUri(uri)) ?? 0 }
  exited(): Promise<{ code: number | null; signal?: string }> { return this.#exit }
  /** على ويندوز الخادمُ يُطلق عبر cmd.exe /c <shim>.cmd — قتلُ الغلاف وحده يترك الخادمَ يتيماً؛ فالشجرةُ كلُّها (taskkill /T). */
  kill(): void {
    try {
      if (process.platform === "win32" && this.#child.pid !== undefined) Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(this.#child.pid)], { stdout: "ignore", stderr: "ignore" })
      this.#child.kill()
    } catch { /* انتهى */ }
  }
  onDiagnostics(handler: (params: { uri: string; diagnostics: readonly LspDiagnostic[] }) => void): void { this.#diagnostics = handler }
}

function indexOfSeq(buf: Uint8Array, seq: string): number {
  const s = new TextEncoder().encode(seq)
  outer: for (let i = 0; i + s.length <= buf.length; i += 1) { for (let j = 0; j < s.length; j += 1) if (buf[i + j] !== s[j]) continue outer; return i }
  return -1
}

/** مسارُ ملفٍّ ⇦ URI ملفّ كما يفهمه الخادم (ويندوز: `file:///C:/…`)؛ المسافاتُ وغيرُ ASCII تُرمَّز (encodeURI يبقي / و:). */
export const fileUri = (absolutePath: string): string => `file:///${encodeURI(absolutePath.replace(/\\/g, "/").replace(/^\//, ""))}`

/** صورةٌ موحَّدة لمقارنة URIs الملفّات: فكُّ الترميز، حرفُ السواقة صغيراً، شرطاتٌ أماميّة. */
export const canonicalUri = (uri: string): string => {
  let u = uri
  try { u = decodeURIComponent(uri) } catch { /* ترميزٌ معطوب — تُقارن كما هي */ }
  return u.replace(/\\/g, "/").replace(/^file:\/\/\/?/i, "file:///").replace(/^file:\/\/\/([a-z]):/i, (_m, d: string) => `file:///${d.toLowerCase()}:`)
}
