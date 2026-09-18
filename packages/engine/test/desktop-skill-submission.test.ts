import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {test} from 'bun:test';
test('composer preserves selected skill directives across submit and retains chat/palette behavior',()=>{
const html=fs.readFileSync(new URL('../../desktop/ui/index.html',import.meta.url),'utf8');
const commands=html.slice(html.indexOf('const COMMANDS = ['),html.indexOf('let palSel ='));
const fire=html.slice(html.indexOf('const fire = () => {'),html.indexOf('el("send").onclick = fire;'));
let mode='code',calls:any[]=[];const prompt={value:''};const context={prompt,engineUp:true,working:undefined,palette:{style:{}},window:{AbdoDesktopShell:{api:{chatWork:{prepareSubmission:()=>({conversationMode:mode,attachments:[]})}}}},submitBody:(body:string,prepared:object)=>{calls.push({body,...prepared});return true},notice:(e:unknown)=>{throw Error(e)}};
vm.createContext(context);vm.runInContext(commands+fire+'globalThis.send=fire;',context);
const directives='/skill abdo-workflow/project-resume\n/skill abdo-workflow/browser-check\nInspect this project.';
for(const [text,expected] of [[directives,directives],['/status','status'],['/read PLAN.md','read PLAN.md'],['/unknown user text','/unknown user text']]){prompt.value=text;(context as any).send();assert.equal(calls.at(-1).body,expected);assert.equal(prompt.value,'');}
mode='chat';prompt.value='/status';context.send();assert.equal(calls.at(-1).body,'/status');assert.equal(calls.at(-1).conversationMode,'chat');console.log('PASS: selected skills preserved through real composer submit; palette commands and chat semantics retained');

});
