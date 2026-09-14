const REQUEST_MAGIC = new TextEncoder().encode("ABPM1")
// ABGS2: بايتُ «نوع البحث» (0 ويب، 1 صور) بعد safe — الإصدارُ يُرفع لا يُمدَّد بصمت، فعاملٌ قديم يرفض الإطارَ الجديد بدل أن يقرأه مقلوباً.
const SEARCH_MAGIC = new TextEncoder().encode("ABGS2")
const RESPONSE_MAGIC = new TextEncoder().encode("ABPR1")
const MAX_REQUEST_BYTES = 1024 * 1024
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

export interface ModelProviderWorkerRequest {
  readonly provider: string
  readonly url: string
  readonly body: string
  readonly timeoutMs: number
}

export interface ModelProviderWorkerResponse {
  readonly status: number
  readonly body: string
}

export interface GoogleSearchWorkerRequest {
  readonly query: string
  readonly count: number
  readonly site?: string
  readonly language: string
  readonly country: string
  readonly safe: "active" | "off"
  readonly kind?: "web" | "image"
  readonly timeoutMs: number
}

const same = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index])

const boundedText = (value: string, label: string): Uint8Array => {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new Error(`provider_worker_${label}_invalid`)
  const bytes = new TextEncoder().encode(value)
  if (bytes.byteLength > 0xffff) throw new Error(`provider_worker_${label}_oversize`)
  return bytes
}

/**
 * سقفُ مهلةِ نداء المزوّد وأرضيّتُها — **معلَنتان** لأنّ المُنادي يجب أن يقصّ
 * عليهما قبل أن يبني الطلب.
 *
 * ⚠ العطلُ الذي أنطق هذين الثابتين (مقيس 2026-09-04 على النسخة المشحونة):
 * حارةُ الوكيل في المحرّك كانت تطلب 360 ألف مللي، وهذا المُرمِّز يرفض ما فوق
 * 300 ألف — فكان **كلُّ دورِ وكيلٍ على أيّ مزوّدٍ سحابيّ** يسقط فوراً بـ
 * `provider_worker_timeout_invalid`. أولاما وحدَه ينجو لأنّه محلّيٌّ لا يمرّ
 * بالعامل. رقمان في ملفّين، لا أحدَ يقابلهما، فعُطّل جوهرُ المنتج بصمت.
 * والحدُّ الآن **يُستورَد** لا يُنسَخ، وبوّابةٌ في الاختبار تقابلهما.
 */
export const PROVIDER_WORKER_TIMEOUT_MS_MIN = 1_000
export const PROVIDER_WORKER_TIMEOUT_MS_MAX = 300_000

export function encodeModelProviderWorkerRequest(request: ModelProviderWorkerRequest): Uint8Array {
  const provider = boundedText(request.provider, "provider")
  const url = boundedText(request.url, "url")
  const body = new TextEncoder().encode(request.body)
  if (
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < PROVIDER_WORKER_TIMEOUT_MS_MIN ||
    request.timeoutMs > PROVIDER_WORKER_TIMEOUT_MS_MAX
  ) throw new Error("provider_worker_timeout_invalid")
  if (body.byteLength === 0 || body.byteLength > MAX_REQUEST_BYTES) throw new Error("provider_worker_body_invalid")
  const frame = new Uint8Array(5 + 2 + provider.byteLength + 2 + url.byteLength + 4 + 4 + body.byteLength)
  const view = new DataView(frame.buffer)
  let at = 0
  frame.set(REQUEST_MAGIC, at); at += 5
  view.setUint16(at, provider.byteLength, false); at += 2; frame.set(provider, at); at += provider.byteLength
  view.setUint16(at, url.byteLength, false); at += 2; frame.set(url, at); at += url.byteLength
  view.setUint32(at, request.timeoutMs, false); at += 4
  view.setUint32(at, body.byteLength, false); at += 4; frame.set(body, at)
  return frame
}

const writeText = (target: Uint8Array, view: DataView, at: number, value: string, label: string, allowEmpty = false): number => {
  const bytes = new TextEncoder().encode(value)
  if ((!allowEmpty && bytes.byteLength === 0) || bytes.byteLength > 0xffff || value.includes("\0")) throw new Error(`provider_worker_${label}_invalid`)
  view.setUint16(at, bytes.byteLength, false)
  target.set(bytes, at + 2)
  return at + 2 + bytes.byteLength
}

export function encodeGoogleSearchWorkerRequest(request: GoogleSearchWorkerRequest): Uint8Array {
  if (!Number.isSafeInteger(request.count) || request.count < 1 || request.count > 10) throw new Error("provider_worker_search_count_invalid")
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1_000 || request.timeoutMs > 30_000) throw new Error("provider_worker_timeout_invalid")
  const values = [request.query, request.site ?? "", request.language, request.country]
  const size = 5 + values.reduce((sum, value) => sum + 2 + new TextEncoder().encode(value).byteLength, 0) + 1 + 1 + 1 + 4
  const frame = new Uint8Array(size)
  const view = new DataView(frame.buffer)
  frame.set(SEARCH_MAGIC)
  let at = 5
  at = writeText(frame, view, at, request.query, "search_query")
  at = writeText(frame, view, at, request.site ?? "", "search_site", true)
  at = writeText(frame, view, at, request.language, "search_language")
  at = writeText(frame, view, at, request.country, "search_country")
  frame[at++] = request.count
  frame[at++] = request.safe === "active" ? 1 : request.safe === "off" ? 0 : 255
  if (frame[at - 1] === 255) throw new Error("provider_worker_search_safe_invalid")
  frame[at++] = request.kind === "image" ? 1 : request.kind === undefined || request.kind === "web" ? 0 : 255
  if (frame[at - 1] === 255) throw new Error("provider_worker_search_kind_invalid")
  view.setUint32(at, request.timeoutMs, false)
  return frame
}

export function decodeModelProviderWorkerResponse(frame: Uint8Array): ModelProviderWorkerResponse {
  if (frame.byteLength < 11 || frame.byteLength > MAX_RESPONSE_BYTES + 11 || !same(frame.subarray(0, 5), RESPONSE_MAGIC)) {
    throw new Error("provider_worker_response_invalid")
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  const status = view.getUint16(5, false)
  const length = view.getUint32(7, false)
  if (status < 100 || status > 599 || length > MAX_RESPONSE_BYTES || frame.byteLength !== 11 + length) {
    throw new Error("provider_worker_response_invalid")
  }
  let body: string
  try { body = new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(11)) }
  catch { throw new Error("provider_worker_response_invalid_utf8") }
  return Object.freeze({ status, body })
}

export class ModelProviderWorker {
  constructor(private readonly executable: string) {}

  async request(request: ModelProviderWorkerRequest, signal?: AbortSignal): Promise<ModelProviderWorkerResponse> {
    const input = encodeModelProviderWorkerRequest(request)
    if (signal?.aborted) throw new Error("provider_worker_aborted")
    let child: Bun.Subprocess<Uint8Array, "pipe", "pipe">
    // env تُمرَّر نصاً: بلا الخيار لا يرى الوليد تحويرات process.env التي
    // كتبها المضيف بعد الإقلاع (ABDO_CUSTOM_PROVIDERS تُضبط عند حفظ
    // الإعدادات) — قيس حياً 2026-09-01: الإعلان لم يصل فرفض العامل مزوّداً
    // معلَناً صحيحاً.
    try { child = Bun.spawn([this.executable, "provider"], { stdin: input, stdout: "pipe", stderr: "pipe", env: { ...process.env } }) }
    catch (error) { throw new Error(`provider_worker_unavailable: ${error instanceof Error ? error.message : String(error)}`) }
    const timeout = setTimeout(() => child.kill(), request.timeoutMs + 5_000)
    const abort = () => child.kill()
    signal?.addEventListener("abort", abort, { once: true })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
    ]).finally(() => {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", abort)
    })
    if (signal?.aborted) throw new Error("provider_worker_aborted")
    if (exitCode !== 0) throw new Error(`provider_worker_refused: ${stderr.trim().slice(0, 512) || `exit ${exitCode}`}`)
    return decodeModelProviderWorkerResponse(new Uint8Array(stdout))
  }

  async hasCredential(provider: string): Promise<boolean> {
    if (!/^[a-z0-9-]{1,32}$/.test(provider)) throw new Error("provider_worker_provider_invalid")
    let child: Bun.Subprocess<undefined, "pipe", "pipe">
    try { child = Bun.spawn([this.executable, "provider-has", provider], { stdout: "pipe", stderr: "pipe", env: { ...process.env } }) }
    catch (error) { throw new Error(`provider_worker_unavailable: ${error instanceof Error ? error.message : String(error)}`) }
    const timeout = setTimeout(() => child.kill(), 10_000)
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]).finally(() => clearTimeout(timeout))
    if (exitCode !== 0 || (stdout !== "0" && stdout !== "1")) {
      throw new Error(`provider_worker_refused: ${stderr.trim().slice(0, 512) || `exit ${exitCode}`}`)
    }
    return stdout === "1"
  }

  async search(request: GoogleSearchWorkerRequest, signal?: AbortSignal): Promise<ModelProviderWorkerResponse> {
    const input = encodeGoogleSearchWorkerRequest(request)
    if (signal?.aborted) throw new Error("provider_worker_aborted")
    let child: Bun.Subprocess<Uint8Array, "pipe", "pipe">
    try { child = Bun.spawn([this.executable, "provider-search"], { stdin: input, stdout: "pipe", stderr: "pipe", env: { ...process.env } }) }
    catch (error) { throw new Error(`provider_worker_unavailable: ${error instanceof Error ? error.message : String(error)}`) }
    const timeout = setTimeout(() => child.kill(), request.timeoutMs + 5_000)
    const abort = () => child.kill()
    signal?.addEventListener("abort", abort, { once: true })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
    ]).finally(() => {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", abort)
    })
    if (signal?.aborted) throw new Error("provider_worker_aborted")
    if (exitCode !== 0) throw new Error(`provider_worker_refused: ${stderr.trim().slice(0, 512) || `exit ${exitCode}`}`)
    return decodeModelProviderWorkerResponse(new Uint8Array(stdout))
  }
}
