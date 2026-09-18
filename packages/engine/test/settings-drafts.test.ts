import {test,expect} from 'bun:test'
import {createSettingsDrafts} from '../../desktop/ui/settings-drafts.js'
import {writeWorkspacePreference} from '../../desktop/ui/workspace-preference-write.js'

const input=(id:string,value:unknown,checkbox=false):any=>({id,tagName:'INPUT',type:checkbox?'checkbox':'text',value,checked:value,disabled:false,dataset:{}})
test('incoming settings do not erase unsaved language or Super Abdo edits',()=>{
 const d=createSettingsDrafts(),language=input('setlanguage','fr'),superMode=input('super-enabled',true,true),root:any={getElementById:(id:string)=>id==='setlanguage'?language:superMode};
 d.remember(language);d.remember(superMode);language.value='en';superMode.checked=false;d.restore(root);expect(language.value).toBe('fr');expect(superMode.checked).toBe(true)
})
test('acknowledging a snapshot preserves edits made while that save was pending',()=>{
 const d=createSettingsDrafts(),n=input('setchatmodel','provider/first'),root:any={getElementById:()=>n};d.remember(n);const saved=d.revision();n.value='provider/second';d.remember(n);d.clear(saved);n.value='provider/first';d.restore(root);expect(n.value).toBe('provider/second');d.clear();n.value='provider/third';d.restore(root);expect(n.value).toBe('provider/third')
})
test('immediate controls are not drafts and pinned controls cannot be overwritten',()=>{
 const d=createSettingsDrafts(),instant=input('native-memory-search',false,true),pinned=input('plugreviewer',true,true);d.remember(instant);d.remember(pinned);instant.checked=true;pinned.checked=false;pinned.disabled=true;d.restore({getElementById:(id:string)=>id==='plugreviewer'?pinned:instant} as any);expect(instant.checked).toBe(true);expect(pinned.checked).toBe(false)
})
test('failed preference write restores its field and preserves other changes',async()=>{
 const meta:any={preferences:{accentColor:'gold',codeFont:'Consolas'}};await expect(writeWorkspacePreference(meta,'accentColor','blue',async()=>{meta.preferences.codeFont='Cascadia Code';throw Error('disk refused')})).rejects.toThrow('disk refused');expect(meta.preferences).toEqual({accentColor:'gold',codeFont:'Cascadia Code'})
})
test('failed old write cannot roll back a newer value of the same preference',async()=>{
 const meta:any={preferences:{accentColor:'gold'}};await expect(writeWorkspacePreference(meta,'accentColor','blue',async()=>{meta.preferences.accentColor='emerald';throw Error('old write failed')})).rejects.toThrow();expect(meta.preferences.accentColor).toBe('emerald')
})
test('failure restores an absent default and successful writes remain saved',async()=>{
 const meta:any={preferences:{}};await expect(writeWorkspacePreference(meta,'uiDensity','compact',async()=>{throw Error('refused')})).rejects.toThrow();expect(Object.hasOwn(meta.preferences,'uiDensity')).toBe(false);await writeWorkspacePreference(meta,'uiDensity','spacious',async()=>true);expect(meta.preferences.uiDensity).toBe('spacious')
})
