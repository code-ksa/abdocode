import {expect,test} from 'bun:test'
import {existsSync,mkdirSync,mkdtempSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {encodeLocalJsonFrame,LocalJsonFrameDecoder} from '@abdo/transport-contracts'
import {stripChildEnv} from '../../tools/src/env-strip'

// 10-10 مرجعُ التصميم يؤخذ كما في DevTools «Inspect ⇦ <html> ⇦ Copy element» مع CSS وJavaScript الصفحة. على Edge حقيقيّ
// (يُتخطّى حين يغيب): صفحةٌ بورقة أنماطٍ خارجيّة وسكربتٍ خارجيّ وآخرين مضمَّنين ⇒ open ⇒ page save ⇒ الحكمُ من الملفّات على القرص.

const edge=["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe","C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(existsSync)

test.skipIf(!edge)('page save writes the <html> outerHTML (as DevTools Copy element), every stylesheet and script, and meta.json into the project',async()=>{
 const home=mkdtempSync(join(tmpdir(),'abdo-page-save-')),settings=join(home,'engine-settings.json'),project=join(home,'project')
 mkdirSync(project)
 const site=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){const p=new URL(req.url).pathname
  if(p==='/assets/site.css')return new Response('.hero{color:rgb(17,34,51);font-family:Inter}',{headers:{'content-type':'text/css'}})
  if(p==='/assets/app.js')return new Response('window.__appLoaded=true;document.body.dataset.ready="1"',{headers:{'content-type':'application/javascript'}})
  return new Response('<!doctype html><html lang="en"><head><title>Workflow fixture</title><link rel="stylesheet" href="/assets/site.css"><style>.cta{background:#ea4b71}</style></head><body><section class="hero"><h1>AI agents and workflows</h1><a class="cta" href="/signup">Get started</a></section><script src="/assets/app.js"></script><script>window.__inline=1</script></body></html>',{headers:{'content-type':'text/html'}})}})
 const lease=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('')}),port=lease.port!;lease.stop(true)
 const browser=Bun.spawn([edge!,'--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--no-proxy-server',`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1',`--user-data-dir=${join(home,'browser')}`,'about:blank'],{env:stripChildEnv(process.env).env,stdout:'ignore',stderr:'ignore'})
 let endpoint=''
 for(let i=0;i<60&&!endpoint;i++){try{endpoint=((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as {webSocketDebuggerUrl:string}).webSocketDebuggerUrl}catch{await Bun.sleep(150)}}
 expect(endpoint.startsWith('ws://')).toBe(true)
 const listenerPid=(()=>{const out=Bun.spawnSync([join(process.env.SystemRoot??'C:/Windows','System32','netstat.exe'),'-ano','-p','tcp']).stdout.toString();const line=out.split(/\r?\n/u).find(l=>l.includes(`127.0.0.1:${port}`)&&l.includes('LISTENING'));const pid=Number(line?.trim().split(/\s+/u).at(-1));return Number.isInteger(pid)&&pid>0?pid:browser.pid})()
 writeFileSync(settings,JSON.stringify({language:'en',mode:'full-access',project,computerUseEnabled:true,modelRole:'agent',routerGate:'off',agentModel:'ollama/none',chatModel:'ollama/none',
  plugins:{projectAwareness:false,sessionAwareness:false,generalAwareness:false,verifier:false,reviewer:false,delegation:false,semanticFrame:false,lessons:false,usageMeter:false}}))
 writeFileSync(join(home,'workspace-v1.json'),JSON.stringify({preferences:{browserDefaultPermission:'allow',blockedSites:[]}}))
 writeFileSync(join(home,'browser-control-lease.json'),JSON.stringify({version:1,port,pid:listenerPid,ownerPid:process.pid,endpoint}))
 const frames:any[]=[];const child=Bun.spawn([process.execPath,'packages/engine/src/cli.ts','serve'],{cwd:resolve(import.meta.dir,'../../..'),env:{...stripChildEnv(process.env).env,ABDO_CODE_SETTINGS:settings,ABDO_CODE_STATE_DIR:join(home,'state'),ABDO_SHELL_TOKEN:'page-save-test',ABDO_FRAMED_STDIO:'1',ABDO_DESKTOP_OWNER_PID:String(process.pid),USERPROFILE:home,HOME:home,ABDO_MAX_AGENT_EPOCHS:'1',ABDO_REQUIRE_SPRINT_PLAN:'0',ABDO_AGENT_PHASE:'',ABDO_PROJECT:project},stdin:'pipe',stdout:'pipe',stderr:'pipe'})
 const stderr=new Response(child.stderr).text();const decoder=new LocalJsonFrameDecoder();const reading=(async()=>{for await(const bytes of child.stdout)for(const f of decoder.push(bytes))frames.push(f)})()
 const send=(f:object)=>{child.stdin.write(encodeLocalJsonFrame(f));void child.stdin.flush()}
 const wait=async(predicate:()=>boolean,label:string)=>{const deadline=Date.now()+40000;while(!predicate()){if(Date.now()>deadline)throw Error(label+' '+JSON.stringify(frames).slice(-2500));await Bun.sleep(10)}}
 let n=0
 const turn=async(body:string)=>{const id=`ps-${++n}`;send({kind:'submit',turn:{id,body},mode:'full-access'});await wait(()=>frames.some(f=>f.turnId===id&&['done','refused'].includes(f.kind)),'turn '+body);return id}
 const events=(id:string)=>frames.filter(f=>f.kind==='event'&&f.turnId===id).map(f=>String(f.payload))
 const url=`http://127.0.0.1:${site.port}/`
 try{
  send({kind:'hello',shell:'desktop',token:'page-save-test'});await wait(()=>frames.some(f=>f.kind==='ready'),'ready')
  send({kind:'trust-grant',path:project})
  const s=await turn(`surface ${port}`);expect(events(s).some(p=>p.startsWith('وُصل السطح على المنفذ '+port)),events(s).join('\n')).toBe(true)
  const o=await turn(`open ${url}`);expect(events(o).some(p=>p.startsWith('انتقلتُ'))).toBe(true)
  const sv=await turn('page save');const said=events(sv).join('\n')
  expect(said,said).toContain('Copy element')
  // the disk is the verdict, not the receipt text
  const dir=join(project,'.abdo','reference','127.0.0.1','home')
  const html=readFileSync(join(dir,'page.html'),'utf8')
  expect(html.startsWith('<!DOCTYPE html>\n<html lang="en">')).toBe(true)
  expect(html).toContain('AI agents and workflows')
  expect(html).toContain('data-ready="1"') // the live DOM after scripts ran, as DevTools shows it
  expect(html).not.toContain('data-abdo-ref')
  const styles=readdirSync(join(dir,'styles')).map(f=>readFileSync(join(dir,'styles',f),'utf8')).join('\n')
  expect(styles).toContain('rgb(17,34,51)');expect(styles).toContain('#ea4b71')
  const scripts=readdirSync(join(dir,'scripts')).map(f=>readFileSync(join(dir,'scripts',f),'utf8')).join('\n')
  expect(scripts).toContain('__appLoaded');expect(scripts).toContain('__inline')
  const meta=JSON.parse(readFileSync(join(dir,'meta.json'),'utf8'))
  expect(meta.url).toBe(url);expect(meta.styles.length).toBe(2);expect(meta.scripts.length).toBe(2)
 }finally{child.kill();await child.exited;await reading;await stderr;try{process.kill(listenerPid)}catch{}browser.kill();await browser.exited;site.stop(true)
  for(let i=0;i<10;i++){try{rmSync(home,{recursive:true,force:true});break}catch{await Bun.sleep(300)}}}
},120000)
