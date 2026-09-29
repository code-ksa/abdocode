/**
 * 09-29 — أداةُ `probe`: فحصُ عناوين خادم التطوير المحلّيّ في نداءٍ واحد. مقيس على مهمّة OpenRouter: كلُّ فحصٍ كان نداءَ
 * نموذجٍ كاملاً (`powershell -Command "Invoke-WebRequest …"`) — ثمانيةُ نداءاتٍ لثماني صفحات في كلّ جولة، وأوّلُها انفجر
 * بـNullReferenceException بلا `-UseBasicParsing`. المشرفُ يفحص الصفحاتِ كلَّها بحلقةٍ واحدة؛ فليكن للمحرّك مثلُها.
 * الأهدافُ محصورةٌ في المضيف المحلّيّ (loopback) — لا SSRF ولا خروجٌ إلى الشبكة من هذه الأداة.
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"])

export interface ProbePlan { readonly urls: string[]; readonly refused: string[] }

/** يفكّ الوسائط: روابطُ مطلقة محلّيّة أو مساراتٌ تبدأ بـ`/` تُضاف إلى أصلِ أوّلِ رابطٍ مطلق (أو الأصل الافتراضيّ). */
export function probeTargets(rest: string, defaultBase: string): ProbePlan {
  const tokens = rest.trim().split(/\s+/u).filter((t) => t.length > 0 && t !== "probe")
  const urls: string[] = []
  const refused: string[] = []
  let base = defaultBase
  for (const token of tokens) {
    let candidate = token
    if (token.startsWith("/")) candidate = `${base.replace(/\/+$/u, "")}${token}`
    else if (!/^https?:\/\//iu.test(token)) candidate = `http://${token}`
    let parsed: URL
    try { parsed = new URL(candidate) } catch { refused.push(token); continue }
    if (!LOOPBACK.has(parsed.hostname.toLowerCase())) { refused.push(token); continue }
    if (!token.startsWith("/")) base = parsed.origin
    if (!urls.includes(parsed.toString())) urls.push(parsed.toString())
    if (urls.length >= 12) break
  }
  return { urls, refused }
}

export interface ProbeResult { readonly url: string; readonly status: number | undefined; readonly bytes: number; readonly type: string; readonly snippet: string; readonly ms: number; readonly error?: string }

const titleOf = (html: string): string | undefined => /<title[^>]*>([^<]{1,160})<\/title>/iu.exec(html)?.[1]?.trim()

export function snippetOf(type: string, body: string): string {
  if (/json/iu.test(type)) return body.replace(/\s+/gu, " ").slice(0, 160)
  if (/html/iu.test(type)) {
    const title = titleOf(body)
    const text = body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<title[\s\S]*?<\/title>/giu, " ").replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim()
    return `${title === undefined ? "" : `«${title}» `}${text.slice(0, 140)}`.trim()
  }
  return body.replace(/\s+/gu, " ").slice(0, 160)
}

/** يفحص الروابطَ بالتوازي (مهلة لكلّ رابط) — كلُّ نتيجةٍ سطرٌ واحد: الحالة والحجم والنوع والزمن ومقتطف. */
export async function probeUrls(urls: readonly string[], fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): Promise<ProbeResult[]> {
  return Promise.all(urls.map(async (url): Promise<ProbeResult> => {
    const started = Date.now()
    try {
      const res = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { accept: "text/html,application/json;q=0.9,*/*;q=0.5" } })
      const type = res.headers.get("content-type") ?? ""
      const body = (await res.text()).slice(0, 65_536)
      const location = res.headers.get("location")
      return { url, status: res.status, bytes: body.length, type: type.split(";")[0] ?? "", snippet: location !== null ? `⇒ ${location}` : snippetOf(type, body), ms: Date.now() - started }
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      return { url, status: undefined, bytes: 0, type: "", snippet: "", ms: Date.now() - started, error: why.slice(0, 160) }
    }
  }))
}

export function renderProbe(results: readonly ProbeResult[], refused: readonly string[]): string {
  const lines = results.map((r) => r.status === undefined
    ? `✕ ${r.url} — لا استجابة (${r.error ?? "?"}) في ${r.ms}ms`
    : `${r.status >= 200 && r.status < 400 ? "✓" : "✕"} ${r.status} ${r.url} — ${r.bytes}B ${r.type || "?"} ${r.ms}ms${r.snippet.length > 0 ? ` — ${r.snippet}` : ""}`)
  const ok = results.filter((r) => r.status !== undefined && r.status >= 200 && r.status < 400).length
  const head = `probe: ${ok}/${results.length} تستجيب بنجاح`
  const foot = refused.length > 0 ? `\n⚠ رُفض (غير محلّيّ أو غير صالح): ${refused.join("، ")} — probe للمضيف المحلّيّ وحده؛ للشبكة استعمل fetch.` : ""
  return `${head}\n${lines.join("\n")}${foot}`
}
