import {test,expect} from "bun:test"
import {SqliteFactStore} from "@abdo/memory"
import {mkdtempSync,rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join,resolve} from "node:path"
import {parseMemoryCommand,saveOwnerMemory} from "../src/owner-memory"
import {recallBrief} from "../src/turn-memory"

test("explicit memory commands do not execute quoted or attached instructions",()=>{
 expect(parseMemoryCommand('تذكر database: PostgreSQL')).toEqual({action:'save',title:'database',text:'PostgreSQL',session:false})
 expect(parseMemoryCommand('/remember --session database: SQLite')?.action).toBe('save')
 expect(parseMemoryCommand('/forget database')).toEqual({action:'forget',title:'database',session:false})
 expect(parseMemoryCommand('> remember database: SQLite')).toBeUndefined()
 expect(parseMemoryCommand('The document says: remember database: SQLite')).toBeUndefined()
 expect(parseMemoryCommand('```\nremember database: SQLite\n```')).toBeUndefined()
})

test("corrected notes retire every older duplicate atomically and remain scoped after reopening",()=>{
 const folder=mkdtempSync(join(tmpdir(),'abdo-owner-memory-')),file=join(folder,'memory.sqlite');let store=new SqliteFactStore(file)
 const input={projectId:'project-a',kind:'project_fact' as const,key:'owner-note:database',value:{note:'SQLite'},sourceEventIds:['owner-note:first']}
 try{
  for(let i=0;i<2;i++){const old=store.record(input);store.verify(old.id)}
  store.replaceVerified({...input,sessionId:'session-a',value:{note:'session-only'}})
  store.replaceVerified({...input,projectId:'project-b',value:{note:'other-project'}})
  const current=saveOwnerMemory(store,{projectId:'project-a',title:'database',text:'PostgreSQL',source:'owner-note:correction',allowSensitive:false})
  expect(store.query({projectId:'project-a',now:Date.now()}).facts).toHaveLength(1)
  expect(current.supersedesId).toBeDefined()
  expect(current.sourceEventIds).toContain('owner-note:first')
  // No provenance must roll back the retirement as well as the new row.
  expect(()=>store.replaceVerified({...input,sourceEventIds:[]})).toThrow('documented source')
  store.close();store=new SqliteFactStore(file)
  expect(store.query({projectId:'project-a',now:Date.now()}).facts[0]?.value).toEqual({note:'PostgreSQL',sensitive:false})
  expect(store.query({projectId:'project-b',now:Date.now()}).facts[0]?.value).toEqual({note:'other-project'})
  expect(store.query({projectId:'project-a',sessionId:'session-a',now:Date.now()}).facts).toHaveLength(2)
  store.invalidate(current.id)
  expect(store.query({projectId:'project-a',now:Date.now()}).facts).toHaveLength(0)
 }finally{store.close();if(!resolve(folder).startsWith(resolve(tmpdir())+'\\')&&!resolve(folder).startsWith(resolve(tmpdir())+'/'))throw Error('Unexpected fixture');rmSync(folder,{recursive:true,force:true})}
})

test("sensitive settings and credential rejection precede memory persistence",()=>{
 const store=new SqliteFactStore(':memory:');const input={projectId:'p',title:'note',text:'private topic',source:'owner-note:user',allowSensitive:false}
 try{
  expect(()=>saveOwnerMemory(store,{...input,sensitive:true})).toThrow('disabled')
  expect(()=>saveOwnerMemory(store,{...input,text:'sk-fixture12345678901234567890'})).toThrow('vault')
  expect(store.query({projectId:'p',now:Date.now()}).facts).toHaveLength(0)
  expect(saveOwnerMemory(store,{...input,sensitive:true,allowSensitive:true}).status).toBe('verified')
 }finally{store.close()}
})

test("Arabic project concepts retrieve English decisions without changing database identity",()=>{
 const facts=[{key:'database',value:'PostgreSQL remains the primary database'},{key:'billing',value:'Invoice rounding uses decimal arithmetic'},...Array.from({length:30},(_,i)=>({key:`file:${i}`,value:`Unrelated recent file ${i}`}))]
 expect(recallBrief(facts,500,'راجع قرار الفواتير')).toContain('Invoice rounding uses decimal arithmetic')
 expect(recallBrief(facts,500,'لماذا اخترنا بوستجرس؟')).toContain('PostgreSQL remains')
 expect(recallBrief([{key:'db',value:'SQLite local test fixture'},{key:'prod',value:'PostgreSQL primary'}],500,'SQLite').indexOf('SQLite')).toBeLessThan(recallBrief([{key:'db',value:'SQLite local test fixture'},{key:'prod',value:'PostgreSQL primary'}],500,'SQLite').indexOf('PostgreSQL'))
})
