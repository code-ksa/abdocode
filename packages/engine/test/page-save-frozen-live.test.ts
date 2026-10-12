import {expect,test} from 'bun:test'
import {existsSync,mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {stripChildEnv} from '../../tools/src/env-strip'

// 10-10 — مقيسٌ في مهمّة n8n: «page save» انقضى أربع مرّات. سببان: مهلةُ القناة ١٥ ث ثابتة (فمهلةُ الأمر ٦٠ ث لا تصل)، وإيدج يجمّد التبويبَ
// الخفيّ فتنتظر ردودُ fetch داخله ومحتوى موارده (أكثر من ٢٠٠ ث على n8n.io/workflows). الحكم: صفحةٌ مجمَّدة عمداً (كما يجمّدها المتصفّح)
// ثمّ copyDocument يعود بسرعةٍ بالأنماط والسكربتات الخارجيّة من مخزن المتصفّح. على Edge حقيقيّ؛ يُتخطّى حين يغيب.

const edge=["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe","C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(existsSync)

test.skipIf(!edge)('a frozen background page is woken: copyDocument returns every external stylesheet and script quickly',async()=>{
 const home=mkdtempSync(join(tmpdir(),'abdo-frozen-'))
 const site=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){const p=new URL(req.url).pathname
  if(p==='/a.css')return new Response('.a{color:rgb(1,2,3)}',{headers:{'content-type':'text/css'}})
  if(p==='/b.css')return new Response('.b{margin:7px}',{headers:{'content-type':'text/css'}})
  if(p==='/app.js')return new Response('window.__app=1',{headers:{'content-type':'application/javascript'}})
  return new Response('<!doctype html><html lang="en"><head><link rel="stylesheet" href="/a.css"><link rel="stylesheet" href="/b.css"></head><body><h1>Frozen</h1><script src="/app.js"></script></body></html>',{headers:{'content-type':'text/html'}})}})
 const lease=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('')}),port=lease.port!;lease.stop(true)
 const browser=Bun.spawn([edge!,'--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--no-proxy-server',`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1',`--user-data-dir=${join(home,'browser')}`,`http://127.0.0.1:${site.port}/`],{env:stripChildEnv(process.env).env,stdout:'ignore',stderr:'ignore'})
 try{
  let wsUrl=''
  for(let i=0;i<80&&!wsUrl;i++){try{const list=(await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as {type:string;url:string;webSocketDebuggerUrl:string}[];wsUrl=list.find(p=>p.type==='page'&&p.url.includes(String(site.port)))?.webSocketDebuggerUrl??''}catch{}if(!wsUrl)await Bun.sleep(150)}
  expect(wsUrl.startsWith('ws://')).toBe(true)
  await Bun.sleep(500)
  // freeze it as the browser does to a hidden tab — from another DevTools client
  const freezer=new WebSocket(wsUrl);await new Promise(r=>freezer.addEventListener('open',r,{once:true}))
  const frozen=new Promise<string>(r=>freezer.addEventListener('message',e=>r(String(e.data)),{once:true}))
  freezer.send(JSON.stringify({id:1,method:'Page.setWebLifecycleState',params:{state:'frozen'}}))
  expect(JSON.parse(await frozen).error).toBeUndefined()
  const {CdpBrowser}=await import('../../browser/src/cdp')
  const surface=new CdpBrowser(port);await surface.attach(new RegExp(String(site.port)))
  const started=Date.now()
  const copy=await surface.copyDocument()
  const took=Date.now()-started
  surface.close();freezer.close()
  expect(took).toBeLessThan(10_000)
  expect(copy.html).toContain('<h1>Frozen</h1>')
  expect(copy.styles.map(s=>s.text)).toEqual(['.a{color:rgb(1,2,3)}','.b{margin:7px}'])
  expect(copy.scripts.find(s=>s.src?.endsWith('/app.js'))?.text).toBe('window.__app=1')
 }finally{browser.kill();await browser.exited;site.stop(true);for(let i=0;i<10;i++){try{rmSync(home,{recursive:true,force:true});break}catch{await Bun.sleep(300)}}}
},90_000)
