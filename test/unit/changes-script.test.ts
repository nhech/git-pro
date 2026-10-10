import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

type TestEvent={key?:string;clientX?:number;clientY?:number;ctrlKey?:boolean;metaKey?:boolean;shiftKey?:boolean;preventDefault?:()=>void;target?:Element;data?:unknown};
class Element {
  static active:Element|undefined;tag:string;children:Element[]=[];text='';className='';id='';hidden=false;disabled=false;scrollTop=0;isConnected=true;tabIndex=-1;
  dataset:Record<string,string>={};attributes=new Map<string,string>();listeners=new Map<string,(event:TestEvent)=>void>();style:Record<string,string>={};parent?:Element;
  constructor(tag='div'){this.tag=tag;}
  get textContent():string{return this.text+this.children.map(child=>child.textContent).join('');}
  get childElementCount():number{return this.children.length;}
  set textContent(value:string){this.replaceChildren();this.text=String(value);}
  get classList(){return{add:(value:string)=>{if(!this.className.split(' ').includes(value))this.className=`${this.className} ${value}`.trim();},remove:(value:string)=>{this.className=this.className.split(' ').filter(item=>item!==value).join(' ');}};}
  append(...nodes:Element[]){for(const node of nodes){node.parent=this;this.children.push(node);}}
  replaceChildren(...nodes:Element[]){this.children.forEach(node=>{node.isConnected=false;});this.children=[];this.text='';this.append(...nodes);}
  remove(){this.parent?.children.splice(this.parent.children.indexOf(this),1);this.isConnected=false;}
  setAttribute(key:string,value:string){this.attributes.set(key,value);}getAttribute(key:string){return this.attributes.get(key);}
  addEventListener(type:string,callback:(event:TestEvent)=>void){this.listeners.set(type,callback);}
  focus(){Element.active=this;this.listeners.get('focus')?.({target:this});}
  contains(target:Element):boolean{return this===target||this.children.some(child=>child.contains(target));}
  matches(selector:string):boolean{
    if(selector==='button')return this.tag==='button';if(selector==='[data-key]')return Boolean(this.dataset.key);
    if(selector==='button[data-action]')return this.tag==='button'&&Boolean(this.dataset.action);
    const attr=/^\[data-key="([^"]+)"\]$/.exec(selector);if(attr)return this.dataset.key===attr[1];
    const action=/^\[data-action="([^"]+)"\]$/.exec(selector);if(action)return this.dataset.action===action[1];
    const menuAction=/^\[data-menu-action="([^"]+)"\]$/.exec(selector);if(menuAction)return this.dataset.menuAction===menuAction[1];return false;
  }
  querySelector(selector:string):Element|undefined{for(const child of this.children){if(child.matches(selector))return child;const nested=child.querySelector(selector);if(nested)return nested;}return undefined;}
  querySelectorAll(selector:string):Element[]{return this.children.flatMap(child=>[...(child.matches(selector)?[child]:[]),...child.querySelectorAll(selector)]);}
  closest(selector:string):Element|undefined{return this.matches(selector)?this:this.parent?.closest(selector);}
  getBoundingClientRect(){return{left:10,top:10,width:20,height:20};}
}

function createHarness(){
  Element.active=undefined;
  const ids=['rows','notice','selection-actions','selection-count','more'];const elements=new Map(ids.map(id=>[id,new Element()]));
  for(const [id,node] of elements)node.id=id;
  for(const action of ['stage','unstage','discard']){const button=new Element('button');button.dataset.action=action;elements.get('selection-actions')!.append(button);}
  const session='12345678-1234-4234-9234-123456789abc';const body=new Element('body');body.dataset.session=session;const sent:Record<string,unknown>[]=[],created:string[]=[];const listeners=new Map<string,(event:TestEvent)=>void>();
  const document={body,get activeElement(){return Element.active;},getElementById:(id:string)=>elements.get(id),createElement:(tag:string)=>{created.push(tag);return new Element(tag);},createElementNS:(namespace:string,tag:string)=>{assert.equal(namespace,'http://www.w3.org/2000/svg');created.push(tag);return new Element(tag);},addEventListener:(type:string,callback:(event:TestEvent)=>void)=>listeners.set(type,callback)};
  const windowListeners=new Map<string,(event:TestEvent)=>void>();const window={addEventListener:(type:string,callback:(event:TestEvent)=>void)=>windowListeners.set(type,callback)};
  runInNewContext(readFileSync('media/changes.js','utf8'),{document,window,innerWidth:320,innerHeight:640,acquireVsCodeApi:()=>({postMessage:(value:Record<string,unknown>)=>sent.push(value)})});
  const update=(rows:unknown[])=>windowListeners.get('message')!({data:{type:'state',session,repository:'demo',total:rows.length,message:'',rows}});
  const row=(key:string)=>elements.get('rows')!.querySelector(`[data-key="${key}"]`)!;
  const key=(node:Element,value:string,shiftKey=false)=>node.listeners.get('keydown')!({key:value,shiftKey,preventDefault:()=>undefined});
  return {session,body,sent,created,elements,listeners,windowListeners,update,row,key};
}

test('Changes script keeps status at the right, renders safe labels, supports multi-select and context actions',()=>{
  const {session,body,sent,created,elements,windowListeners}=createHarness();
  assert.equal(sent[0]?.type,'ready');assert.equal(sent[0]?.session,session);
  const group={key:'G',kind:'group',label:'Working Tree',group:'working',count:2,depth:0};
  windowListeners.get('message')!({data:{type:'state',session,repository:'demo',total:2,message:'',rows:[group,{key:'M1',kind:'file',label:'<img src=x>',group:'working',status:'Modified',depth:1,parent:'G'},{key:'U1',kind:'file',label:'notes.txt',group:'untracked',status:'Untracked',depth:1,parent:'G'}]}});
  assert.equal(elements.get('rows')!.children[0]!.tabIndex,0,'the tree has an initial keyboard entry point');assert.equal(elements.get('rows')!.children[1]!.tabIndex,-1);
  const modified=elements.get('rows')!.children[1]!;assert.match(modified.className,/state-modified/);assert.equal(modified.children[0]!.children[1]!.textContent,'<img src=x>');assert.equal(modified.children[1]!.textContent,'Modified');assert.equal(created.includes('img'),false);
  assert.match(readFileSync('media/changes.css','utf8'),/grid-template-columns:minmax\(0,1fr\) auto/,'CSS reserves a distinct right-hand status column');
  modified.listeners.get('click')!({ctrlKey:false,metaKey:false,shiftKey:false});assert.equal(sent.at(-1)?.type,'select');assert.equal(JSON.stringify(sent.at(-1)?.keys),JSON.stringify(['M1']));
  const contextEvent={preventDefault:()=>undefined,clientX:315,clientY:638};modified.listeners.get('contextmenu')!(contextEvent);
  const menu=body.children.find(node=>node.className==='context-menu')!;assert.ok(menu);assert.deepEqual(menu.querySelectorAll('button').map(node=>node.textContent),['Diff','Stage','File History','Copy Relative Path','Discard']);
  menu.children[1]!.listeners.get('click')!({});assert.equal(sent.at(-1)?.type,'action');assert.equal(sent.at(-1)?.action,'stage');assert.equal(JSON.stringify(sent.at(-1)?.keys),JSON.stringify(['M1']));
  const large=Array.from({length:250},(_,index)=>({key:`K${index}`,kind:'file',label:`file-${index}`,group:'working',status:'Modified',depth:0}));
  windowListeners.get('message')!({data:{type:'state',session,repository:'demo',total:250,message:'',rows:large}});assert.equal(elements.get('rows')!.children.length,200);assert.match(elements.get('more')!.textContent,/50 remaining/);
  elements.get('more')!.listeners.get('click')!({});assert.equal(elements.get('rows')!.children.length,250);
});

test('Changes keyboard stays within mounted rows, recovers removed focus and retains toolbar focus on refresh',()=>{
  const {elements,update,row,key}=createHarness();
  const files=Array.from({length:250},(_,index)=>({key:`K${index}`,kind:'file',label:`file-${index}`,group:'working',status:'Modified',depth:0}));
  update(files);row('K0').focus();key(row('K0'),'End');assert.equal(Element.active?.dataset.key,'K199');
  key(row('K199'),'ArrowDown');assert.equal(Element.active?.dataset.key,'K199','arrows do not target rows outside the current page');
  update(files.slice(200));assert.equal(Element.active?.dataset.key,'K200','a removed focused entry restores to a current entry');
  assert.equal(elements.get('rows')!.children.filter(node=>node.tabIndex===0).length,1);
  const toolbar=elements.get('selection-actions')!.children[0]!;toolbar.focus();update(files.slice(210));assert.equal(Element.active,toolbar,'background refresh leaves toolbar focus alone');
  assert.equal(elements.get('rows')!.children.filter(node=>node.tabIndex===0).length,1,'stale key never removes keyboard entry point');
});

test('Changes disclosure navigates folders, collapses descendants and pages visible rows',()=>{
  const {elements,update,row,key}=createHarness();
  update([{key:'G',kind:'group',label:'Working Tree',group:'working',count:220,depth:0},{key:'F',kind:'folder',label:'src',group:'working',depth:1,parent:'G'},...Array.from({length:220},(_,index)=>({key:`K${index}`,kind:'file',label:`file-${index}`,group:'working',status:'Modified',depth:2,parent:'F'})),{key:'U',kind:'group',label:'Untracked',group:'untracked',count:1,depth:0},{key:'U1',kind:'file',label:'notes.txt',group:'untracked',status:'Untracked',depth:1,parent:'U'}]);
  row('F').focus();key(row('F'),'ArrowLeft');assert.equal(row('F').getAttribute('aria-expanded'),'false');assert.equal(elements.get('rows')!.children.length,4);assert.equal(elements.get('more')!.hidden,true,'collapsed files do not consume the page');
  key(row('F'),'ArrowLeft');assert.equal(Element.active?.dataset.key,'G');key(row('G'),'ArrowRight');assert.equal(Element.active?.dataset.key,'F');
  key(row('F'),'ArrowRight');assert.equal(row('F').getAttribute('aria-expanded'),'true');assert.equal(elements.get('rows')!.children.length,200);key(row('F'),'ArrowRight');assert.equal(Element.active?.dataset.key,'K0');
  key(row('K0'),'ArrowLeft');assert.equal(Element.active?.dataset.key,'F');
  row('F').listeners.get('click')!({target:row('F').children[0]!.children[0]!});assert.equal(row('F').getAttribute('aria-expanded'),'false','folder disclosure click collapses instead of selecting');
  assert.match(readFileSync('media/changes.css','utf8'),/\[hidden\]\{display:none!important\}/,'hidden selection actions override display:flex in real CSS');
});

test('Changes menu keeps reads on the clicked row, validates bulk selection and closes after refresh',()=>{
  const {session,body,sent,elements,update,row,key,windowListeners}=createHarness();
  const files=[{key:'W',kind:'file',label:'working.txt',group:'working',status:'Modified',depth:0},{key:'S',kind:'file',label:'staged.txt',group:'staged',status:'Modified',depth:0},{key:'U',kind:'file',label:'new.txt',group:'untracked',status:'Untracked',depth:0}];
  update(files);row('W').listeners.get('click')!({});row('U').listeners.get('click')!({ctrlKey:true});
  row('W').listeners.get('contextmenu')!({preventDefault:()=>undefined,clientX:10,clientY:10});let menu=body.children[0]!;
  assert.equal(menu.children.find(node=>node.textContent==='Discard 2 Selected')?.disabled,true,'untracked entry cannot be discarded');
  key(menu,'End');assert.equal(Element.active?.textContent,'Copy Relative Path');key(menu,'Home');assert.equal(Element.active?.textContent,'Diff');
  menu.children[0]!.listeners.get('click')!({});assert.equal(JSON.stringify(sent.at(-1)?.keys),JSON.stringify(['W']),'Diff uses clicked row even with a bulk selection');
  row('S').listeners.get('click')!({ctrlKey:true});row('W').listeners.get('contextmenu')!({preventDefault:()=>undefined,clientX:10,clientY:10});menu=body.children[0]!;
  assert.equal(menu.children.find(node=>node.textContent==='Stage 3 Selected')?.disabled,true,'mixed staged/working selection cannot stage');
  const retainedFocus=Element.active;update(files);assert.equal(body.children[0],menu,'identical polling snapshots keep the action menu');assert.equal(Element.active,retainedFocus,'unchanged polling does not replace focused elements');
  update(files.map(file=>file.key==='W'?{...file,status:'Deleted'}:file));assert.equal(body.children.length,0,'changed snapshot removes a stale action menu');assert.equal(Element.active?.dataset.key,'W');
  windowListeners.get('message')!({data:{type:'busy',session,busy:true}});const before=sent.length;key(row('W'),'Enter');assert.equal(sent.length,before,'busy rows cannot submit another action');
  assert.equal(elements.get('selection-actions')!.children.every(button=>button.disabled),true,'selected-entry toolbar reflects host busy state');
  windowListeners.get('message')!({data:{type:'state',session:'different-session',rows:[]}});assert.ok(row('W'),'foreign-session updates are ignored');
});

test('Changes range selections respect the host limit and group menus keep the clicked identity',()=>{
  const {body,sent,update,row,key}=createHarness();
  update(Array.from({length:200},(_,index)=>({key:`K${index}`,kind:'file',label:`file-${index}`,group:'working',status:'Modified',depth:0})));
  row('K0').listeners.get('click')!({});key(row('K0'),'End',true);assert.equal((sent.at(-1)?.keys as unknown[]).length,100,'Shift range is bounded by protocol capacity');
  update([{key:'G',kind:'group',group:'untracked',label:'Untracked',count:1,depth:0},{key:'U',kind:'file',group:'untracked',label:'new.txt',status:'Untracked',parent:'G',depth:1}]);
  row('G').listeners.get('contextmenu')!({preventDefault:()=>undefined,clientX:10,clientY:10});const menu=body.children[0]!;assert.equal(menu.children[0]!.textContent,'Stage Untracked');menu.children[0]!.listeners.get('click')!({});assert.equal(sent.at(-1)?.key,'G');assert.equal(JSON.stringify(sent.at(-1)?.keys),JSON.stringify(['G']));
});

test('Changes menu separates Discard, keeps decorative icons out of names and returns focus without dispatch',()=>{
  const {body,sent,listeners,update,row,key}=createHarness();
  update([{key:'W',kind:'file',label:'<svg onload=alert(1)>.txt',group:'working',status:'Modified',depth:0}]);
  row('W').listeners.get('contextmenu')!({preventDefault:()=>undefined,clientX:10,clientY:10});
  const menu=body.children[0]!,buttons=menu.querySelectorAll('button'),separator=menu.children.find(node=>node.getAttribute('role')==='separator')!;
  assert.ok(separator);assert.equal(menu.children.indexOf(separator),4);assert.equal(separator.tabIndex,-1);assert.equal(separator.listeners.size,0);
  assert.equal(separator.getAttribute('aria-orientation'),'horizontal');
  for(const button of buttons){
    const icon=button.children[0]!;
    assert.equal(icon.tag,'svg');assert.equal(icon.getAttribute('aria-hidden'),'true');assert.equal(icon.getAttribute('focusable'),'false');
    assert.equal(icon.textContent,'');assert.ok(icon.children.every(node=>node.tag==='path'&&!node.getAttribute('onload')));
    assert.equal(button.dataset.action,undefined,'custom menu cannot enter the delegated toolbar handler');
  }
  key(menu,'End');assert.equal(Element.active?.textContent,'Discard');key(menu,'ArrowUp');assert.equal(Element.active?.textContent,'Copy Relative Path','arrows skip separator');
  key(menu,'ArrowDown');assert.equal(Element.active?.textContent,'Discard');
  const before=sent.length;key(menu,'Tab');assert.equal(body.children.length,0);assert.equal(Element.active?.dataset.key,'W');assert.equal(sent.length,before);
  row('W').listeners.get('contextmenu')!({preventDefault:()=>undefined,clientX:10,clientY:10});
  const copy=body.children[0]!.querySelector('[data-menu-action="copyPath"]')!;copy.listeners.get('click')!({});
  assert.equal(sent.at(-1)?.action,'copyPath');assert.equal(JSON.stringify(sent.at(-1)?.keys),JSON.stringify(['W']));
  const after=sent.length;listeners.get('click')!({target:copy});assert.equal(sent.length,after,'bubbled menu click does not dispatch a second toolbar action');
});

test('Changes menu preserves action scopes across files and folders with Discard last only for working changes',()=>{
  const {body,update,row}=createHarness();
  const cases=[
    ['working','file',['diff','stage','history','copyPath','discard']],
    ['staged','file',['diff','unstage','history','copyPath']],
    ['untracked','file',['diff','stage','history','copyPath']],
    ['conflicts','file',['resolve','history','copyPath']],
    ['working','folder',['stage','discard']],['staged','folder',['unstage']],['untracked','folder',['stage']],
  ] as const;
  for(const [group,kind,actions] of cases){
    update([{key:'entry',kind,group,label:'entry',status:'Modified',depth:0}]);
    row('entry').listeners.get('contextmenu')!({preventDefault:()=>undefined,clientX:10,clientY:10});
    const menu=body.children[0]!;
    assert.deepEqual(menu.querySelectorAll('button').map(node=>node.dataset.menuAction),actions);
    assert.equal(menu.children.filter(node=>node.getAttribute('role')==='separator').length,group==='working'?1:0);
  }
});

test('Changes rows offer native-style inline actions that act on the row without changing the selection',()=>{
  const {sent,update,row}=createHarness();
  const rows=[{key:'S',kind:'group',label:'Staged',group:'staged',count:1,depth:0},{key:'S1',kind:'file',label:'staged.ts',group:'staged',status:'Added',depth:1,parent:'S'},
    {key:'W',kind:'group',label:'Working Tree',group:'working',count:2,depth:0},{key:'W1',kind:'file',label:'app.ts',group:'working',status:'Modified',depth:1,parent:'W'},{key:'W2',kind:'file',label:'gone.ts',group:'working',status:'Deleted',depth:1,parent:'W'},
    {key:'U',kind:'group',label:'Untracked',group:'untracked',count:1,depth:0},{key:'U1',kind:'file',label:'notes.txt',group:'untracked',status:'Untracked',depth:1,parent:'U'},
    {key:'C',kind:'group',label:'Conflicts',group:'conflicts',count:1,depth:0},{key:'C1',kind:'file',label:'both.ts',group:'conflicts',status:'Conflict',depth:1,parent:'C'}];
  update(rows);
  const bar=(key:string)=>row(key).children.find(child=>child.className==='row-actions');
  const actions=(key:string)=>Array.from(bar(key)?.children.map(button=>button.dataset.inlineAction)??[]);
  assert.deepEqual(actions('W1'),['diff','open','discard','stage']);assert.deepEqual(actions('W2'),['diff','discard','stage'],'a deleted file cannot be opened');
  assert.deepEqual(actions('S1'),['diff','open','unstage']);assert.deepEqual(actions('U1'),['open','stage']);assert.deepEqual(actions('C1'),['open','resolve']);
  assert.deepEqual(actions('W'),['stageAll']);assert.deepEqual(actions('S'),['unstageAll']);
  assert.equal(row('W1').children[1]!.className.split(' ')[0],'status','the status stays the second child; CSS orders the bar before it');
  assert.equal(bar('W1')!.getAttribute('aria-hidden'),'true');assert.ok(bar('W1')!.children.every(button=>button.tabIndex===-1&&button.getAttribute('aria-label')&&!button.dataset.action),'inline buttons stay out of the tab order and the bulk toolbar');
  const click=(key:string,id:string)=>{let stopped=false;bar(key)!.children.find(button=>button.dataset.inlineAction===id)!.listeners.get('click')!({preventDefault:()=>undefined,stopPropagation:()=>{stopped=true;}} as never);return stopped;};
  assert.ok(click('W1','open'));assert.equal(JSON.stringify({action:sent.at(-1)?.action,key:sent.at(-1)?.key,keys:sent.at(-1)?.keys}),JSON.stringify({action:'open',key:'W1',keys:['W1']}));
  assert.equal(row('W1').getAttribute('aria-selected'),'false','an inline action does not select the row');
  click('W1','stage');assert.equal(sent.at(-1)?.action,'stage');click('W','stageAll');assert.equal(JSON.stringify({action:sent.at(-1)?.action,keys:sent.at(-1)?.keys}),JSON.stringify({action:'stageAll',keys:['W']}));
  // With several rows selected, an inline bulk action on one of them applies to the selection.
  row('W1').listeners.get('click')!({target:row('W1')});row('W2').listeners.get('click')!({target:row('W2'),ctrlKey:true});
  click('W2','discard');assert.equal(JSON.stringify(sent.at(-1)?.keys),JSON.stringify(['W1','W2']));
});
