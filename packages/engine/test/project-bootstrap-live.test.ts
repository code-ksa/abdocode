import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { createProjectFolder, projectPathProblem, resolveNewProjectTarget } from "../src/project-bootstrap"

const ROOT = resolve(import.meta.dir, "../../..")
test("project bootstrap protects existing files, application roots and junctions", () => {
  const base = mkdtempSync(join(tmpdir(), "abdo-bootstrap-paths-"))
  try {
    const install = join(base,"install"), state = join(base,"state"), projects = join(base,"projects")
    for(const path of [install,state,projects]) mkdirSync(path)
    const blocked = [install,state]
    for(const path of [install,state,base,join(install,"child"),"relative-project"]) expect(projectPathProblem(path,blocked,true)).toBeDefined()
    writeFileSync(join(projects,"keep.txt"),"preserve")
    expect(()=>createProjectFolder(projects,blocked)).toThrow()
    expect(readFileSync(join(projects,"keep.txt"),"utf8")).toBe("preserve")
    const link = join(base,"linked")
    symlinkSync(install,link,process.platform === "win32" ? "junction" : "dir")
    expect(projectPathProblem(join(link,"escape"),blocked,true)).toBeDefined()
    const created=createProjectFolder(join(projects,"new-crm"),blocked)
    expect(existsSync(created)).toBe(true)
    expect(projectPathProblem(created,blocked)).toBeUndefined()
    // 2026-09-13: مجلّدٌ موجودٌ **فارغ** يُتبنّى (الاسمُ نفسُه)، وغيرُ الفارغ يأخذ اللاحقة — التوأمُ في project-bootstrap-adopt.test.ts
    expect(resolveNewProjectTarget("new-crm",projects)).toBe(join(projects,"new-crm"))
    writeFileSync(join(created,"index.html"),"<html></html>")
    expect(resolveNewProjectTarget("new-crm",projects)).toBe(join(projects,"new-crm-2"))
    expect(resolveNewProjectTarget("Customer CRM",projects)).toBe(join(projects,"Customer CRM"))
    expect(()=>resolveNewProjectTarget("../escape",projects)).toThrow()
    expect(()=>resolveNewProjectTarget("CRM",undefined)).toThrow()
    expect(resolveNewProjectTarget(join(projects,"explicit"),undefined)).toBe(join(projects,"explicit"))
  } finally { rmSync(base,{recursive:true,force:true}) }
})

async function fixture(mode: "create"|"deny"|"cancel") {
  const base = mkdtempSync(join(tmpdir(),"abdo-bootstrap-live-"))
  const state = join(base,"state"), install = join(base,"payload"), target = join(base,"CRM Trial")
  mkdirSync(state); mkdirSync(install)
  const settings=join(state,"settings.json"), preload=join(base,"fixture.ts"), requests=join(base,"requests.jsonl")
  writeFileSync(settings,JSON.stringify({language:"en",agentModel:"ollama/bootstrap-fixture",modelRole:"agent",mode:"read-only",project:install,plugins:{routerGate:false,inventory:false,verifier:false,reviewer:false,delegation:false,projectAwareness:false,generalAwareness:false,sessionAwareness:false},superAbdo:{enabled:false}}))
  const responses=[`نفّذ: project-create ${target}`,"نفّذ: write PLAN.md <<<\n# Sprint 1\nCreate Next.js with SQLite. Use PostgreSQL or MariaDB if the user requests it.","The empty project and sprint plan were created. Application implementation is still pending."]
  writeFileSync(preload,`import {appendFileSync} from 'node:fs'; let n=0;
  globalThis.fetch=async (url,init)=>{appendFileSync(${JSON.stringify(requests)},String(init.body)+'\\n');
  ${mode === "cancel" ? `await new Promise((_,reject)=>{const fail=()=>reject(new TypeError('worker transport closed'));if(init.signal?.aborted)fail();else init.signal?.addEventListener('abort',fail,{once:true})});` : ""}
  return new Response(JSON.stringify({model:"bootstrap-fixture",message:{role:"assistant",content:${JSON.stringify(responses)}[Math.min(n++,2)]},done:true,done_reason:'stop',prompt_eval_count:5,eval_count:10})+'\\n');};`)
  const child=Bun.spawn([process.execPath,"--preload",preload,"packages/engine/src/cli.ts","serve"],{cwd:ROOT,env:{...process.env,ABDO_SHELL_TOKEN:"bootstrap-test",ABDO_FRAMED_STDIO:"1",ABDO_REQUIRE_PROJECT:"1",ABDO_INSTALL_ROOT:install,ABDO_PROJECT:"",ABDO_CODE_STATE_DIR:state,ABDO_CODE_SETTINGS:settings,ABDO_VAULT_HOME:state,ABDO_REQUIRE_SPRINT_PLAN:"0",ABDO_AGENT_PHASE:"",ABDO_NATIVE_TOOLS:"text",ABDO_MAX_AGENT_EPOCHS:"1",ABDO_CLOUD_DAILY_TOKENS:"0"},stdin:"pipe",stdout:"pipe",stderr:"pipe"})
  const errors = new Response(child.stderr).text(), frames:any[]=[]
  const decoder=new LocalJsonFrameDecoder()
  const reading=(async()=>{for await(const bytes of child.stdout) frames.push(...decoder.push(bytes))})()
  const send=(frame:object)=>{child.stdin.write(encodeLocalJsonFrame(frame));void child.stdin.flush()}
  const wait=async(predicate:()=>boolean)=>{const deadline=Date.now()+20000;while(!predicate()){if(Date.now()>deadline)throw Error('timed out '+JSON.stringify(frames).slice(-1800));await Bun.sleep(15)}}
  try{
    send({kind:"hello",shell:"desktop",token:"bootstrap-test"});await wait(()=>frames.some(f=>f.kind==="ready"))
    send({kind:"project-set",path:install});await wait(()=>frames.some(f=>f.kind==="refused"))
    expect(frames.some(f=>f.kind==="project"&&f.path===install)).toBe(false)
    send({kind:"submit",mode:mode==="deny"?"read-only":"full-access",turn:{id:"bootstrap-turn",body:"Create my CRM project and a sprint plan at "+target+". No need to implement the app yet."}})
    await wait(()=>existsSync(requests))
    if(mode==="deny") {await wait(()=>frames.some(f=>f.kind==="approval"));send({kind:"deny",turnId:"bootstrap-turn"})}
    if(mode==="cancel") send({kind:"interrupt",turnId:"bootstrap-turn"})
    await wait(()=>frames.some(f=>f.turnId==="bootstrap-turn"&&["done","refused","unresolved"].includes(f.kind)))
    const calls=readFileSync(requests,"utf8").trim().split("\n").map(s=>JSON.parse(s))
    expect(JSON.stringify(calls[0])).toContain("NO PROJECT IS SELECTED")
    expect(existsSync(join(install,"PLAN.md"))).toBe(false)
    if(mode==="create") {
      if(!existsSync(join(target,"PLAN.md"))) throw Error(JSON.stringify(frames.filter(f=>["event","tool","tool-result","refused","done"].includes(f.kind))).slice(-6000))
      expect(readFileSync(join(target,"PLAN.md"),"utf8")).toContain("SQLite")
      expect(frames.some(f=>f.kind==="project"&&f.path===target&&f.created)).toBe(true)
      expect(JSON.parse(readFileSync(settings,"utf8")).project).toBe(target)
      expect(JSON.stringify(calls.at(-1))).toContain("Active project root: "+target.replaceAll("\\","\\\\"))
    } else {
      expect(existsSync(target)).toBe(false)
      if(mode==="cancel") expect(frames.find(f=>f.turnId==="bootstrap-turn"&&f.kind==="refused")?.failure?.kind).toBe("cancelled")
    }
    return frames
  } finally {child.kill();await child.exited;await reading;await errors;rmSync(base,{recursive:true,force:true})}
}
test("the real engine binds an agent-created project before native file writes",()=>fixture("create"),30000)
test("read-only mode cannot create a project",()=>fixture("deny"),30000)
test("operator cancellation is not mislabeled as a provider transport failure",()=>fixture("cancel"),30000)
