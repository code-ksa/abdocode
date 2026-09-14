/**
 * بحث Google — مصدرٌ واحد لأداة عبدو وخادم MCP.
 *
 * الفكرة الممتصّة من خوادم Workspace MCP: أداةٌ ضيقة للبحث المنظّم عبر
 * Programmable Search، ومدخلان سرّيان فقط (API key + cx). لا OAuth، لا
 * Workspace كامل، ولا مفتاح في URL معروض أو دفتر أو renderer.
 */

export interface GoogleSearchRequest {
  readonly query: string
  readonly count?: number
  readonly site?: string
  readonly language?: string
  readonly country?: string
  readonly safe?: "active" | "off"
  /** ويب افتراضاً؛ «image» يطلب صوراً من PSE نفسِه (`searchType=image`) — الفكرةُ من خوادم MCP للصور، والمالكُ واحد. */
  readonly kind?: "web" | "image"
}

export interface GoogleSearchItem {
  readonly title: string
  readonly url: string
  readonly displayUrl: string
  readonly snippet: string
  /** يحضر في نتائج الصور وحدها: الصفحةُ الحاضنة، المصغَّرة، الأبعادُ، والنوع — ما يحتاجه اختيارٌ مرئيّ لاحق. */
  readonly image?: { readonly contextUrl: string; readonly thumbnailUrl: string; readonly width?: number; readonly height?: number; readonly mime?: string }
}

export interface GoogleSearchResponse {
  readonly query: string
  readonly totalResults?: string
  readonly searchTime?: number
  readonly correctedQuery?: string
  readonly items: readonly GoogleSearchItem[]
  readonly browserUrl: string
}

const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i

const clean = (value: unknown, max: number): string =>
  String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max)

export const browserUrl = (query: string, kind: "web" | "image" = "web"): string => {
  const q = clean(query, 300)
  return `https://www.google.com/search?q=${encodeURIComponent(q)}${kind === "image" ? "&tbm=isch" : ""}`
}

export const normaliseRequest = (request: GoogleSearchRequest): GoogleSearchRequest => {
  const query = clean(request.query, 300)
  if (query.length === 0) throw new Error("البحث يحتاج عبارة")
  const site = request.site === undefined ? undefined : clean(request.site.replace(/^https?:\/\//i, "").split("/")[0], 253)
  if (site !== undefined && !DOMAIN.test(site)) throw new Error("نطاق site غير صالح")
  return {
    query,
    count: Math.min(10, Math.max(1, Math.round(request.count ?? 5))),
    site,
    language: /^[a-z]{2}(?:-[A-Z]{2})?$/.test(request.language ?? "") ? request.language : "ar",
    country: /^[a-z]{2}$/i.test(request.country ?? "") ? request.country!.toLowerCase() : "sa",
    safe: request.safe === "off" ? "off" : "active",
    kind: request.kind === "image" ? "image" : "web",
  }
}

export const parseCommand = (input: string): GoogleSearchRequest => {
  const tokens = input.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  const query: string[] = []
  let count: number | undefined
  let site: string | undefined
  let kind: "web" | "image" | undefined
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === "--count" && tokens[i + 1]) {
      count = Number(tokens[i + 1])
      i += 1
      continue
    }
    if (token === "--site" && tokens[i + 1]) {
      site = tokens[i + 1]
      i += 1
      continue
    }
    if (token === "--images" || token === "--صور") { kind = "image"; continue }
    query.push(token.replace(/^['"]|['"]$/g, ""))
  }
  return normaliseRequest({ query: query.join(" "), count, site, kind })
}

export const decodeWorkerResponse = (request: GoogleSearchRequest, status: number, body: string): GoogleSearchResponse => {
  const input = normaliseRequest(request)
  if (!Number.isInteger(status) || status < 200 || status > 299) throw new Error(`Google Search ردّ ${status}`)
  let data: {
    searchInformation?: { totalResults?: string; searchTime?: number }
    spelling?: { correctedQuery?: string }
    items?: { title?: string; link?: string; displayLink?: string; snippet?: string; mime?: string; image?: { contextLink?: string; thumbnailLink?: string; width?: number; height?: number } }[]
  }
  try { data = JSON.parse(body) }
  catch { throw new Error("Google Search أعاد استجابة غير صالحة") }
  const items = (data.items ?? []).flatMap((item): GoogleSearchItem[] => {
    const url = clean(item.link, 2048)
    if (!/^https?:\/\//i.test(url)) return []
    return [{
      title: clean(item.title, 240),
      url,
      displayUrl: clean(item.displayLink, 253),
      snippet: clean(item.snippet, 600),
      ...(input.kind === "image" && item.image ? { image: {
        contextUrl: /^https?:\/\//i.test(clean(item.image.contextLink, 2048)) ? clean(item.image.contextLink, 2048) : "",
        thumbnailUrl: /^https?:\/\//i.test(clean(item.image.thumbnailLink, 2048)) ? clean(item.image.thumbnailLink, 2048) : "",
        ...(Number.isInteger(item.image.width) && item.image.width! > 0 ? { width: item.image.width } : {}),
        ...(Number.isInteger(item.image.height) && item.image.height! > 0 ? { height: item.image.height } : {}),
        ...(/^image\/[a-z0-9.+-]+$/i.test(clean(item.mime, 60)) ? { mime: clean(item.mime, 60).toLowerCase() } : {}),
      } } : {}),
    }]
  }).slice(0, input.count)
  return {
    query: input.query,
    totalResults: clean(data.searchInformation?.totalResults, 40) || undefined,
    searchTime: data.searchInformation?.searchTime,
    correctedQuery: clean(data.spelling?.correctedQuery, 300) || undefined,
    items,
    browserUrl: browserUrl(input.query, input.kind),
  }
}

export const format = (result: GoogleSearchResponse): string => {
  const head = `نتائج Google عن «${result.query}»${result.totalResults ? ` — نحو ${result.totalResults}` : ""}${result.searchTime === undefined ? "" : ` (${result.searchTime}ث)`}`
  const correction = result.correctedQuery ? `تصحيح مقترح: ${result.correctedQuery}\n` : ""
  if (result.items.length === 0) return `${head}\n${correction}لا نتائج.`
  return `${head}\n${correction}${result.items.map((item, i) => item.image
    ? `${i + 1}. ${item.title}\n   ${item.url}\n   ${[item.image.width && item.image.height ? `${item.image.width}×${item.image.height}` : "", item.image.mime ?? "", item.image.contextUrl ? `الصفحة: ${item.image.contextUrl}` : ""].filter(Boolean).join(" · ")}`
    : `${i + 1}. ${item.title}\n   ${item.url}\n   ${item.snippet}`).join("\n")}`
}

export * as GoogleSearch from "./google-search"
