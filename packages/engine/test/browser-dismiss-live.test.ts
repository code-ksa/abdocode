import {expect,test} from 'bun:test'
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {encodeLocalJsonFrame,LocalJsonFrameDecoder} from '@abdo/transport-contracts'
import {stripChildEnv} from '../../tools/src/env-strip'

// م12 حيّاً (مقيس 09-14): نافذةُ لغة Google فوق نتائج البحث — `dismiss` عبر الموزّع الحقيقيّ إلى فكستشر CDP: تقرأ الشجرة،
// تختار «الاستمرار باللغة العربية» (إبقاءُ اللغة لا تبديلُها ولا إغلاقٌ أعمى)، وتنقرها بحدثَي إدخالٍ موثوقَين في موضعها.

const PNG_1x1='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const DIALOG_TREE=JSON.stringify([{ref:'r1',role:'combobox',name:'بحث'},{ref:'r3',role:'dialog',name:'Looking for results in English?',children:[{ref:'r4',role:'link',name:'Change to English'},{ref:'r5',role:'link',name:'الاستمرار باللغة العربية'},{ref:'r7',role:'button',name:'×'}]},{ref:'r8',role:'link',name:'Blender render to PDF'}])
const PLAIN_TREE=JSON.stringify([{ref:'r1',role:'combobox',name:'بحث'},{ref:'r8',role:'link',name:'Blender render to PDF'}])
const mode={tree:'dialog' as 'dialog'|'plain'}
// ب9 — الفكستشر يجيب عقدَ locate الجديد: موضعٌ **وهويّةٌ وحالة**. الحالةُ تُبدَّل في الاختبار لإثبات الرفض بلا حدثِ إدخالٍ واحد.
const NODES:Record<string,{role:string,name:string,sensitive?:boolean}>={r1:{role:'combobox',name:'بحث'},r3:{role:'dialog',name:'Looking for results in English?'},r4:{role:'link',name:'Change to English'},r5:{role:'link',name:'الاستمرار باللغة العربية'},r7:{role:'button',name:'×'},r8:{role:'link',name:'Blender render to PDF'}}
const state={hit:true,width:80,height:24,inView:true,value:'',impostor:false}

test('dismiss reads the page, picks the safest closer (keep current language) and taps it through the trusted path; no overlay → nothing is clicked',async()=>{
 const home=mkdtempSync(join(tmpdir(),'abdo-browser-actions-')),settings=join(home,'engine-settings.json')
 let currentUrl='about:blank';const input:any[]=[],evaluated:string[]=[]
 const cdp=Bun.serve<{}>({hostname:'127.0.0.1',port:0,fetch(request,server){const path=new URL(request.url).pathname
   if(path==='/json')return Response.json([{id:'main',type:'page',url:currentUrl,webSocketDebuggerUrl:`ws://127.0.0.1:${server.port}/devtools/page/main`}])
   if(path==='/json/version')return Response.json({webSocketDebuggerUrl:`ws://127.0.0.1:${server.port}/devtools/browser/01234567-89ab-cdef-0123-456789abcdef`})
   if(server.upgrade(request,{data:{}}))return;return new Response('missing',{status:404})},
  websocket:{message(socket,message){const f=JSON.parse(String(message));let result:any={}
   if(f.method==='Target.setAutoAttach'&&!f.sessionId)socket.send(JSON.stringify({method:'Target.attachedToTarget',params:{sessionId:'main-session',targetInfo:{targetId:'main',type:'page'}}}))
   if(f.method==='Runtime.evaluate'){const e=String(f.params.expression);evaluated.push(e.includes('el.focus()')?'focus':e.slice(0,40))
    result={result:{value:e==='document.title'?'Fixture signup':e==='location.href'?currentUrl:(e.includes('innerWidth')&&!e.includes('data-abdo-ref'))?JSON.stringify({x:400,y:300}):e.includes('el.focus(); return document.activeElement')?'yes':e.includes('getComputedStyle')?JSON.stringify({title:'Fixture signup',url:currentUrl,text:'Email field text',styles:{color:'rgb(0, 0, 0)','font-size':'14px'}}):e.startsWith("(() => { const el = document.querySelector('[data-abdo-ref=")?(()=>{const ref=(e.match(/data-abdo-ref="(r\d+)"/)||[])[1]||'r0';const n=NODES[ref]||{role:'?',name:'?'};if(e.includes('el.select'))return 'yes';if(e.includes('length: v.length'))return JSON.stringify(n.sensitive?{length:state.value.length,sensitive:true}:{value:state.value,length:state.value.length,sensitive:false});if(e.includes('elementFromPoint'))return JSON.stringify({x:10,y:20,width:state.width,height:state.height,inView:state.inView,hit:state.hit,role:state.impostor?'link':n.role,name:state.impostor?'حذف الحساب':n.name,sensitive:n.sensitive===true});return 'yes'})():(mode.tree==='dialog'?DIALOG_TREE:PLAIN_TREE)}}}
   if(f.method==='Page.navigate'){currentUrl=f.params.url;result={frameId:'main'}}
   if(f.method==='Page.captureScreenshot')result={data:PNG_1x1}
   if(f.method==='Page.bringToFront')input.push({method:f.method})
   if(f.method==='Input.dispatchMouseEvent'||f.method==='Input.dispatchKeyEvent'){input.push({method:f.method,...f.params});if(f.method==='Input.dispatchKeyEvent'&&f.params.type==='keyDown'&&typeof f.params.text==='string')state.value+=f.params.text}
   socket.send(JSON.stringify({id:f.id,result,...(f.sessionId?{sessionId:f.sessionId}:{})}))}}})
 const port=cdp.port!
 // READ_TREE نفسُه يحوي getBoundingClientRect — تمييزُ locate بصدر تعبيره (قيس: طابقت الشجرةُ فرعَ الإحداثيات).
 // مزوّدٌ محلّيّ مزيّف بنموذجَين: agent بلا صور، وvision يقبل الصور — الطلباتُ تُسجَّل بنموذجها وبوجود الصورة.
 const requests:{model:string,hasImage:boolean}[]=[]
 const model=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){const raw=await req.text();const body=JSON.parse(raw);requests.push({model:body.model,hasImage:raw.includes('image_url')});const answer='FAKE_'+requests.length
  return new Response(body.stream?'data: '+JSON.stringify({choices:[{delta:{content:answer},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n':JSON.stringify({choices:[{message:{role:'assistant',content:answer},finish_reason:'stop'}]}),{headers:{'content-type':body.stream?'text/event-stream':'application/json'}})}})
 writeFileSync(settings,JSON.stringify({language:'en',mode:'full-access',computerUseEnabled:true,modelRole:'agent',routerGate:'off',agentModel:'fixture/agent',chatModel:'fixture/agent',visionModel:'fixture/vision',
  plugins:{projectAwareness:false,sessionAwareness:false,generalAwareness:false,verifier:false,reviewer:false,delegation:false,semanticFrame:false,lessons:false,usageMeter:false},
  customProviders:[{id:'fixture',label:'Browser fixture',local:true,baseUrl:`http://127.0.0.1:${model.port}/v1`,vaultKey:'',models:['agent','vision'],imageModels:['vision']}]}))
 writeFileSync(join(home,'workspace-v1.json'),JSON.stringify({preferences:{browserDefaultPermission:'allow',blockedSites:[]}}))
 writeFileSync(join(home,'browser-control-lease.json'),JSON.stringify({version:1,port,pid:process.pid,ownerPid:process.pid,endpoint:`ws://127.0.0.1:${port}/devtools/browser/01234567-89ab-cdef-0123-456789abcdef`}))
 const frames:any[]=[];const child=Bun.spawn([process.execPath,'packages/engine/src/cli.ts','serve'],{cwd:resolve(import.meta.dir,'../../..'),env:{...stripChildEnv(process.env).env,ABDO_CODE_SETTINGS:settings,ABDO_CODE_STATE_DIR:join(home,'state'),ABDO_SHELL_TOKEN:'browser-actions-test',ABDO_FRAMED_STDIO:'1',ABDO_DESKTOP_OWNER_PID:String(process.pid),USERPROFILE:home,HOME:home,ABDO_MAX_AGENT_EPOCHS:'1',ABDO_REQUIRE_SPRINT_PLAN:'0',ABDO_AGENT_PHASE:''},stdin:'pipe',stdout:'pipe',stderr:'pipe'})
 const stderr=new Response(child.stderr).text();const decoder=new LocalJsonFrameDecoder();const reading=(async()=>{for await(const bytes of child.stdout)for(const f of decoder.push(bytes))frames.push(f)})()
 const send=(f:object)=>{child.stdin.write(encodeLocalJsonFrame(f));void child.stdin.flush()}
 const wait=async(predicate:()=>boolean,label:string)=>{const deadline=Date.now()+30000;while(!predicate()){if(Date.now()>deadline)throw Error(label+' '+JSON.stringify(frames).slice(-2500));await Bun.sleep(10)}}
 let n=0
 const turn=async(body:string)=>{const id=`ba-${++n}`;send({kind:'submit',turn:{id,body},mode:'full-access'});await wait(()=>frames.some(f=>f.turnId===id&&['done','refused'].includes(f.kind)),'turn '+body);return id}
 const events=(id:string)=>frames.filter(f=>f.kind==='event'&&f.turnId===id).map(f=>String(f.payload))
 try{
  send({kind:'hello',shell:'desktop',token:'browser-actions-test'});await wait(()=>frames.some(f=>f.kind==='ready'),'ready')
  const s=await turn(`surface ${port}`);expect(events(s).some(p=>p.startsWith('وُصل السطح على المنفذ '+port))).toBe(true)
  await turn('open https://allowed.test/search?q=blender');expect(currentUrl).toBe('https://allowed.test/search?q=blender')
  const before=input.length
  const d=await turn('dismiss')
  expect(events(d).some(p=>p.includes('أغلقتُ الطبقةَ العائمة بنقر «الاستمرار باللغة العربية»')),JSON.stringify(events(d)).slice(0,1200)).toBe(true)
  expect(input.slice(before).filter(e=>e.method==='Input.dispatchMouseEvent').map(e=>`${e.type}@${e.x},${e.y}`)).toEqual(['mousePressed@10,20','mouseReleased@10,20'])
  // التوأمُ السلبيّ: صفحةٌ بلا طبقة ⇦ لا نقرةَ ولا ادّعاء.
  mode.tree='plain'
  const clicks=input.filter(e=>e.method==='Input.dispatchMouseEvent').length
  const none=await turn('dismiss');expect(events(none).some(p=>p.startsWith('لا طبقةَ عائمة تُغلَق'))).toBe(true)
  expect(input.filter(e=>e.method==='Input.dispatchMouseEvent').length).toBe(clicks)
 }finally{child.kill();await child.exited;await reading;await stderr;cdp.stop(true);model.stop(true);rmSync(home,{recursive:true,force:true})}
},120000)
