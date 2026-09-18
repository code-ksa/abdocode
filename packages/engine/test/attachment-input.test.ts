import {test,expect} from 'bun:test'
import {mountChatWork} from '../../desktop/ui/native-chat-work.js'

test('paste and file drop import actual bytes, keep text paste native, and preserve drafts on rejection',async()=>{
 const previousDocument=globalThis.document,previousWindow=globalThis.window;
 class Element extends EventTarget{value='';children:any[]=[];dataset={};className='';textContent='';classList={remove(){},toggle(){}};append(...items:any[]){this.children.push(...items)}replaceChildren(...items:any[]){this.children=items}setAttribute(){}before(){}remove(){}contains(target:any){return target===this||this.children.includes(target)}}
 const prompt=new Element(),composer=new Element();composer.append(prompt);const win=new EventTarget(),calls:any[]=[],notices:string[]=[];let fail=false;
 (globalThis as any).document={createElement:()=>new Element(),getElementById:(id:string)=>id==='prompt'?prompt:id==='composer'?composer:null};(globalThis as any).window=win;
 const ui=mountChatWork({bridge:{snapshot:()=>({working:false}),notice:(m:string)=>notices.push(m),invoke:async(command:string,args:any)=>{calls.push({command,args});if(fail)throw Error('Invalid document');return args.files.map((f:any,i:number)=>({id:`attached-${calls.length}-${i}`,name:f.name,mime:'text/plain',bytes:Buffer.from(f.dataBase64,'base64').length}));}}});
 const wait=async()=>{for(let i=0;i<100;i++){await Bun.sleep(5);try{ui.prepareSubmission();return}catch{}}throw Error('Import did not settle')};
 try{
  ui.frame({kind:'ready',sessionId:'paste-session',conversationMode:'chat'});prompt.value='Keep my question';
  const file=new File(['screenshot bytes'],'capture.png',{type:'image/png'}),paste=new Event('paste',{cancelable:true});Object.defineProperty(paste,'clipboardData',{value:{items:[{kind:'file',getAsFile:()=>file}]}});prompt.dispatchEvent(paste);await wait();
  expect(paste.defaultPrevented).toBe(true);expect(calls[0].command).toBe('attachments_import');expect(calls[0].args.sessionId).toBe('paste-session');expect(Buffer.from(calls[0].args.files[0].dataBase64,'base64').toString()).toBe('screenshot bytes');expect(prompt.value).toBe('Keep my question');
  const text=new Event('paste',{cancelable:true});Object.defineProperty(text,'clipboardData',{value:{items:[{kind:'string'}]}});prompt.dispatchEvent(text);expect(text.defaultPrevented).toBe(false);expect(calls.length).toBe(1);
  const drop=new Event('drop',{cancelable:true});Object.defineProperty(drop,'target',{value:prompt});Object.defineProperty(drop,'dataTransfer',{value:{types:['Files'],files:[new File(['const a=73;'],'note.ts')]}});win.dispatchEvent(drop);await wait();expect(drop.defaultPrevented).toBe(true);expect(calls[1].args.files[0].name).toBe('note.ts');expect(ui.prepareSubmission().attachments.length).toBe(2);
  fail=true;win.dispatchEvent(drop);await wait();expect(ui.prepareSubmission().attachments.length).toBe(2);expect(notices).toContain('Invalid document');
  const oversized=new Event('drop',{cancelable:true});Object.defineProperty(oversized,'target',{value:prompt});Object.defineProperty(oversized,'dataTransfer',{value:{types:['Files'],files:[{name:'huge.pdf',size:17*1024*1024,arrayBuffer(){throw Error('Must not read oversized bytes')}}]}});win.dispatchEvent(oversized);await wait();expect(calls.length).toBe(3);expect(notices.at(-1)).toContain('16 MiB');
 }finally{ui.dispose();globalThis.document=previousDocument;globalThis.window=previousWindow;}
})
