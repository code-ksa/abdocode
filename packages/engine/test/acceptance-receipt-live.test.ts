import {expect,test} from 'bun:test'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {encodeLocalJsonFrame,LocalJsonFrameDecoder} from '@abdo/transport-contracts'
import {stripChildEnv} from '../../tools/src/env-strip'

// ذ4 — على دورٍ حقيقيّ: بوّابةُ بناءٍ مطلوبة. (أ) نُفّذت وسقطت ⇒ الإيصالُ النهائيّ «البناء ✗ فشل» ومعه
// الدليل، والدورُ غيرُ مكتمل. (ب) لم تُنفَّذ قطّ (لا package.json فلا أمرَ يُفرض) ⇒ «البناء ○ لم يُفحص»
// — لا «فشل» مزعوم ولا نجاحٌ مدّعى — والدورُ غيرُ مكتمل. الوصفة من model-ladder-live: مزوّدٌ مزيّف
// يجيب نصّاً بلا أداة، والمحرّكُ الحقيقيّ مؤطَّراً.

const boot=async(opts:{withPackage:boolean,tag:string})=>{
 const home=mkdtempSync(join(tmpdir(),'abdo-accept-')),settings=join(home,'settings.json'),project=join(home,'project');mkdirSync(project)
 if(opts.withPackage)writeFileSync(join(project,'package.json'),JSON.stringify({name:'accept-probe',version:'1.0.0',private:true,scripts:{build:'node -e "console.error(\'SyntaxError: Unexpected token )\');process.exit(1)"'}}))
 const requests:any[]=[];const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){const body=await req.json();requests.push({model:body.model});const answer='FAKE_'+requests.length;
  return new Response(body.stream?'data: '+JSON.stringify({choices:[{delta:{content:answer},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n':JSON.stringify({choices:[{message:{role:'assistant',content:answer},finish_reason:'stop'}]}),{headers:{'content-type':body.stream?'text/event-stream':'application/json'}})}})
 writeFileSync(settings,JSON.stringify({language:'en',mode:'full-access',modelRole:'agent',routerGate:'off',project,
  agentModel:'fixture/agent-model',chatModel:'fixture/agent-model',
  plugins:{projectAwareness:false,sessionAwareness:false,generalAwareness:false,verifier:false,reviewer:false,delegation:false},
  customProviders:[{id:'fixture',label:'Acceptance fixture',local:true,baseUrl:`http://127.0.0.1:${server.port}/v1`,vaultKey:'',models:['agent-model']}]}))
 const frames:any[]=[];const child=Bun.spawn([process.execPath,'packages/engine/src/cli.ts','serve'],{cwd:resolve(import.meta.dir,'../../..'),env:{...stripChildEnv(process.env).env,ABDO_CODE_SETTINGS:settings,ABDO_CODE_STATE_DIR:join(home,'state'),ABDO_SHELL_TOKEN:'accept-test',ABDO_FRAMED_STDIO:'1',USERPROFILE:home,HOME:home,ABDO_MAX_AGENT_EPOCHS:'3',ABDO_REQUIRE_SPRINT_PLAN:'0',ABDO_AGENT_PHASE:''},stdin:'pipe',stdout:'pipe',stderr:'pipe'})
 const stderr=new Response(child.stderr).text();const decoder=new LocalJsonFrameDecoder();const reading=(async()=>{for await(const bytes of child.stdout)for(const f of decoder.push(bytes))frames.push(f)})()
 const send=(f:object)=>{child.stdin.write(encodeLocalJsonFrame(f));void child.stdin.flush()}
 const wait=async(predicate:()=>boolean,label:string)=>{const deadline=Date.now()+40000;while(!predicate()){if(Date.now()>deadline)throw Error(label+' '+JSON.stringify(frames).slice(-2500));await Bun.sleep(10)}}
 send({kind:'hello',shell:'desktop',token:'accept-test'});await wait(()=>frames.some(f=>f.kind==='ready'),'ready')
 const turn=async(body:string)=>{const id='accept-'+opts.tag;send({kind:'submit',turn:{id,body},mode:'full-access'});await wait(()=>frames.some(f=>f.turnId===id&&['done','refused'].includes(f.kind)),'turn '+id);return id}
 const stop=async()=>{child.kill();await child.exited;await reading;await stderr;server.stop(true);rmSync(home,{recursive:true,force:true})}
 return {frames,turn,stop}
}

test('a build gate that ran and failed is reported as failed with its evidence, and the turn is not completed',async()=>{
 const {frames,turn,stop}=await boot({withPackage:true,tag:'failed'})
 try{
  const id=await turn('build the project')
  const events=frames.filter(f=>f.kind==='event'&&f.turnId===id).map(f=>String(f.payload))
  const line=events.find(p=>p.startsWith('بوابات القبول:'))
  expect(line,'no acceptance line; events:\n'+events.join('\n---\n')).toBeDefined()
  expect(line).toContain('البناء ✗ فشل')
  expect(line).toContain('SyntaxError')
  expect(line).not.toContain('لم يُفحص')
  // القصّةُ بترتيبها: قبل الفحص يقول التلميحُ «لم يُفحص» (صدقاً، لا «لا يوجد إيصال» المبهمة)، ثم يُفرض
  // الفحصُ فيسقط ويُعلَن سقوطُه، فيقول الإيصالُ النهائيّ «فشل» — لا «لم يُفحص».
  const hint=events.findIndex(p=>p.startsWith('↻ شرط القبول:')&&p.includes('**لم يُفحص**'))
  expect(hint,'no pre-probe hint; events:\n'+events.join('\n---\n')).toBeGreaterThanOrEqual(0)
  const failedProbe=events.findIndex(p=>p.startsWith('⚠ فشل فحص القبول'))
  expect(failedProbe).toBeGreaterThan(hint)
  expect(events.indexOf(line!)).toBeGreaterThan(failedProbe)
  const done=frames.find(f=>f.kind==='done'&&f.turnId===id)
  expect(done.outcome).toBe('checkpointed')
 }finally{await stop()}
},90000)

test('a build gate that never ran is reported as unverified — not failed, never passed — and the turn is not completed',async()=>{
 const {frames,turn,stop}=await boot({withPackage:false,tag:'unverified'})
 try{
  const id=await turn('build the project')
  const events=frames.filter(f=>f.kind==='event'&&f.turnId===id).map(f=>String(f.payload))
  const line=events.find(p=>p.startsWith('بوابات القبول:'))
  expect(line,'no acceptance line; events:\n'+events.join('\n---\n')).toBeDefined()
  expect(line).toContain('البناء ○ لم يُفحص')
  expect(line).not.toContain('فشل')
  expect(line).not.toContain('نجح')
  expect(events.some(p=>p.startsWith('↻ شرط القبول:')&&p.includes('**لم يُفحص**'))).toBe(true)
  const done=frames.find(f=>f.kind==='done'&&f.turnId===id)
  expect(done.outcome).toBe('checkpointed')
 }finally{await stop()}
},90000)
