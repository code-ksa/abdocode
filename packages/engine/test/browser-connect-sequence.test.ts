import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { tool } from "../../tools/src/catalogue"
import { stripChildEnv } from "../../tools/src/env-strip"
import { Turns } from "../src/shells/turns"
import { mountWorkspaceSettings } from "../../desktop/ui/native-workspace-settings.js"

// Only the DOM host and native process-status dependency are fixtures. The actual
// settings module consumes unmodified frames from a real engine serve process.
function node(): any {
  const n:any={children:[],dataset:{},isConnected:true,value:"",_text:"",append(...items:any[]){this.children.push(...items)},replaceChildren(...items:any[]){this.children=items},querySelector(){return null},setAttribute(){}};
  Object.defineProperty(n,"textContent",{get(){return n._text+n.children.map((child:any)=>child.textContent||"").join(" ")},set(value){n._text=String(value)}});
  return n;
}

test("real serve admission/event/done connects, opens, reads, and settles failed connection in the actual settings module", async () => {
  const home=mkdtempSync(join(tmpdir(),"abdo-browser-connect-")),settings=join(home,"engine-settings.json"),originalDocument=globalThis.document;
  let rejectAttach=false,currentUrl="about:blank",heldDone:any,holdConnectionDone=true,working=false,counter=0;
  const frames:any[]=[],submitted:{id:string;body:string}[]=[],navigated:string[]=[],pageHost=node();
  const server=Bun.serve<{unused?:boolean}>({hostname:"127.0.0.1",port:0,
    fetch(request,server){const path=new URL(request.url).pathname;
      if(path==='/json')return Response.json(rejectAttach?[]:[{id:'main',type:'page',url:currentUrl,webSocketDebuggerUrl:`ws://127.0.0.1:${server.port}/devtools/page/main`}]);
      if(path==='/json/version')return Response.json({webSocketDebuggerUrl:`ws://127.0.0.1:${server.port}/devtools/browser/01234567-89ab-cdef-0123-456789abcdef`});
      if(server.upgrade(request,{data:{}}))return;
      return new Response('missing',{status:404});
    },websocket:{message(socket,message){const f=JSON.parse(String(message));let result:any={};
      if(f.method==='Target.setAutoAttach'&&!f.sessionId)socket.send(JSON.stringify({method:'Target.attachedToTarget',params:{sessionId:'main-session',targetInfo:{targetId:'main',type:'page'}}}));
      if(f.method==='Runtime.evaluate'){const expression=f.params.expression;result={result:{value:expression==='document.title'?'Fixture browser':expression==='location.href'?currentUrl:JSON.stringify([{ref:'r1',role:'heading',name:'REAL_SERVE_BROWSER_PAGE_PROOF'}])}};}
      if(f.method==='Page.navigate'){currentUrl=f.params.url;navigated.push(currentUrl);result={frameId:'main'};}
      socket.send(JSON.stringify({id:f.id,result,...(f.sessionId?{sessionId:f.sessionId}:{})}));
    }}});
  const port=server.port!;
  writeFileSync(settings,JSON.stringify({language:'en',mode:'full-access',computerUseEnabled:true}));
  writeFileSync(join(home,'workspace-v1.json'),JSON.stringify({preferences:{browserDefaultPermission:'allow',blockedSites:[]}}));
  writeFileSync(join(home,'browser-control-lease.json'),JSON.stringify({version:1,port,pid:process.pid,ownerPid:process.pid,endpoint:`ws://127.0.0.1:${port}/devtools/browser/01234567-89ab-cdef-0123-456789abcdef`}));
  const child=Bun.spawn([process.execPath,'packages/engine/src/cli.ts','serve'],{cwd:resolve(import.meta.dir,'../../..'),env:{...stripChildEnv(process.env).env,ABDO_CODE_SETTINGS:settings,ABDO_CODE_STATE_DIR:join(home,'state'),ABDO_SHELL_TOKEN:'browser-connect-test',ABDO_FRAMED_STDIO:'1',ABDO_DESKTOP_OWNER_PID:String(process.pid),USERPROFILE:home,HOME:home},stdin:'pipe',stdout:'pipe',stderr:'pipe'});
  const stderr=new Response(child.stderr).text(),decoder=new LocalJsonFrameDecoder();
  const send=(frame:object)=>{child.stdin.write(encodeLocalJsonFrame(frame));void child.stdin.flush()};
  let outbox:any={kind:'idle'},mounted:any;
  const submit=(body:string)=>{const turn={id:`browser-test-${++counter}`,body};const admitted=Turns.submit(outbox,turn);if(!admitted.ok)throw Error(admitted.why);outbox=admitted.state;working=true;submitted.push(turn);send({kind:'submit',turn,mode:'full-access'});return turn.id};
  const api:any={L:(en:string)=>en,state:{metadata:{projects:[],preferences:{}}},bridge:{snapshot:()=>({working,settings:{}}),invoke:async(command:string)=>command==='workspace_controls_get'?{profiles:[],folders:[]}:{ownedProcessRunning:true,endpointReady:true,port},submit}};
  Object.assign(globalThis,{document:{createElement:()=>node(),querySelector:(selector:string)=>selector==='[data-panel="nss-chrome"]'?pageHost:null,addEventListener(){},removeEventListener(){}}});
  mounted=mountWorkspaceSettings(api);
  const deliver=async(frame:any)=>{
    if(['done','failed','unresolved'].includes(frame.kind)&&outbox.kind==='offering'&&outbox.turn.id===frame.turnId){outbox={kind:'idle'};working=false;}
    // The native shell forwards frames after its outbox settles, in a microtask.
    await new Promise<void>(done=>queueMicrotask(()=>{mounted.frame(frame);done()}));
  };
  const reading=(async()=>{for await(const bytes of child.stdout)for(const raw of decoder.push(bytes)){const frame:any=raw;frames.push(frame);if(holdConnectionDone&&frame.kind==='done'&&frame.turnId===submitted[0]?.id){heldDone=frame;continue;}await deliver(frame);}})();
  const wait=async(predicate:()=>boolean,label:string)=>{const deadline=Date.now()+12000;while(!predicate()){if(Date.now()>deadline)throw Error(label+'; frames='+JSON.stringify(frames).slice(-1800));await Bun.sleep(10)}};
  try{
    send({kind:'hello',shell:'desktop',token:'browser-connect-test'});
    await wait(()=>frames.some(f=>f.kind==='ready'),'ready');
    await mounted.openAndConnect('https://allowed.test/intended');
    await wait(()=>!!heldDone,'direct surface done');
    const connectionTurn=submitted[0]!.id;
    expect(frames.some(f=>f.kind==='admission'&&f.turnId===connectionTurn)).toBe(true);
    expect(frames.some(f=>f.kind==='event'&&f.turnId===connectionTurn&&String(f.payload).startsWith('وُصل السطح على المنفذ '+port))).toBe(true);
    expect(frames.some(f=>f.kind==='tool-result'&&f.turnId===connectionTurn)).toBe(false);
    expect(submitted.map(t=>t.body)).toEqual([`surface ${port}`]);
    expect(pageHost.textContent).toContain('Waiting for engine receipt');
    mounted.frame({kind:'admission',turnId:'unrelated',decision:'accepted'});
    mounted.frame({kind:'event',turnId:'unrelated',payload:'وُصل السطح على المنفذ '+port});
    mounted.frame({kind:'done',turnId:'unrelated'});await Bun.sleep(0);
    expect(submitted).toHaveLength(1);
    // A nonterminal tool receipt also cannot advance the occupied outbox.
    mounted.frame({kind:'tool-result',turnId:connectionTurn,cmd:`surface ${port}`,output:'وُصل السطح على المنفذ '+port});
    expect(submitted).toHaveLength(1);
    holdConnectionDone=false;await deliver(heldDone);
    await wait(()=>submitted.length===2&&frames.some(f=>f.kind==='done'&&f.turnId===submitted[1]?.id),'open completion');
    expect(submitted[1]!.body).toBe('open https://allowed.test/intended');
    expect(tool(submitted[1]!.body.split(/\s/u)[0]!)?.runner).toBe('surface');
    expect(navigated).toEqual(['https://allowed.test/intended']);
    expect(pageHost.textContent).toContain('Connected — verified by engine');
    await wait(()=>!working,'open settled');submit('page');
    await wait(()=>frames.some(f=>f.kind==='event'&&f.turnId===submitted[2]?.id&&String(f.payload).includes('REAL_SERVE_BROWSER_PAGE_PROOF')),'page actual output');
    await wait(()=>!working,'page settled');
    rejectAttach=true;await mounted.openAndConnect('https://allowed.test/must-not-open');
    await wait(()=>frames.some(f=>f.kind==='done'&&f.turnId===submitted[3]?.id),'failed surface settled');
    await wait(()=>pageHost.textContent.includes('Connection failed'),'failed UI state');
    expect(submitted).toHaveLength(4);
    expect(navigated).toEqual(['https://allowed.test/intended']);
    expect(pageHost.textContent).not.toContain('Waiting for engine receipt');
  }finally{mounted.dispose();child.kill();await child.exited;await reading;await stderr;server.stop(true);Object.assign(globalThis,{document:originalDocument});rmSync(home,{recursive:true,force:true});}
},30000);

test("connection correlation rejects refused submission, terminal failures and checkpointed receipts without replaying navigation", async () => {
  const originalDocument=globalThis.document,pageHost=node();let nextId:string|null='connection-1',working=false;
  const submitted:string[]=[];
  Object.assign(globalThis,{document:{createElement:()=>node(),querySelector:(selector:string)=>selector==='[data-panel="nss-chrome"]'?pageHost:null,addEventListener(){},removeEventListener(){}}});
  const api:any={L:(en:string)=>en,state:{metadata:{projects:[],preferences:{}}},bridge:{snapshot:()=>({working,settings:{}}),invoke:async(command:string)=>command==='workspace_controls_get'?{profiles:[],folders:[]}:{ownedProcessRunning:true,endpointReady:true,port:9366},submit:(body:string)=>{submitted.push(body);return nextId}}};
  const mounted=mountWorkspaceSettings(api);
  try{
    working=true;await mounted.openAndConnect('https://allowed.test/busy');expect(submitted).toHaveLength(0);
    working=false;nextId=null;await mounted.openAndConnect('https://allowed.test/refused');
    expect(pageHost.textContent).toContain('The browser connection request was not accepted.');
    mounted.frame({kind:'admission',turnId:'old-turn'});mounted.frame({kind:'event',turnId:'old-turn',payload:'وُصل السطح على المنفذ 9366'});mounted.frame({kind:'done',turnId:'old-turn',outcome:'completed'});await Bun.sleep(0);
    expect(submitted).toHaveLength(1);
    for(const kind of ['refused','unresolved','interrupted','checkpointed','engine-died']){
      nextId='connection-'+kind;await mounted.openAndConnect('https://allowed.test/'+kind);
      mounted.frame({kind:'event',turnId:nextId,payload:'وُصل السطح على المنفذ 9366'});
      mounted.frame(kind==='checkpointed'?{kind:'done',turnId:nextId,outcome:'checkpointed'}:{kind,turnId:nextId});
      mounted.frame({kind:'done',turnId:nextId,outcome:'completed'});await Bun.sleep(0);
      expect(pageHost.textContent).not.toContain('Waiting for engine receipt');
      expect(submitted.some(body=>body.startsWith('open '))).toBe(false);
    }
  }finally{mounted.dispose();Object.assign(globalThis,{document:originalDocument});}
});

test("native submit returns its real turn ID or busy null and a rejected send settles only that same outbox", async () => {
  const html=readFileSync(resolve(import.meta.dir,'../../desktop/ui/index.html'),'utf8');
  const source=html.slice(html.indexOf('    const submitBody = ('),html.indexOf('    const reofferPending ='));
  expect(source).toContain('return turn.id');
  const emitted:any[]=[],rejects:((error:Error)=>void)[]=[];
  const create=new Function('Turns','sendFrame','window','el','notice','uiText',`
    let outbox={kind:'idle'},turnCounter=0,lastPrompt,working,trajStore,pendingSubmissionEnvelope;
    const mode='full-access',Trajectory=null,renderStatus=()=>{},addBlock=()=>{},openAnswerBlock=()=>{},trajTouch=()=>{};
    const settle=(id)=>{if(outbox.kind==='offering'&&outbox.turn.id===id){outbox={kind:'idle'};working=undefined;}};
    ${source}
    return {submit:submitBody,settle,snapshot:()=>({outbox,working})};
  `);
  const sent:any[]=[];
  const bridge=create(Turns,(frame:any)=>{sent.push(frame);return new Promise((_resolve,reject)=>rejects.push(reject))},{AbdoDesktopShell:{api:{},submitted(){},frame:(frame:any)=>emitted.push(frame)}},()=>({disabled:false}),()=>{},(en:string)=>en);
  const first=bridge.submit('surface 9366');expect(typeof first).toBe('string');
  expect(sent[0]).toMatchObject({conversationMode:'code',attachments:[],turn:{id:first}});
  expect(bridge.submit('must-not-send')).toBeNull();expect(rejects).toHaveLength(1);
  rejects[0]!(new Error('private transport detail'));await Bun.sleep(0);
  expect(bridge.snapshot().outbox.kind).toBe('idle');expect(bridge.snapshot().working).toBeUndefined();
  expect(emitted).toEqual([{kind:'refused',turnId:first,why:'The request could not reach the engine. Reconnect and try again.'}]);
  const previous=bridge.submit('surface 9366');bridge.settle(previous);
  const current=bridge.submit('page');rejects[1]!(new Error('late failure'));await Bun.sleep(0);
  expect(bridge.snapshot().outbox.turn.id).toBe(current);expect(emitted).toHaveLength(1);
  bridge.settle(current);
});
