import {expect,test} from 'bun:test'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {encodeLocalJsonFrame,LocalJsonFrameDecoder} from '@abdo/transport-contracts'
import {stripChildEnv} from '../../tools/src/env-strip'

// د2 — المحرّك الدلاليّ في الدور: «وين مجلد الفواتير؟» يُفهم حتمياً (خليجية · find ·
// folder · «الفواتير») ويُعثر على المجلّد بالاسم المنطوق **قبل أوّل نداء للنموذج**، ويصل
// الموجزُ بالمسار الحقيقيّ إلى أوّل طلبٍ عند المزوّد. الوصفةُ من chat-conversation.test.ts:
// مزوّدٌ مزيّف محليّ بلا خزنة، والمحرّكُ الحقيقيّ مؤطَّراً، والإطاراتُ كلُّها تُحفظ.

const boot=async(semanticOn:boolean)=>{
 const home=mkdtempSync(join(tmpdir(),'abdo-semantic-')),settings=join(home,'settings.json'),docs=join(home,'docs')
 mkdirSync(join(docs,'الفواتير'),{recursive:true});writeFileSync(join(docs,'الفواتير','README.md'),'# فواتير\n')
 mkdirSync(join(docs,'reports'),{recursive:true});writeFileSync(join(docs,'reports','README.md'),'# reports\n')
 const requests:any[]=[];const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){const body=await req.json();requests.push({model:body.model,messages:body.messages});const answer='FAKE_'+requests.length;
  return new Response(body.stream?'data: '+JSON.stringify({choices:[{delta:{content:answer},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n':JSON.stringify({choices:[{message:{role:'assistant',content:answer},finish_reason:'stop'}]}),{headers:{'content-type':body.stream?'text/event-stream':'application/json'}})}})
 writeFileSync(settings,JSON.stringify({language:'en',mode:'full-access',modelRole:'agent',routerGate:'off',
  agentModel:'fixture/agent-model',chatModel:'fixture/agent-model',
  plugins:{projectAwareness:false,sessionAwareness:false,generalAwareness:false,verifier:false,reviewer:false,delegation:false,...(semanticOn?{}:{semanticFrame:false})},
  customProviders:[{id:'fixture',label:'Semantic fixture',local:true,baseUrl:`http://127.0.0.1:${server.port}/v1`,vaultKey:'',models:['agent-model']}]}))
 const frames:any[]=[];const child=Bun.spawn([process.execPath,'packages/engine/src/cli.ts','serve'],{cwd:resolve(import.meta.dir,'../../..'),env:{...stripChildEnv(process.env).env,ABDO_CODE_SETTINGS:settings,ABDO_CODE_STATE_DIR:join(home,'state'),ABDO_DOCUMENTS_DIR:docs,ABDO_SHELL_TOKEN:'semantic-test',ABDO_FRAMED_STDIO:'1',USERPROFILE:home,HOME:home,ABDO_MAX_AGENT_EPOCHS:'1',ABDO_REQUIRE_SPRINT_PLAN:'0',ABDO_AGENT_PHASE:''},stdin:'pipe',stdout:'pipe',stderr:'pipe'})
 const stderr=new Response(child.stderr).text();const decoder=new LocalJsonFrameDecoder();const reading=(async()=>{for await(const bytes of child.stdout)for(const f of decoder.push(bytes))frames.push(f)})()
 const send=(f:object)=>{child.stdin.write(encodeLocalJsonFrame(f));void child.stdin.flush()}
 const wait=async(predicate:()=>boolean,label:string)=>{const deadline=Date.now()+40000;while(!predicate()){if(Date.now()>deadline)throw Error(label+' '+JSON.stringify(frames).slice(-2500));await Bun.sleep(10)}}
 send({kind:'hello',shell:'desktop',token:'semantic-test'});await wait(()=>frames.some(f=>f.kind==='ready'),'ready')
 const turn=async(body:string)=>{const id='semantic-'+(semanticOn?'on':'off');send({kind:'submit',turn:{id,body},mode:'full-access'});await wait(()=>frames.some(f=>f.turnId===id&&['done','refused'].includes(f.kind)),'turn '+id);return id}
 const stop=async()=>{child.kill();await child.exited;await reading;await stderr;server.stop(true);rmSync(home,{recursive:true,force:true})}
 return {frames,requests,turn,stop,docs}
}

test('a dialect request is framed deterministically, the folder is located by its spoken name before the first model call, and the real path reaches the first request',async()=>{
 const {frames,requests,turn,stop,docs}=await boot(true)
 try{
  const id=await turn('وين مجلد الفواتير؟')
  const events=frames.filter(f=>f.kind==='event'&&f.turnId===id).map(f=>String(f.payload))
  const frameLine=events.find(p=>p.startsWith('🧭 لغة:'))
  expect(frameLine,'no 🧭 frame line; events:\n'+events.join('\n---\n')).toBeDefined()
  expect(frameLine).toContain('لهجة: gulf')
  expect(frameLine).toContain('فعل: find')
  expect(frameLine).toContain('نوع: folder')
  expect(frameLine).toContain('هدف: «الفواتير»')
  // العثورُ حتميّ: مرشّحٌ واحد هو مجلّدُ «الفواتير» تحت الجذر الممسوح.
  const located=events.find(p=>p.startsWith('🧭 عثورٌ حتميّ:'))
  expect(located,'no location line; events:\n'+events.join('\n---\n')).toBeDefined()
  expect(located).toContain('1 مرشّح')
  // والمسارُ الحقيقيّ وصل إلى **أوّل** طلبٍ عند المزوّد — قبل أن يُسأل النموذجُ شيئاً.
  expect(requests.length).toBeGreaterThan(0)
  const first=JSON.stringify(requests[0].messages)
  expect(first).toContain('المحرّك الدلاليّ')
  expect(first).toContain(join(docs,'الفواتير').replace(/\\/g,'\\\\'))
  expect(first).toContain('مرشّحٌ واحدٌ واضح')
 }finally{await stop()}
},90000)

test('a continuation request («كمل مشروع X») is framed as resume and served by the same deterministic location before the first model call',async()=>{
 // ثقبٌ قيس 2026-09-06: «كمل/استكمل/تابع/واصل + مشروع» كانت action none فلا عثورَ ولا موجز.
 const {frames,requests,turn,stop,docs}=await boot(true)
 try{
  const id=await turn('كمل مشروع الفواتير')
  const events=frames.filter(f=>f.kind==='event'&&f.turnId===id).map(f=>String(f.payload))
  const frameLine=events.find(p=>p.startsWith('🧭 لغة:'))
  expect(frameLine,'no 🧭 frame line; events:\n'+events.join('\n---\n')).toBeDefined()
  expect(frameLine).toContain('فعل: resume')
  expect(frameLine).toContain('نوع: project')
  expect(frameLine).toContain('هدف: «الفواتير»')
  const located=events.find(p=>p.startsWith('🧭 عثورٌ حتميّ:'))
  expect(located,'no location line; events:\n'+events.join('\n---\n')).toBeDefined()
  expect(located).toContain('1 مرشّح')
  const first=JSON.stringify(requests[0].messages)
  expect(first).toContain('الطلبُ «resume» لـ«project» باسم «الفواتير»')
  expect(first).toContain(join(docs,'الفواتير').replace(/\\/g,'\\\\'))
 }finally{await stop()}
},90000)

test('with the plugin off the same request produces no frame line, no location, and no brief in the first request (absence is refusal, not permission)',async()=>{
 const {frames,requests,turn,stop}=await boot(false)
 try{
  const id=await turn('وين مجلد الفواتير؟')
  const events=frames.filter(f=>f.kind==='event'&&f.turnId===id).map(f=>String(f.payload))
  expect(events.some(p=>p.startsWith('🧭'))).toBe(false)
  expect(requests.length).toBeGreaterThan(0)
  expect(JSON.stringify(requests[0].messages)).not.toContain('المحرّك الدلاليّ')
 }finally{await stop()}
},90000)
