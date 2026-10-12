/**
 * 10-09 — وجهاتُ الموصّلات في سياج الخروج. قيس حيّاً: «egress refused: mcp.slack.com — destination was never declared» عند ضغط
 * «اربط» في سلاك، ولينير ونوشن بالطريق نفسه — السياجُ يُركَّب عند تحميل المحرّك (ويغطّي جسرَي mcp-remote/mcp-google) ولم يُعلَن
 * له أيُّ مضيف موصّل؛ والاختبارُ الحيّ أخضر لأنه يربط على 127.0.0.1 المعلَن أصلاً.
 *
 * ما يُفتح هنا محدود بما اختاره المستخدم: موردُ موصّلٍ من السجلّ المضمَّن (أو مخصّصٍ أضافه بيده) بعد ضغط «اربط»، ثمّ المضيفات التي
 * يعلنها ذلك المورد نفسُه في بيانات التفويض (RFC 9728/8414) — https وحده. لا شيء يفتحه النموذج.
 */

/** Pure. Hostname of an https URL; `undefined` for anything else (http, unparseable) — never widened to a plain-http host. */
export const httpsHost = (url: string | undefined): string | undefined => {
  if (url === undefined) return undefined
  try { const u = new URL(url); return u.protocol === "https:" && u.hostname !== "" ? u.hostname.toLowerCase() : undefined } catch { return undefined }
}

/** Pure. The https hosts an authorization server announced for the token exchange, registration and revocation. */
export const connectorAuthHosts = (meta: { token_endpoint?: string; registration_endpoint?: string; revocation_endpoint?: string; authorization_endpoint?: string }): string[] =>
  [...new Set([meta.token_endpoint, meta.registration_endpoint, meta.revocation_endpoint].map(httpsHost).filter((h): h is string => h !== undefined))]

/** واجهاتُ جوجل التي يناديها خادمُ mcp-google المدمج (google.ts: gmail، calendar/drive، تجديدُ الرمز). */
export const GOOGLE_API_HOSTS = Object.freeze(["gmail.googleapis.com", "www.googleapis.com", "oauth2.googleapis.com"])

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/**
 * Fetch for discovery: each https host it is about to reach is declared first (with the connector named as the reason). The hosts are the
 * resource's own and the authorization server its metadata points at — chosen by the connector the user linked, not by the model.
 */
export const connectorDiscoveryFetch = (id: string, allow: (host: string, why: string) => void, fetchImpl: Fetch): Fetch => (input, init) => {
  const host = httpsHost(input instanceof Request ? input.url : String(input))
  if (host !== undefined) allow(host, `connector ${id} (linked by the user)`)
  return fetchImpl(input, init)
}
