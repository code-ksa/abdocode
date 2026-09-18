/**
 *
 * جلسةُ سطح المكتب تُعلن نفسَها على الشبكة المحلّيّة: صفحةُ ويب خفيفة تُفتح من الهاتف، تقترن برمزٍ من ستّة أرقام
 * يُعرض في الإعدادات، ثمّ تبثّ أُطرَ المحرّك نفسَها (دلتا، أحداث، أدوات، موافقات، تمام) وتدفع إلى الجلسة نفسِها
 * دوراً جديداً أو قطعاً أو توجيهاً أو قرارَ موافقة. لا سحابةَ وسيطة: المنفذُ على واجهات الجهاز وحدها (0.0.0.0).
 *
 * الحدود المقصودة:
 *  - الأُطرُ الواردة من الهاتف محصورةٌ في REMOTE_INBOUND_KINDS — لا إعداداتَ ولا مزوّدين ولا مشروعاً من بعيد.
 *  - رمزُ الاقتران يُستهلك عند نجاحه ويُجدَّد بعد خمس محاولاتٍ خاطئة؛ الرمزُ والجهازُ لا يُبثّان إلى العملاء.
 *  - أُطرٌ حاملةٌ لأسرارٍ أو ثقيلةٌ (bridge-pairing، لقطاتُ المتصفّح، كتالوجُ النماذج…) لا تُبثّ.
 *  - إغلاقُ المفتاح في الإعدادات يوقف الخادم ويقطع كلَّ العملاء ويُلغي رموزَهم.
 */
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto"
import { networkInterfaces } from "node:os"

export const REMOTE_INBOUND_KINDS: ReadonlySet<string> = new Set(["submit", "interrupt", "steer", "approve", "deny", "background-list"])
export const REMOTE_BROADCAST_SKIP: ReadonlySet<string> = new Set([
  "bridge-pairing", "remote-control", "ready", "settings", "models", "history", "archive", "usage-summary", "meter-summary",
  "vault-status", "browser-shot", "connectors", "connector-open", "connector-status", "extensions-bundled", "memory-notes",
  "memory-recall", "memory-inferred", "plugins", "grants", "denials", "resumed",
])
const MAX_DEVICES = 8
const MAX_FAILED_PAIRINGS = 5
const MAX_INBOUND_BYTES = 300 * 1024
const MAX_OUTBOUND_BYTES = 256 * 1024
const TOOL_OUTPUT_CAP = 8 * 1024

export type RemoteSnapshot = { project?: string; model?: string; mode?: string; running?: boolean; language?: string }
export type RemoteStatus = {
  status: "on" | "off"
  port?: number
  code?: string
  urls?: readonly string[]
  clients?: number
  devices?: number
}
export type RemoteControlOptions = {
  /** يُستدعى لكلّ إطارٍ مقبولٍ من الهاتف؛ المحرّك يمرّره في مسار أُطر القشرة نفسِه (وبتحقّق العقد نفسِه). */
  onFrame: (frame: Record<string, unknown>) => void
  snapshot: () => RemoteSnapshot
  /** الافتراض 0.0.0.0 (الشبكة المحلّيّة)؛ الاختباراتُ تمرّر 127.0.0.1. */
  hostname?: string
  /** 0 = منفذٌ عشوائيّ يختاره النظام. */
  port?: number
  log?: (line: string) => void
}

type Socket = { send(data: string): unknown; close(code?: number, reason?: string): unknown; data: { token: string } }

const pairingCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, "0")
const sameText = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))
const plainRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** عناوينُ IPv4 غيرُ الداخليّة لهذا الجهاز — ما يكتبه المستخدم في هاتفه. */
export function lanAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) for (const entry of list ?? []) {
    if (entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254.")) out.push(entry.address)
  }
  return out
}

/** يقصّ الأُطرَ الثقيلة قبل بثّها إلى الهاتف: ناتجُ الأداة إلى ٨ كيلوبايت، وما فوق السقف يُستبدل بإشارة. */
export function outboundForRemote(frame: Record<string, unknown>): string | undefined {
  const kind = typeof frame.kind === "string" ? frame.kind : ""
  if (kind.length === 0 || REMOTE_BROADCAST_SKIP.has(kind)) return undefined
  let shaped = frame
  if (kind === "tool-result" && typeof frame.output === "string" && frame.output.length > TOOL_OUTPUT_CAP) {
    shaped = { ...frame, output: `${frame.output.slice(0, TOOL_OUTPUT_CAP)}\n… (${frame.output.length - TOOL_OUTPUT_CAP} حرفاً محذوفة للهاتف)` }
  }
  const text = JSON.stringify(shaped)
  if (text.length <= MAX_OUTBOUND_BYTES) return text
  return JSON.stringify({ kind, turnId: frame.turnId, truncated: true, bytes: text.length })
}

/** يحكم على إطارٍ وارد من الهاتف قبل أن يبلغ المحرّك: النوعُ من القائمة، والحقولُ الخطِرة تُسقَط. */
export function inboundFromRemote(raw: string): { ok: true; frame: Record<string, unknown> } | { ok: false; why: string } {
  if (raw.length > MAX_INBOUND_BYTES) return { ok: false, why: "إطارٌ أكبر من سقف الريموت" }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return { ok: false, why: "إطارٌ ليس JSON" } }
  if (!plainRecord(parsed) || typeof parsed.kind !== "string") return { ok: false, why: "إطارٌ بلا نوع" }
  if (!REMOTE_INBOUND_KINDS.has(parsed.kind)) return { ok: false, why: `النوع «${parsed.kind}» غير مسموحٍ من الريموت — المسموح: ${[...REMOTE_INBOUND_KINDS].join("، ")}` }
  const frame: Record<string, unknown> = { ...parsed }
  delete frame.attachments // المرفقاتُ معرِّفاتُ ملفّاتٍ محلّيّة على سطح المكتب؛ لا معنى لها من الهاتف
  return { ok: true, frame }
}

export type RemoteControl = {
  start(): Promise<RemoteStatus>
  stop(): void
  status(): RemoteStatus
  regenerate(): RemoteStatus
  broadcast(frame: Record<string, unknown>): void
  readonly running: boolean
}

export function createRemoteControl(options: RemoteControlOptions): RemoteControl {
  const hostname = options.hostname ?? "0.0.0.0"
  const log = options.log ?? (() => {})
  let server: ReturnType<typeof Bun.serve> | undefined
  let code = pairingCode()
  let failed = 0
  const devices = new Map<string, { pairedAt: string; label: string }>()
  const sockets = new Set<Socket>()

  const urls = (port: number): string[] => (hostname === "0.0.0.0" ? lanAddresses() : [hostname]).map((ip) => `http://${ip}:${port}/`)
  const status = (): RemoteStatus => server === undefined
    ? { status: "off" }
    : { status: "on", port: server.port, code, urls: urls(server.port ?? 0), clients: sockets.size, devices: devices.size }
  const hello = (): string => JSON.stringify({ kind: "remote-hello", ...options.snapshot(), clients: sockets.size })

  const pair = async (request: Request): Promise<Response> => {
    let body: unknown
    try { body = await request.json() } catch { return Response.json({ ok: false, why: "JSON مطلوب" }, { status: 400 }) }
    const presented = plainRecord(body) && typeof body.code === "string" ? body.code.trim() : ""
    const label = plainRecord(body) && typeof body.label === "string" ? body.label.slice(0, 40) : "device"
    if (presented.length !== 6 || !sameText(presented, code)) {
      failed += 1
      if (failed >= MAX_FAILED_PAIRINGS) { code = pairingCode(); failed = 0; log("remote-control: pairing code rotated after repeated failures") }
      return Response.json({ ok: false, why: "رمزُ الاقتران غير صحيح" }, { status: 403 })
    }
    if (devices.size >= MAX_DEVICES) return Response.json({ ok: false, why: "بلغ عددُ الأجهزة المقترنة الحدّ" }, { status: 429 })
    const token = randomBytes(24).toString("hex")
    devices.set(token, { pairedAt: new Date().toISOString(), label })
    code = pairingCode(); failed = 0 // الرمزُ يُستهلك باقترانٍ واحد
    log(`remote-control: device paired (${label})`)
    return Response.json({ ok: true, token })
  }

  return {
    get running() { return server !== undefined },
    async start() {
      if (server !== undefined) return status()
      server = Bun.serve({
        hostname,
        port: options.port ?? 0,
        fetch(request, srv) {
          const url = new URL(request.url)
          if (request.method === "GET" && url.pathname === "/") return new Response(REMOTE_CLIENT_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } })
          if (request.method === "GET" && url.pathname === "/health") return Response.json({ ok: true, clients: sockets.size })
          if (request.method === "POST" && url.pathname === "/pair") return pair(request)
          if (request.method === "GET" && url.pathname === "/ws") {
            const token = url.searchParams.get("token") ?? ""
            if (token.length !== 48 || !devices.has(token)) return new Response("forbidden", { status: 403 })
            if (srv.upgrade(request, { data: { token } })) return undefined
            return new Response("upgrade required", { status: 426 })
          }
          return new Response("not found", { status: 404 })
        },
        websocket: {
          open(socket) { sockets.add(socket as unknown as Socket); socket.send(hello()) },
          message(socket, raw) {
            const verdict = inboundFromRemote(String(raw))
            if (!verdict.ok) { socket.send(JSON.stringify({ kind: "refused", why: verdict.why })); return }
            options.onFrame(verdict.frame)
          },
          close(socket) { sockets.delete(socket as unknown as Socket) },
        },
      })
      log(`remote-control: listening on ${hostname}:${server.port}`)
      return status()
    },
    stop() {
      if (server === undefined) return
      for (const socket of sockets) { try { socket.close(1001, "remote control stopped") } catch { /* مغلقٌ أصلاً */ } }
      sockets.clear(); devices.clear()
      server.stop(true); server = undefined
      code = pairingCode(); failed = 0
      log("remote-control: stopped")
    },
    status,
    regenerate() { code = pairingCode(); failed = 0; return status() },
    broadcast(frame) {
      if (sockets.size === 0) return
      const text = outboundForRemote(frame)
      if (text === undefined) return
      for (const socket of sockets) { try { socket.send(text) } catch { /* عميلٌ ساقط يُزال عند close */ } }
    },
  }
}

/** طابورُ أُطرٍ يُدفع إليه من الريموت ويُقرأ كمصدرٍ غيرِ متزامن بجوار stdin. */
export class FrameQueue<T> implements AsyncIterable<T> {
  #items: T[] = []
  #waiters: Array<(result: IteratorResult<T>) => void> = []
  #closed = false
  push(item: T): void {
    if (this.#closed) return
    const waiter = this.#waiters.shift()
    if (waiter !== undefined) waiter({ value: item, done: false }); else this.#items.push(item)
  }
  close(): void {
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined as T, done: true })
  }
  get size(): number { return this.#items.length }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.#items.length > 0) return Promise.resolve({ value: this.#items.shift() as T, done: false })
        if (this.#closed) return Promise.resolve({ value: undefined as T, done: true })
        return new Promise((resolve) => this.#waiters.push(resolve))
      },
    }
  }
}

/** يدمج مصدرين: ينتهي حين ينتهي الأوّل (القشرةُ ماتت = الجلسةُ انتهت)؛ الثاني (الريموت) يُقرأ ما دام حيّاً. */
export async function* mergeFrames<T>(primary: AsyncIterable<T>, secondary: AsyncIterable<T>): AsyncGenerator<T> {
  const a = primary[Symbol.asyncIterator]()
  const b = secondary[Symbol.asyncIterator]()
  let nextA: Promise<{ from: "a"; result: IteratorResult<T> }> | undefined = a.next().then((result) => ({ from: "a" as const, result }))
  let nextB: Promise<{ from: "b"; result: IteratorResult<T> }> | undefined = b.next().then((result) => ({ from: "b" as const, result }))
  while (nextA !== undefined) {
    const winner = await (nextB === undefined ? nextA : Promise.race([nextA, nextB]))
    if (winner.from === "a") {
      if (winner.result.done) return
      yield winner.result.value
      nextA = a.next().then((result) => ({ from: "a" as const, result }))
    } else {
      if (winner.result.done) { nextB = undefined; continue }
      yield winner.result.value
      nextB = b.next().then((result) => ({ from: "b" as const, result }))
    }
  }
}

/** صفحةُ الهاتف — ملفٌّ واحد بلا تبعيّات: اقترانٌ، بثٌّ حيّ، إرسالٌ، قطعٌ، موافقة/رفض. الرمزُ يُحمل في hash الرابط. */
export const REMOTE_CLIENT_HTML = `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>عبدو ريموت كونترول</title>
<style>
:root{color-scheme:light dark;--bg:#f6f5f2;--fg:#222;--dim:#75736d;--line:#dedcd6;--card:#fff;--ok:#1f6b35;--warn:#9a4a00;--danger:#b32b30}
@media(prefers-color-scheme:dark){:root{--bg:#161616;--fg:#eee;--dim:#9a9a94;--line:#333;--card:#1f1f1f}}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,"Segoe UI",Tahoma,sans-serif;display:flex;flex-direction:column;min-height:100dvh}
header{padding:10px 14px;border-bottom:1px solid var(--line);display:flex;gap:10px;align-items:center;flex-wrap:wrap}header strong{font-size:16px}header small{color:var(--dim)}
#state{margin-inline-start:auto;font-size:13px;padding:2px 10px;border-radius:999px;border:1px solid var(--line)}#state.on{color:var(--ok)}#state.run{color:var(--warn)}
main{flex:1;overflow:auto;padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.b{padding:10px 12px;border-radius:12px;background:var(--card);border:1px solid var(--line);white-space:pre-wrap;overflow-wrap:anywhere}
.b.user{background:transparent;border-style:dashed}.b.tool{font:13px/1.5 Consolas,monospace;direction:ltr;text-align:left;color:var(--dim)}
.b.done{color:var(--ok);border-color:var(--ok)}.b.refused{color:var(--danger)}.b.approval{border-color:var(--warn)}
.b.approval .row{display:flex;gap:8px;margin-top:8px}button{font:inherit;padding:8px 14px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:inherit}
button.primary{background:var(--fg);color:var(--bg);border-color:var(--fg)}button:disabled{opacity:.5}
footer{padding:10px 14px;border-top:1px solid var(--line);display:flex;gap:8px;align-items:flex-end}
textarea{flex:1;min-height:44px;max-height:160px;padding:10px;border-radius:12px;border:1px solid var(--line);background:var(--card);color:inherit;font:inherit;resize:vertical}
#pair{padding:24px 16px;display:flex;flex-direction:column;gap:12px;max-width:420px;margin:auto}#pair input{font-size:28px;letter-spacing:.4em;text-align:center;padding:10px;border-radius:12px;border:1px solid var(--line);background:var(--card);color:inherit;direction:ltr}
.hint{color:var(--dim);font-size:13px}
</style></head><body>
<header><strong>عبدو ريموت كونترول</strong><small id="meta">—</small><span id="state">غير متّصل</span></header>
<section id="pair" hidden><h2 style="margin:0">اقترانٌ بجلسة سطح المكتب</h2><p class="hint">اكتب رمز الاقتران المعروض في عبدو كود ▸ الإعدادات ▸ عبدو ريموت كونترول.</p><input id="code" inputmode="numeric" maxlength="6" placeholder="000000" autocomplete="one-time-code"><button class="primary" id="pairbtn">اقترن</button><p class="hint" id="pairmsg"></p></section>
<main id="feed" hidden></main>
<footer id="bar" hidden><textarea id="text" placeholder="اكتب طلبك… (Ctrl+Enter للإرسال)"></textarea><button id="send" class="primary">إرسال</button><button id="stop" title="قطع الدور الجاري">⏹</button></footer>
<script>
(()=>{
const $=id=>document.getElementById(id);const feed=$('feed');let ws,token=(location.hash.match(/t=([0-9a-f]{48})/)||[])[1]||'',running=null,streamBlock=null,pending=null,drops=0;
const el=(cls,text)=>{const n=document.createElement('div');n.className='b '+cls;n.textContent=text;feed.append(n);feed.scrollTop=feed.scrollHeight;return n;};
const setState=(txt,cls)=>{const s=$('state');s.textContent=txt;s.className=cls||'';};
function showPair(msg){$('pair').hidden=false;feed.hidden=true;$('bar').hidden=true;$('pairmsg').textContent=msg||'';}
function showFeed(){$('pair').hidden=true;feed.hidden=false;$('bar').hidden=false;}
async function pair(){const code=$('code').value.trim();$('pairbtn').disabled=true;try{const r=await fetch('/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code,label:navigator.userAgent.slice(0,40)})});const j=await r.json();if(!j.ok){showPair(j.why||'فشل الاقتران');return;}token=j.token;location.hash='t='+token;connect();}catch(e){showPair('تعذّر الوصول إلى الجلسة: '+e);}finally{$('pairbtn').disabled=false;}}
function connect(){if(!token){showPair('');return;}showFeed();setState('يتّصل…');ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws?token='+token);
ws.onopen=()=>{drops=0;setState('متّصل','on');};
// إغلاقٌ من الخادم (1000/1001/1008) = أُلغيت الرموز؛ وثلاثُ محاولاتٍ فاشلة متتالية (1006 بعد 403) = الرمزُ لم يعد صالحاً
ws.onclose=e=>{setState('انقطع');drops+=1;if(e.code===1000||e.code===1001||e.code===1008||drops>=3){token='';location.hash='';showPair('انتهى الاقتران — اقترن من جديد.');}else setTimeout(connect,2500);};
ws.onmessage=ev=>{let f;try{f=JSON.parse(ev.data)}catch{return}handle(f);};}
function handle(f){switch(f.kind){
case 'remote-hello':$('meta').textContent=[f.project&&('📁 '+f.project),f.model,f.mode].filter(Boolean).join(' · ');if(f.running)setState('يعمل','run');break;
case 'admission':running=f.turnId;streamBlock=null;setState('يعمل','run');break;
case 'delta':if(!streamBlock||streamBlock.dataset.turn!==f.turnId){streamBlock=el('assistant','');streamBlock.dataset.turn=f.turnId;}streamBlock.textContent+=f.text;feed.scrollTop=feed.scrollHeight;break;
case 'event':{const p=typeof f.payload==='string'?f.payload:JSON.stringify(f.payload);if(p&&!(streamBlock&&streamBlock.textContent===p))el('event',p);streamBlock=null;break;}
case 'tool':el('tool','⚙ '+f.cmd);break;
case 'tool-result':el('tool',String(f.output||'').slice(0,2000));break;
case 'approval':{pending=f;const b=el('approval','🔐 موافقة: '+f.request+(f.target?' — '+f.target:''));const row=document.createElement('div');row.className='row';const ok=document.createElement('button');ok.className='primary';ok.textContent='وافق';const no=document.createElement('button');no.textContent='ارفض';ok.onclick=()=>{send({kind:'approve',turnId:f.turnId});b.textContent+='\\n✓ وافقت';row.remove();};no.onclick=()=>{send({kind:'deny',turnId:f.turnId});b.textContent+='\\n✗ رفضت';row.remove();};row.append(ok,no);b.append(row);break;}
case 'approval-expired':el('refused','انتهت مهلة الموافقة');break;
case 'done':running=null;streamBlock=null;setState('متّصل','on');el('done','✓ انتهى الدور'+(typeof f.contextLeft==='number'?' · سياق متبقٍّ '+Math.round(f.contextLeft*100)+'%':''));break;
case 'interrupted':running=null;setState('متّصل','on');el('refused','⏹ قُطع الدور');break;
case 'unresolved':running=null;setState('متّصل','on');el('refused','دورٌ بلا تمام: '+f.why);break;
case 'refused':el('refused','رُفض: '+f.why);break;
case 'plan':el('event','📋 '+(f.steps||[]).map((s,i)=>(i+1)+'. '+(s.title||s.text||s)).join('\\n'));break;
default:break;}}
function send(frame){if(!ws||ws.readyState!==1){el('refused','غير متّصل');return;}ws.send(JSON.stringify(frame));}
$('send').onclick=()=>{const body=$('text').value.trim();if(!body)return;el('user',body);send({kind:'submit',turn:{id:'r-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8),body}});$('text').value='';};
$('text').onkeydown=e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();$('send').click();}};
$('stop').onclick=()=>{if(running)send({kind:'interrupt',turnId:running});};
$('pairbtn').onclick=pair;$('code').onkeydown=e=>{if(e.key==='Enter')pair();};
connect();
})();
</script></body></html>`
