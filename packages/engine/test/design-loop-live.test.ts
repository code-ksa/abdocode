import {expect,test} from 'bun:test'
import {existsSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {encodeLocalJsonFrame,LocalJsonFrameDecoder} from '@abdo/transport-contracts'
import {stripChildEnv} from '../../tools/src/env-strip'

// ب4 — حلقةُ إصلاح التصميم على متصفّحٍ **حقيقيّ** (Edge بلا رأس، يُتخطّى حين يغيب): صفحةٌ ساكنة بعيبٍ مرئيّ (زرٌّ أحمر
// والمطلوبُ أزرق) ⇒ المحرّكُ الحقيقيّ يفتحها ويقرأ الزرَّ بأنماطه المحسوبة (`look`) فيرى الأحمر ⇒ يُصلَح ملفُّ CSS
// (تعديلُ الملفّ مُثبَتٌ في ألواح edit؛ هنا يقوم به الاختبار مقامَ الوكيل) ⇒ إعادةُ الفتح والقراءة تثبت الأزرق ⇒ `shot`
// لقطةٌ حقيقية غيرُ فارغة تصل اللوحة. الدليلُ من المتصفّح لا من الفكستشر.

const edge=["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe","C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(existsSync)

test.skipIf(!edge)('the design-fix loop runs end to end on real Edge: open → page → look (red) → fix css → open → look (blue) → shot',async()=>{
 const home=mkdtempSync(join(tmpdir(),'abdo-design-loop-')),settings=join(home,'engine-settings.json'),css=join(home,'style.css')
 writeFileSync(css,'#cta{color:rgb(255,0,0);font-size:18px}')
 const site=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){const p=new URL(req.url).pathname
  if(p==='/style.css')return new Response(Bun.file(css),{headers:{'content-type':'text/css','cache-control':'no-store'}})
  if(p==='/signup')return new Response('<!doctype html><title>Signup fixture</title><form onsubmit="event.preventDefault();document.getElementById(\'out\').textContent=\'Welcome \'+email.value+\' pw:\'+password.value.length"><input id="email" name="email" placeholder="Email"><input id="password" name="password" type="password" placeholder="Password"><button type="submit">Create account</button></form><p id="out"></p>',{headers:{'content-type':'text/html','cache-control':'no-store'}})
  return new Response('<!doctype html><title>Design fixture</title><link rel="stylesheet" href="/style.css"><main><h1>Landing</h1><button id="cta">Sign up</button></main>',{headers:{'content-type':'text/html','cache-control':'no-store'}})}})
 const lease=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('')}),port=lease.port!;lease.stop(true)
 const browser=Bun.spawn([edge!,'--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--no-proxy-server',`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1',`--user-data-dir=${join(home,'browser')}`,'about:blank'],{env:stripChildEnv(process.env).env,stdout:'ignore',stderr:'ignore'})
 // نقطةُ CDP الحقيقية للمتصفّح — ملفُّ الإيجار يجب أن يسمّيها بحرفها وإلا رفض المحرّكُ الوصل (الملكيّةُ تُثبَت لا تُحزر).
 let endpoint=''
 for(let i=0;i<60&&!endpoint;i++){try{endpoint=((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as {webSocketDebuggerUrl:string}).webSocketDebuggerUrl}catch{await Bun.sleep(150)}}
 expect(endpoint.startsWith('ws://')).toBe(true)
 // msedge.exe المُطلَق مُشغِّلٌ يخرج بعد التسليم (قيس: ESRCH على معرّفه) — معرّفُ المتصفّح الحقيقيّ هو المستمعُ على المنفذ،
 // وهو ما يسجّله إيجارُ Rust في المنتج. يُقرأ من netstat كما يُقرأ هناك.
 const listenerPid=(()=>{const out=Bun.spawnSync([join(process.env.SystemRoot??'C:/Windows','System32','netstat.exe'),'-ano','-p','tcp']).stdout.toString();const line=out.split(/\r?\n/u).find(l=>l.includes(`127.0.0.1:${port}`)&&l.includes('LISTENING'));const pid=Number(line?.trim().split(/\s+/u).at(-1));return Number.isInteger(pid)&&pid>0?pid:browser.pid})()
 writeFileSync(settings,JSON.stringify({language:'en',mode:'full-access',computerUseEnabled:true,modelRole:'agent',routerGate:'off',agentModel:'ollama/none',chatModel:'ollama/none',
  plugins:{projectAwareness:false,sessionAwareness:false,generalAwareness:false,verifier:false,reviewer:false,delegation:false,semanticFrame:false,lessons:false,usageMeter:false}}))
 writeFileSync(join(home,'workspace-v1.json'),JSON.stringify({preferences:{browserDefaultPermission:'allow',blockedSites:[]}}))
 writeFileSync(join(home,'browser-control-lease.json'),JSON.stringify({version:1,port,pid:listenerPid,ownerPid:process.pid,endpoint}))
 const frames:any[]=[];const child=Bun.spawn([process.execPath,'packages/engine/src/cli.ts','serve'],{cwd:resolve(import.meta.dir,'../../..'),env:{...stripChildEnv(process.env).env,ABDO_CODE_SETTINGS:settings,ABDO_CODE_STATE_DIR:join(home,'state'),ABDO_SHELL_TOKEN:'design-loop-test',ABDO_FRAMED_STDIO:'1',ABDO_DESKTOP_OWNER_PID:String(process.pid),USERPROFILE:home,HOME:home,ABDO_MAX_AGENT_EPOCHS:'1',ABDO_REQUIRE_SPRINT_PLAN:'0',ABDO_AGENT_PHASE:''},stdin:'pipe',stdout:'pipe',stderr:'pipe'})
 const stderr=new Response(child.stderr).text();const decoder=new LocalJsonFrameDecoder();const reading=(async()=>{for await(const bytes of child.stdout)for(const f of decoder.push(bytes))frames.push(f)})()
 const send=(f:object)=>{child.stdin.write(encodeLocalJsonFrame(f));void child.stdin.flush()}
 const wait=async(predicate:()=>boolean,label:string)=>{const deadline=Date.now()+40000;while(!predicate()){if(Date.now()>deadline)throw Error(label+' '+JSON.stringify(frames).slice(-2500));await Bun.sleep(10)}}
 let n=0
 const turn=async(body:string)=>{const id=`dl-${++n}`;send({kind:'submit',turn:{id,body},mode:'full-access'});await wait(()=>frames.some(f=>f.turnId===id&&['done','refused'].includes(f.kind)),'turn '+body);return id}
 const events=(id:string)=>frames.filter(f=>f.kind==='event'&&f.turnId===id).map(f=>String(f.payload))
 const refOf=(pageEvents:string[],name:string)=>{const line=pageEvents.join('\n').split('\n').find(l=>l.includes(name));const m=line?.match(/\[(r\d+)\]/u);if(!m)throw Error('no ref for '+name+' in:\n'+pageEvents.join('\n'));return m[1]}
 const url=`http://127.0.0.1:${site.port}/`
 try{
  send({kind:'hello',shell:'desktop',token:'design-loop-test'});await wait(()=>frames.some(f=>f.kind==='ready'),'ready')
  const s=await turn(`surface ${port}`);expect(events(s).some(p=>p.startsWith('وُصل السطح على المنفذ '+port)),events(s).join('\n')).toBe(true)
  const o=await turn(`open ${url}`);expect(events(o).some(p=>p.startsWith('انتقلتُ'))).toBe(true)
  const p1=await turn('page');const cta=refOf(events(p1),'Sign up')
  const l1=await turn(`look ${cta}`);const read1=events(l1).join('\n')
  expect(read1).toContain('rgb(255, 0, 0)')
  expect(read1).toContain('Sign up')
  // الإصلاح: ملفُّ الأنماط يُصلَح (مقامَ أداة edit المُثبَتة في ألواحها)، ثم إعادةُ الفتح تُبطل المراجعَ القديمة فتُقرأ من جديد.
  writeFileSync(css,'#cta{color:rgb(0,0,255);font-size:18px}')
  const o2=await turn(`open ${url}`);expect(events(o2).some(p=>p.startsWith('انتقلتُ'))).toBe(true)
  const stale=await turn(`look ${cta}`);expect(events(stale).some(p=>p.includes('مرجعٌ غير معروف'))).toBe(true)
  const p2=await turn('page');const cta2=refOf(events(p2),'Sign up')
  const l2=await turn(`look ${cta2}`);expect(events(l2).join('\n')).toContain('rgb(0, 0, 255)')
  // لقطةٌ حقيقية من Edge: بياناتٌ غيرُ فارغة تصل اللوحةَ إطارَ browser-shot — وبلا نموذجِ رؤيةٍ تبقى عرضاً ويُقال.
  const sh=await turn('shot');expect(events(sh).some(p=>p.includes('لا نموذجَ رؤيةٍ مضبوط'))).toBe(true)
  const shot=frames.filter(f=>f.kind==='browser-shot').at(-1)
  expect(shot).toBeDefined();expect(String(shot.data).length).toBeGreaterThan(200);expect(shot.url).toBe(url)
  expect(String(shot.data).startsWith('iVBORw0KGgo')).toBe(true)
  // تمريرٌ وتحويمٌ على الصفحة الحقيقية — لا خطأ ولا رفض.
  const sc=await turn('scroll down');expect(events(sc).some(p=>p.startsWith('مرّرتُ down'))).toBe(true)
  const hv=await turn(`hover ${cta2}`);expect(events(hv).some(p=>p.startsWith('حوّمتُ'))).toBe(true)
  // ب5 — التسجيل: البريدُ يملؤه الوكيل، كلمةُ المرور تُرفض ثم تُسلَّم (تركيزٌ حقيقيّ)، «المستخدم» يكتبها بيده عبر جلسة CDP
  // ثانية على الصفحة نفسها (كما يفعل بلوحة المفاتيح)، ثم الوكيلُ يرسل ويقرأ الترحيب — كلمةُ المرور لم تمرّ بالوكيل.
  const o3=await turn(`open ${url}signup`);expect(events(o3).some(p=>p.startsWith('انتقلتُ'))).toBe(true)
  const p3=await turn('page');const emailRef=refOf(events(p3),'Email'),pwRef=refOf(events(p3),'Password'),submitRef=refOf(events(p3),'Create account')
  const fe=await turn(`fill ${emailRef} user@example.com`);expect(events(fe).some(p=>p.startsWith('كتبتُ'))).toBe(true)
  const fp=await turn(`fill ${pwRef} hunter2`);expect(events(fp).some(p=>(p.includes('حقلُ اعتمادٍ بنوعه')||p.includes('حقلٌ محظورٌ'))&&p.includes(`handoff ${pwRef}`))).toBe(true) // ب9 — الرفضُ صار من نوع الحقل قبل نصّه
  const ho=await turn(`handoff ${pwRef}`);expect(events(ho).some(p=>p.startsWith('سلّمتُ الحقلَ')),events(ho).join('\n')).toBe(true)
  const lk=await turn(`look ${pwRef}`);expect(events(lk).join('\n')).toContain('"focused":true')
  {const {CdpBrowser}=await import('../../browser/src/cdp');const human=new CdpBrowser(port);await human.attach(/signup/u);await human.typeKeys('hunter2');human.close();await Bun.sleep(150)}
  const tp=await turn(`tap ${submitRef}`);expect(events(tp).some(p=>p.startsWith('نقرتُ'))).toBe(true)
  const done=await turn('look');expect(events(done).join('\n')).toContain('Welcome user@example.com pw:7')
 }finally{child.kill();await child.exited;await reading;await stderr;try{process.kill(listenerPid)}catch{}browser.kill();await browser.exited;site.stop(true);
  // ملفُّ Edge يبقى مقفولاً لحظاتٍ بعد الخروج: إزالةٌ بمحاولاتٍ لا ترمي — التنظيفُ لا يُخفي فشلَ التوقّعات.
  for(let i=0;i<10;i++){try{rmSync(home,{recursive:true,force:true});break}catch{await Bun.sleep(300)}}}
},120000)
