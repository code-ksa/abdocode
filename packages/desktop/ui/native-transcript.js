// Render receipts as receipts, separate from the model's prose. Text always
// enters through textContent; project output cannot inject executable markup.
export function createTranscript(document, language = () => 'en') {
  const turns = new WeakMap();
  const text = (en, ar) => language() === 'ar' ? ar : en;
  const make = (tag, cls, value) => {const n=document.createElement(tag);n.className=cls;if(value!==undefined)n.textContent=value;return n;};
  function state(entry) {
    let s=turns.get(entry);
    if(!s){entry.bodyEl.replaceChildren();entry.bodyEl.classList.add('acx-transcript');s={entry,prose:null,raw:'',group:null,pending:null,tools:new Map()};turns.set(entry,s);}
    return s;
  }
  function prose(s, value) {
    if(!s.prose){s.prose=make('div','acx-prose');s.prose.dir='auto';s.entry.bodyEl.append(s.prose);}
    s.prose.textContent=value;
  }
  function update(g) {
    const complete=g.items.filter(i=>i.done), commands=complete.filter(i=>i.word==='run').length;
    const files=new Set(complete.filter(i=>i.ok&&['write','edit','patch'].includes(i.word)).map(i=>i.path));
    const failed=complete.filter(i=>i.ok===false).length, pending=g.items.length-complete.length;
    const pieces=[];
    if(commands)pieces.push(text(`Ran ${commands} command${commands===1?'':'s'}`,`نُفّذ ${commands} من الأوامر`));
    if(files.size)pieces.push(text(`edited ${files.size} file${files.size===1?'':'s'}`,`عُدّل ${files.size} من الملفات`));
    const others=complete.length-commands-complete.filter(i=>['write','edit','patch'].includes(i.word)).length;
    if(others)pieces.push(text(`used ${others} tool${others===1?'':'s'}`,`استُخدمت ${others} من الأدوات`));
    if(!pieces.length)pieces.push(text(pending?'Running a tool':'Tool results',pending?'جارٍ استخدام أداة':'نتائج الأدوات'));
    if(failed)pieces.push(text(`(${failed} failed)`,`(${failed} فشلت)`));
    if(pending&&complete.length)pieces.push(text('· running…','· جارٍ التنفيذ…'));
    g.label.textContent=pieces.join(', ');
    let added=0,removed=0;
    for(const i of complete.filter(i=>i.ok&&i.diff))for(const line of i.diff.split('\n')){if(line.startsWith('+')&&!line.startsWith('+++'))added++;if(line.startsWith('-')&&!line.startsWith('---'))removed++;}
    g.add.textContent=added?`+${added}`:'';g.remove.textContent=removed?`−${removed}`:'';
  }
  function group(s,expanded) {
    if(s.group)return s.group;
    const node=make('details','acx-tools'),summary=make('summary','acx-summary'),label=make('span','acx-summary-label'),add=make('span','acx-added'),remove=make('span','acx-removed'),items=make('div','acx-tool-items');
    summary.append(label,add,remove);node.append(summary,items);node.open=!!expanded;s.entry.bodyEl.append(node);
    return s.group={node,label,add,remove,body:items,items:[]};
  }
  function flush(s) {
    // The wire's tool syntax is not an assistant paragraph. Its complete bytes
    // are preserved in the command card, including multiline writes.
    const content=s.raw.split(/(?:نف[ّ]?ذ|نفّذ)\s*:|<tool_call>/u)[0].trim();
    if(content)prose(s,content);else s.prose?.remove();
    s.raw='';s.prose=null;
    if(content)s.group=null;
  }
  return {
    has: entry=>turns.has(entry),
    delta(entry,value){const s=state(entry);if(s.pending&&!s.pending.done){s.pending.output.textContent+=value;return;}s.raw+=value;const content=s.raw.split(/(?:نف[ّ]?ذ|نفّذ)\s*:|<tool_call>/u)[0];prose(s,content);},
    tool(entry,frame,expanded){const s=state(entry);flush(s);const g=group(s,expanded),cmd=String(frame.cmd||''),word=cmd.split(/\s/)[0],path=cmd.slice(word.length).trim().split(/\s*<<<|\s+::/)[0];
      const node=make('details','acx-tool'),summary=make('summary','acx-tool-title'),title=make('span','',word==='run'?text('Running command','تنفيذ أمر'):['write','edit'].includes(word)?text('Update ','تحديث ')+path:cmd.split('\n')[0]);
      const status=make('span','acx-tool-status',text('Running…','جارٍ التنفيذ…'));summary.append(title,status);
      const command=make('pre','acx-command'),sigil=make('span','acx-sigil','$ '),verb=make('span','acx-verb',word),args=make('span','acx-args',cmd.slice(word.length));command.append(sigil,verb,args);
      const output=make('pre','acx-output');node.append(summary,command,output);g.body.append(node);const item={node,title,status,output,word,path,done:false,ok:undefined,diff:null};g.items.push(item);s.pending=item;s.tools.set(cmd,{item,g});update(g);
    },
    diff(entry,frame){const s=state(entry),item=s.pending;if(!item)return;item.diff=String(frame.diff||'');const preview=make('details','acx-preview'),title=make('summary','',text('Review changes: ','معاينة التغييرات: ')+frame.path),body=make('pre','acx-diff');
      for(const line of item.diff.split('\n'))body.append(make('div',line.startsWith('+')?'acx-added':line.startsWith('-')?'acx-removed':'',line));preview.append(title,body);item.node.append(preview);
    },
    result(entry,frame){const s=state(entry),found=s.tools.get(String(frame.cmd||''));if(!found)return;const {item,g}=found;item.done=true;item.ok=frame.verdict?.ok;item.output.textContent=String(frame.output||'')+(frame.outputTruncated?'\n\n'+text('Output shortened for display.','اختُصر الناتج للعرض.'):'');item.status.textContent=item.ok===false?text('Failed','فشلت'):item.ok===true?text('Completed','اكتملت'):text('Finished · unverified','انتهت · غير متحقق');item.node.dataset.outcome=item.ok===false?'failed':'finished';item.title.textContent=item.word==='run'?text('Command output','نتيجة الأمر'):item.title.textContent;update(g);},
    finish(entry){const s=turns.get(entry);if(!s)return;flush(s);for(const {item,g} of s.tools.values())if(!item.done){item.done=true;item.status.textContent=text('Interrupted · no result','توقفت · بلا نتيجة');update(g);}},
    diagnostics(entry,value){const node=make('details','acx-diagnostics'),summary=make('summary','',text('Execution details','تفاصيل التنفيذ')),body=make('pre','acx-output',value);node.append(summary,body);entry.node.append(node);},
  };
}
