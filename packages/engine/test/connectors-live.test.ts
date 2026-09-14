import {expect,test} from 'bun:test'
import {createHash} from 'node:crypto'
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {encodeLocalJsonFrame,LocalJsonFrameDecoder} from '@abdo/transport-contracts'

// ص1 — الموصّلات على المحرّك الحقيقيّ (stdio مؤطَّر) وخزنةٍ حقيقية في مجلّدٍ مؤقّت، وخادمٍ زائف واحد يلعب دورَ خادم التفويض
// (اكتشاف RFC 9728/8414، تسجيلٌ ديناميكيّ، PKCE يُفحص) ودورَ خادم MCP البعيد (Bearer). الرقصة: connector-list ⇦ connector-auth
// ⇦ connector-open (الرابط) ⇦ «المتصفّح» يعيد التوجيه إلى loopback ⇦ connector-status linked ⇦ الإعداداتُ تحمل خادم الموصّل
// بمنحٍ بلا قيم ⇦ external-connect يشغّل mcp-remote طفلاً حقيقيّاً فتصل أدواتُ الخادم البعيد ⇦ connector-forget يمسح ويفصل.

test('connector-auth links Linear via DCR+PKCE, stores tokens in the vault, and external-connect reaches the remote tools through mcp-remote',async()=>{
  const home=mkdtempSync(join(tmpdir(),'abdo-connectors-live-')),settings=join(home,'settings.json')
  const issued:{challenge:string;code:string}[]=[];let currentToken='none';const remoteSeen:string[]=[]
  const fake=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
    const url=new URL(request.url);const origin=`http://127.0.0.1:${fake.port}`
    if(url.pathname==='/.well-known/oauth-protected-resource/mcp')return Response.json({resource:`${origin}/mcp`,authorization_servers:[origin]})
    if(url.pathname==='/.well-known/oauth-authorization-server')return Response.json({issuer:origin,authorization_endpoint:`${origin}/authorize`,token_endpoint:`${origin}/token`,registration_endpoint:`${origin}/register`,code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none']})
    if(url.pathname==='/register')return Response.json({client_id:'dyn-linear'},{status:201})
    if(url.pathname==='/token'){const form=new URLSearchParams(await request.text());if(form.get('grant_type')==='refresh_token'){currentToken='access-refreshed';return Response.json({access_token:'access-refreshed',token_type:'Bearer',expires_in:60})}
      const rec=issued.find(i=>i.code===form.get('code'));if(!rec||createHash('sha256').update(form.get('code_verifier')??'').digest('base64url')!==rec.challenge)return Response.json({error:'invalid_grant'},{status:400})
      currentToken='access-live';return Response.json({access_token:'access-live',refresh_token:'refresh-live',token_type:'Bearer',expires_in:3600})}
    if(url.pathname==='/mcp'){const body=await request.json() as {id?:number;method:string};remoteSeen.push(body.method)
      if(request.headers.get('authorization')!==`Bearer ${currentToken}`)return Response.json({jsonrpc:'2.0',id:body.id??null,error:{code:-32001,message:'missing_token'}},{status:401})
      if(body.method==='initialize')return Response.json({jsonrpc:'2.0',id:body.id,result:{protocolVersion:'2025-11-25',serverInfo:{name:'fake-linear',version:'1'},capabilities:{tools:{}}}})
      if(body.method==='notifications/initialized')return new Response(null,{status:202})
      if(body.method==='tools/list')return Response.json({jsonrpc:'2.0',id:body.id,result:{tools:[{name:'issues',description:'list issues',inputSchema:{type:'object',properties:{}}}]}})
      return Response.json({jsonrpc:'2.0',id:body.id,error:{code:-32601,message:'nope'}})}
    return new Response('nf',{status:404})}})
  const initial={language:'ar',mode:'read-only',chatModel:'local-proof/model',agentModel:'local-proof/model',modelRole:'chat',plugins:{mcpClient:true},customProviders:[{id:'local-proof',label:'Local proof',baseUrl:'http://127.0.0.1:9/v1',vaultKey:'',local:true,models:['model']}]}
  writeFileSync(settings,JSON.stringify(initial))
  const child=Bun.spawn([process.execPath,'packages/engine/src/cli.ts','serve'],{cwd:resolve(import.meta.dir,'../../..'),env:{...process.env,ABDO_CODE_SETTINGS:settings,ABDO_CODE_STATE_DIR:join(home,'state'),ABDO_SHELL_TOKEN:'connectors-test',ABDO_FRAMED_STDIO:'1',ABDO_VAULT_HOME:home,USERPROFILE:home,HOME:home,ABDO_REQUIRE_SPRINT_PLAN:'0',ABDO_CONNECTOR_RESOURCE_OVERRIDE:`linear=http://127.0.0.1:${fake.port}/mcp`},stdin:'pipe',stdout:'pipe',stderr:'pipe'})
  const stderr=new Response(child.stderr).text(),decoder=new LocalJsonFrameDecoder(),reader=child.stdout.getReader(),frames:Record<string,any>[]=[]
  let pending:Promise<ReadableStreamReadResult<Uint8Array>>|undefined
  const send=async(f:Record<string,unknown>)=>{child.stdin.write(encodeLocalJsonFrame(f));await child.stdin.flush()}
  const next=async(kind:string,where?:(f:Record<string,any>)=>boolean):Promise<Record<string,any>>=>{const deadline=Date.now()+60000;for(;;){const i=frames.findIndex(f=>f.kind===kind&&(where===undefined||where(f)));if(i>=0)return frames.splice(i,1)[0]!;if(Date.now()>deadline)throw Error('Missing '+kind+': '+JSON.stringify(frames.map(f=>f.kind+(f.state?':'+f.state:'')+(f.why?':'+f.why:''))));pending??=reader.read();const r=await Promise.race([pending,new Promise<undefined>(res=>setTimeout(()=>res(undefined),200))]);if(r===undefined)continue;pending=undefined;if(r.done)throw Error('engine closed: '+await stderr);for(const f of decoder.push(r.value))frames.push(f as Record<string,any>)}}
  try{
    await send({kind:'hello',shell:'desktop',token:'connectors-test'});await next('ready')
    await send({kind:'connector-list'});const list=await next('connectors')
    const linear=list.entries.find((e:any)=>e.id==='linear');expect(linear).toMatchObject({linked:false,clientReady:true,connected:false,serverId:'connector-linear'})
    expect(JSON.stringify(list)).not.toContain('access-')
    // الربط: الرابطُ يُبثّ للقشرة؛ «المتصفّح» هنا يصدر رمزاً مربوطاً بالتحدّي ويعيد التوجيه إلى loopback
    await send({kind:'connector-auth',id:'linear'})
    await next('connector-status',f=>f.id==='linear'&&f.state==='authorizing')
    const open=await next('connector-open');const u=new URL(open.url)
    expect(u.origin).toBe(`http://127.0.0.1:${fake.port}`);expect(u.searchParams.get('client_id')).toBe('dyn-linear');expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    const redirect=new URL(u.searchParams.get('redirect_uri')!);expect(redirect.hostname).toBe('127.0.0.1')
    issued.push({challenge:u.searchParams.get('code_challenge')!,code:'code-1'});redirect.searchParams.set('code','code-1');redirect.searchParams.set('state',u.searchParams.get('state')!)
    expect((await fetch(redirect.toString())).status).toBe(200)
    const linked=await next('connector-status',f=>f.id==='linear'&&(f.state==='linked'||f.state==='error'));expect(linked.state+': '+(linked.detail||'')).toBe('linked: مربوطٌ — الخادم connector-linear يُوصَل تلقائياً عند فتح الجلسة')
    const saved=JSON.parse(readFileSync(settings,'utf8'));const server=saved.mcpServers.find((s:any)=>s.id==='connector-linear')
    expect(server.autoConnect).toBe(true);expect(server.command.slice(-2)).toEqual(['mcp-remote',`http://127.0.0.1:${fake.port}/mcp`])
    expect(server.secrets.map((g:any)=>g.env).sort()).toEqual(['ABDO_CONNECTOR_ACCESS','ABDO_CONNECTOR_CLIENT_ID','ABDO_CONNECTOR_REFRESH','ABDO_CONNECTOR_TOKEN_URL'])
    expect(readFileSync(settings,'utf8')).not.toContain('access-live')
    await send({kind:'connector-list'});const list2=await next('connectors');expect(list2.entries.find((e:any)=>e.id==='linear').linked).toBe(true)
    // التوصيل الحقيقيّ: mcp-remote طفلٌ يقرأ المنح من بيئته ويصل الخادمَ البعيد بالرمز
    await send({kind:'external-connect',id:'connector-linear',command:server.command,protocol:'mcp'})
    const connected=await next('external');expect(connected.tools.map((t:any)=>t.name)).toEqual(['connector-linear.issues']);expect(remoteSeen).toContain('tools/list')
    // الفصل: الرموز تُمسح والخادم يُزال ويُفصل
    await send({kind:'connector-forget',id:'linear'});expect((await next('external-gone')).id).toBe('connector-linear')
    expect((await next('connector-status',f=>f.id==='linear')).state).toBe('unlinked')
    expect(JSON.parse(readFileSync(settings,'utf8')).mcpServers.some((s:any)=>s.id==='connector-linear')).toBe(false)
    await send({kind:'connector-list'});expect((await next('connectors')).entries.find((e:any)=>e.id==='linear').linked).toBe(false)
  }finally{child.kill();await child.exited;fake.stop(true);await stderr;rmSync(home,{recursive:true,force:true})}
},120000)
