import {expect,test} from 'bun:test'
import {createHash,randomUUID} from 'node:crypto'
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {encodeLocalJsonFrame,LocalJsonFrameDecoder} from '@abdo/transport-contracts'
import {stripChildEnv} from '../../tools/src/env-strip'

// ذ1 — مسارُ الرؤية على دورٍ حقيقيّ: دورٌ يحمل صورةً ونموذجُ رؤيةٍ مضبوط ⇒ إيصالُ model-route يسمّي نموذجَ
// الرؤية بسمة vision، والصورةُ تصل **نموذجَ الرؤية وحده**؛ الدورُ النصّيّ التالي يعود إلى نموذج حارته؛
// وبلا نموذجِ رؤيةٍ مضبوط لا سقوطَ صامتاً: رفضٌ صريح يسمّي السبب. التبديلُ من مزوّدٍ إلى آخر إعدادٌ لا شيفرة.

const PNG=readFileSync(resolve(import.meta.dir,'../../desktop/src-tauri/test-fixtures/attachments/screenshot.png'))

const boot=async(opts:{withVision:boolean,tag:string})=>{
 const home=mkdtempSync(join(tmpdir(),'abdo-vision-')),settings=join(home,'settings.json'),store=join(home,'attachments-v1'),docs=join(home,'docs');mkdirSync(store);mkdirSync(docs)
 const requests:{model:string,hasImage:boolean}[]=[]
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){const raw=await req.text();const body=JSON.parse(raw);requests.push({model:body.model,hasImage:raw.includes('image_url')});const answer='FAKE_'+requests.length
  return new Response(body.stream?'data: '+JSON.stringify({choices:[{delta:{content:answer},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n':JSON.stringify({choices:[{message:{role:'assistant',content:answer},finish_reason:'stop'}]}),{headers:{'content-type':body.stream?'text/event-stream':'application/json'}})}})
 writeFileSync(settings,JSON.stringify({language:'en',mode:'full-access',modelRole:'chat',routerGate:'off',agentModel:'fixture/agent',chatModel:'fixture/agent',...(opts.withVision?{visionModel:'fixture/vision'}:{}),
  plugins:{projectAwareness:false,sessionAwareness:false,generalAwareness:false,verifier:false,reviewer:false,delegation:false,semanticFrame:false,lessons:false,usageMeter:false},
  customProviders:[{id:'fixture',label:'Vision fixture',local:true,baseUrl:`http://127.0.0.1:${server.port}/v1`,vaultKey:'',models:['agent','vision'],imageModels:['vision']}]}))
 const frames:any[]=[];const child=Bun.spawn([process.execPath,'packages/engine/src/cli.ts','serve'],{cwd:resolve(import.meta.dir,'../../..'),env:{...stripChildEnv(process.env).env,ABDO_CODE_SETTINGS:settings,ABDO_CODE_STATE_DIR:join(home,'state'),ABDO_DOCUMENTS_DIR:docs,ABDO_SHELL_TOKEN:'vision-test',ABDO_FRAMED_STDIO:'1',USERPROFILE:home,HOME:home,ABDO_MAX_AGENT_EPOCHS:'1',ABDO_REQUIRE_SPRINT_PLAN:'0',ABDO_AGENT_PHASE:''},stdin:'pipe',stdout:'pipe',stderr:'pipe'})
 const stderr=new Response(child.stderr).text();const decoder=new LocalJsonFrameDecoder();const reading=(async()=>{for await(const bytes of child.stdout)for(const f of decoder.push(bytes))frames.push(f)})()
 const send=(f:object)=>{child.stdin.write(encodeLocalJsonFrame(f));void child.stdin.flush()}
 const wait=async(predicate:()=>boolean,label:string)=>{const deadline=Date.now()+40000;while(!predicate()){if(Date.now()>deadline)throw Error(label+' '+JSON.stringify(frames).slice(-2500));await Bun.sleep(10)}}
 send({kind:'hello',shell:'desktop',token:'vision-test'});await wait(()=>frames.some(f=>f.kind==='ready'),'ready')
 // نمطُ المحادثة ثابتٌ للجلسة: تُفتح جلسةُ دردشةٍ جديدة (كما تفعل القشرة) ويُربط المرفقُ بمعرّفها.
 send({kind:'session-new',conversationMode:'chat'});await wait(()=>frames.some(f=>f.kind==='session'&&f.conversationMode==='chat'),'chat session')
 const sessionId=String(frames.find(f=>f.kind==='session'&&f.conversationMode==='chat').id)
 // صورةٌ في مخزن المرفقات مربوطةٌ بالجلسة الحيّة — كما تفعل القشرة.
 const attach=()=>{const id=randomUUID();writeFileSync(join(store,id+'.bin'),PNG);writeFileSync(join(store,id+'.json'),JSON.stringify({version:1,id,name:'screenshot.png',sessionId,mime:'image/png',bytes:PNG.length,sha256:createHash('sha256').update(PNG).digest('hex')}));return id}
 let n=0
 const turn=async(body:string,attachments:string[])=>{const id=`vision-${opts.tag}-${++n}`;send({kind:'submit',turn:{id,body},mode:'full-access',conversationMode:'chat',attachments});await wait(()=>frames.some(f=>f.turnId===id&&['done','refused','error'].includes(f.kind)),'turn '+id);return id}
 const of=(id:string)=>frames.filter(f=>f.turnId===id)
 const stop=async()=>{child.kill();await child.exited;await reading;await stderr;server.stop(true);rmSync(home,{recursive:true,force:true})}
 return {frames,requests,attach,turn,of,stop}
}

test('an image turn routes to the configured vision model — named in the receipt — and the image reaches that model only; the next text turn returns to the lane model',async()=>{
 const {requests,attach,turn,of,stop}=await boot({withVision:true,tag:'on'})
 try{
  const id1=await turn('describe this screenshot',[attach()])
  const route1=of(id1).find(f=>f.kind==='model-route')
  expect(route1,'no model-route; frames:\n'+JSON.stringify(of(id1)).slice(0,2000)).toBeDefined()
  expect(route1).toMatchObject({lane:'chat',ref:'fixture/vision',vision:true})
  expect(of(id1).some(f=>f.kind==='done')).toBe(true)
  expect(requests.some(r=>r.model==='vision'&&r.hasImage)).toBe(true)
  expect(requests.some(r=>r.model==='agent'&&r.hasImage)).toBe(false)
  const before=requests.length
  const id2=await turn('and now a plain question',[])
  const route2=of(id2).find(f=>f.kind==='model-route')
  expect(route2).toMatchObject({lane:'chat',ref:'fixture/agent'})
  expect(route2.vision).toBeUndefined()
  expect(requests.slice(before).every(r=>r.model==='agent'&&!r.hasImage)).toBe(true)
 }finally{await stop()}
},90000)

test('without a configured vision model an image turn is refused explicitly — the receipt names the lane model and no silent fallback answers',async()=>{
 const {requests,attach,turn,of,stop}=await boot({withVision:false,tag:'off'})
 try{
  const id=await turn('describe this screenshot',[attach()])
  const route=of(id).find(f=>f.kind==='model-route')
  expect(route).toMatchObject({lane:'chat',ref:'fixture/agent'})
  expect(route.vision).toBeUndefined()
  const text=JSON.stringify(of(id))
  // الرسالةُ بالعربية أوّلاً وتسمّي الإعداد (قيس 2026-09-06: وصلت المالكَ إنجليزيةً بلا دليل)، وذيلٌ إنجليزيّ يبقي الحقيقة للقارئ الآخر.
  expect(text).toContain('نموذج الرؤية (الصور)')
  expect(text).toContain('fixture/agent')
  expect(text).toContain('no verified image input')
  expect(of(id).some(f=>f.kind==='done'&&f.outcome==='completed')).toBe(false)
  expect(requests.some(r=>r.hasImage)).toBe(false)
 }finally{await stop()}
},90000)
