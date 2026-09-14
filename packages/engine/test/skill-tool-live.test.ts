import {expect,test} from 'bun:test'
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {encodeLocalJsonFrame,LocalJsonFrameDecoder} from '@abdo/transport-contracts'
import {type ExtensionCatalog} from '../src/local-extensions'

// أداةُ `skill` كما يستعملها كلود: النموذجُ يرى إعلانَ المهارات المفعَّلة في النظام (أسماءٌ وأوصاف لا أجساد)، يطلب
// «نفّذ: skill proof/proof»، فيصل جسدُ المهارة إلى سياقه في النداء التالي. والحزمةُ المعطَّلة ترفض بنصٍّ لا بانهيار،
// و`skill list` يسرد. المحرّكُ حقيقيٌّ على stdio مؤطَّر، والنموذجُ خادمٌ زائف يردّ بالسيناريو.

test('the model loads an enabled local skill by itself through the skill tool; disabled packages are refused by text',async()=>{
  const home=mkdtempSync(join(tmpdir(),'abdo-skill-tool-')),settings=join(home,'settings.json'),ext=join(home,'extensions'),directory='abcdef1234567890abcdef1234567890',folder=join(ext,'packages',directory)
  mkdirSync(folder,{recursive:true});writeFileSync(join(folder,'SKILL.md'),'---\nname: proof\ndescription: Proof skill that says SKILL-TOOL-PROOF\n---\nSKILL-TOOL-PROOF: verify measured receipts before answering.')
  const registry:ExtensionCatalog={schemaVersion:1,revision:1,packages:[{id:'proof',name:'Proof',version:'1.0.0',description:'Local proof',enabled:true,directory,skills:[{id:'proof',name:'proof',description:'Proof skill that says SKILL-TOOL-PROOF',file:'SKILL.md'}],mcpServers:[]}]}
  const save=()=>writeFileSync(join(ext,'registry.json'),JSON.stringify(registry));save()
  const requests:any[]=[]
  // السيناريو: النداءُ الأوّل لكلّ دورٍ يطلب الأداة؛ ما بعده «Ready.».
  let script:string[]=[]
  const reply=()=>script.shift()??'Ready.'
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){const body=await request.json() as any;requests.push(body);const content=reply();if(body.stream)return new Response(`data: ${JSON.stringify({choices:[{delta:{content},finish_reason:null}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});return Response.json({choices:[{message:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}})
  const initial={language:'en',mode:'read-only',chatModel:'local-proof/model',agentModel:'local-proof/model',modelRole:'agent',customProviders:[{id:'local-proof',label:'Local proof',baseUrl:`http://127.0.0.1:${server.port}/v1`,vaultKey:'',local:true,models:['model']}]}
  writeFileSync(settings,JSON.stringify(initial))
  const child=Bun.spawn([process.execPath,'packages/engine/src/cli.ts','serve'],{cwd:resolve(import.meta.dir,'../../..'),env:{...process.env,ABDO_CODE_SETTINGS:settings,ABDO_CODE_STATE_DIR:join(home,'state'),ABDO_SHELL_TOKEN:'skill-test',ABDO_FRAMED_STDIO:'1',ABDO_VAULT_HOME:home,USERPROFILE:home,HOME:home,ABDO_REQUIRE_SPRINT_PLAN:'0'},stdin:'pipe',stdout:'pipe',stderr:'pipe'})
  const stderr=new Response(child.stderr).text(),decoder=new LocalJsonFrameDecoder(),reader=child.stdout.getReader(),frames:Record<string,any>[]=[]
  let pending:Promise<ReadableStreamReadResult<Uint8Array>>|undefined
  const send=async(f:Record<string,unknown>)=>{child.stdin.write(encodeLocalJsonFrame(f));await child.stdin.flush()}
  const next=async(kind:string):Promise<Record<string,any>>=>{const deadline=Date.now()+30000;for(;;){const i=frames.findIndex(f=>f.kind===kind);if(i>=0)return frames.splice(i,1)[0]!;if(Date.now()>deadline)throw Error('Missing '+kind+': '+JSON.stringify(frames.map(f=>f.kind)));pending??=reader.read();const r=await Promise.race([pending,new Promise<undefined>(res=>setTimeout(()=>res(undefined),200))]);if(r===undefined)continue;pending=undefined;if(r.done)throw Error('engine closed');for(const f of decoder.push(r.value))frames.push(f as Record<string,any>)}}
  const allText=(r:any)=>r.messages.map((m:any)=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).join('\n')
  try{
    await send({kind:'hello',shell:'desktop',token:'skill-test'});await next('ready')
    // ١) الإعلانُ في النظام يسمّي المهارة ووصفها، لا جسدها؛ النموذجُ يطلبها؛ الجسدُ يصل النداءَ التالي.
    script=['نفّذ: skill proof/proof','Ready.']
    await send({kind:'submit',turn:{id:'t1',body:'Use your skills to review this project.'}});await next('done')
    const first=requests[0],second=requests[1]
    expect(first).toBeDefined();expect(second).toBeDefined()
    const system=first.messages.find((m:any)=>m.role==='system').content as string
    expect(system).toContain('proof/proof — Proof skill that says SKILL-TOOL-PROOF')
    expect(system).not.toContain('SKILL-TOOL-PROOF: verify')
    expect(allText(second)).toContain('SKILL-TOOL-PROOF: verify measured receipts')
    expect(allText(second)).toContain('<local-skill name="proof/proof">')
    // ٢) skill list يسرد المفعَّل
    const before=requests.length
    script=['نفّذ: skill list proof','Ready.']
    await send({kind:'submit',turn:{id:'t2',body:'List skills.'}});await next('done')
    expect(allText(requests[before+1])).toContain('- proof/proof — Proof skill')
    // ٣) الحزمةُ المعطَّلة: رفضٌ نصّيّ، ولا إعلانَ في النظام، ولا جسدَ في السياق.
    registry.packages[0]!.enabled=false;registry.revision++;save();await send({kind:'settings-get'});await next('settings')
    const mark=requests.length
    script=['نفّذ: skill proof/proof','Ready.']
    await send({kind:'submit',turn:{id:'t3',body:'Try again.'}});await next('done')
    const sys3=requests[mark].messages.find((m:any)=>m.role==='system').content as string
    expect(sys3).not.toContain('proof/proof —')
    const after=allText(requests[mark+1])
    expect(after).toContain('رُفض تحميل المهارة proof/proof')
    expect(after).not.toContain('SKILL-TOOL-PROOF: verify')
  }finally{child.kill();await child.exited;server.stop(true);await stderr;rmSync(home,{recursive:true,force:true})}
},90000)
