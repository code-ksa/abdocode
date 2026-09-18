import {expect,test} from 'bun:test'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {encodeLocalJsonFrame,LocalJsonFrameDecoder} from '@abdo/transport-contracts'
import {stripChildEnv} from '../../tools/src/env-strip'

// د3 — الطبقةُ الرابعة في الدور: نداءٌ جانبيٌّ واحدٌ بمفتاح المستخدم يخرج بأربعة أسطرٍ حرفية،
// فيصل الاستنتاجُ إلى سطر 🧭 وإلى أوّل طلبٍ للنموذج الرئيس. ثلاثةُ توائم: الشكلُ الحرفيّ يُحقن؛
// والنثرُ الحرّ لا يُحقن (الحدسُ ممنوع)؛ والإضافةُ المطفأة لا تنادي أصلاً (الغيابُ رفضٌ لا إذن).

type Reply='strict'|'prose'
const boot=async(inferOn:boolean,reply:Reply)=>{
 const home=mkdtempSync(join(tmpdir(),'abdo-infer-')),settings=join(home,'settings.json'),docs=join(home,'docs');mkdirSync(docs,{recursive:true})
 const requests:any[]=[];const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){const body=await req.json();const isInfer=JSON.stringify(body.messages).includes('المراد:')||JSON.stringify(body.messages).includes('فُهم حتمياً');requests.push({infer:isInfer,messages:body.messages,stream:body.stream})
  if(isInfer){const text=reply==='strict'?'المراد: يريد الوصول إلى مجلد الفواتير\nالدافع: يعمل على الفواتير الآن\nالمطلوب: افتح مجلد الفواتير في المشروع الحالي\nالثقة: 0.83':'يبدو أن المستخدم يريد فتح مجلد الفواتير وربما إنشاءه.';return Response.json({choices:[{message:{role:'assistant',content:text},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:30}})}
  const answer='FAKE_'+requests.length
  return new Response(body.stream?'data: '+JSON.stringify({choices:[{delta:{content:answer},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n':JSON.stringify({choices:[{message:{role:'assistant',content:answer},finish_reason:'stop'}]}),{headers:{'content-type':body.stream?'text/event-stream':'application/json'}})}})
 writeFileSync(settings,JSON.stringify({language:'en',mode:'full-access',modelRole:'agent',routerGate:'off',agentModel:'fixture/agent-model',chatModel:'fixture/agent-model',
  plugins:{projectAwareness:false,sessionAwareness:false,generalAwareness:false,verifier:false,reviewer:false,delegation:false,...(inferOn?{semanticInfer:true}:{})},
  customProviders:[{id:'fixture',label:'Infer fixture',local:true,baseUrl:`http://127.0.0.1:${server.port}/v1`,vaultKey:'',models:['agent-model']}]}))
 const frames:any[]=[];const child=Bun.spawn([process.execPath,'packages/engine/src/cli.ts','serve'],{cwd:resolve(import.meta.dir,'../../..'),env:{...stripChildEnv(process.env).env,ABDO_CODE_SETTINGS:settings,ABDO_CODE_STATE_DIR:join(home,'state'),ABDO_DOCUMENTS_DIR:docs,ABDO_SHELL_TOKEN:'infer-test',ABDO_FRAMED_STDIO:'1',USERPROFILE:home,HOME:home,ABDO_MAX_AGENT_EPOCHS:'1',ABDO_REQUIRE_SPRINT_PLAN:'0',ABDO_AGENT_PHASE:''},stdin:'pipe',stdout:'pipe',stderr:'pipe'})
 const stderr=new Response(child.stderr).text();const decoder=new LocalJsonFrameDecoder();const reading=(async()=>{for await(const bytes of child.stdout)for(const f of decoder.push(bytes))frames.push(f)})()
 const send=(f:object)=>{child.stdin.write(encodeLocalJsonFrame(f));void child.stdin.flush()}
 const wait=async(predicate:()=>boolean,label:string)=>{const deadline=Date.now()+40000;while(!predicate()){if(Date.now()>deadline)throw Error(label+' '+JSON.stringify(frames).slice(-2500));await Bun.sleep(10)}}
 send({kind:'hello',shell:'desktop',token:'infer-test'});await wait(()=>frames.some(f=>f.kind==='ready'),'ready')
 const turn=async(body:string)=>{const id='infer-'+(inferOn?'on':'off')+'-'+reply;send({kind:'submit',turn:{id,body},mode:'full-access'});await wait(()=>frames.some(f=>f.turnId===id&&['done','refused'].includes(f.kind)),'turn '+id);return id}
 const stop=async()=>{child.kill();await child.exited;await reading;await stderr;server.stop(true);rmSync(home,{recursive:true,force:true})}
 return {frames,requests,turn,stop}
}

test('a strict four-line reply from the user\'s own provider becomes an inference line and reaches the first main request',async()=>{
 const {frames,requests,turn,stop}=await boot(true,'strict')
 try{
  const id=await turn('وين مجلد الفواتير؟')
  const events=frames.filter(f=>f.kind==='event'&&f.turnId===id).map(f=>String(f.payload))
  const line=events.find(p=>p.startsWith('🧭 استنتاج ('))
  expect(line,'no inference line; events:\n'+events.join('\n---\n')).toBeDefined()
  expect(line).toContain('83%')
  expect(line).toContain('fixture/agent-model')
  expect(line).toContain('افتح مجلد الفواتير في المشروع الحالي')
  // نداءٌ جانبيّ واحدٌ سبق النداءَ الرئيس، والاستنتاجُ وصل إلى أوّل طلبٍ رئيس.
  expect(requests[0]?.infer).toBe(true)
  const main=requests.find(r=>!r.infer)
  expect(main).toBeDefined()
  expect(JSON.stringify(main.messages)).toContain('الطبقة الرابعة')
  expect(JSON.stringify(main.messages)).toContain('الدافع «يعمل على الفواتير الآن»')
 }finally{await stop()}
},90000)

test('free prose from the provider is rejected whole: no inference line is claimed and nothing is injected (no guessing)',async()=>{
 const {frames,requests,turn,stop}=await boot(true,'prose')
 try{
  const id=await turn('وين مجلد الفواتير؟')
  const events=frames.filter(f=>f.kind==='event'&&f.turnId===id).map(f=>String(f.payload))
  expect(events.some(p=>p.startsWith('🧭 استنتاج ('))).toBe(false)
  expect(events.some(p=>p.startsWith('🧭 استنتاج: لم يُقبل'))).toBe(true)
  expect(requests[0]?.infer).toBe(true)
  const main=requests.find(r=>!r.infer)
  expect(JSON.stringify(main.messages)).not.toContain('الطبقة الرابعة')
 }finally{await stop()}
},90000)

test('with semanticInfer off no side call is made at all (absence is refusal, not permission)',async()=>{
 const {frames,requests,turn,stop}=await boot(false,'strict')
 try{
  const id=await turn('وين مجلد الفواتير؟')
  const events=frames.filter(f=>f.kind==='event'&&f.turnId===id).map(f=>String(f.payload))
  expect(events.some(p=>p.startsWith('🧭 استنتاج'))).toBe(false)
  expect(requests.some(r=>r.infer)).toBe(false)
  expect(events.some(p=>p.startsWith('🧭 لغة:'))).toBe(true)
 }finally{await stop()}
},90000)
