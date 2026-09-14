// Drafts belong to Save and apply. Immediate controls are deliberately excluded.
export function createSettingsDrafts(){
  const edits=new Map();let revision=0;
  const key=n=>n?.dataset?.pluginRule?'rule:'+n.dataset.pluginRule:/^(?:set[a-z]+|super-[A-Za-z]+|plug[a-z]+)$/.test(n?.id||'')?n.id:null;
  function remember(n){const id=key(n);if(!id||n.disabled||!['INPUT','SELECT','TEXTAREA'].includes(n.tagName))return;edits.set(id,{revision:++revision,checked:n.type==='checkbox',value:n.type==='checkbox'?n.checked:n.value});}
  return {
    remember, revision:()=>revision,
    clear(through=Infinity){for(const[id,entry]of edits)if(entry.revision<=through)edits.delete(id);},
    restore(root=document){for(const[id,entry]of edits){const n=id.startsWith('rule:')?root.querySelector('[data-plugin-rule="'+CSS.escape(id.slice(5))+'"]'):root.getElementById(id);if(n&&!n.disabled){if(entry.checked)n.checked=entry.value;else n.value=entry.value;}}},
    mount(root){const listener=e=>remember(e.target);root.addEventListener('input',listener,true);root.addEventListener('change',listener,true);return()=>{root.removeEventListener('input',listener,true);root.removeEventListener('change',listener,true);};},
  };
}
export const settingsDrafts=createSettingsDrafts();
