/**
 * يبحث المحرّكُ عن الجسر الحيّ (chrome-bridge.json ⇦ /health)، يفتح نافذةَ الاقتران (`POST /pair/open` بالرمز)، يُقلع
 * متصفّحاً إن لم يكن أيٌّ يعمل، وينتظر اتّصالَ الإضافة. النتيجةُ **حالةٌ مسمّاة** لا ادّعاء:
 *   connected — الإضافةُ متّصلة الآن؛ paired-waiting — نافذةٌ مفتوحة والمتصفّحُ يعمل ولم تتّصل بعد؛
 *   no-bridge — لا جسرَ يعمل (وصّل «إضافة المتصفّح» من الإعدادات)؛ not-installed — بعد الانتظار لا اتّصال ⇦ رابطُ التثبيت.
 * الوحدةُ نقيّة: fetch والإقلاعُ والانتظارُ تُحقن وتُبدَّل في الاختبار.
 */
import { readBridgePairing } from "./mcp-servers/chrome-bridge"

export const EXTENSION_INSTALL_URL = "https://github.com/code-ksa/abdocode-addons/releases/latest"

export interface PairingDeps {
  readonly stateDir: string
  readonly fetchFn?: typeof fetch
  /** أسماءُ عمليّات المتصفّحات العاملة (msedge, chrome, firefox…) — فارغةٌ = لا متصفّح. */
  readonly runningBrowsers?: () => Promise<readonly string[]>
  /** يُقلع متصفّحاً (Edge ثمّ Chrome) ويعيد اسمَه، أو undefined إن لم يوجد. */
  readonly launchBrowser?: () => Promise<string | undefined>
  readonly sleep?: (ms: number) => Promise<void>
  readonly waitMs?: number
  readonly pollMs?: number
}

export interface PairingOutcome { readonly status: "connected" | "paired-waiting" | "no-bridge" | "not-installed"; readonly text: string; readonly port?: number; readonly launched?: string }

const health = async (fetchFn: typeof fetch, port: number): Promise<{ connected: boolean; pairing: boolean } | undefined> => {
  try {
    const response = await fetchFn(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2500) })
    if (!response.ok) return undefined
    const body = (await response.json()) as { connected?: unknown; pairing?: unknown }
    return { connected: body.connected === true, pairing: body.pairing === true }
  } catch { return undefined }
}

export const installGuidance = (port: number): string =>
  `الإضافةُ غيرُ مثبّتة أو غيرُ مقترنة في المتصفّح. ثبّتها: ${EXTENSION_INSTALL_URL} (كروم/إيدج: AbdoCode-Extension-Chrome.zip أو -Edge.zip ⇦ فكّ الضغط ⇦ chrome://extensions أو edge://extensions ⇦ وضعُ المطوّر ⇦ «تحميل غير معبّأ»). بعد التثبيت تقترن وحدها ما دامت نافذةُ الاقتران مفتوحة (دقيقتان من الآن على المنفذ ${port}) — أو اضغط في نافذة الإضافة «ابحث عن عبدو كود واقترن». أعد «browser pair» بعدها.`

export async function ensureExtensionPaired(deps: PairingDeps): Promise<PairingOutcome> {
  const fetchFn = deps.fetchFn ?? fetch
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const pairing = readBridgePairing(deps.stateDir)
  if (pairing === undefined) return { status: "no-bridge", text: "لا جسرَ لإضافة المتصفّح: أضف «إضافة المتصفّح» من الإعدادات ▸ الاتّصالات ثمّ «وصّل» — الجسرُ يعمل داخل عبدو كود ويكتب منفذَه ورمزَه على هذا الجهاز فقط." }
  const first = await health(fetchFn, pairing.port)
  if (first === undefined) return { status: "no-bridge", port: pairing.port, text: `جسرُ الإضافة غيرُ عاملٍ على 127.0.0.1:${pairing.port} (ملفُّ الاقتران موجود لكنّ الخادم لا يردّ): وصّل «إضافة المتصفّح» من الإعدادات ▸ الاتّصالات، أو أعد تشغيل عبدو كود.` }
  if (first.connected) return { status: "connected", port: pairing.port, text: `إضافةُ المتصفّح متّصلةٌ بعبدو كود (المنفذ ${pairing.port}) — أدواتُ page/open/look/tap/scroll/shot تعمل في تبويب المستخدم.` }
  // النافذةُ تُفتح بالرمز الذي يملكه المحرّك وحده — الإضافةُ غيرُ المقترنة تسأل /pair فتأخذه.
  try { await fetchFn(`http://127.0.0.1:${pairing.port}/pair/open`, { method: "POST", headers: { "x-abdo-bridge-token": pairing.token }, signal: AbortSignal.timeout(2500) }) } catch { /* الصحّةُ ردّت للتوّ؛ فشلُ الفتح يظهر في الانتظار */ }
  let launched: string | undefined
  const running = deps.runningBrowsers === undefined ? [] : await deps.runningBrowsers()
  if (running.length === 0 && deps.launchBrowser !== undefined) launched = await deps.launchBrowser()
  const waitMs = deps.waitMs ?? 25_000, pollMs = deps.pollMs ?? 1000
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await sleep(pollMs)
    const now = await health(fetchFn, pairing.port)
    if (now?.connected === true) return { status: "connected", port: pairing.port, ...(launched === undefined ? {} : { launched }), text: `اقترنت إضافةُ المتصفّح واتّصلت${launched === undefined ? "" : ` (أُقلع ${launched})`} — المنفذ ${pairing.port}. أدواتُ page/open/look/tap/scroll/shot تعمل الآن في تبويب المستخدم.` }
  }
  const browsers = running.length > 0 ? `المتصفّحُ يعمل (${running.join(", ")})` : launched !== undefined ? `أُقلع ${launched}` : "لا متصفّحَ يعمل ولم يُعثر على Edge أو Chrome"
  return { status: launched !== undefined || running.length > 0 ? "not-installed" : "paired-waiting", port: pairing.port, ...(launched === undefined ? {} : { launched }), text: `${browsers}، ولم تتّصل الإضافةُ خلال ${Math.round(waitMs / 1000)} ث. ${installGuidance(pairing.port)}` }
}

/** المتصفّحاتُ العاملة على ويندوز بأسماء عمليّاتها. */
export async function runningBrowsersWindows(): Promise<readonly string[]> {
  if (process.platform !== "win32") return []
  try {
    const proc = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", "(Get-Process msedge,chrome,firefox,brave -ErrorAction SilentlyContinue | Group-Object Name | ForEach-Object { $_.Name }) -join ','"], { stdout: "pipe", stderr: "ignore", windowsHide: true })
    const out = (await new Response(proc.stdout).text()).trim()
    await proc.exited
    return out.length === 0 ? [] : out.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
  } catch { return [] }
}

/** يُقلع Edge ثمّ Chrome بـShellExecute (لا بصدفة Git)؛ يعيد اسمَ ما أُقلع. */
export async function launchBrowserWindows(): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined
  for (const exe of ["msedge", "chrome"]) {
    try {
      const proc = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", `try { Start-Process -FilePath '${exe}' -ErrorAction Stop; 'ok' } catch { 'no' }`], { stdout: "pipe", stderr: "ignore", windowsHide: true })
      const out = (await new Response(proc.stdout).text()).trim()
      await proc.exited
      if (out === "ok") return exe
    } catch { /* جرّب التالي */ }
  }
  return undefined
}
