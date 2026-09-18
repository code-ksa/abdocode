import {expect,test} from 'bun:test'
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {encodeLocalJsonFrame,LocalJsonFrameDecoder} from '@abdo/transport-contracts'
import {stripChildEnv} from '../../tools/src/env-strip'

// ب1/ب2 — ما كان مسجَّلاً بلا إثباتِ إرسال: `page ⇦ tap ⇦ fill` عبر الموزّع الحقيقيّ (serve) إلى فكستشر CDP يسجّل
// أحداثَ الإدخال الموثوقة؛ حقلُ كلمة المرور يُرفض بالحارس فلا يصله حرف؛ و`shot` تلتقط لقطةً حقيقيةً (فكستشر)
// تصل اللوحةَ إطارَ `browser-shot` وتصل **نموذجَ الرؤية** في نداء النموذج التالي مع سطر model-route بسمة vision.

const PNG_1x1='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const TREE=JSON.stringify([{ref:'r1',role:'textbox',name:'Email'},{ref:'r2',role:'textbox:password',name:'Password (فارغ)',sensitive:true},{ref:'r3',role:'button',name:'Sign up'}])
// ب9 — الفكستشر يجيب عقدَ locate الجديد: موضعٌ **وهويّةٌ وحالة**. الحالةُ تُبدَّل في الاختبار لإثبات الرفض بلا حدثِ إدخالٍ واحد.
const NODES:Record<string,{role:string,name:string,sensitive?:boolean}>={r1:{role:'textbox',name:'Email'},r2:{role:'textbox:password',name:'Password (فارغ)',sensitive:true},r3:{role:'button',name:'Sign up'}}
const state={hit:true,width:80,height:24,inView:true,value:'',impostor:false}

test('page → tap → fill reach the browser as trusted input events, the password field is refused before any key, and shot feeds the pane and the vision model',async()=>{
 const home=mkdtempSync(join(tmpdir(),'abdo-browser-actions-')),settings=join(home,'engine-settings.json')
 let currentUrl='about:blank';const input:any[]=[],evaluated:string[]=[]
 const cdp=Bun.serve<{}>({hostname:'127.0.0.1',port:0,fetch(request,server){const path=new URL(request.url).pathname
   if(path==='/json')return Response.json([{id:'main',type:'page',url:currentUrl,webSocketDebuggerUrl:`ws://127.0.0.1:${server.port}/devtools/page/main`}])
   if(path==='/json/version')return Response.json({webSocketDebuggerUrl:`ws://127.0.0.1:${server.port}/devtools/browser/01234567-89ab-cdef-0123-456789abcdef`})
   if(server.upgrade(request,{data:{}}))return;return new Response('missing',{status:404})},
  websocket:{message(socket,message){const f=JSON.parse(String(message));let result:any={}
   if(f.method==='Target.setAutoAttach'&&!f.sessionId)socket.send(JSON.stringify({method:'Target.attachedToTarget',params:{sessionId:'main-session',targetInfo:{targetId:'main',type:'page'}}}))
   if(f.method==='Runtime.evaluate'){const e=String(f.params.expression);evaluated.push(e.includes('el.focus()')?'focus':e.slice(0,40))
    result={result:{value:e==='document.title'?'Fixture signup':e==='location.href'?currentUrl:(e.includes('innerWidth')&&!e.includes('data-abdo-ref'))?JSON.stringify({x:400,y:300}):e.includes('el.focus(); return document.activeElement')?'yes':e.includes('getComputedStyle')?JSON.stringify({title:'Fixture signup',url:currentUrl,text:'Email field text',styles:{color:'rgb(0, 0, 0)','font-size':'14px'}}):e.startsWith("(() => { const el = document.querySelector('[data-abdo-ref=")?(()=>{const ref=(e.match(/data-abdo-ref="(r\d+)"/)||[])[1]||'r0';const n=NODES[ref]||{role:'?',name:'?'};if(e.includes('el.select'))return 'yes';if(e.includes('length: v.length'))return JSON.stringify(n.sensitive?{length:state.value.length,sensitive:true}:{value:state.value,length:state.value.length,sensitive:false});if(e.includes('elementFromPoint'))return JSON.stringify({x:10,y:20,width:state.width,height:state.height,inView:state.inView,hit:state.hit,role:state.impostor?'link':n.role,name:state.impostor?'حذف الحساب':n.name,sensitive:n.sensitive===true});return 'yes'})():TREE}}}
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
  // قيس (سجلّ المالك 2026-09-06): «open» بلا سطحٍ كان يرفض «لا سطحَ موصول» ثمّ ينجح «ui» بالرابط نفسه — الآن open يُطلق السطحَ كما ui
  // (عقدُ الإيجار المكتوب أعلاه يشير إلى فكستشر CDP فيتّصل به بلا إيدج حقيقيّ).
  const o0=await turn('open https://allowed.test/signup');expect(events(o0).some(p=>p.includes('فُتحت الواجهة واتصل متصفح الوكيل'))).toBe(true);expect(currentUrl).toBe('https://allowed.test/signup')
  const s=await turn(`surface ${port}`);expect(events(s).some(p=>p.startsWith('وُصل السطح على المنفذ '+port))).toBe(true)
  const o=await turn('open https://allowed.test/signup');expect(currentUrl).toBe('https://allowed.test/signup')
  const p=await turn('page');expect(events(p).some(p=>p.includes('r3')&&p.includes('Sign up'))).toBe(true)
  // النقرةُ حدثان موثوقان في موضع العنصر — لا el.click() المزروع.
  const t=await turn('tap r3')
  expect(input.filter(e=>e.method==='Input.dispatchMouseEvent').map(e=>`${e.type}@${e.x},${e.y}`)).toEqual(['mousePressed@10,20','mouseReleased@10,20'])
  expect(events(t).some(p=>p.startsWith('نقرتُ'))).toBe(true)
  // الكتابةُ حرفاً حرفاً بأحداث لوحة المفاتيح.
  const before=input.length
  const f=await turn('fill r1 hello')
  const keys=input.slice(before).filter(e=>e.method==='Input.dispatchKeyEvent')
  expect(keys.filter(e=>e.type==='keyDown').map(e=>e.text).join('')).toBe('hello')
  expect(events(f).some(p=>p.includes('وقرأتُ الحقلَ بعدها فطابق'))).toBe(true)
  // كلمةُ المرور: الحارسُ يرفض قبل أن يصل المتصفّحَ حرفٌ واحد.
  const before2=input.length
  const pw=await turn('fill r2 hunter2')
  expect(events(pw).some(p=>p.includes('حقلُ اعتمادٍ بنوعه')&&p.includes('handoff r2'))).toBe(true)
  expect(input.length).toBe(before2)
  // ب9 — ثلاثةُ أوجهٍ للكذب في الموضع، وكلُّها تُرفض **بلا حدثِ إدخالٍ واحد** يصل المتصفّح:
  //   (أ) عنصرٌ انطوى (مقاسُه صفر) كان يعطي (0,0) فتقع نقرةٌ موثوقةٌ في زاوية الصفحة؛
  //   (ب) عنصرٌ يغطّيه حوارٌ يعطي موضعاً صحيحاً لعنصرٍ خاطئ؛
  //   (ج) ومرجعٌ صار عنصراً آخر بين القراءة والنقر — الموافقةُ تحمل اسماً والفعلُ يقع على غيره.
  const beforeGuards=input.length
  state.width=0
  const gone=await turn('tap r3');expect(events(gone).some(p=>p.includes('لم يعد ظاهراً'))).toBe(true)
  state.width=80;state.hit=false
  const covered=await turn('tap r3');expect(events(covered).some(p=>p.includes('يغطّي'))).toBe(true)
  state.hit=true;state.impostor=true
  const swapped=await turn('tap r3');expect(events(swapped).some(p=>p.includes('تغيّر ما عند المرجع r3')&&p.includes('حذف الحساب'))).toBe(true)
  const swappedFill=await turn('fill r1 hello');expect(events(swappedFill).some(p=>p.includes('لم أكتب'))).toBe(true)
  state.impostor=false
  expect(input.length).toBe(beforeGuards)
  // وما استقرّ في الحقل يُقرأ ويُقارَن: قيمةٌ سابقةٌ تجعل الناتجَ غيرَ المطلوب فيُقال ذلك بدل «كتبتُ».
  state.value='قديمٌ '
  const drift=await turn('fill r1 جديد');expect(events(drift).some(p=>p.includes('ما استقرّ ليس ما طُلب')&&p.includes('قديمٌ'))).toBe(true)
  state.value=''
  // ب5 — التسليم: تركيزٌ وإحضارٌ للمقدّمة بلا حدث كتابةٍ واحد.
  const beforeHandoff=input.length
  const ho=await turn('handoff r2')
  expect(events(ho).some(p=>p.startsWith('سلّمتُ الحقلَ «Password (فارغ)»'))).toBe(true) // ب9 — الاسمُ يقول حالةَ الحقل ولا يحمل قيمتَه
  expect(input.slice(beforeHandoff).map(e=>e.method)).toEqual(['Page.bringToFront'])
  expect(evaluated).toContain('focus')
  // ب3 — الماوس والكيبورد: تمريرٌ بعجلة الماوس في المركز، تحويمٌ فوق العنصر، مفتاحٌ بكوده، ونصٌّ بأنماطه.
  const before5=input.length
  const sc=await turn('scroll down 2');expect(events(sc).some(p=>p.startsWith('مرّرتُ down'))).toBe(true)
  expect(input.slice(before5).filter(e=>e.type==='mouseWheel').map(e=>`${e.x},${e.y}:${e.deltaY}`)).toEqual(['400,300:1200'])
  const hv=await turn('hover r3');expect(events(hv).some(p=>p.startsWith('حوّمتُ'))).toBe(true)
  expect(input.filter(e=>e.type==='mouseMoved').map(e=>`${e.x},${e.y}`)).toEqual(['10,20'])
  const ky=await turn('key Enter');expect(events(ky).some(p=>p.startsWith('ضغطتُ Enter'))).toBe(true)
  expect(input.filter(e=>e.type==='rawKeyDown').map(e=>e.windowsVirtualKeyCode)).toEqual([13])
  const bad=await turn('key F13');expect(events(bad).some(p=>p.startsWith('مفتاحٌ غيرُ مدعوم'))).toBe(true)
  // ذ٩هـ — أدواتي في المتصفّح: `find` يعثر على المرجع بالنصّ بدل قراءة الشجرة كاملة، و`console` يقرأ طرفيّة الصفحة.
  const fd=await turn('find sign');expect(events(fd).some(p=>p.includes('r3')&&p.includes('button')&&p.includes('Sign up'))).toBe(true)
  // وغيابُ المطابقة يُقال بعدد ما فُحص لا يُخترع مرجعٌ
  const fx=await turn('find زرٌّ-لا-وجودَ-له');expect(events(fx).some(p=>p.includes('لا عنصرَ يطابق'))).toBe(true)
  // والطرفيّةُ الفارغة تُقال فارغة (فكستشرٌ لا يبثّ رسائل) — لا تُخمّن من شكل الصفحة
  // ذ٩ز — طلباتُ الشبكة: الفكستشر لا يبثّ أحداثَ Network، فالفارغُ يُقال فارغاً ولا يُخترع (الإثباتُ الموجب على إيدج حقيقيّ في cdp-console-capture).
  const nw=await turn('network');expect(events(nw).some(p=>p.includes('لا طلباتِ شبكةٍ منذ الوصل'))).toBe(true)
  const cs=await turn('console');expect(events(cs).some(p=>p.includes('لا رسائلَ في طرفيّة الصفحة'))).toBe(true)
  const lk=await turn('look r1');expect(events(lk).some(p=>p.includes('Email field text')&&p.includes('font-size'))).toBe(true)
  // اللقطةُ: إطارُ browser-shot إلى اللوحة، ثم نداءُ النموذج التالي يذهب إلى نموذج الرؤية والصورةُ فيه.
  const sh=await turn('shot')
  expect(events(sh).some(p=>p.startsWith('التُقطت'))).toBe(true)
  const shots=frames.filter(f=>f.kind==='browser-shot')
  expect(shots.length).toBeGreaterThan(0)
  expect(shots.at(-1).data).toBe(PNG_1x1)
  expect(shots.at(-1).url).toBe('https://allowed.test/signup')
  const before3=requests.length
  const ask=await turn('ما الذي تراه في الصفحة؟')
  const route=frames.find(f=>f.kind==='model-route'&&f.turnId===ask&&f.vision===true)
  expect(route,'no vision route; frames:\n'+JSON.stringify(frames.filter(f=>f.turnId===ask)).slice(0,1500)).toBeDefined()
  expect(route.ref).toBe('fixture/vision')
  expect(requests.slice(before3).some(r=>r.model==='vision'&&r.hasImage)).toBe(true)
  // اللقطةُ تُستهلك مرّةً: الدورُ التالي بلا صورة يعود إلى نموذج الوكيل.
  const before4=requests.length
  const plain=await turn('وماذا بعد؟')
  expect(frames.some(f=>f.kind==='model-route'&&f.turnId===plain&&f.vision===true)).toBe(false)
  expect(requests.slice(before4).every(r=>r.model==='agent'&&!r.hasImage)).toBe(true)
 }finally{child.kill();await child.exited;await reading;await stderr;cdp.stop(true);model.stop(true);rmSync(home,{recursive:true,force:true})}
},120000)
