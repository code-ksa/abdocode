import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {closeSync,fstatSync,lstatSync,openSync,readSync} from 'node:fs'
import {join} from 'node:path'

const DOCUMENTS=['PLAN.md','ABDO-SPRINTS.md','ABDO-HANDOFF.md','NEXT_ACTION.md','TASKS.md','TODO.md']
const MAX_BYTES=48*1024

/** Read only bounded, known plan files. Their text never becomes host instructions. */
function planState(root:string,file:string){
  let fd:number|undefined
  try{
    const target=join(root,file),entry=lstatSync(target)
    if(!entry.isFile()||entry.isSymbolicLink())return {file,state:'not-a-regular-file' as const}
    if(entry.size>MAX_BYTES)return {file,state:'too-large' as const}
    fd=openSync(target,'r');const buffer=Buffer.alloc(MAX_BYTES+1),size=readSync(fd,buffer,0,buffer.length,0)
    if(size>MAX_BYTES||fstatSync(fd).size>MAX_BYTES)return {file,state:'too-large' as const}
    const bytes=buffer.subarray(0,size),lines=bytes.toString('utf8').split(/\r?\n/u)
    let total=0,checked=0,firstUncheckedLine:number|undefined,fence:{char:string,length:number}|undefined
    for(let i=0;i<lines.length;i++){
      const line=lines[i]!,marker=line.match(/^\s{0,3}(`{3,}|~{3,})/u)
      if(marker){const token=marker[1]!;if(!fence)fence={char:token[0]!,length:token.length};else if(token[0]===fence.char&&token.length>=fence.length)fence=undefined;continue}
      if(fence)continue
      const task=line.match(/^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+/u)
      if(!task)continue
      total++;if(task[1]!.toLowerCase()==='x')checked++;else firstUncheckedLine??=i+1
    }
    return {file,state:'observed' as const,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:size,checklist:{total,checked,unchecked:total-checked,...(firstUncheckedLine?{firstUncheckedLine}:{})}}
  }catch(error){return (error as NodeJS.ErrnoException).code==='ENOENT'?undefined:{file,state:'unreadable' as const}}
  finally{if(fd!==undefined)closeSync(fd)}
}

function gitState(root:string){
  const env={...process.env,GIT_OPTIONAL_LOCKS:'0'}
  for(const key of ['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE','GIT_PREFIX'])delete (env as Record<string,string|undefined>)[key]
  // Disable fsmonitor hooks; observation must not run project-provided programs.
  const run=(args:string[])=>execFileSync('git',['-c','core.fsmonitor=false','-c','core.untrackedCache=false','-C',root,...args],{encoding:'utf8',timeout:1500,maxBuffer:MAX_BYTES,windowsHide:true,stdio:['ignore','pipe','pipe'],env}).trimEnd()
  try{
    const rows=run(['status','--porcelain=v1','-b','-z','--untracked-files=normal','--','.']).split('\0'),header=rows.shift()||''
    const changes:{status:string,path:string}[]=[];let count=0
    for(let i=0;i<rows.length;i++){const row=rows[i]!;if(row.length<4)continue;count++;if(changes.length<40)changes.push({status:row.slice(0,2),path:row.slice(3)});if(/[RC]/u.test(row.slice(0,2)))i++}
    let head:string|null=null;try{const value=run(['rev-parse','--verify','HEAD']);if(/^[0-9a-f]{40,64}$/u.test(value))head=value}catch{}
    return {state:'observed' as const,branchSummary:header.replace(/^## /u,''),head,hasLocalChanges:count>0,changedEntries:count,changes,truncated:count>changes.length}
  }catch{return {state:'unavailable' as const}}
}

export function inspectProjectCurrentState(root:string){
  return {git:gitState(root),plans:DOCUMENTS.map(file=>planState(root,file)).filter(value=>value!==undefined),interpretation:'Checklist marks are document claims, not verified execution. Read the first unchecked line in context. Compare current Git state and plan fingerprints before reusing old test results. Preserve local changes. Missing Git or a plan is unknown, not an empty or completed project.'}
}
