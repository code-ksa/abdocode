// The name is retained for the integration entry point; the product has only
// Chat and Code. Conversation identity and mode are owned by engine receipts.
export function mountChatWork(api) {
  const bridge=api.bridge,L=api.L||((en)=>en),drafts=new Map(),textDrafts=new Map(),submissions=new Map();
  let currentMode='code',sessionId=null,choosing=false,pendingSession=null,disposed=false;
  const host=document.createElement('section');host.className='ncw-composer-context';host.setAttribute('aria-label',L('Conversation attachments','مرفقات المحادثة'));
  document.getElementById('composer')?.before(host);
  const prompt=document.getElementById('prompt'),composer=document.getElementById('composer');
  const inputSurface=document.createElement('div');inputSurface.className='ncw-input-surface';
  const attachments=document.createElement('div');attachments.className='ncw-attachments';
  prompt?.before(inputSurface);inputSurface.append(attachments);if(prompt)inputSurface.append(prompt);
  const saveText=()=>{if(sessionId&&prompt)textDrafts.set(sessionId,prompt.value);};
  prompt?.addEventListener('input',saveText);
  const error=message=>bridge.notice?.(String(message));
  const list=()=>drafts.get(sessionId)||[];
  function render(){
    host.replaceChildren();attachments.replaceChildren();host.dataset.mode=currentMode;
    const top=document.createElement('div');top.className='ncw-controls';
    const label=document.createElement('span');label.className='ncw-mode-label';label.textContent=currentMode==='chat'?L('Chat · conversation only','الدردشة · محادثة فقط'):L('Code · project agent','الكود · وكيل المشاريع');
    const attach=document.createElement('button');attach.type='button';attach.className='ncw-attach ncw-attach-icon';attach.disabled=choosing||!!pendingSession||!sessionId||!!bridge.snapshot().working;attach.textContent=choosing?'…':'+';attach.title=L('Attach files: images, PDF, Word, Excel or code (or paste / drop)','إرفاق ملفات: صور أو PDF أو Word أو Excel أو كود (أو الصق/اسحب)');attach.setAttribute('aria-label',attach.title);attach.onclick=()=>void choose();
    top.append(label,attach);host.append(top);const hint=document.createElement('div');hint.className='ncw-hint';hint.textContent=L('Paste a screenshot or drop images, PDF, Word, Excel and code here.','الصق لقطة شاشة أو اسحب صورًا أو PDF أو Word أو Excel أو ملفات كود هنا.');host.append(hint);
    if(list().length){const chips=attachments;for(const file of list()){
      const chip=document.createElement('span');chip.className='ncw-attachment';chip.title=`${file.mime} · ${Math.ceil(file.bytes/1024)} KiB`;
      if(/^image\/(png|jpeg|webp)$/.test(file.mime)&&typeof file.previewUrl==='string'&&file.previewUrl.startsWith(`data:${file.mime};base64,`)){
        const image=document.createElement('img');image.src=file.previewUrl;image.alt=file.name;image.className='ncw-thumbnail';chip.classList.add('ncw-image-attachment');chip.append(image);
      }
      const name=document.createElement('span');name.textContent=file.name;name.dir='auto';const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.setAttribute('aria-label',L('Remove attachment ','إزالة المرفق ')+file.name);remove.disabled=choosing;remove.onclick=()=>{drafts.set(sessionId,list().filter(item=>item.id!==file.id));render();};chip.append(name,remove);chips.append(chip);
    }}
  }
  async function choose(loader){
    if(choosing||pendingSession||bridge.snapshot().working||!sessionId)return;
    const selectedSession=sessionId;choosing=true;render();
    try{
      const selected=await (loader?loader(selectedSession):bridge.invoke('attachments_pick',{sessionId:selectedSession}));
      if(!Array.isArray(selected)||selected.some(f=>typeof f.id!=='string'||typeof f.name!=='string'||typeof f.mime!=='string'||!Number.isSafeInteger(f.bytes)))throw Error(L('The selected files were not accepted.','لم تُقبل الملفات المختارة.'));
      const previous=drafts.get(selectedSession)||[],combined=[...previous,...selected];
      if(combined.length>4||combined.reduce((sum,f)=>sum+f.bytes,0)>24*1024*1024)throw Error(L('Use up to four files, 24 MiB total. Remove an attachment before selecting more.','استخدم حتى أربعة ملفات بإجمالي 24 ميجابايت. أزل مرفقًا قبل اختيار المزيد.'));
      drafts.set(selectedSession,combined);
    }catch(e){error(e.message||e);}finally{choosing=false;render();}
  }
  function importFiles(files){
    const items=Array.from(files||[]);if(!items.length)return;
    if(choosing||pendingSession||bridge.snapshot().working||!sessionId){error(L('Wait for the current action before attaching files.','انتظر انتهاء الإجراء الحالي قبل إرفاق ملفات.'));return;}
    if(items.length+list().length>4||items.some(f=>!f.size||f.size>16*1024*1024)||items.reduce((n,f)=>n+f.size,0)>32*1024*1024){error(L('Attach up to four files, 16 MiB per source file and 32 MiB total.','أرفق حتى أربعة ملفات، بحد 16 ميجابايت للملف و32 ميجابايت إجمالًا.'));return;}
    return choose(async selectedSession=>{
      const encoded=[];
      for(const file of items){
        // 09-14 (مقيس من لقطة المالك): لقطةُ شاشةٍ ملصوقة PNG ≈ 700k+ حرفاً تتجاوز سقفَ البوّابة (350k) فيموت الدور «invalid image content».
        // الصورةُ تُصغَّر هنا في القشرة (canvas ⇦ JPEG بسلّم جودة/مقياس) حتى تتّسع — كما تفعل لقطةُ المتصفّح في المحرّك.
        const shrunk=/^image\/(png|jpeg|webp)$/.test(file.type)&&file.size>220*1024?await shrinkImage(file).catch(()=>null):null;
        if(shrunk){encoded.push(shrunk);continue;}
        if(/^image\/(png|jpeg|webp)$/.test(file.type)&&file.size>1024*1024){error(L('This image is too large to send readably; crop it or paste a smaller screenshot.','هذه الصورة أكبر من أن تُرسل مقروءةً؛ قصّها أو الصق لقطةً أصغر.'));continue;}
        const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));encoded.push({name:file.name||('Screenshot-'+Date.now()+'.png'),dataBase64:btoa(binary)});}
      return bridge.invoke('attachments_import',{sessionId:selectedSession,files:encoded});
    });
  }
  async function shrinkImage(file){
    const bitmap=await createImageBitmap(file);
    const base=(file.name||'Screenshot-'+Date.now()).replace(/\.(png|jpe?g|webp)$/i,'');
    for(const [maxSide,quality] of [[1600,.82],[1400,.72],[1200,.65],[1000,.6]]){
      const scale=Math.min(1,maxSide/Math.max(bitmap.width,bitmap.height));
      const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
      const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
      const dataUrl=canvas.toDataURL('image/jpeg',quality);const dataBase64=dataUrl.slice(dataUrl.indexOf(',')+1);
      if(dataBase64.length<=300000)return{name:base+'.jpg',dataBase64};
    }
    return null;
  }
  function onPaste(event){const files=Array.from(event.clipboardData?.items||[]).filter(item=>item.kind==='file').map(item=>item.getAsFile()).filter(Boolean);if(files.length){event.preventDefault();void importFiles(files);}}
  const fileDrag=event=>Array.from(event.dataTransfer?.types||[]).includes('Files');
  const inside=target=>composer?.contains(target)||host.contains(target);
  function onDragOver(event){if(!fileDrag(event))return;event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect=inside(event.target)?'copy':'none';composer?.classList.toggle('ncw-drop-active',inside(event.target));}
  function onDrop(event){if(!fileDrag(event))return;event.preventDefault();composer?.classList.remove('ncw-drop-active');if(inside(event.target))void importFiles(event.dataTransfer.files);else error(L('Drop files on the message input.','أسقط الملفات داخل مربع الرسالة.'));}
  const onDragLeave=event=>{if(!event.relatedTarget||!inside(event.relatedTarget))composer?.classList.remove('ncw-drop-active');};
  prompt?.addEventListener('paste',onPaste);window.addEventListener('dragover',onDragOver);window.addEventListener('drop',onDrop);window.addEventListener('dragleave',onDragLeave);
  function newSession(next=currentMode){
    if(!['chat','code'].includes(next))return Promise.reject(Error('Invalid conversation mode'));
    if(bridge.snapshot().working||choosing||pendingSession)return Promise.reject(Error(L('Finish the current action before starting another conversation.','أنه الإجراء الحالي قبل بدء محادثة أخرى.')));
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pendingSession=null;render();reject(Error(L('The engine did not confirm the new conversation.','لم يؤكد المحرك إنشاء المحادثة الجديدة.')));},10000);
      pendingSession={mode:next,previous:sessionId,resolve,reject,timer};render();
      Promise.resolve(bridge.send({kind:'session-new',conversationMode:next})).catch(e=>{clearTimeout(timer);pendingSession=null;render();reject(e);});
    });
  }
  function frame(f){
    if(disposed)return;
    if(['ready','session','archive'].includes(f?.kind)){
      const id=f.kind==='archive'?f.session:f.kind==='session'?f.id:f.sessionId;
      if(typeof id==='string'&&id!==sessionId){saveText();const initial=sessionId===null&&textDrafts.size===0;sessionId=id;if(prompt&&!initial)prompt.value=textDrafts.get(id)||'';saveText();}
      currentMode=f.conversationMode==='chat'?'chat':'code';api.setShellMode?.(currentMode);
      if(pendingSession&&f.kind==='session'&&sessionId!==pendingSession.previous&&currentMode===pendingSession.mode){const pending=pendingSession;pendingSession=null;clearTimeout(pending.timer);pending.resolve(sessionId);}
    }
    if(f?.kind==='admission'){
      const pending=submissions.get(f.turnId);
      if(pending){const sent=new Set(pending.ids);drafts.set(pending.session,(drafts.get(pending.session)||[]).filter(file=>!sent.has(file.id)));submissions.delete(f.turnId);}
    }
    if(['refused','unresolved','interrupted'].includes(f?.kind)){submissions.delete(f.turnId);if(pendingSession&&!f.turnId){const pending=pendingSession;pendingSession=null;clearTimeout(pending.timer);pending.reject(Error(f.why||'Conversation was not created'));}}
    if(f?.kind==='engine-died'){saveText();submissions.clear();if(pendingSession){clearTimeout(pendingSession.timer);pendingSession.reject(Error('Engine disconnected'));pendingSession=null;}sessionId=null;}
    render();
  }
  function prepareSubmission(){
    if(choosing||pendingSession||!sessionId)throw Error(L('Wait for the conversation and attachments to be ready.','انتظر حتى تصبح المحادثة والمرفقات جاهزة.'));
    return {conversationMode:currentMode,attachments:list().map(file=>file.id)};
  }
  render();
  return {mode:()=>currentMode,setMode:next=>next===currentMode?Promise.resolve(sessionId):newSession(next),newSession:()=>newSession(),prepareSubmission,choose,frame,render,
    submitted(turn,submission){if(submission?.conversationMode===currentMode&&prompt?.value.trim()===turn.body.trim())textDrafts.set(sessionId,'');if(submission?.attachments?.length)submissions.set(turn.id,{session:sessionId,ids:[...submission.attachments]});render();},
    dispose(){disposed=true;if(pendingSession){clearTimeout(pendingSession.timer);pendingSession.reject(Error('Conversation controls closed'));}prompt?.removeEventListener('input',saveText);prompt?.removeEventListener('paste',onPaste);window.removeEventListener('dragover',onDragOver);window.removeEventListener('drop',onDrop);window.removeEventListener('dragleave',onDragLeave);composer?.classList.remove('ncw-drop-active');if(prompt)inputSurface.before(prompt);inputSurface.remove();host.remove();drafts.clear();textDrafts.clear();submissions.clear();}
  };
}
