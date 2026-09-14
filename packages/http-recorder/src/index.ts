import { createHash } from "node:crypto"
const SAFE_HEADERS = new Set(["content-type", "content-length", "etag", "last-modified"])
export interface HttpRecord { readonly method: string; readonly origin: string; readonly path: string; readonly headers: Readonly<Record<string, string>>; readonly bodyDigest: string; readonly bodyBytes: number }

export function recordHttp(input: { method: string; url: string; headers?: Record<string, string>; body?: Uint8Array; maximumBodyBytes?: number }): HttpRecord {
  const url = new URL(input.url)
  if (url.username || url.password) throw new Error("credentialed_url_refused")
  const body = input.body ?? new Uint8Array()
  if (body.byteLength > (input.maximumBodyBytes ?? 1024 * 1024)) throw new Error("http_record_body_too_large")
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(input.headers ?? {})) if (SAFE_HEADERS.has(name.toLowerCase())) headers[name.toLowerCase()] = value
  return Object.freeze({ method: input.method.toUpperCase(), origin: url.origin, path: url.pathname, headers: Object.freeze(headers), bodyDigest: createHash("sha256").update(body).digest("hex"), bodyBytes: body.byteLength })
}
