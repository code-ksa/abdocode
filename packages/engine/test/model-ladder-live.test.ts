import {expect,test} from 'bun:test'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {encodeLocalJsonFrame,LocalJsonFrameDecoder} from '@abdo/transport-contracts'
import {stripChildEnv} from '../../tools/src/env-strip'

// ذ2ب — سلّمُ النماذج يصعد **بفشلٍ مثبت** لا بتقدير: بوّابةُ بناءٍ حتميّة رجعت حمراء.
//
// قِيس قبل هذا الاختبار أنّ سويتة المحرّك لا تشغّل بوّابةَ قبولٍ فاشلةً في أيّ موضع
// (طفرةُ وصولٍ على فرع الصعود لم تغيّر نتيجةَ اختبارٍ واحد). فهذا اللوح يغطّي ثغرةً في
// المستودع قبل أن يثبت الوصلَ الجديد. الوصفة من chat-conversation.test.ts حرفاً:
// مزوّدٌ مزيّف محليّ (بلا خزنة)، والمحرّك الحقيقيّ مؤطَّراً، والإطاراتُ كلُّها تُحفظ.
//
// كيف يُبلَغ الفشل: الهدفُ فيه «build» فيُشعل requiresBuild؛ والنموذجُ المزيّف يجيب
// نصّاً بلا أداة فتكتمل الحقبةُ بصفر أدوات؛ فيفرض المضيفُ `run npm run build` (لأن
// package.json موجود) وسكربتُ البناء `exit 1` ⇒ forcedFailed ⇒ الصعود.

const boot=async(withLadder:boolean)=>{
 const home=mkdtempSync(join(tmpdir(),'abdo-ladder-')),settings=join(home,'settings.json'),project=join(home,'project');mkdirSync(project)
 writeFileSync(join(project,'package.json'),JSON.stringify({name:'ladder-probe',version:'1.0.0',private:true,scripts:{build:'exit 1'}}))
 const requests:any[]=[];const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){const body=await req.json();requests.push({model:body.model,stream:body.stream});const answer='FAKE_'+requests.length;
  return new Response(body.stream?'data: '+JSON.stringify({choices:[{delta:{content:answer},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n':JSON.stringify({choices:[{message:{role:'assistant',content:answer},finish_reason:'stop'}]}),{headers:{'content-type':body.stream?'text/event-stream':'application/json'}})}})
 writeFileSync(settings,JSON.stringify({language:'en',mode:'full-access',modelRole:'agent',routerGate:'off',project,
  agentModel:'fixture/rung1',chatModel:'fixture/rung1',
  ...(withLadder?{modelLadder:['fixture/rung1','fixture/rung2']}:{}),
  plugins:{projectAwareness:false,sessionAwareness:false,generalAwareness:false,verifier:false,reviewer:false,delegation:false},
  customProviders:[{id:'fixture',label:'Ladder fixture',local:true,baseUrl:`http://127.0.0.1:${server.port}/v1`,vaultKey:'',models:['rung1','rung2']}]}))
 const frames:any[]=[];const child=Bun.spawn([process.execPath,'packages/engine/src/cli.ts','serve'],{cwd:resolve(import.meta.dir,'../../..'),env:{...stripChildEnv(process.env).env,ABDO_CODE_SETTINGS:settings,ABDO_CODE_STATE_DIR:join(home,'state'),ABDO_SHELL_TOKEN:'ladder-test',ABDO_FRAMED_STDIO:'1',USERPROFILE:home,HOME:home,ABDO_MAX_AGENT_EPOCHS:'3',ABDO_REQUIRE_SPRINT_PLAN:'0',ABDO_AGENT_PHASE:''},stdin:'pipe',stdout:'pipe',stderr:'pipe'})
 const stderr=new Response(child.stderr).text();const decoder=new LocalJsonFrameDecoder();const reading=(async()=>{for await(const bytes of child.stdout)for(const f of decoder.push(bytes))frames.push(f)})()
 const send=(f:object)=>{child.stdin.write(encodeLocalJsonFrame(f));void child.stdin.flush()}
 const wait=async(predicate:()=>boolean,label:string)=>{const deadline=Date.now()+40000;while(!predicate()){if(Date.now()>deadline)throw Error(label+' '+JSON.stringify(frames).slice(-2500));await Bun.sleep(10)}}
 send({kind:'hello',shell:'desktop',token:'ladder-test'});await wait(()=>frames.some(f=>f.kind==='ready'),'ready')
 const turn=async(body:string)=>{const id='ladder-'+(withLadder?'on':'off');send({kind:'submit',turn:{id,body},mode:'full-access'});await wait(()=>frames.some(f=>f.turnId===id&&['done','refused'].includes(f.kind)),'turn '+id);return id}
 const stop=async()=>{child.kill();await child.exited;await reading;await stderr;server.stop(true);rmSync(home,{recursive:true,force:true})}
 return {frames,requests,turn,stop}
}

test('a red build gate climbs the owner ladder one rung, with a receipt line that names the evidence, and the next model call goes to the higher rung',async()=>{
 const {frames,requests,turn,stop}=await boot(true)
 try{
  const id=await turn('build the project')
  const routes=frames.filter(f=>f.kind==='model-route'&&f.turnId===id)
  const events=frames.filter(f=>f.kind==='event'&&f.turnId===id).map(f=>String(f.payload))
  // ١) الصعودُ وقع، وسطرُ الإيصال يحمل الدليلَ لا مجرّدَ الإعلان.
  const climb=events.find(p=>p.startsWith('⛰ صعود: fixture/rung1 ⇦ fixture/rung2'))
  expect(climb,'no ⛰ line; events were:\n'+events.join('\n---\n')).toBeDefined()
  expect(climb).toContain('gate_failed: run npm run build')
  // ٢) مسارُ النموذج أُعلن مرّتين: البدايةُ ثم الدرجةُ الأعلى.
  expect(routes[0]).toMatchObject({lane:'agent',ref:'fixture/rung1'})
  expect(routes.at(-1)).toMatchObject({lane:'agent',ref:'fixture/rung2'})
  // ٣) والنداءُ التالي ذهب فعلاً إلى الدرجة الأعلى — الطلبُ عند المزوّد لا الإعلان.
  expect(requests[0].model).toBe('rung1')
  expect(requests.some(r=>r.model==='rung2')).toBe(true)
 }finally{await stop()}
},90000)

test('without a configured ladder the same red gate changes nothing: one route, one model, no climb line (absence is refusal, not permission)',async()=>{
 const {frames,requests,turn,stop}=await boot(false)
 try{
  const id=await turn('build the project')
  const events=frames.filter(f=>f.kind==='event'&&f.turnId===id).map(f=>String(f.payload))
  expect(events.some(p=>p.startsWith('⛰'))).toBe(false)
  expect(frames.filter(f=>f.kind==='model-route'&&f.turnId===id)).toHaveLength(1)
  expect(requests.length).toBeGreaterThan(0)
  expect(requests.every(r=>r.model==='rung1')).toBe(true)
 }finally{await stop()}
},90000)
