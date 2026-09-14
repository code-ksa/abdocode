import {expect,test} from 'bun:test'
import {createHash,randomUUID} from 'node:crypto'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {validateShellFrame} from '@abdo/transport-contracts'
import {encodeChatRequest} from '@abdo/model-gateway'
import {buildChatRequest} from '@abdo/harness'
import {openServeJournal} from '@abdo/engine-host'
import {Providers} from '@abdo/providers'
import {acceptsImages,resolveAttachments,CHAT_SYSTEM} from '../src/conversation-attachments'
import {mountChatWork} from '../../desktop/ui/native-chat-work.js'

test('attachment transport accepts only explicit bounded IDs and immutable Chat/Code vocabulary',()=>{
 const id=randomUUID(),base={kind:'submit',turn:{id:'turn',body:'hello'}};
 expect(validateShellFrame({...base,conversationMode:'chat',attachments:[id]}).ok).toBe(true);
 expect(validateShellFrame({...base,conversationMode:'code',attachments:[]}).ok).toBe(true);
 for(const attachments of [['../private.txt'],['C:\\private.txt'],[id,id],Array.from({length:5},()=>randomUUID())])expect(validateShellFrame({...base,attachments}).ok).toBe(false);
 expect(validateShellFrame({...base,conversationMode:'work'}).ok).toBe(false);
});

test('selected snapshots reject path traversal, secret content, wrong owner, forged MIME and oversized content',()=>{
 const root=mkdtempSync(join(tmpdir(),'abdo-attachment-bounds-')),store=join(root,'attachments-v1'),settings=join(root,'settings.json');mkdirSync(store);
 const save=(name:string,content:Buffer,mime='text/plain',sessionId='session')=>{const id=randomUUID();writeFileSync(join(store,id+'.bin'),content);writeFileSync(join(store,id+'.json'),JSON.stringify({version:1,id,name,sessionId,mime,bytes:content.length,sha256:createHash('sha256').update(content).digest('hex')}));return id};
 try{
  const valid=save('document.md',Buffer.from('A selected document.'));
  expect(resolveAttachments(settings,'session',[valid]).text).toContain('A selected document.');
  expect(()=>resolveAttachments(settings,'session',['../settings'])).toThrow('Invalid attachment reference');
  expect(()=>resolveAttachments(settings,'other',[valid])).toThrow();
  expect(()=>resolveAttachments(settings,'session',[save('../private.txt',Buffer.from('x'))])).toThrow();
  expect(()=>resolveAttachments(settings,'session',[save('false.png',Buffer.from('not an image'))])).toThrow();
  expect(()=>resolveAttachments(settings,'session',[save('token.txt',Buffer.from('Authorization: Bearer '+'a'.repeat(60)))])).toThrow();
  expect(()=>resolveAttachments(settings,'session',[save('large.txt',Buffer.alloc(256*1024+1,65))])).toThrow();
  expect(()=>resolveAttachments(settings,'session',[save('binary.bin',Buffer.from([0,1,2]))])).toThrow();
 }finally{rmSync(root,{recursive:true,force:true})}
});

test('owned image codecs send bytes through all supported wires; pure Chat omits agent instructions and tool declarations',()=>{
 const image={mime:'image/png' as const,data:'YWJj'},messages=[{role:'user' as const,content:'Describe',images:[image]}];
 const encode=(wire:any)=>JSON.parse(encodeChatRequest({wire,model:'test',messages,stream:false}).body);
 expect(encode('native-ollama').messages[0].images).toEqual(['YWJj']);
 expect(encode('openai-compatible').messages[0].content).toEqual([{type:'text',text:'Describe'},{type:'image_url',image_url:{url:'data:image/png;base64,YWJj'}}]);
 expect(encode('anthropic').messages[0].content).toContainEqual({type:'image',source:{type:'base64',media_type:'image/png',data:'YWJj'}});
 expect(()=>encodeChatRequest({wire:'native-ollama',model:'test',stream:false,messages:[{role:'user',content:'bad',images:[{mime:'image/png',data:'https://private.example/a.png'}]}]})).toThrow();
 const body=JSON.parse(buildChatRequest({wire:'openai-compatible',harness:'qwen-style',model:'test',system:CHAT_SYSTEM,messages,stream:false,conversationOnly:true}).body);
 expect(body.messages[0].content.trim()).toBe(CHAT_SYSTEM);expect(body.tools).toBeUndefined();expect(body.stop).toBeUndefined();
 expect(()=>buildChatRequest({wire:'openai-compatible',harness:'qwen-style',model:'test',messages,stream:false,conversationOnly:true,nativeTools:true})).toThrow('cannot advertise tools');
});

test('image capability uses declared cloud input or an actual local model show receipt, never model-name guessing',async()=>{
 const calls:any[]=[];const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){const data:any=await req.json();calls.push(data);return Response.json({capabilities:data.model==='vision-installed'?['completion','vision']:['completion','tools']})}});
 try{
  const local={...Providers.provider('ollama')!,baseUrl:`http://127.0.0.1:${server.port}`};
  expect(await acceptsImages(local,'vision-installed')).toBe(true);expect(await acceptsImages(local,'named-vision-but-unverified')).toBe(false);expect(calls).toEqual([{model:'vision-installed'},{model:'named-vision-but-unverified'}]);
  expect(await acceptsImages(Providers.provider('deepseek')!,'deepseek-v4-flash')).toBe(false);
  expect(await acceptsImages(Providers.provider('openai')!,'gpt-4o')).toBe(true);
 }finally{server.stop(true)}
});

test('session mode and attachment identity survive journal reopen and cannot be rebound',async()=>{
 const root=mkdtempSync(join(tmpdir(),'abdo-chat-journal-')),database=join(root,'events.sqlite');let journal=await openServeJournal({database});
 try{
  await journal.openSession('chat','chat');await journal.admit({turnId:'t',body:'hello',sessionId:'chat',attachments:['selected-id']});journal.close();journal=await openServeJournal({database});
  expect(journal.snapshot().sessionModes.get('chat')).toBe('chat');expect(journal.snapshot().admissions.get('t')?.attachments).toEqual(['selected-id']);
  await expect(journal.openSession('chat','code')).rejects.toThrow('serve_session_mode_conflict');
  await expect(journal.admit({turnId:'t',body:'hello',sessionId:'chat',attachments:[]})).rejects.toThrow('serve_turn_identity_conflict');
  await journal.openSession('legacy');expect(journal.snapshot().sessionModes.get('legacy')).toBe('code');
 }finally{journal.close();rmSync(root,{recursive:true,force:true})}
});

test('actual attachment controls bind drafts to session and admission; mode changes wait for engine receipt',async()=>{
 const original=globalThis.document,originalWindow=globalThis.window,sent:any[]=[],modes:string[]=[],picked=randomUUID();
 const node=():any=>({value:'',children:[],dataset:{},classList:{remove(){}},append(...items:any[]){this.children.push(...items)},replaceChildren(...items:any[]){this.children=items},setAttribute(){},before(){},remove(){},addEventListener(){},removeEventListener(){}});
 (globalThis as any).window=new EventTarget();const prompt=node();(globalThis as any).document={createElement:node,getElementById:(id:string)=>id==='prompt'?prompt:node()};
 const ui=mountChatWork({bridge:{snapshot:()=>({working:false}),send:(frame:any)=>{sent.push(frame)},invoke:async()=>[{id:picked,name:'selected.txt',mime:'text/plain',bytes:4}]},setShellMode:(mode:string)=>modes.push(mode)});
 try{
  expect(()=>ui.prepareSubmission()).toThrow();ui.frame({kind:'ready',sessionId:'first',conversationMode:'code'});await ui.choose();expect(ui.prepareSubmission().attachments).toEqual([picked]);
  ui.submitted({id:'accepted'},{attachments:[picked]});ui.frame({kind:'admission',turnId:'unrelated'});expect(ui.prepareSubmission().attachments).toEqual([picked]);
  ui.frame({kind:'refused',turnId:'accepted'});expect(ui.prepareSubmission().attachments).toEqual([picked]);
  prompt.value='Unsent Code draft';ui.submitted({id:'internal',body:'status'},{});const switched=ui.setMode('chat');expect(ui.mode()).toBe('code');expect(sent.at(-1)).toEqual({kind:'session-new',conversationMode:'chat'});ui.frame({kind:'session',id:'second',conversationMode:'chat'});await switched;expect(prompt.value).toBe('');
  prompt.value='Chat draft';ui.frame({kind:'ready',sessionId:'second',conversationMode:'chat'});expect(prompt.value).toBe('Chat draft');expect(ui.prepareSubmission()).toEqual({conversationMode:'chat',attachments:[]});ui.frame({kind:'archive',session:'first',conversationMode:'code'});expect(ui.prepareSubmission().attachments).toEqual([picked]);expect(prompt.value).toBe('Unsent Code draft');
  ui.submitted({id:'accepted-again'},{attachments:[picked]});ui.frame({kind:'admission',turnId:'accepted-again'});expect(ui.prepareSubmission().attachments).toEqual([]);expect(modes).toContain('chat');
 }finally{ui.dispose();globalThis.document=original;globalThis.window=originalWindow}
});
