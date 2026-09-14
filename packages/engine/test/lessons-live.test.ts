import {expect,test} from 'bun:test'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {encodeLocalJsonFrame,LocalJsonFrameDecoder} from '@abdo/transport-contracts'
import {stripChildEnv} from '../../tools/src/env-strip'

// ذ3 — الخبرةُ تصير قدرة، على دورٍ حقيقيّ: بوّابةُ بناءٍ حمراء (الوصفة من model-ladder-live)
// تُسجَّل درساً مقيَّداً بالمشروع بسطر 📚؛ الدورُ التالي في المشروع نفسه يستلم الدرسَ **قبل أوّل
// نداء** ويسمّي التكرارَ في الإيصال؛ ومشروعٌ آخر على المخزن نفسه لا يرى منه شيئاً (حارسُ
// التسرّب — تعطيلُ قيد المشروع يُحمِّره)؛ والإضافةُ المطفأة لا تسجّل ولا تحقن (الغيابُ رفض).

const boot=async(opts:{home:string,project:string,lessonsOn:boolean,tag:string})=>{
 const settings=join(opts.home,`settings-${opts.tag}.json`)
 mkdirSync(opts.project,{recursive:true})
 writeFileSync(join(opts.project,'package.json'),JSON.stringify({name:'lesson-probe',version:'1.0.0',private:true,scripts:{build:'node -e "console.error(\'TypeError: boom is not a function\');process.exit(1)"'}}))
 const requests:any[]=[];const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){const body=await req.json();requests.push({model:body.model,messages:body.messages});const answer='FAKE_'+requests.length;
  return new Response(body.stream?'data: '+JSON.stringify({choices:[{delta:{content:answer},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n':JSON.stringify({choices:[{message:{role:'assistant',content:answer},finish_reason:'stop'}]}),{headers:{'content-type':body.stream?'text/event-stream':'application/json'}})}})
 writeFileSync(settings,JSON.stringify({language:'en',mode:'full-access',modelRole:'agent',routerGate:'off',project:opts.project,
  agentModel:'fixture/agent-model',chatModel:'fixture/agent-model',
  plugins:{projectAwareness:false,sessionAwareness:false,generalAwareness:false,verifier:false,reviewer:false,delegation:false,...(opts.lessonsOn?{}:{lessons:false})},
  customProviders:[{id:'fixture',label:'Lessons fixture',local:true,baseUrl:`http://127.0.0.1:${server.port}/v1`,vaultKey:'',models:['agent-model']}]}))
 const frames:any[]=[];const child=Bun.spawn([process.execPath,'packages/engine/src/cli.ts','serve'],{cwd:resolve(import.meta.dir,'../../..'),env:{...stripChildEnv(process.env).env,ABDO_CODE_SETTINGS:settings,ABDO_CODE_STATE_DIR:join(opts.home,'state'),ABDO_SHELL_TOKEN:'lessons-test',ABDO_FRAMED_STDIO:'1',USERPROFILE:opts.home,HOME:opts.home,ABDO_MAX_AGENT_EPOCHS:'3',ABDO_REQUIRE_SPRINT_PLAN:'0',ABDO_AGENT_PHASE:''},stdin:'pipe',stdout:'pipe',stderr:'pipe'})
 const stderr=new Response(child.stderr).text();const decoder=new LocalJsonFrameDecoder();const reading=(async()=>{for await(const bytes of child.stdout)for(const f of decoder.push(bytes))frames.push(f)})()
 const send=(f:object)=>{child.stdin.write(encodeLocalJsonFrame(f));void child.stdin.flush()}
 const wait=async(predicate:()=>boolean,label:string)=>{const deadline=Date.now()+40000;while(!predicate()){if(Date.now()>deadline)throw Error(label+' '+JSON.stringify(frames).slice(-2500));await Bun.sleep(10)}}
 send({kind:'hello',shell:'desktop',token:'lessons-test'});await wait(()=>frames.some(f=>f.kind==='ready'),'ready')
 let n=0
 const turn=async(body:string)=>{const id=`lessons-${opts.tag}-${++n}`;send({kind:'submit',turn:{id,body},mode:'full-access'});await wait(()=>frames.some(f=>f.turnId===id&&['done','refused'].includes(f.kind)),'turn '+id);return id}
 const events=(id:string)=>frames.filter(f=>f.kind==='event'&&f.turnId===id).map(f=>String(f.payload))
 const stop=async()=>{child.kill();await child.exited;await reading;await stderr;server.stop(true)}
 return {frames,requests,turn,events,stop}
}

test('a red build gate becomes a project-scoped lesson; the next turn in the same project receives it before the first model call and names the repeat in the receipt; another project on the same store sees nothing',async()=>{
 const home=mkdtempSync(join(tmpdir(),'abdo-lessons-live-'))
 const a=await boot({home,project:join(home,'project-a'),lessonsOn:true,tag:'a'})
 try{
  // الدورُ الأوّل: البوّابةُ تحمرّ فيُسجَّل الدرس بسطر 📚 يسمّي الأمرَ والبصمة.
  const t1=a.turn('build the project')
  const id1=await t1
  const ev1=a.events(id1)
  const recorded=ev1.filter(p=>p.startsWith('📚 درسٌ مقيَّد بالمشروع'))
  expect(recorded.length,'no 📚 lesson line; events:\n'+ev1.join('\n---\n')).toBeGreaterThan(0)
  expect(recorded[0]).toContain('run npm run build')
  expect(recorded[0]).toContain('typeerror')
  expect(JSON.stringify(a.requests[0].messages)).not.toContain('دروسُ هذا المشروع')
  // الدورُ الثاني في المشروع نفسه: الدرسُ يصل أوّلَ طلبٍ للنموذج قبل أيّ أداة، ثم يُسمّى التكرار.
  const before=a.requests.length
  const id2=await a.turn('build the project again')
  const ev2=a.events(id2)
  expect(ev2.some(p=>p.startsWith('📚 دروس المشروع: 1')),'no brief line; events:\n'+ev2.join('\n---\n')).toBe(true)
  // أوّلُ طلبٍ **رئيس** في الدور الثاني (نداءُ مرتِّب الاسترجاع الدلاليّ نداءٌ جانبيّ يسبقه ولا يُحسب).
  const mainOfTurn2=a.requests.slice(before).map(r=>JSON.stringify(r.messages)).find(m=>!m.includes('semantic memory retriever'))
  expect(mainOfTurn2,'no main request in turn 2').toBeDefined()
  expect(mainOfTurn2).toContain('دروسُ هذا المشروع')
  expect(mainOfTurn2).toContain('run npm run build')
  const repeated=ev2.filter(p=>p.startsWith('📚 درسٌ مقيَّد بالمشروع'))
  expect(repeated.length).toBeGreaterThan(0)
  expect(repeated.at(-1)).toContain('الحكم:')
  expect(repeated.at(-1)).toMatch(/\((?:build)، [2-9]\d*×\)/u)
 }finally{await a.stop()}
 // مشروعٌ آخر على المخزن نفسه: لا سطرَ دروس ولا موجز — الدرسُ مقيَّدٌ بمشروعه.
 const b=await boot({home,project:join(home,'project-b'),lessonsOn:true,tag:'b'})
 try{
  const id=await b.turn('build the project')
  const ev=b.events(id)
  expect(ev.some(p=>p.startsWith('📚 دروس المشروع')),'lesson leaked to another project; events:\n'+ev.join('\n---\n')).toBe(false)
  expect(JSON.stringify(b.requests[0].messages)).not.toContain('دروسُ هذا المشروع')
  // توأمٌ إيجابيّ: المشروعُ ب يسجّل درسَه هو — المخزنُ يعمل، والقيدُ هو ما منع التسرّب.
  expect(ev.some(p=>p.startsWith('📚 درسٌ مقيَّد بالمشروع'))).toBe(true)
 }finally{await b.stop();rmSync(home,{recursive:true,force:true})}
},150000)

test('with the plugin off the same red gate records no lesson and injects nothing (absence is refusal, not permission)',async()=>{
 const home=mkdtempSync(join(tmpdir(),'abdo-lessons-off-'))
 const off=await boot({home,project:join(home,'project-off'),lessonsOn:false,tag:'off'})
 try{
  const id1=await off.turn('build the project')
  const id2=await off.turn('build the project again')
  const ev=[...off.events(id1),...off.events(id2)]
  expect(ev.some(p=>p.startsWith('📚'))).toBe(false)
  expect(off.requests.length).toBeGreaterThan(0)
  expect(off.requests.every(r=>!JSON.stringify(r.messages).includes('دروسُ هذا المشروع'))).toBe(true)
 }finally{await off.stop();rmSync(home,{recursive:true,force:true})}
},120000)
