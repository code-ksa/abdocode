import {createHash} from 'node:crypto'
import {mkdirSync, writeFileSync} from 'node:fs'
import {basename, dirname, join} from 'node:path'
import catalogue from './template-catalogue.json'
import {createProjectFolder} from './project-bootstrap'
import {allow} from '@abdo/egress'

export const PROJECT_TEMPLATES = catalogue.templates
export const TEMPLATE_REVISION = 'b1690ff08fb7e18d772177314fa65de07803b947'
export function findTemplates(query = '') {
  const words=query.toLowerCase().trim().split(/\s+/u)
  return PROJECT_TEMPLATES.filter(t=>words.every(w=>`${t.id} ${t.framework} ${t.database||''} ${t.orm||''} ${t.features.join(' ')}`.includes(w)))
}
export function validateTemplateBundle(text:string, expectedHash:string): {path:string;content:string}[] {
  if(Buffer.byteLength(text)>2_000_000)throw Error('Template exceeds the size limit.')
  if(createHash('sha256').update(text).digest('hex')!==expectedHash)throw Error('Template checksum does not match the reviewed release.')
  const data=JSON.parse(text)
  if(data?.schemaVersion!==1||!Array.isArray(data.files)||!data.files.length||data.files.length>200)throw Error('Invalid template bundle.')
  const seen=new Set<string>()
  for(const file of data.files){
    if(typeof file.path!=='string'||typeof file.content!=='string'||file.path.length>180||file.content.includes('\0'))throw Error('Invalid template file.')
    if(!file.path.split('/').every((part:string)=>part!=='.'&&part!=='..'&&/^[a-zA-Z0-9_.()[\]-]+$/u.test(part)&&!/[. ]$/u.test(part)&&! /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))||file.path.startsWith('/')||file.path.toLowerCase().split('/').some((p:string)=>['.git','node_modules','.env'].includes(p)))throw Error('Unsafe template path.')
    const key=file.path.toLowerCase();if(seen.has(key))throw Error('Duplicate template file.');seen.add(key)
  }
  return data.files
}
export async function downloadTemplate(id:string,signal?:AbortSignal){
  const template=PROJECT_TEMPLATES.find(t=>t.id===id);if(!template)throw Error('Unknown template. Use templates to list available starters.')
  allow('raw.githubusercontent.com','Explicitly requested, checksum-pinned code-ksa project template download')
  const response=await fetch(`https://raw.githubusercontent.com/code-ksa/abdocode-templates/${TEMPLATE_REVISION}/${template.bundle}`,{redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)})
  if(!response.ok)throw Error(`Template download failed (${response.status}).`)
  if(Number(response.headers.get('content-length'))>2_000_000)throw Error('Template download exceeds size limit.')
  const reader=response.body?.getReader();if(!reader)throw Error('Empty template response.')
  const chunks:Uint8Array[]=[];let length=0
  while(true){const result=await reader.read();if(result.done)break;length+=result.value.length;if(length>2_000_000){await reader.cancel();throw Error('Template download exceeds size limit.')}chunks.push(result.value)}
  return {template,files:validateTemplateBundle(Buffer.concat(chunks).toString('utf8'),template.sha256)}
}
export function materializeTemplate(target:string,blockedRoots:readonly string[],files:{path:string;content:string}[]){
  const actual=createProjectFolder(target,blockedRoots)
  // All paths and bytes have been checked before the exclusive root creation.
  // No package installation, scripts or shell commands run as part of extraction.
  try{for(const file of files){const output=join(actual,...file.path.split('/'));mkdirSync(dirname(output),{recursive:true});let content=file.content;if(file.path==='package.json'){const manifest=JSON.parse(content);manifest.name=basename(actual).toLowerCase().replace(/[^a-z0-9-]+/gu,'-').replace(/^-+|-+$/gu,'')||'abdocode-project';content=JSON.stringify(manifest,null,2)+'\n'}writeFileSync(output,content,{flag:'wx'})}}
  catch(error){throw Error(`Template creation stopped; partial files remain at ${actual}. ${String(error)}`)}
  return actual
}
