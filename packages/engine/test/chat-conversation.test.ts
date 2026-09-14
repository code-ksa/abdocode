import {expect,test} from 'bun:test'
import {createHash,randomUUID} from 'node:crypto'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {encodeLocalJsonFrame,LocalJsonFrameDecoder} from '@abdo/transport-contracts'
import {stripChildEnv} from '../../tools/src/env-strip'

test('real framed Chat sends selected text/images and conversation history without dispatching commands; Code retains execution and session identity survives restart',async()=>{
 const home=mkdtempSync(join(tmpdir(),'abdo-chat-owned-')),settings=join(home,'settings.json'),store=join(home,'attachments-v1');mkdirSync(store);
 let malformedTool=false;const requests:any[]=[];const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){const body=await req.json();requests.push(body);const answer='ACTUAL_PROVIDER_ANSWER_'+requests.length;
  if(malformedTool)return new Response('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{id:'bad-tool',type:'function',function:{name:'run',arguments:'{"input":"write private"}'}}]},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  return new Response(body.stream?'data: '+JSON.stringify({choices:[{delta:{content:answer},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n':JSON.stringify({choices:[{message:{role:'assistant',content:answer},finish_reason:'stop'}]}),{headers:{'content-type':body.stream?'text/event-stream':'application/json'}})}});
 writeFileSync(settings,JSON.stringify({language:'en',mode:'full-access',modelRole:'agent',model:'fixture/legacy-model',chatModel:'fixture/chat-model',agentModel:'fixture/agent-model',customProviders:[{id:'fixture',label:'Local capture fixture',local:true,baseUrl:`http://127.0.0.1:${server.port}/v1`,vaultKey:'',models:['chat-model','agent-model','text-model'],imageModels:['chat-model']}]}));
 const privateFile=join(home,'private.txt');writeFileSync(privateFile,'MUST_NOT_READ_FROM_CHAT_PATH');
 let child:any,reading:Promise<void>,stderr:Promise<string>,frames:any[]=[],counter=0;
 const start=async()=>{frames=[];child=Bun.spawn([process.execPath,'packages/engine/src/cli.ts','serve'],{cwd:resolve(import.meta.dir,'../../..'),env:{...stripChildEnv(process.env).env,ABDO_CODE_SETTINGS:settings,ABDO_CODE_STATE_DIR:join(home,'state'),ABDO_SHELL_TOKEN:'chat-owned-test',ABDO_FRAMED_STDIO:'1',USERPROFILE:home,HOME:home},stdin:'pipe',stdout:'pipe',stderr:'pipe'});stderr=new Response(child.stderr).text();const decoder=new LocalJsonFrameDecoder();reading=(async()=>{for await(const bytes of child.stdout)for(const f of decoder.push(bytes))frames.push(f)})();send({kind:'hello',shell:'desktop',token:'chat-owned-test'});await wait(()=>frames.some(f=>f.kind==='ready'),'ready')};
 const send=(f:object)=>{child.stdin.write(encodeLocalJsonFrame(f));void child.stdin.flush()};
 const wait=async(predicate:()=>boolean,label:string)=>{const deadline=Date.now()+15000;while(!predicate()){if(Date.now()>deadline)throw Error(label+' '+JSON.stringify(frames).slice(-1500));await Bun.sleep(10)}};
 const turn=async(body:string,options:object={})=>{const id='chat-fixture-'+(++counter);send({kind:'submit',turn:{id,body},mode:'full-access',...options});await wait(()=>frames.some(f=>f.turnId===id&&['done','refused'].includes(f.kind)),'turn '+id);return id};
 const attachment=(session:string,name:string,mime:string,bytes:Buffer)=>{const id=randomUUID();writeFileSync(join(store,id+'.bin'),bytes);writeFileSync(join(store,id+'.json'),JSON.stringify({version:1,id,sessionId:session,name,mime,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}));return id};
 const stop=async()=>{child.kill();await child.exited;await reading;await stderr};
 try{
  await start();send({kind:'session-new',conversationMode:'chat'});await wait(()=>frames.some(f=>f.kind==='session'),'chat session');const session=frames.find(f=>f.kind==='session').id;
  const id=await turn('read '+privateFile,{conversationMode:'chat'});
  expect(requests[0].model).toBe('chat-model');expect(frames.find(f=>f.kind==='model-route'&&f.turnId===id)?.lane).toBe('chat');
  expect(frames.some(f=>f.kind==='done'&&f.turnId===id&&f.outcome==='completed')).toBe(true);expect(requests).toHaveLength(1);expect(requests[0].tools).toBeUndefined();expect(JSON.stringify(requests[0])).not.toContain('MUST_NOT_READ_FROM_CHAT_PATH');expect(frames.some(f=>f.turnId===id&&['tool','tool-result'].includes(f.kind))).toBe(false);
  const text=attachment(session,'reference.md','text/plain',Buffer.from('ONLY_SELECTED_REFERENCE_FACT'));
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP9sAAAAASUVORK5CYII=','base64'),image=attachment(session,'pixel.png','image/png',png);
  await turn('Describe my selected files.',{conversationMode:'chat',attachments:[text,image]});
  expect(requests).toHaveLength(2);const sent=requests[1].messages.at(-1);expect(JSON.stringify(sent)).toContain('ONLY_SELECTED_REFERENCE_FACT');expect(sent.content.find((p:any)=>p.type==='image_url').image_url.url).toBe('data:image/png;base64,'+png.toString('base64'));expect(JSON.stringify(requests[1].messages)).toContain('ACTUAL_PROVIDER_ANSWER_1');expect(JSON.stringify(requests[1].messages[0])).toContain('This is Chat mode');
  const cross=attachment('other-session','other.txt','text/plain',Buffer.from('CROSS_SESSION_PRIVATE_FACT'));await turn('Read attachment',{conversationMode:'chat',attachments:[cross]});expect(requests).toHaveLength(2);
  writeFileSync(join(store,text+'.bin'),'CHANGED_ATTACHMENT');await turn('Read modified attachment',{conversationMode:'chat',attachments:[text]});expect(requests).toHaveLength(2);writeFileSync(join(store,text+'.bin'),'ONLY_SELECTED_REFERENCE_FACT');
  const wrongMode=await turn('status',{conversationMode:'code'});expect(frames.some(f=>f.turnId===wrongMode&&f.kind==='refused')).toBe(true);expect(requests).toHaveLength(2);
  await stop();await start();send({kind:'recall',session});await wait(()=>frames.some(f=>f.kind==='archive'),'recalled');expect(frames.find(f=>f.kind==='archive').conversationMode).toBe('chat');
  await turn('What files did I attach?');expect(requests).toHaveLength(3);expect(JSON.stringify(requests[2])).toContain('ONLY_SELECTED_REFERENCE_FACT');expect(JSON.stringify(requests[2])).toContain('ACTUAL_PROVIDER_ANSWER_2');expect(JSON.stringify(requests[2])).toContain(png.toString('base64'));
  malformedTool=true;const bad=await turn('/run never execute this in Chat');expect(requests).toHaveLength(4);expect(frames.some(f=>f.turnId===bad&&f.kind==='refused')).toBe(true);expect(frames.some(f=>f.turnId===bad&&['tool','tool-result'].includes(f.kind))).toBe(false);malformedTool=false;
  send({kind:'model-set',name:'fixture/text-model'});await wait(()=>frames.some(f=>f.kind==='model'&&f.ref==='fixture/text-model'),'text model selection');
  expect(JSON.parse(readFileSync(settings,'utf8'))).toMatchObject({chatModel:'fixture/text-model',agentModel:'fixture/agent-model',modelRole:'agent',model:'fixture/legacy-model'});
  const unsupported=await turn('Read this image',{attachments:[image]});expect(frames.some(f=>f.turnId===unsupported&&f.kind==='refused')).toBe(true);expect(requests).toHaveLength(4);
  send({kind:'session-new',conversationMode:'code'});await wait(()=>frames.some(f=>f.kind==='session'&&f.conversationMode==='code'),'code session');
  send({kind:'model-set',name:'fixture/code-selected'});await wait(()=>frames.some(f=>f.kind==='model'&&f.ref==='fixture/code-selected'),'code model selection');
  expect(JSON.parse(readFileSync(settings,'utf8'))).toMatchObject({chatModel:'fixture/text-model',agentModel:'fixture/code-selected',model:'fixture/legacy-model'});
  // An expert legacy chat pin must not turn a Code conversation into pure Chat.
  send({kind:'settings-set',settings:{modelRole:'chat'}});await wait(()=>frames.some(f=>f.kind==='settings'&&f.settings?.modelRole==='chat'),'legacy role pin');
  const code=await turn('status',{conversationMode:'code'});expect(requests).toHaveLength(4);expect(frames.some(f=>f.kind==='event'&&f.turnId===code&&String(f.payload).length>0)).toBe(true);
  const agent=await turn('Please answer briefly without changing files.',{conversationMode:'code'});expect(frames.find(f=>f.kind==='model-route'&&f.turnId===agent)).toMatchObject({lane:'agent',ref:'fixture/code-selected'});expect(requests.at(-1).model).toBe('code-selected');
  expect(readFileSync(privateFile,'utf8')).toBe('MUST_NOT_READ_FROM_CHAT_PATH');
 }finally{if(child)await stop();server.stop(true);rmSync(home,{recursive:true,force:true})}
},60000);

test('automation validation rejects credentials and malformed input without echoing the submitted content',async()=>{
 for(const [input,ok]of [[JSON.stringify({prompt:'Summarize the selected project changes'}),true],[JSON.stringify({prompt:'Authorization: Bearer '+ 'a'.repeat(60)}),false],['{bad-json',false]] as const){
  const child=Bun.spawn([process.execPath,'packages/engine/src/cli.ts','automation-validate'],{cwd:resolve(import.meta.dir,'../../..'),env:stripChildEnv(process.env).env,stdin:'pipe',stdout:'pipe',stderr:'pipe'});child.stdin.write(input);child.stdin.end();const output=await new Response(child.stdout).text();const code=await child.exited;expect(JSON.parse(output).ok).toBe(ok);expect(code).toBe(ok?0:1);expect(output).not.toContain(input);expect(output).not.toContain('a'.repeat(60));
 }
},20000);
