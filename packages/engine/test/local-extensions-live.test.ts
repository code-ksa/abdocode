import {expect,test} from 'bun:test'
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {encodeLocalJsonFrame,LocalJsonFrameDecoder} from '@abdo/transport-contracts'
import {type ExtensionCatalog} from '../src/local-extensions'

test('real engine consumes selected skills and connects, disables, rejects stale MCP commands without altering manual settings',async()=>{
  const home=mkdtempSync(join(tmpdir(),'abdo-extension-live-')),settings=join(home,'settings.json'),ext=join(home,'extensions'),directory='1234567890abcdef1234567890abcdef',folder=join(ext,'packages',directory)
  mkdirSync(folder,{recursive:true});writeFileSync(join(folder,'SKILL.md'),'---\nname: proof\n---\nEXTENSION-PROOF: verify measured receipts before answering.')
  writeFileSync(join(folder,'server.cjs'),`const rl=require('readline').createInterface({input:process.stdin});rl.on('line',line=>{const f=JSON.parse(line);if(f.id===undefined)return;let result={};if(f.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'local-proof',version:'1'}};if(f.method==='tools/list')result={tools:[{name:'ping',description:'Read-only health check',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true}}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:f.id,result})+'\\n');});`)
  const registry:ExtensionCatalog={schemaVersion:1,revision:1,packages:[{id:'proof',name:'Proof',version:'1.0.0',description:'Local proof',enabled:true,directory,skills:[{id:'proof',name:'proof',description:'Verify',file:'SKILL.md'}],mcpServers:[{id:'ping',command:[process.execPath,'${extension}/server.cjs'],secrets:[]}]}]}
  const save=()=>writeFileSync(join(ext,'registry.json'),JSON.stringify(registry));save()
  const requests:any[]=[]
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){const body=await request.json() as any;requests.push(body);if(body.stream)return new Response(`data: ${JSON.stringify({choices:[{delta:{content:'Ready.'},finish_reason:null}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});return Response.json({choices:[{message:{role:'assistant',content:'Ready.'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}})
  const initial={language:'en',mode:'read-only',chatModel:'local-proof/model',agentModel:'local-proof/model',modelRole:'chat',plugins:{mcpClient:true},customProviders:[{id:'local-proof',label:'Local proof',baseUrl:`http://127.0.0.1:${server.port}/v1`,vaultKey:'',local:true,models:['model']}],mcpServers:[{id:'manual',command:['unstarted-manual-program']}]}
  writeFileSync(settings,JSON.stringify(initial));const original=readFileSync(settings,'utf8')
  const child=Bun.spawn([process.execPath,'packages/engine/src/cli.ts','serve'],{cwd:resolve(import.meta.dir,'../../..'),env:{...process.env,ABDO_CODE_SETTINGS:settings,ABDO_CODE_STATE_DIR:join(home,'state'),ABDO_SHELL_TOKEN:'extension-test',ABDO_FRAMED_STDIO:'1',ABDO_VAULT_HOME:home,USERPROFILE:home,HOME:home,ABDO_REQUIRE_SPRINT_PLAN:'0'},stdin:'pipe',stdout:'pipe',stderr:'pipe'})
  const stderr=new Response(child.stderr).text(),decoder=new LocalJsonFrameDecoder(),reader=child.stdout.getReader(),frames:Record<string,any>[]=[]
  let pending:Promise<ReadableStreamReadResult<Uint8Array>>|undefined
  const send=async(f:Record<string,unknown>)=>{child.stdin.write(encodeLocalJsonFrame(f));await child.stdin.flush()}
  const next=async(kind:string):Promise<Record<string,any>>=>{const deadline=Date.now()+20000;for(;;){const i=frames.findIndex(f=>f.kind===kind);if(i>=0)return frames.splice(i,1)[0]!;if(Date.now()>deadline)throw Error('Missing '+kind+': '+JSON.stringify(frames).slice(-2000));pending??=reader.read();const read=await Promise.race([pending,Bun.sleep(100).then(()=>undefined)]);if(!read)continue;pending=undefined;if(read.done)throw Error('Engine exited '+(await stderr).slice(-1000));for(const frame of decoder.push(read.value))frames.push(frame as Record<string,any>);}}
  try{
    await send({kind:'hello',shell:'desktop',token:'extension-test'});const ready=await next('ready');expect(ready.extensionRegistry.packages[0].id).toBe('proof');expect(ready.extensionMcpServers).toHaveLength(1);expect(JSON.stringify(ready)).not.toContain('EXTENSION-PROOF:');
    await send({kind:'submit',turn:{id:'plain',body:'Reply ready.'}});await next('done');expect(requests.some(r=>r.messages.some((m:any)=>m.role==='system'&&m.content.includes('EXTENSION-PROOF:')))).toBe(false)
    await send({kind:'submit',turn:{id:'selected',body:'/skill proof/proof\nReply ready.'}});await next('done');expect(requests.at(-1).messages.some((m:any)=>m.role==='system'&&m.content.includes('EXTENSION-PROOF:'))).toBe(true)
    const configured=ready.extensionMcpServers[0];await send({kind:'external-connect',id:configured.id,command:configured.command,protocol:'mcp'});const connected=await next('external');expect(connected.id).toBe('ext-proof-ping');expect(connected.tools).toHaveLength(1)
    registry.packages[0]!.enabled=false;registry.revision++;save();await send({kind:'settings-get'});expect((await next('external-gone')).id).toBe('ext-proof-ping');const disabled=await next('settings');expect(disabled.extensionMcpServers).toEqual([])
    await send({kind:'external-connect',id:configured.id,command:configured.command,protocol:'mcp'});expect((await next('refused')).why).toContain('disabled')
    registry.packages[0]!.enabled=true;registry.revision++;save();await send({kind:'external-connect',id:configured.id,command:[process.execPath,'different.cjs'],protocol:'mcp'});expect((await next('refused')).why).toContain('differs')
    await send({kind:'settings-set',settings:{mcpServers:[{id:'ext-proof-ping',command:['rogue']}]}});expect((await next('refused')).why).toContain('conflicts');expect(readFileSync(settings,'utf8')).toBe(original)
  }finally{child.kill();await child.exited;server.stop(true);await stderr;rmSync(home,{recursive:true,force:true})}
},65000)
