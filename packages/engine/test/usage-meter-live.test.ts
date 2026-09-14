import {expect,test} from 'bun:test'
import {existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {encodeLocalJsonFrame,LocalJsonFrameDecoder} from '@abdo/transport-contracts'
import {stripChildEnv} from '../../tools/src/env-strip'

// ذ5 — العدّادُ المحلي على دورٍ حقيقيّ بمزوّدٍ محلّيّ مزيّف **يعلن استعماله**: كلُّ نداءٍ يصير سطراً في
// ABDO_USAGE_METER بزمنه ونموذجه وما أُعلن، ومجموعُ المبلَّغ في العدّاد = مجموعُ ما أعلنه المزوّد حرفاً
// (البوّابة: ±١٪ — والمطابقةُ هنا تامّة لأنه لا تقدير)؛ والدفترُ السحابيّ لا يُمسّ (النداءُ محلّيّ)؛
// والإضافةُ المطفأة لا تكتب شيئاً (الغيابُ رفض).

const boot=async(opts:{home:string,meterOn:boolean,tag:string})=>{
 const settings=join(opts.home,`settings-${opts.tag}.json`),docs=join(opts.home,'docs');mkdirSync(docs,{recursive:true})
 const reported={input:0,output:0,calls:0}
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){const body=await req.json();const answer='FAKE_'+(reported.calls+1)
  // أرقامٌ متعمَّدةُ الاختلاف لكلّ نداء كي لا تُخفي مصادفةٌ خطأً في الجمع.
  const usage={prompt_tokens:100+reported.calls*7,completion_tokens:10+reported.calls*3};reported.calls++;reported.input+=usage.prompt_tokens;reported.output+=usage.completion_tokens
  if(body.stream)return new Response('data: '+JSON.stringify({choices:[{delta:{content:answer},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})
  return Response.json({choices:[{message:{role:'assistant',content:answer},finish_reason:'stop'}],usage})}})
 writeFileSync(settings,JSON.stringify({language:'en',mode:'full-access',modelRole:'agent',routerGate:'off',agentModel:'fixture/agent-model',chatModel:'fixture/agent-model',
  plugins:{projectAwareness:false,sessionAwareness:false,generalAwareness:false,verifier:false,reviewer:false,delegation:false,semanticFrame:false,lessons:false,...(opts.meterOn?{}:{usageMeter:false})},
  customProviders:[{id:'fixture',label:'Meter fixture',local:true,baseUrl:`http://127.0.0.1:${server.port}/v1`,vaultKey:'',models:['agent-model']}]}))
 const meter=join(opts.home,`meter-${opts.tag}.jsonl`),ledger=join(opts.home,`cloud-ledger-${opts.tag}.json`)
 const frames:any[]=[];const child=Bun.spawn([process.execPath,'packages/engine/src/cli.ts','serve'],{cwd:resolve(import.meta.dir,'../../..'),env:{...stripChildEnv(process.env).env,ABDO_CODE_SETTINGS:settings,ABDO_CODE_STATE_DIR:join(opts.home,'state-'+opts.tag),ABDO_DOCUMENTS_DIR:docs,ABDO_SHELL_TOKEN:'meter-test',ABDO_FRAMED_STDIO:'1',USERPROFILE:opts.home,HOME:opts.home,ABDO_MAX_AGENT_EPOCHS:'1',ABDO_REQUIRE_SPRINT_PLAN:'0',ABDO_AGENT_PHASE:'',ABDO_USAGE_METER:meter,ABDO_TOKEN_LEDGER:ledger},stdin:'pipe',stdout:'pipe',stderr:'pipe'})
 const stderr=new Response(child.stderr).text();const decoder=new LocalJsonFrameDecoder();const reading=(async()=>{for await(const bytes of child.stdout)for(const f of decoder.push(bytes))frames.push(f)})()
 const send=(f:object)=>{child.stdin.write(encodeLocalJsonFrame(f));void child.stdin.flush()}
 const wait=async(predicate:()=>boolean,label:string)=>{const deadline=Date.now()+40000;while(!predicate()){if(Date.now()>deadline)throw Error(label+' '+JSON.stringify(frames).slice(-2500));await Bun.sleep(10)}}
 send({kind:'hello',shell:'desktop',token:'meter-test'});await wait(()=>frames.some(f=>f.kind==='ready'),'ready')
 const turn=async(body:string)=>{const id='meter-'+opts.tag;send({kind:'submit',turn:{id,body},mode:'full-access'});await wait(()=>frames.some(f=>f.turnId===id&&['done','refused'].includes(f.kind)),'turn '+id);return id}
 const stop=async()=>{child.kill();await child.exited;await reading;await stderr;server.stop(true)}
 return {frames,reported,meter,ledger,turn,stop}
}

test('every model call of a turn becomes one meter line with its model, time and the usage the provider reported — sums match the provider exactly — and the cloud ledger stays untouched for local calls',async()=>{
 const home=mkdtempSync(join(tmpdir(),'abdo-meter-live-'))
 const a=await boot({home,meterOn:true,tag:'on'})
 try{
  await a.turn('say hello')
  expect(a.reported.calls).toBeGreaterThan(0)
  expect(existsSync(a.meter),'meter file missing').toBe(true)
  const entries=readFileSync(a.meter,'utf8').trim().split('\n').map(l=>JSON.parse(l))
  // سطرٌ لكلّ نداءٍ وصل المزوّد — لا أكثر ولا أقلّ.
  expect(entries.length).toBe(a.reported.calls)
  for(const e of entries){
   expect(e).toMatchObject({provider:'fixture',model:'agent-model',local:true})
   expect(typeof e.ms).toBe('number');expect(e.ms).toBeGreaterThanOrEqual(0)
   expect(typeof e.reportedInputTokens).toBe('number');expect(typeof e.reportedOutputTokens).toBe('number')
   expect(e.chargedInputTokens).toBeGreaterThanOrEqual(e.reportedInputTokens)
  }
  const sumIn=entries.reduce((n,e)=>n+e.reportedInputTokens,0),sumOut=entries.reduce((n,e)=>n+e.reportedOutputTokens,0)
  expect(sumIn).toBe(a.reported.input)
  expect(sumOut).toBe(a.reported.output)
  // النداءُ المحلّيّ لا يدخل الدفترَ السحابيّ — العدّادُ للمستخدم، والدفترُ للسقف.
  expect(existsSync(a.ledger)).toBe(false)
 }finally{await a.stop()}
 // الإضافةُ المطفأة: النداءاتُ تجري ولا سطرَ يُكتب.
 const off=await boot({home,meterOn:false,tag:'off'})
 try{
  await off.turn('say hello')
  expect(off.reported.calls).toBeGreaterThan(0)
  expect(existsSync(off.meter)).toBe(false)
 }finally{await off.stop();rmSync(home,{recursive:true,force:true})}
},120000)
