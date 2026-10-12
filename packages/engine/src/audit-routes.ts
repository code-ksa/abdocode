/**
 * 10-08 (مقيس بـgpt-6.1-sol على موقع Next.js): «audit http://localhost:3001/ http://localhost:3001/models --widths …» — الأداةُ تقبل
 * المساراتِ التي تبدأ بـ«/» وحدها، فسقط الرابطان بصمت ودُقِّقت كلُّ صفحات البناء (40 صفحة، 185 خطأً) بدل الصفحتين المطلوبتين، فظنّ
 * النموذجُ أنّ صفحتَه فشلت. رابطٌ محلّيٌّ على منفذ الخادم المُدار مسارُه؛ ورابطٌ محلّيٌّ على منفذٍ آخر ليس خادمَ المشروع فيُسمّى؛ والخارجيُّ يُسمّى.
 */
const LOCAL = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?(\/[^\s]*)?$/iu

export function auditRoutesFromArgs(tokens: readonly string[], managedPort: number): { readonly routes: string[]; readonly refused: string[] } {
  const routes: string[] = [], refused: string[] = []
  for (const t of tokens) {
    if (t.startsWith("/")) { routes.push(t); continue }
    if (!/^https?:\/\//iu.test(t)) continue
    const m = LOCAL.exec(t)
    if (m === null) { refused.push(`${t} (خارجيّ — audit يقيس خادمَ المشروع المُدار وحده)`); continue }
    const port = m[1] === undefined ? 80 : Number(m[1])
    if (port !== managedPort) { refused.push(`${t} (المنفذ ${port} ليس خادمَ المشروع المُدار على ${managedPort})`); continue }
    routes.push(m[2] ?? "/")
  }
  return { routes, refused }
}

/** ضجيجُ خادم التطوير في الطرفيّة: مقبسُ إعادة التحميل الساخن لـNext/webpack/Vite — ليس خطأً في الصفحة. */
export const isDevHmrNoise = (text: string): boolean =>
  /WebSocket connection to '[^']*\/(?:_next\/(?:webpack-)?hmr|__webpack_hmr|@vite\/client|sockjs-node)/iu.test(text) || /\[HMR\]|\[Fast Refresh\]/u.test(text)
