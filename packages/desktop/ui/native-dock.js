// Physical layout only. Runtime panels remain owned and torn down by SlotHost.
export class NativeDock {
  constructor(host, bridge, label) {
    this.host = host; this.bridge = bridge; this.label = label; this.nodes = new Map(); this.serial = 0;
    this.tree = { id: 'conversation', tabs: ['conversation'], active: 'conversation' };
    this.floating = []; this.floatBounds = {}; this.resizeObservers = []; this.maximized = null; this.dragging = null; this.history = [];
    try { const v = JSON.parse(localStorage.getItem('abdocode-native-layout-v1')); const seen=new Set(); if (this.valid(v?.tree,seen)&&seen.has('conversation')) { this.tree = v.tree; this.floating = Array.isArray(v.floating)?v.floating.filter((id,i,all)=>typeof id==='string'&&/^[a-z-]+$/.test(id)&&id!=='conversation'&&!seen.has(id)&&all.indexOf(id)===i).slice(0,16):[]; for(const id of this.floating){const b=v.floatBounds?.[id];if(b&&['left','top','width','height'].every(k=>Number.isFinite(b[k])))this.floatBounds[id]=b;} } } catch {}
  }
  valid(tree, seen = new Set(), depth = 0) {
    if (!tree || depth > 10) return false;
    if (tree.axis) return ['row', 'column'].includes(tree.axis) && Number.isFinite(tree.ratio) && tree.ratio > 0 && tree.ratio < 1 && this.valid(tree.first, seen, depth + 1) && this.valid(tree.second, seen, depth + 1);
    return typeof tree.id === 'string' && Array.isArray(tree.tabs) && tree.tabs.length > 0 && tree.tabs.length <= 16 && tree.tabs.every(x => typeof x === 'string' && /^[a-z-]+$/.test(x) && !seen.has(x) && seen.add(x)) && tree.tabs.includes(tree.active);
  }
  leaves(node = this.tree) { return !node ? [] : node.axis ? [...this.leaves(node.first), ...this.leaves(node.second)] : [node]; }
  leaf(id) { return this.leaves().find(n => n.tabs.includes(id)); }
  replace(old, next, node = this.tree) { if (node === old) return next; if (!node?.axis) return node; return { ...node, first: this.replace(old, next, node.first), second: this.replace(old, next, node.second) }; }
  remove(id, node = this.tree) {
    if (!node) return null;
    if (node.axis) { const first = this.remove(id, node.first), second = this.remove(id, node.second); return !first ? second : !second ? first : { ...node, first, second }; }
    const tabs = node.tabs.filter(t => t !== id); return tabs.length ? { ...node, tabs, active: tabs.includes(node.active) ? node.active : tabs[0] } : null;
  }
  register(id, node, options = {}) {
    this.nodes.set(id, { node, ...options });
    if (!this.leaf(id) && !this.floating.includes(id)) {
      const preferred=options.position||(id==='terminal'||id==='browser'?'right':id==='changes'&&this.leaf('terminal')?'bottom':this.leaf('terminal')?'center':'right');
      const target=id==='changes'&&this.leaf('terminal')?'terminal':!['terminal','browser'].includes(id)&&this.leaf('terminal')?'terminal':'conversation';
      this.move(id,this.leaf(target)?.id||this.leaves()[0]?.id,preferred,false);
    } else this.render();
  }
  detach(id) { this.nodes.delete(id); this.tree = this.remove(id); this.floating = this.floating.filter(x => x !== id); this.render(); }
  open(id, position = 'right') {
    if (!this.nodes.has(id)) return;
    const found = this.leaf(id); if (found) found.active = id;
    else this.move(id, this.leaves().find(l => l.tabs.includes('conversation'))?.id || this.leaves()[0]?.id, position);
    this.render();
  }
  close(id) {
    if (id === 'conversation') return;
    this.checkpoint();const item = this.nodes.get(id); this.tree = this.remove(id); this.floating = this.floating.filter(x => x !== id);
    if (item?.close) item.close(); else if (item) item.node.remove();
    this.maximized = null; this.render();
  }
  checkpoint() { const snapshot=this.snapshot(),encoded=JSON.stringify(snapshot),last=this.history.at(-1);if(!last||JSON.stringify(last)!==encoded){this.history.push(snapshot);if(this.history.length>30)this.history.shift();} }
  canUndo() { return this.history.length>0; }
  undo() { const previous=this.history.pop();return previous?this.restore(previous,false):false; }
  move(id, targetId, edge, record = true) {
    if(!this.nodes.has(id)||!['left','right','top','bottom','center','float'].includes(edge))return;
    const oldTarget = this.leaves().find(l => l.id === targetId);
    if (oldTarget?.tabs.length === 1 && oldTarget.tabs[0] === id && edge !== 'float') return;
    if(id==='conversation'&&edge==='float')return;
    if(record)this.checkpoint();this.bridge.park();
    this.tree = this.remove(id); this.floating = this.floating.filter(x => x !== id);
    if (edge === 'float' && id !== 'conversation') { this.floating.push(id); this.render(); return; }
    const target = this.leaves().find(l => l.id === targetId) || this.leaves()[0];
    const fresh = { id: `leaf-${Date.now()}-${++this.serial}`, tabs: [id], active: id };
    if (!target) this.tree = fresh;
    else if (edge === 'center') { target.tabs.push(id); target.active = id; }
    else {
      const before = edge === 'left' || edge === 'top';
      const split = { axis: ['top','bottom'].includes(edge) ? 'column' : 'row', ratio: .5, first: before ? fresh : target, second: before ? target : fresh };
      this.tree = this.replace(target, split);
    }
    this.maximized = null; this.render();
  }
  reset() {
    this.checkpoint();
    this.tree = { id: 'conversation', tabs: ['conversation'], active: 'conversation' }; this.floating = []; this.floatBounds = {}; this.maximized = null;
    for (const id of this.nodes.keys()) if (id !== 'conversation') this.move(id, 'conversation', id === 'terminal' ? 'bottom' : 'right',false);
    this.render();
  }
  snapshot() { return structuredClone({ tree:this.tree, floating:this.floating, floatBounds:this.floatBounds }); }
  restore(snapshot, record = true) {
    const seen=new Set();
    if(!snapshot||!this.valid(snapshot.tree,seen)||!seen.has('conversation'))return false;
    if(record)this.checkpoint();this.bridge.park();this.tree=structuredClone(snapshot.tree);
    this.floating=Array.isArray(snapshot.floating)?snapshot.floating.filter(id=>typeof id==='string'&&id!=='conversation'&&!seen.has(id)):[];
    this.floatBounds=structuredClone(snapshot.floatBounds||{});this.maximized=null;this.render();return true;
  }
  applyPreset(name) {
    const available=id=>this.nodes.has(id), leaf=(id,tabs=[id])=>({id:`preset-${id}-${++this.serial}`,tabs:tabs.filter(available),active:tabs.filter(available)[0]});
    const split=(axis,ratio,first,second)=>({axis,ratio,first,second});
    const conversation=leaf('conversation');
    const terminal=available('terminal')?leaf('terminal'):null,changes=available('changes')?leaf('changes'):null,browser=available('browser')?leaf('browser'):null;
    let tree=conversation;
    if(name==='focus')tree=conversation;
    else if(name==='review')tree=changes?split('row',.58,conversation,changes):conversation;
    else if(name==='ide') { const tools=terminal&&changes?split('column',.55,terminal,changes):terminal||changes;tree=tools?split('row',.56,conversation,tools):conversation; }
    else if(name==='agent') { const sideTabs=['trajectory','tasks','approvals','agents'].filter(available);const side=sideTabs.length?leaf('agent-tabs',sideTabs):terminal;tree=side?split('row',.62,conversation,side):conversation; }
    else { const middle=terminal&&changes?split('column',.55,terminal,changes):terminal||changes;tree=middle?split('row',.48,conversation,middle):conversation;if(browser)tree=split('row',.72,tree,browser); }
    const included=new Set(this.leaves(tree).flatMap(x=>x.tabs));
    const extras=[...this.nodes.keys()].filter(id=>id!=='conversation'&&!included.has(id));
    if(extras.length){const target=this.leaves(tree).find(x=>x.tabs.includes('terminal'))||this.leaves(tree).at(-1);target.tabs.push(...extras);}
    this.checkpoint();this.bridge.park();this.tree=tree;this.floating=[];this.floatBounds={};this.maximized=null;this.render();return true;
  }
  saveNamed(name) { const value=name.trim().slice(0,60);if(!value)return false;try{const layouts=JSON.parse(localStorage.getItem('abdocode-native-named-layouts-v1')||'{}');layouts[value]=this.snapshot();localStorage.setItem('abdocode-native-named-layouts-v1',JSON.stringify(layouts));return true;}catch{return false;} }
  named() { try{return Object.keys(JSON.parse(localStorage.getItem('abdocode-native-named-layouts-v1')||'{}')).slice(0,24);}catch{return [];} }
  restoreNamed(name) { try{const layouts=JSON.parse(localStorage.getItem('abdocode-native-named-layouts-v1')||'{}');return this.restore(layouts[name]);}catch{return false;} }
  deleteNamed(name) { try{const layouts=JSON.parse(localStorage.getItem('abdocode-native-named-layouts-v1')||'{}');if(!(name in layouts))return false;delete layouts[name];localStorage.setItem('abdocode-native-named-layouts-v1',JSON.stringify(layouts));return true;}catch{return false;} }
  exportLayout() { return JSON.stringify({format:'abdocode-layout',version:1,layout:this.snapshot()},null,2); }
  importLayout(text) { try{if(typeof text!=='string'||text.length>131072)return false;const value=JSON.parse(text);if(value?.format!=='abdocode-layout'||value?.version!==1)return false;return this.restore(value.layout);}catch{return false;} }
  button(text, title, handler) { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.title = title; b.setAttribute('aria-label', title); b.onclick = handler; return b; }
  setConversationOnly(value) { if(this.conversationOnly===!!value)return;this.conversationOnly=!!value;this.render(); }
  render() {
    this.bridge.park();
    for(const observer of this.resizeObservers)observer.disconnect();this.resizeObservers=[];
    // Keep node identity, editor values, and all native listeners during reflow.
    for (const { node } of this.nodes.values()) if (node.parentNode) node.remove();
    this.host.replaceChildren();
    if (!this.tree) this.tree = { id: 'conversation', tabs: ['conversation'], active: 'conversation' };
    const minima = new WeakMap(), splitSizers = [];
    const mount = (node) => {
      if (node.axis) {
        const firstVisible=this.leaves(node.first).some(l=>l.tabs.some(id=>this.nodes.has(id)));
        const secondVisible=this.leaves(node.second).some(l=>l.tabs.some(id=>this.nodes.has(id)));
        // Saved positions for lazy/closed features remain metadata. They do
        // not reserve empty panes or cause disabled modules to be loaded.
        if(!firstVisible)return secondVisible?mount(node.second):document.createElement('div');
        if(!secondVisible)return mount(node.first);
        const split = document.createElement('div'); split.className = `nd-split nd-${node.axis}`;split.dir='ltr';
        const first = mount(node.first), last = mount(node.second); first.style.flex = `${node.ratio} 1 0`; last.style.flex = `${1-node.ratio} 1 0`;
        const handle = document.createElement('div'); handle.className = 'nd-splitter'; handle.tabIndex = 0; handle.setAttribute('role','separator'); handle.setAttribute('aria-orientation', node.axis === 'row' ? 'vertical' : 'horizontal'); handle.setAttribute('aria-label', this.label('Resize panels','تغيير حجم الألواح'));
        const apply = (v) => {
          if(!Number.isFinite(v))return;
          const dimension=node.axis==='row'?'width':'height', bounds=split.getBoundingClientRect();
          const a=minima.get(first)?.[dimension]||0,b=minima.get(last)?.[dimension]||0;
          const available=Math.max(a+b,bounds[dimension]-handle.getBoundingClientRect()[dimension]);
          const low=available>0?a/available:0,high=available>0?1-b/available:1;
          node.ratio=Math.max(.000001,Math.min(.999999,Math.min(high,Math.max(low,v))));
          first.style.flex = `${node.ratio} 1 0`; last.style.flex = `${1-node.ratio} 1 0`;
          handle.setAttribute('aria-valuemin',Math.ceil(low*100));handle.setAttribute('aria-valuemax',Math.floor(high*100));handle.setAttribute('aria-valuenow',Math.round(node.ratio*100));
        };
        splitSizers.push(()=>apply(node.ratio));
        handle.onpointerdown = e => { if(e.button !== 0)return;e.preventDefault(); this.checkpoint();this.bridge.park(); handle.setPointerCapture(e.pointerId); };
        handle.onpointermove = e => { if (!handle.hasPointerCapture(e.pointerId)) return; const r = split.getBoundingClientRect(),h=handle.getBoundingClientRect(); apply(node.axis === 'row' ? (e.clientX-r.left-h.width/2)/(r.width-h.width) : (e.clientY-r.top-h.height/2)/(r.height-h.height)); };
        const end = e => { if(handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId); this.save(); this.bridge.sync(); };
        handle.onpointerup = end; handle.onpointercancel = end;handle.onlostpointercapture=()=>{this.save();this.bridge.sync();};
        handle.onkeydown = e => { if((node.axis==='row'?['ArrowLeft','ArrowRight']:['ArrowUp','ArrowDown']).includes(e.key)){e.preventDefault();this.bridge.park();apply(node.ratio + (['ArrowLeft','ArrowUp'].includes(e.key)?-.04:.04));this.save();this.bridge.sync();} };
        split.append(first, handle, last); return split;
      }
      const leaf = document.createElement('section'); leaf.className = 'nd-leaf'; leaf.dir=document.documentElement.dir||'ltr';leaf.dataset.leaf = node.id;
      const bar = document.createElement('div'); bar.className = 'nd-tabs';
      const visible = node.tabs.filter(id => this.nodes.has(id));
      if (!visible.includes(node.active)) node.active = visible[0] || node.tabs[0];
      for (const id of visible) {
        const item = this.nodes.get(id);
        const tab = this.button(item.title || id, item.title || id, () => { node.active = id; this.render(); });
        tab.className = 'nd-tab' + (node.active === id ? ' active' : ''); tab.draggable = true; tab.dataset.panel = id;
        tab.ondragstart = e => { this.dragging = id; e.dataTransfer.setData('text/plain', id); this.bridge.park(); this.host.classList.add('nd-dragging'); };
        tab.ondragend = () => { this.dragging = null; this.host.classList.remove('nd-dragging'); this.render(); };
        bar.append(tab);
      }
      const actions = document.createElement('span'); actions.className = 'nd-actions';
      actions.append(this.button('⋮', this.label('Move panel','نقل اللوح'), e => {
        e.stopPropagation(); const old = leaf.querySelector('.nd-move-menu'); if(old){old.remove();this.bridge.sync();return;}this.bridge.park();
        const menu = document.createElement('div'); menu.className = 'nd-move-menu';
        for(const [edge,en,ar] of [['left','Move left','نقل لليسار'],['right','Move right','نقل لليمين'],['top','Move above','نقل للأعلى'],['bottom','Move below','نقل للأسفل'],['center','Group with conversation','ضم للمحادثة'],['float','Float panel','لوح عائم']]) {
          if(edge==='float'&&node.active==='conversation') continue;
          menu.append(this.button(this.label(en,ar),this.label(en,ar),()=>this.move(node.active,this.leaf('conversation')?.id,edge)));
        }
        leaf.append(menu);
      }), this.button('⤢', this.label('Maximize / restore','تكبير / استعادة'), () => {this.maximized = this.maximized === node.id ? null : node.id; this.render();}));
      if(node.active !== 'conversation') actions.append(this.button('×',this.label('Close panel','إغلاق اللوح'),()=>this.close(node.active)));
      bar.append(actions); leaf.append(bar);
      const body = document.createElement('div'); body.className = 'nd-body';
      for(const id of visible){ const item=this.nodes.get(id); const wrapper=document.createElement('div'); wrapper.className='nd-content'; wrapper.hidden=id!==node.active; wrapper.dataset.panel=id; body.append(wrapper); if(item.slotId) this.bridge.relocate(item.slotId,wrapper); else wrapper.append(item.node); }
      leaf.append(body);
      const zones = document.createElement('div'); zones.className='nd-dropzones';
      for(const edge of ['left','right','top','bottom','center']) { const z=document.createElement('div'); z.className='nd-drop '+edge; z.textContent=edge==='center'?'+':' '; z.ondragover=e=>{if(this.dragging){e.preventDefault();z.classList.add('over');}};z.ondragleave=()=>z.classList.remove('over');z.ondrop=e=>{if(!this.dragging)return;e.preventDefault();e.stopPropagation();const id=this.dragging;this.dragging=null;this.host.classList.remove('nd-dragging');this.move(id,node.id,edge);};zones.append(z); }
      leaf.append(zones); if(this.maximized === node.id)leaf.classList.add('nd-maximized'); return leaf;
    };
    const visibleTree=this.conversationOnly?{id:'chat-conversation',tabs:['conversation'],active:'conversation'}:this.tree;
    const canvas=mount(visibleTree);this.host.append(canvas);
    // A split's minimum is the sum of its children along its axis. Without
    // this, nested flex items shrink below their leaves and overlap siblings.
    // Measure the actual stylesheet so media-query minima stay authoritative.
    const measure = element => {
      let size;
      if(element.classList.contains('nd-split')) {
        const [a,handle,b]=element.children,first=measure(a),last=measure(b),gap=handle.getBoundingClientRect();
        size=element.classList.contains('nd-row')?{width:first.width+last.width+gap.width,height:Math.max(first.height,last.height)}:{width:Math.max(first.width,last.width),height:first.height+last.height+gap.height};
        element.style.minWidth=size.width+'px';element.style.minHeight=size.height+'px';
      } else {
        const style=getComputedStyle(element),borderBox=style.boxSizing==='border-box';
        const extra=axis=>borderBox?0:axis==='width'?(parseFloat(style.borderLeftWidth)||0)+(parseFloat(style.borderRightWidth)||0)+(parseFloat(style.paddingLeft)||0)+(parseFloat(style.paddingRight)||0):(parseFloat(style.borderTopWidth)||0)+(parseFloat(style.borderBottomWidth)||0)+(parseFloat(style.paddingTop)||0)+(parseFloat(style.paddingBottom)||0);
        size={width:(parseFloat(style.minWidth)||160)+extra('width'),height:(parseFloat(style.minHeight)||100)+extra('height')};
      }
      minima.set(element,size);return size;
    };
    const fit=()=>{if(!this.host.getClientRects().length)return;measure(canvas);for(const size of [...splitSizers].reverse())size();};fit();
    const canvasObserver=new ResizeObserver(()=>{fit();this.bridge.sync();});canvasObserver.observe(this.host);this.resizeObservers.push(canvasObserver);
    for(const id of this.conversationOnly?[]:this.floating) { const item=this.nodes.get(id);if(!item)continue;
      const frame=document.createElement('section');frame.className='nd-floating';frame.dir=document.documentElement.dir||'ltr';frame.dataset.panel=id;frame.style.resize='none';
      const stored=this.floatBounds[id]||{left:innerWidth*.18,top:innerHeight*.14,width:480,height:360};
      const width=Math.max(250,Math.min(innerWidth-20,stored.width)),height=Math.max(180,Math.min(innerHeight-60,stored.height));
      const left=Math.max(0,Math.min(innerWidth-width,stored.left)),top=Math.max(40,Math.min(innerHeight-height,stored.top));
      Object.assign(frame.style,{left:left+'px',top:top+'px',width:width+'px',height:height+'px'});
      const remember=()=>{const r=frame.getBoundingClientRect();this.floatBounds[id]={left:r.left,top:r.top,width:r.width,height:r.height};this.save();};
      const head=document.createElement('div');head.className='nd-tabs';head.textContent=item.title||id;
      head.append(this.button('↙',this.label('Dock','إرساء'),()=>this.move(id,this.leaf('conversation')?.id,'right')),this.button('×',this.label('Close','إغلاق'),()=>this.close(id)));frame.append(head);
      const body=document.createElement('div');body.className='nd-body';body.style.paddingBottom='14px';frame.append(body);
      if(item.slotId)this.bridge.relocate(item.slotId,body);else body.append(item.node);
      let start;
      head.onpointerdown=e=>{if(e.button!==0||e.target.closest('button'))return;e.preventDefault();this.checkpoint();this.bridge.park();head.setPointerCapture(e.pointerId);const r=frame.getBoundingClientRect();start={x:e.clientX,y:e.clientY,left:r.left,top:r.top};};
      head.onpointermove=e=>{if(!head.hasPointerCapture(e.pointerId))return;frame.style.left=Math.max(0,Math.min(innerWidth-frame.offsetWidth,start.left+e.clientX-start.x))+'px';frame.style.top=Math.max(40,Math.min(innerHeight-60,start.top+e.clientY-start.y))+'px';};
      const finishDrag=e=>{if(head.hasPointerCapture(e.pointerId))head.releasePointerCapture(e.pointerId);start=undefined;remember();this.bridge.sync();};
      head.onpointerup=finishDrag;head.onpointercancel=finishDrag;head.onlostpointercapture=()=>{start=undefined;remember();this.bridge.sync();};
      const resize=document.createElement('div');resize.className='nd-float-resize';resize.tabIndex=0;resize.setAttribute('role','separator');resize.setAttribute('aria-label',this.label('Resize floating panel','تغيير حجم اللوح العائم'));
      resize.style.cssText='position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;touch-action:none;z-index:5;border-right:3px solid #94a3b8;border-bottom:3px solid #94a3b8;box-sizing:border-box';
      const setSize=(w,h)=>{frame.style.width=Math.max(250,Math.min(innerWidth-frame.getBoundingClientRect().left-4,w))+'px';frame.style.height=Math.max(180,Math.min(innerHeight-frame.getBoundingClientRect().top-4,h))+'px';};
      let sizing;
      resize.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();this.checkpoint();this.bridge.park();resize.setPointerCapture(e.pointerId);sizing={x:e.clientX,y:e.clientY,w:frame.offsetWidth,h:frame.offsetHeight};};
      resize.onpointermove=e=>{if(resize.hasPointerCapture(e.pointerId))setSize(sizing.w+e.clientX-sizing.x,sizing.h+e.clientY-sizing.y);};
      const finishSize=e=>{if(resize.hasPointerCapture(e.pointerId))resize.releasePointerCapture(e.pointerId);sizing=undefined;remember();this.bridge.sync();};
      resize.onpointerup=finishSize;resize.onpointercancel=finishSize;resize.onlostpointercapture=()=>{sizing=undefined;remember();this.bridge.sync();};
      resize.onkeydown=e=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();this.bridge.park();setSize(frame.offsetWidth+(e.key==='ArrowLeft'?-20:e.key==='ArrowRight'?20:0),frame.offsetHeight+(e.key==='ArrowUp'?-20:e.key==='ArrowDown'?20:0));remember();this.bridge.sync();}};
      frame.append(resize);this.host.append(frame);
      const observer=new ResizeObserver(()=>{remember();if(!sizing&&!start)this.bridge.sync();});observer.observe(frame);this.resizeObservers.push(observer);
    }
    if(this.conversationOnly){
      // Keep SlotHost-owned panels connected so shell reconciliation preserves
      // their registrations, listeners and Code positions while Chat is open.
      const parked=document.createElement('div');parked.className='nd-chat-parked';parked.hidden=true;parked.inert=true;this.host.append(parked);
      for(const [id,item] of this.nodes)if(id!=='conversation'&&!item.node.isConnected){if(item.slotId)this.bridge.relocate(item.slotId,parked);else parked.append(item.node);}
    }
    this.save(); requestAnimationFrame(()=>this.bridge.sync());
  }
  save() { try{localStorage.setItem('abdocode-native-layout-v1',JSON.stringify({tree:this.tree,floating:this.floating,floatBounds:this.floatBounds}));}catch{} }
}
