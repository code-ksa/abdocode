import {expect,test} from 'bun:test'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {encodeLocalJsonFrame,LocalJsonFrameDecoder} from '@abdo/transport-contracts'
import {stripChildEnv} from '../../tools/src/env-strip'

// 09-17 (مقيس على المثبَّت 4.0.45): NIM ردّ 503 «Service temporarily overloaded» خمسَ مرّاتٍ فمات دورُ المالك في أوّله «تعذّر الوصول إلى المزوّد».
// على المحرّك الحقيقيّ مؤطَّراً: مزوّدٌ مزيّف «down» يردّ 503 دائماً، وآخر «up» يجيب؛ سلّمُ المالك يحوي up.
// المطلوب: سطورُ إعادة المحاولة تُقال (⏳)، ثمّ صعودٌ مكتوب (⛰ صعود: down ⇦ up)، ويكتمل الدورُ على up — لا رفضٌ ختاميّ.
// والتوأمُ السلبيّ: بلا سلّمٍ يعود الرفضُ باسمه (لا نموذجَ يُخترع)، ورسالتُه تقول «مزدحم» لا «تحقّق من اتصالك».

const answer=(body:any,text:string)=>new Response(body.stream?'data: '+JSON.stringify({choices:[{delta:{content:text},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n':JSON.stringify({choices:[{message:{role:'assistant',content:text},finish_reason:'stop'}]}),{headers:{'content-type':body.stream?'text/event-stream':'application/json'}})

const boot=async(opts:{ladder:boolean,tag:string})=>{
 const home=mkdtempSync(join(tmpdir(),'abdo-outage-')),settings=join(home,'settings.json'),project=join(home,'project');mkdirSync(project)
 const hits={down:0,up:0}
 // المزوّدُ المزيّف يقبل أيَّ طلب (بعضُ النكهات تسأل /models للاكتشاف بجسدٍ فارغ): الجسدُ يُقرأ نصّاً ويُفكّ إن كان JSON.
 const parse=async(req:Request)=>{const t=await req.text();try{return t?JSON.parse(t):{}}catch{return {}}}
 const down=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){await parse(req);hits.down+=1;return new Response(JSON.stringify({error:{message:'Service temporarily overloaded',type:'Service Unavailable',code:503}}),{status:503,headers:{'content-type':'application/json'}})}})
 const up=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){const body=await parse(req);if(new URL(req.url).pathname.endsWith('/models'))return new Response(JSON.stringify({data:[{id:'agent-model'}]}),{headers:{'content-type':'application/json'}});hits.up+=1;return answer(body,'UP_ANSWER_'+hits.up)}})
 writeFileSync(settings,JSON.stringify({language:'ar',mode:'full-access',modelRole:'agent',routerGate:'off',project,
  agentModel:'down/agent-model',chatModel:'down/agent-model',
  ...(opts.ladder?{modelLadder:['up/agent-model']}:{}),
  plugins:{projectAwareness:false,sessionAwareness:false,generalAwareness:false,verifier:false,reviewer:false,delegation:false},
  customProviders:[
   {id:'down',label:'Overloaded fixture',local:true,baseUrl:`http://127.0.0.1:${down.port}/v1`,vaultKey:'',models:['agent-model']},
   {id:'up',label:'Healthy fixture',local:true,baseUrl:`http://127.0.0.1:${up.port}/v1`,vaultKey:'',models:['agent-model']}]}))
 const frames:any[]=[];const child=Bun.spawn([process.execPath,'packages/engine/src/cli.ts','serve'],{cwd:resolve(import.meta.dir,'../../..'),env:{...stripChildEnv(process.env).env,ABDO_CODE_SETTINGS:settings,ABDO_CODE_STATE_DIR:join(home,'state'),ABDO_SHELL_TOKEN:'outage-test',ABDO_FRAMED_STDIO:'1',USERPROFILE:home,HOME:home,ABDO_MAX_AGENT_EPOCHS:'2',ABDO_REQUIRE_SPRINT_PLAN:'0',ABDO_AGENT_PHASE:'',ABDO_MODEL_RETRY_FAST:'1'},stdin:'pipe',stdout:'pipe',stderr:'pipe'})
 const stderr=new Response(child.stderr).text();const decoder=new LocalJsonFrameDecoder();const reading=(async()=>{for await(const bytes of child.stdout)for(const f of decoder.push(bytes))frames.push(f)})()
 const send=(f:object)=>{child.stdin.write(encodeLocalJsonFrame(f));void child.stdin.flush()}
 const wait=async(predicate:()=>boolean,label:string)=>{const deadline=Date.now()+60000;while(!predicate()){if(Date.now()>deadline)throw Error(label+' '+JSON.stringify(frames).slice(-2500));await Bun.sleep(100)}}
 send({kind:'hello',shell:'desktop',token:'outage-test'});await wait(()=>frames.some(f=>f.kind==='ready'),'ready')
 const turn=async(body:string)=>{const id='outage-'+opts.tag;send({kind:'submit',turn:{id,body},mode:'full-access'});await wait(()=>frames.some(f=>f.turnId===id&&['done','refused'].includes(f.kind)),'turn end');return id}
 const stop=async()=>{child.kill();await child.exited;await reading;await stderr;down.stop(true);up.stop(true);rmSync(home,{recursive:true,force:true})}
 return {frames,turn,stop,hits}
}

test('an overloaded provider is retried visibly, then the turn climbs the owner ladder and completes on the next rung',async()=>{
 const {frames,turn,stop,hits}=await boot({ladder:true,tag:'ladder'})
 try{
  const id=await turn('قل كلمة واحدة')
  const events=frames.filter(f=>f.kind==='event'&&f.turnId===id).map(f=>String(f.payload))
  expect(events.some(p=>p.startsWith('⏳ المزوّد down')&&p.includes('HTTP 503')),'no retry line; events:\n'+events.join('\n---\n')).toBe(true)
  expect(events.some(p=>p.startsWith('⛰ صعود: down/agent-model ⇦ up/agent-model')&&p.includes('provider_unavailable')),'no climb line; events:\n'+events.join('\n---\n')).toBe(true)
  expect(hits.down).toBeGreaterThanOrEqual(2)
  expect(hits.up).toBeGreaterThanOrEqual(1)
  expect(frames.some(f=>f.kind==='refused'&&f.turnId===id)).toBe(false)
  expect(frames.some(f=>f.kind==='done'&&f.turnId===id)).toBe(true)
 }finally{await stop()}
},120000)

test('without a ladder the refusal keeps its name and says the provider is overloaded — not the user connection',async()=>{
 const {frames,turn,stop,hits}=await boot({ladder:false,tag:'bare'})
 try{
  const id=await turn('قل كلمة واحدة')
  const refused=frames.find(f=>f.kind==='refused'&&f.turnId===id)
  expect(refused,'expected a refusal; frames:\n'+JSON.stringify(frames).slice(-1500)).toBeDefined()
  expect(String(refused.why)).toContain('مزدحم')
  expect(String(refused.why)).toContain('HTTP 503')
  expect(String(refused.why)).not.toContain('تحقّق من الاتصال')
  expect(refused.failure?.kind).toBe('provider-unavailable')
  expect(hits.up).toBe(0)
  expect(hits.down).toBeGreaterThanOrEqual(2)
 }finally{await stop()}
},120000)
