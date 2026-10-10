import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { layoutGraph } from '../../src/webviews/graph/graph-layout';
const ROW=24; // History virtual row height (media/history.js ROW).
class Element {
  static active:Element|undefined;isConnected=true;tag='button';
  children:Element[]=[];textContent='';className='';id='';value='12';title='';hidden=false;open=false;disabled=false;scrollTop=0;clientHeight=12*ROW;clientWidth=800;
  style:Record<string,string>={};dataset:Record<string,string>={};attributes=new Map<string,string>();listeners=new Map<string,(event:Record<string,unknown>)=>void>();
  append(...children:Element[]){for(const child of children){const index=this.children.indexOf(child);if(index>=0)this.children.splice(index,1);this.children.push(child);}}prepend(...children:Element[]){this.children=this.children.filter(child=>!children.includes(child));this.children.unshift(...children);}replaceChildren(){const disconnect=(node:Element)=>{node.isConnected=false;node.children.forEach(disconnect);};this.children.forEach(disconnect);this.children=[];}
  focus(){Element.active=this;}
  setAttribute(key:string,value:string){this.attributes.set(key,value);}getAttribute(key:string){return this.attributes.get(key);}removeAttribute(key:string){this.attributes.delete(key);}
  addEventListener(type:string,callback:(event:Record<string,unknown>)=>void){this.listeners.set(type,callback);}
}
test('real history script bounds mounted rows, renders hostile labels as text, selects by keys and validates sessions',()=>{
  const elements=new Map(['viewport','rows','spacer','details','status','filters','compare','more','pagination','filter-disclosure','filter-summary','snapshot','zoom','workspace','cancel-read'].map(id=>[id,new Element()]));
  const sent:Record<string,unknown>[]=[],createdTags:string[]=[];let receive:((event:{data:unknown})=>void)|undefined;
  const allElements=()=>{const nodes:Element[]=[];const visit=(node:Element)=>{nodes.push(node);node.children.forEach(visit);};elements.forEach(visit);return nodes;};
  const document={body:{dataset:{session:'s'}},get activeElement(){return Element.active;},getElementById:(id:string)=>elements.get(id),createElement:(tag:string)=>{createdTags.push(tag);const node=new Element();node.tag=tag;return node;},createElementNS:(_ns:string,tag:string)=>{createdTags.push(tag);const node=new Element();node.tag=tag;return node;},querySelectorAll:(selector:string)=>allElements().filter(node=>selector==='[data-focus-key]'?Boolean(node.dataset.focusKey):['button','input','select','textarea'].includes(node.tag))};
  runInNewContext(readFileSync('media/history.js','utf8'),{document,window:{addEventListener:(type:string,callback:typeof receive)=>{if(type==='message')receive=callback;}},acquireVsCodeApi:()=>({postMessage:(value:Record<string,unknown>)=>sent.push(value)})});
  const commits=Array.from({length:2000},(_,index)=>({oid:(index+1).toString(16).padStart(40,'0'),parents:index<1999?[(index+2).toString(16).padStart(40,'0')]:[],subject:index?'Subject':'<img onerror=alert(1)>',author:'Fixture',email:'fixture@example.invalid',timestamp:1700000000}));
  const graph=layoutGraph(commits);receive!({data:{type:'page',session:'s',commits,rows:graph.rows,tips:[commits[0]!.oid],refs:[{name:'<script>ref</script>',oid:commits[0]!.oid}],filters:{},hasMore:false}});
  assert.equal(elements.get('rows')!.children.length,15);assert.equal(createdTags.includes('img'),false);assert.equal(createdTags.includes('script'),false);
  assert.match(elements.get('rows')!.children[0]!.getAttribute('aria-label')!,/<script>ref<\/script>/);
  const pagination=elements.get('pagination')!,details=elements.get('details')!,more=elements.get('more')!;
  assert.equal(details.children[0]!.className,'details-guidance');assert.match(pagination.children[1]!.textContent,/End of matching history/);
  const firstRow=elements.get('rows')!.children[0]!,meta=firstRow.children.at(-1)!;assert.equal(meta.children[0]!.textContent,'Fixture');assert.ok(meta.children[2]!.textContent.length>0);assert.ok(meta.title.includes(meta.children[2]!.textContent));assert.ok(firstRow.getAttribute('aria-label')!.includes(meta.children[2]!.textContent));
  const page={type:'page',session:'s',commits,rows:graph.rows,tips:[commits[0]!.oid],refs:[],filters:{},hasMore:false};receive!({data:{...page,limitReached:true}});assert.match(pagination.children[1]!.textContent,/Load limit reached/);
  receive!({data:{type:'busy',session:'s',busy:true}});receive!({data:{type:'busy',session:'s',busy:false}});assert.match(pagination.children[1]!.textContent,/Narrow the filters/);assert.equal(more.disabled,true);
  receive!({data:{type:'reset',session:'s'}});assert.equal(details.children[0]!.className,'details-guidance');assert.equal(pagination.hidden,true);assert.equal(more.dataset.available,'false');
  receive!({data:{...page,commits:[],rows:[],limitReached:false}});assert.match(pagination.children[1]!.textContent,/0 commits loaded · End/);receive!({data:page});
  elements.get('viewport')!.listeners.get('keydown')!({key:'End',preventDefault:()=>undefined});assert.equal(sent.at(-1)?.oid,commits.at(-1)!.oid);assert.ok(elements.get('rows')!.children.length<=15);
  receive!({data:{type:'busy',session:'s',busy:true}});const before=sent.length;elements.get('viewport')!.listeners.get('keydown')!({key:'Home',preventDefault:()=>undefined});assert.equal(sent.length,before);
  receive!({data:{type:'busy',session:'expired',busy:false}});assert.equal(elements.get('filters')!.disabled,true);
  receive!({data:{type:'busy',session:'s',busy:false}});elements.get('zoom')!.listeners.get('change')!({target:{value:'18'}});assert.equal(elements.get('spacer')!.style.minWidth,'calc(36px + var(--history-row-reserve, 400px))','CSS must use the current containing width instead of pinning a measured viewport width');
  const files=Array.from({length:5000},(_,index)=>({status:'M',path:`file-${index}.txt`}));receive!({data:{type:'comparison',session:'s',result:{from:commits[1]!.oid,to:commits[0]!.oid,files,stats:[],leftCommits:commits.slice(0,40),leftCount:40,rightCommits:[],rightCount:0}}});
  const leftCard=()=>elements.get('details')!.children.find(node=>node.className==='comparison-sides')!.children[0]!;
  assert.ok(elements.get('rows')!.children.every(row=>row.getAttribute('aria-selected')==='false'),'Compare must clear the preceding commit selection');
  const sideList=leftCard().children[1]!;assert.equal(sideList.children.length,25);assert.match(sideList.children[0]!.children[0]!.textContent,/<img onerror/);sideList.children[0]!.children[0]!.listeners.get('click')!({});assert.equal(sent.at(-1)?.oid,commits[0]!.oid);
  const sideNavigation=leftCard().children[2]!;assert.equal(sideNavigation.children[0]!.disabled,true);sideNavigation.children[1]!.listeners.get('click')!({});assert.equal(sent.at(-1)?.type,'comparePage');assert.equal(sent.at(-1)?.side,'left');assert.equal(sent.at(-1)?.offset,25);assert.equal(sent.at(-1)?.from,undefined);
  assert.equal(elements.get('workspace')!.className,'split comparing');const layoutButton=elements.get('details')!.children[1]!.children[0]!,beforeLayout=sent.length;layoutButton.listeners.get('click')!({});assert.equal(elements.get('workspace')!.className,'split');assert.equal(Element.active,elements.get('viewport'));assert.equal(sent.length,beforeLayout);
  const fileList=elements.get('details')!.children.at(-1)!,navigation=elements.get('details')!.children.at(-2)!;
  assert.equal(fileList.children.length,200);assert.equal(navigation.children[0]!.disabled,true);
  navigation.children[1]!.listeners.get('click')!({});assert.equal(fileList.children.length,200);fileList.children[0]!.children[0]!.listeners.get('click')!({});assert.equal(sent.at(-1)?.index,200);
  fileList.children[0]!.children[1]!.listeners.get('click')!({});assert.equal(sent.at(-1)?.type,'workingDiff');assert.equal(sent.at(-1)?.index,200);assert.equal(sent.at(-1)?.path,undefined);
  receive!({data:{type:'busy',session:'s',busy:true}});navigation.children[1]!.listeners.get('click')!({});assert.match(navigation.children[2]!.textContent,/201–400/);
  receive!({data:{type:'comparison',session:'expired',result:{files:[],stats:[]}}});assert.equal(fileList.children.length,200);
  const beforePage=sent.length;sideNavigation.children[1]!.listeners.get('click')!({});assert.equal(sent.length,beforePage);
  receive!({data:{type:'busy',session:'s',busy:false}});sideNavigation.children[1]!.focus();receive!({data:{type:'busy',session:'s',busy:true}});receive!({data:{type:'comparison',session:'s',result:{from:commits[1]!.oid,to:commits[0]!.oid,files,stats:[],leftCommits:commits.slice(25,40),leftCount:40,leftOffset:25,rightCommits:[],rightCount:0,rightOffset:0}}});receive!({data:{type:'busy',session:'s',busy:false}});
  const finalNavigation=leftCard().children[2]!;assert.equal(finalNavigation.children[1]!.disabled,true);assert.match(finalNavigation.children[2]!.textContent,/26–40 of 40/);assert.equal(Element.active,finalNavigation.children[0]);finalNavigation.children[0]!.listeners.get('click')!({});assert.equal(sent.at(-1)?.offset,0);assert.equal(elements.get('workspace')!.className,'split','Side paging retains the layout choice');
  const retainedFiles=elements.get('details')!.children.at(-1)!;retainedFiles.children[0]!.children[0]!.listeners.get('click')!({});assert.equal(sent.at(-1)?.index,200);assert.match(elements.get('details')!.children.at(-2)!.children[2]!.textContent,/201–400/);
  const expandButton=elements.get('details')!.children[1]!.children[0]!;expandButton.listeners.get('click')!({});assert.equal(elements.get('workspace')!.className,'split comparing');assert.equal(Element.active,elements.get('details')!.children[0]);
  const selectedSideButton=leftCard().children[1]!.children[0]!.children[0]!;selectedSideButton.focus();receive!({data:{type:'busy',session:'s',busy:true}});receive!({data:{type:'details',session:'s',details:{commit:commits[25],parent:commits[26]!.oid,refs:[],message:'Details',files,stats:[]},parentIndex:0}});receive!({data:{type:'busy',session:'s',busy:false}});assert.equal(Element.active,elements.get('details')!.children[0]);assert.equal(Element.active?.getAttribute('tabindex'),'-1');assert.equal(elements.get('workspace')!.className,'split');
  elements.get('details')!.children.at(-1)!.children[0]!.children[0]!.listeners.get('click')!({});assert.equal(sent.at(-1)?.index,0);
  receive!({data:{type:'busy',session:'s',busy:true}});elements.get('viewport')!.disabled=false;elements.get('viewport')!.focus();receive!({data:{type:'busy',session:'s',busy:false}});assert.equal(Element.active,elements.get('viewport'),'A deliberate focus move during loading must remain intact');
});

test('History row slots rebind actions, refs, merge geometry and labels without retaining detached pages',()=>{
  const ids=['viewport','rows','spacer','details','status','filters','compare','more','pagination','filter-disclosure','filter-summary','snapshot','zoom','workspace','cancel-read'];
  const elements=new Map(ids.map(id=>[id,new Element()]));let receive!:(event:{data:unknown})=>void;const sent:Record<string,unknown>[]=[],tags:string[]=[];
  const create=(tag:string)=>{tags.push(tag);const n=new Element();n.tag=tag;return n;};
  runInNewContext(readFileSync('media/history.js','utf8'),{document:{body:{dataset:{session:'s'}},getElementById:(id:string)=>elements.get(id),createElement:create,createElementNS:(_ns:string,tag:string)=>create(tag),querySelectorAll:()=>[]},window:{addEventListener:(type:string,callback:typeof receive)=>{if(type==='message')receive=callback;}},acquireVsCodeApi:()=>({postMessage:(value:Record<string,unknown>)=>sent.push(value)})});
  const commits=Array.from({length:2000},(_,index)=>({oid:(index+1).toString(16).padStart(40,'0'),parents:index<1999?[(index+2).toString(16).padStart(40,'0')]:[],subject:`Subject ${index}`,author:`Author ${index}`,timestamp:1700000000+index}));
  const graph=layoutGraph(commits),page={type:'page',session:'s',commits,rows:graph.rows,tips:[commits[0]!.oid],refs:[{name:'old-ref',oid:commits[0]!.oid}],filters:{},hasMore:false};
  receive({data:page});const rows=elements.get('rows')!,viewport=elements.get('viewport')!,initial=[...rows.children],svg=initial[0]!.children[0]!,initialCreated=tags.length;
  const dateNode=initial[0]!.children.at(-1)!.children[2]!;let dateValue=dateNode.textContent,dateWrites=0,graphWrites=0;
  Object.defineProperty(dateNode,'textContent',{get:()=>dateValue,set:(value:string)=>{dateWrites++;dateValue=value;}});
  for(const node of [svg,...svg.children]){const set=node.setAttribute.bind(node);node.setAttribute=(name,value)=>{graphWrites++;set(name,value);};}
  viewport.scrollTop=30*ROW;viewport.listeners.get('scroll')!({});assert.deepEqual(rows.children,initial,'The same mounted slots are reused for a distant full window');assert.equal(tags.length,initialCreated,'Linear graph scroll does not construct new DOM nodes');
  const index=29;assert.equal(dateWrites,0,'An unchanged displayed date must not replace its text node');assert.equal(graphWrites,0,'Unchanged SVG geometry must not receive repeated attribute writes');assert.equal(rows.children[0]!.id,initial[0]!.id);assert.equal(rows.children[0]!.children.at(-1)!.children[0]!.textContent,`Author ${index}`);rows.children[0]!.listeners.get('click')!({});assert.equal(sent.at(-1)?.oid,commits[index]!.oid,'A recycled slot must select its current OID');
  assert.equal(viewport.getAttribute('aria-activedescendant'),rows.children[0]!.id);assert.equal(rows.children[0]!.getAttribute('aria-selected'),'true');
  const replacement=commits.map((c,i)=>i===index?{...c,subject:'<img onerror=alert(1)>',author:'Changed author',timestamp:c.timestamp+86400,parents:[commits[index+1]!.oid,commits[index+2]!.oid]}:c);
  const changedRows=graph.rows.map((r,i)=>i===index?{...r,lane:1,edges:[{from:0,to:1,boundary:true},{from:1,to:2,boundary:false}]}:r);
  receive({data:{...page,commits:replacement,rows:changedRows,refs:[{name:'<script>new-ref</script>',oid:replacement[index]!.oid}]}});
  assert.equal(rows.children[0],initial[0]);assert.equal(dateWrites,1,'A changed date must update its reused text');assert.ok(graphWrites>0,'A changed graph must update its geometry');assert.match(initial[0]!.getAttribute('aria-label')!,/<script>new-ref<\/script>/);assert.doesNotMatch(initial[0]!.getAttribute('aria-label')!,/old-ref/);assert.equal(svg.children.length,3);assert.equal(svg.children[0]!.getAttribute('stroke-dasharray'),'3 2');assert.equal(svg.children[1]!.getAttribute('stroke-dasharray'),undefined);assert.equal(svg.children.at(-1)!.getAttribute('cx'),'18');assert.equal(tags.includes('img')||tags.includes('script'),false);
  receive({data:page});assert.equal(svg.children.length,2);assert.equal(svg.children[0]!.getAttribute('stroke-dasharray'),undefined);assert.equal(initial[0]!.children[1]!.hidden,true,'Old refs must clear on a page replacement');
  elements.get('zoom')!.listeners.get('change')!({target:{value:'18'}});assert.equal(svg.getAttribute('width'),'36');assert.equal(svg.children.at(-1)!.getAttribute('cx'),'9');
  receive({data:{type:'reset',session:'s'}});assert.equal(rows.children.length,0);const count=sent.length;initial[0]!.listeners.get('click')!({});assert.equal(sent.length,count,'Detached slots cannot send a stale selection');
  receive({data:{...page,commits:commits.slice(0,1),rows:graph.rows.slice(0,1)}});assert.equal(rows.children.length,1);assert.notEqual(rows.children[0],initial[0]);assert.equal(rows.children[0]!.getAttribute('aria-setsize'),'1');
});

test('History equal metadata skips visibility, tooltip and size writes while page replacements still update and clear refs',()=>{
  const ids=['viewport','rows','spacer','details','status','filters','compare','more','pagination','filter-disclosure','filter-summary','snapshot','zoom','workspace','cancel-read'];
  const elements=new Map(ids.map(id=>[id,new Element()]));let receive!:(event:{data:unknown})=>void;
  runInNewContext(readFileSync('media/history.js','utf8'),{document:{body:{dataset:{session:'s'}},getElementById:(id:string)=>elements.get(id),createElement:()=>new Element(),createElementNS:()=>new Element(),querySelectorAll:()=>[]},window:{addEventListener:(type:string,callback:typeof receive)=>{if(type==='message')receive=callback;}},acquireVsCodeApi:()=>({postMessage:()=>undefined})});
  const commits=Array.from({length:2000},(_,i)=>({oid:(i+1).toString(16).padStart(40,'0'),parents:[],subject:'Commit '+i,author:'Fixture',timestamp:1700000000})),graph=layoutGraph(commits),page={type:'page',session:'s',commits,rows:graph.rows,tips:[commits[0]!.oid],refs:[],filters:{},hasMore:false};
  receive({data:page});const row=elements.get('rows')!.children[0]!,badge=row.children[1]!,meta=row.children.at(-1)!,writes={hidden:0,badgeTitle:0,metaTitle:0,size:0};
  for(const [node,property,key]of [[badge,'hidden','hidden'],[badge,'title','badgeTitle'],[meta,'title','metaTitle']] as const){let value=node[property];Object.defineProperty(node,property,{get:()=>value,set:(next:string|boolean)=>{writes[key]++;value=next;}});}
  const set=row.setAttribute.bind(row);row.setAttribute=(name,value)=>{if(name==='aria-setsize')writes.size++;set(name,value);};
  const viewport=elements.get('viewport')!;viewport.scrollTop=30*ROW;viewport.listeners.get('scroll')!({});assert.equal(row.getAttribute('aria-posinset'),'30');assert.deepEqual(writes,{hidden:0,badgeTitle:0,metaTitle:0,size:0});assert.equal(row.getAttribute('aria-setsize'),'2000');
  const changed=commits.map((c,i)=>i===29?{...c,author:'Changed author',timestamp:c.timestamp+86400}:c),replacement={...page,commits:changed,refs:[{name:'changed-ref',oid:commits[29]!.oid}]};
  receive({data:replacement});assert.equal(badge.hidden,false);assert.equal(badge.title,'changed-ref');assert.ok(meta.title.startsWith('Changed author · '));assert.equal(meta.children[2]!.textContent,new Date(changed[29]!.timestamp*1000).toLocaleDateString());assert.deepEqual(writes,{hidden:1,badgeTitle:1,metaTitle:1,size:0});
  receive({data:replacement});assert.deepEqual(writes,{hidden:1,badgeTitle:1,metaTitle:1,size:0},'An equal replacement must not repeat metadata writes');
  receive({data:page});assert.equal(badge.hidden,true);assert.equal(badge.title,'');assert.ok(meta.title.startsWith('Fixture · '));assert.deepEqual(writes,{hidden:2,badgeTitle:2,metaTitle:2,size:0});
  receive({data:{...page,commits:commits.slice(0,1000),rows:graph.rows.slice(0,1000)}});assert.equal(row.getAttribute('aria-setsize'),'1000');assert.deepEqual(writes,{hidden:2,badgeTitle:2,metaTitle:2,size:1});
});

test('History reuses only equal local days within a draw, preserving default date text, boundaries and invalid values',()=>{
  const ids=['viewport','rows','spacer','details','status','filters','compare','more','pagination','filter-disclosure','filter-summary','snapshot','zoom','workspace','cancel-read'];
  const elements=new Map(ids.map(id=>[id,new Element()]));let receive!:(event:{data:unknown})=>void,calls=0;
  class CountingDate extends Date { override toLocaleDateString(...args:Parameters<Date['toLocaleDateString']>){calls++;return super.toLocaleDateString(...args);} }
  runInNewContext(readFileSync('media/history.js','utf8'),{Date:CountingDate,document:{body:{dataset:{session:'s'}},getElementById:(id:string)=>elements.get(id),createElement:()=>new Element(),createElementNS:()=>new Element(),querySelectorAll:()=>[]},window:{addEventListener:(type:string,callback:typeof receive)=>{if(type==='message')receive=callback;}},acquireVsCodeApi:()=>({postMessage:()=>undefined})});
  elements.get('viewport')!.clientHeight=17*ROW; // Preserve the original20-row date fixture independently of the smaller buffer.
  const first=new Date(2026,0,15,23,59,0).getTime()/1000,next=new Date(2026,0,16,0,1,0).getTime()/1000;
  const commits=Array.from({length:2000},(_,i)=>({oid:(i+1).toString(16).padStart(40,'0'),parents:[],subject:'Commit '+i,author:'Author',timestamp:i<5?first:i<10?next:i<18?first:i<20?Infinity:first})),graph=layoutGraph(commits),page={type:'page',session:'s',commits,rows:graph.rows,tips:[commits[0]!.oid],refs:[],filters:{},hasMore:false};
  const verify=(values:typeof commits,start:number)=>{for(const [i,row]of elements.get('rows')!.children.entries()){const expected=new Date(values[start+i]!.timestamp*1000).toLocaleDateString(),meta=row.children.at(-1)!;assert.equal(meta.children[2]!.textContent,expected);assert.equal(meta.title,'Author · '+expected);assert.ok(row.getAttribute('aria-label')!.endsWith(', '+expected));}};
  receive({data:page});assert.equal(calls,5,'Three local-day runs and two invalid dates need five formatting calls');verify(commits,0);assert.notEqual(new Date(first*1000).toLocaleDateString(),new Date(next*1000).toLocaleDateString(),'Fixture crosses local midnight');
  calls=0;const viewport=elements.get('viewport')!;viewport.scrollTop=30*ROW;viewport.listeners.get('scroll')!({});assert.equal(calls,1,'One contiguous day across distant rows formats once in this draw');verify(commits,29);
  calls=0;viewport.scrollTop=0;viewport.listeners.get('scroll')!({});assert.equal(calls,5,'Returning to an old window formats again; no cross-draw cache');verify(commits,0);
  const changed=commits.map((c,i)=>({...c,timestamp:i%2?next:first}));calls=0;receive({data:{...page,commits:changed}});assert.equal(calls,20,'Noncontiguous days must not share a stale run');verify(changed,0);
  calls=0;receive({data:{...page,commits:changed,session:'expired'}});assert.equal(calls,0,'A stale session cannot format or replace current rows');verify(changed,0);
  const replacement=commits.map(c=>({...c,timestamp:new Date(2026,3,5,12,30,0).getTime()/1000}));calls=0;receive({data:{...page,commits:replacement}});assert.equal(calls,1);verify(replacement,0);
  receive({data:{type:'reset',session:'s'}});assert.equal(elements.get('rows')!.children.length,0);calls=0;receive({data:page});assert.equal(calls,5);verify(commits,0);
});

test('History mounted IDs remain stable while positions, accessible names and current OID change',()=>{
  const ids=['viewport','rows','spacer','details','status','filters','compare','more','pagination','filter-disclosure','filter-summary','snapshot','zoom','workspace','cancel-read'];
  const elements=new Map(ids.map(id=>[id,new Element()]));let receive!:(event:{data:unknown})=>void;const sent:Record<string,unknown>[]=[];
  runInNewContext(readFileSync('media/history.js','utf8'),{document:{body:{dataset:{session:'s'}},getElementById:(id:string)=>elements.get(id),createElement:()=>new Element(),createElementNS:()=>new Element(),querySelectorAll:()=>[]},window:{addEventListener:(type:string,callback:typeof receive)=>{if(type==='message')receive=callback;}},acquireVsCodeApi:()=>({postMessage:(value:Record<string,unknown>)=>sent.push(value)})});
  const commits=Array.from({length:2000},(_,i)=>({oid:(i+1).toString(16).padStart(40,'0'),parents:i<1999?[(i+2).toString(16).padStart(40,'0')]:[],subject:`Subject ${i}`,author:`Author ${i}`,timestamp:1700000000}));
  const page={type:'page',session:'s',commits,rows:layoutGraph(commits).rows,tips:[commits[0]!.oid],refs:[],filters:{},hasMore:false};receive({data:page});const rows=elements.get('rows')!,viewport=elements.get('viewport')!,initial=[...rows.children],originalIds=initial.map(n=>n.id);let idWrites=0,scrollTop=0;
  Object.defineProperty(viewport,'scrollTop',{get:()=>scrollTop,set:(v:number)=>{scrollTop=Math.max(0,Math.min(v,commits.length*ROW-viewport.clientHeight));}});
  initial.forEach(row=>{let value=row.id;Object.defineProperty(row,'id',{get:()=>value,set:(v:string)=>{idWrites++;value=v;}});});
  const verify=(start:number)=>{assert.equal(new Set(rows.children.map(n=>n.id)).size,rows.children.length);rows.children.forEach((row,i)=>{assert.equal(row.getAttribute('aria-posinset'),String(start+i+1));assert.equal(row.getAttribute('aria-setsize'),'2000');assert.match(row.getAttribute('aria-label')!,new RegExp(`^Subject ${start+i}, Author ${start+i},`));});};
  viewport.scrollTop=30*ROW;viewport.listeners.get('scroll')!({});verify(29);assert.deepEqual(rows.children.map(n=>n.id),originalIds);assert.equal(idWrites,0);rows.children[0]!.listeners.get('click')!({});assert.equal(sent.at(-1)?.oid,commits[29]!.oid);assert.equal(viewport.getAttribute('aria-activedescendant'),originalIds[0]);
  viewport.scrollTop=60*ROW;viewport.listeners.get('scroll')!({});verify(59);assert.equal(viewport.getAttribute('aria-activedescendant'),undefined);assert.equal(idWrites,0);
  const key=(key:string)=>viewport.listeners.get('keydown')!({key,preventDefault:()=>undefined});key('End');verify(1987);const selected=rows.children.find(r=>r.getAttribute('aria-selected')==='true')!;assert.equal(viewport.getAttribute('aria-activedescendant'),selected.id);assert.equal(selected.getAttribute('aria-posinset'),'2000');assert.equal(sent.at(-1)?.oid,commits[1999]!.oid);
  const detached=initial.slice(13);assert.ok(detached.every(r=>!r.isConnected));const count=sent.length;detached[0]!.listeners.get('click')!({});assert.equal(sent.length,count);key('Home');verify(0);assert.equal(rows.children.length,15);assert.equal(new Set(rows.children.map(n=>n.id)).size,15);assert.ok(rows.children.slice(13).every(r=>!detached.includes(r)));assert.equal(sent.at(-1)?.oid,commits[0]!.oid);assert.equal(viewport.getAttribute('aria-activedescendant'),rows.children[0]!.id);key('ArrowDown');assert.equal(sent.at(-1)?.oid,commits[1]!.oid);assert.equal(viewport.getAttribute('aria-activedescendant'),rows.children[1]!.id);assert.equal(idWrites,0);
  const replacement=commits.map((c,i)=>i===1?{...c,subject:'Revised subject'}:c);receive({data:{...page,commits:replacement}});assert.match(rows.children[1]!.getAttribute('aria-label')!,/^Revised subject,/);assert.equal(viewport.getAttribute('aria-activedescendant'),rows.children[1]!.id);assert.equal(idWrites,0);
  const live=[...rows.children];receive({data:{type:'reset',session:'s'}});assert.equal(rows.children.length,0);assert.ok(live.every(r=>!r.isConnected));assert.equal(viewport.getAttribute('aria-activedescendant'),undefined);receive({data:page});verify(0);assert.equal(rows.children.length,15);assert.ok(rows.children.every(n=>!live.includes(n)));const reset=sent.length;live[0]!.listeners.get('click')!({});assert.equal(sent.length,reset);assert.equal(idWrites,0);
});

test('History overlap keeps current commit nodes and actions in ordered natural flow in both directions',()=>{
  const ids=['viewport','rows','spacer','details','status','filters','compare','more','pagination','filter-disclosure','filter-summary','snapshot','zoom','workspace','cancel-read'];
  const elements=new Map(ids.map(id=>[id,new Element()]));let receive!:(event:{data:unknown})=>void;const sent:Record<string,unknown>[]=[],created:Element[]=[];
  const create=()=>{const node=new Element();created.push(node);return node;};
  runInNewContext(readFileSync('media/history.js','utf8'),{document:{body:{dataset:{session:'s'}},getElementById:(id:string)=>elements.get(id),createElement:create,createElementNS:create,querySelectorAll:()=>[]},window:{addEventListener:(type:string,callback:typeof receive)=>{if(type==='message')receive=callback;}},acquireVsCodeApi:()=>({postMessage:(value:Record<string,unknown>)=>sent.push(value)})});
  const commits=Array.from({length:2000},(_,i)=>({oid:(i+1).toString(16).padStart(40,'0'),parents:[],subject:`Subject ${i}`,author:`Author ${i}`,timestamp:1700000000}));
  const page={type:'page',session:'s',commits,rows:layoutGraph(commits).rows,tips:[commits[0]!.oid],refs:[],filters:{},hasMore:false};receive({data:page});
  const rows=elements.get('rows')!,viewport=elements.get('viewport')!,initial=[...rows.children],nodeCount=created.length;let writes=0;
  const retained=initial[5]!,set=retained.setAttribute.bind(retained);retained.setAttribute=(key,value)=>{if(key==='aria-label')writes++;set(key,value);};
  retained.listeners.get('click')!({});assert.equal(sent.at(-1)?.oid,commits[5]!.oid);
  const verify=(start:number)=>{assert.equal(rows.children.length,15);assert.equal(new Set(rows.children).size,15);assert.equal(new Set(rows.children.map(r=>r.id)).size,15);assert.equal(rows.style.top,`${start*ROW}px`);rows.children.forEach((r,i)=>{assert.equal(r.isConnected,true);assert.equal(r.getAttribute('aria-posinset'),String(start+i+1));assert.match(r.getAttribute('aria-label')!,new RegExp(`^Subject ${start+i}, Author ${start+i},`));});};
  const scroll=(top:number,start:number)=>{viewport.scrollTop=top;viewport.listeners.get('scroll')!({});verify(start);};
  scroll(3*ROW,2);assert.deepEqual(rows.children.slice(0,13),initial.slice(2));assert.deepEqual(rows.children.slice(13),initial.slice(0,2));assert.equal(created.length,nodeCount);assert.equal(writes,0,'Overlapping commit does not rewrite its label');assert.equal(retained.getAttribute('aria-selected'),'true');assert.equal(viewport.getAttribute('aria-activedescendant'),retained.id);
  rows.children[14]!.listeners.get('click')!({});assert.equal(sent.at(-1)?.oid,commits[16]!.oid,'Moved row selects its entering commit');assert.equal(viewport.getAttribute('aria-activedescendant'),rows.children[14]!.id);
  scroll(ROW,0);assert.deepEqual(rows.children,initial);assert.equal(viewport.getAttribute('aria-activedescendant'),undefined,'Off-window selection must not reference a mounted different commit');assert.ok(rows.children.every(r=>r.getAttribute('aria-selected')==='false'));assert.equal(writes,0);
  scroll(3*ROW,2);receive({data:{...page,commits:commits.map((c,i)=>i===5?{...c,subject:'Revised subject'}:c)}});assert.equal(writes,1);assert.match(retained.getAttribute('aria-label')!,/^Revised subject,/);retained.listeners.get('click')!({});assert.equal(sent.at(-1)?.oid,commits[5]!.oid);assert.equal(viewport.getAttribute('aria-activedescendant'),retained.id);
  receive({data:page});const afterPageNodes=created.length;for(const top of [7*ROW,2*ROW,10*ROW,3*ROW,30*ROW,29*ROW,32*ROW,0]){const start=Math.max(0,Math.floor(top/ROW)-1);scroll(top,start);const row=rows.children[7]!;row.listeners.get('click')!({});assert.equal(sent.at(-1)?.oid,commits[start+7]!.oid);assert.equal(viewport.getAttribute('aria-activedescendant'),row.id);}assert.equal(created.length,afterPageNodes,'Scroll does not allocate nodes; page messages separately rebuild the existing pagination');assert.ok(rows.children.every(r=>initial.includes(r)));
  const live=[...rows.children];receive({data:{type:'reset',session:'s'}});assert.ok(live.every(r=>!r.isConnected));assert.equal(rows.children.length,0);assert.equal(viewport.getAttribute('aria-activedescendant'),undefined);const count=sent.length;live[0]!.listeners.get('click')!({});assert.equal(sent.length,count);
});

test('History persists only changed presentation state immediately and retries a failed write',()=>{
  const ids=['viewport','rows','spacer','details','status','filters','compare','more','pagination','filter-disclosure','filter-summary','snapshot','zoom','workspace','cancel-read'];
  const elements=new Map(ids.map(id=>[id,new Element()])),summary=new Element();Object.assign(elements.get('filter-disclosure')!,{querySelector:()=>summary});
  let receive!:(event:{data:unknown})=>void,attempts=0,failNext=true;const states:Record<string,unknown>[]=[],sent:Record<string,unknown>[]=[];
  runInNewContext(readFileSync('media/history.js','utf8'),{document:{body:{dataset:{session:'s'}},getElementById:(id:string)=>elements.get(id),createElement:()=>new Element(),createElementNS:()=>new Element(),querySelectorAll:()=>[]},window:{addEventListener:(type:string,callback:typeof receive)=>{if(type==='message')receive=callback;}},acquireVsCodeApi:()=>({getState:()=>({fileScope:'x'.repeat(257),fileOffset:-1,comparisonScope:1,oid:'forged'}),postMessage:(value:Record<string,unknown>)=>sent.push(value),setState:(value:Record<string,unknown>)=>{attempts++;if(failNext){failNext=false;throw Error('fixture failed state write');}states.push(value);}})});
  const commits=Array.from({length:2000},(_,i)=>({oid:(i+1).toString(16).padStart(40,'0'),parents:[],subject:'Subject '+i,author:'Fixture',timestamp:1700000000})),page={type:'page',session:'s',commits,rows:layoutGraph(commits).rows,tips:[commits[0]!.oid],refs:[],filters:{},hasMore:false};receive({data:page});
  const viewport=elements.get('viewport')!,scroll=()=>viewport.listeners.get('scroll')!({});assert.throws(scroll,/fixture failed state write/);assert.equal(attempts,1);assert.equal(states.length,0);scroll();assert.equal(attempts,2,'Failed state write must not be cached');assert.equal(states.length,1);assert.equal(states[0]!.fileScope,'');assert.equal(states[0]!.fileOffset,0);assert.equal(states[0]!.comparisonScope,'');assert.equal(states[0]!.oid,undefined);
  scroll();viewport.scrollTop=.4;scroll();assert.equal(attempts,2,'Duplicate and equally rounded fractional positions must not resend state');viewport.scrollTop=.51;scroll();assert.equal(attempts,3);assert.equal(states.at(-1)!.scrollTop,1);viewport.scrollTop=1200;scroll();assert.equal(attempts,4);assert.equal(states.at(-1)!.scrollTop,1200);scroll();assert.equal(attempts,4);
  const disclosure=elements.get('filter-disclosure')!;summary.listeners.get('click')!({});disclosure.open=true;disclosure.listeners.get('toggle')!({});assert.equal(attempts,5);assert.equal(states.at(-1)!.filtersExpanded,true);disclosure.listeners.get('toggle')!({});assert.equal(attempts,5);disclosure.open=false;disclosure.listeners.get('toggle')!({});assert.equal(attempts,6);assert.equal(states.at(-1)!.filtersExpanded,false);
  const zoom=elements.get('zoom')!;zoom.listeners.get('change')!({target:{value:'18'}});assert.equal(attempts,7);assert.equal(states.at(-1)!.zoom,18);zoom.listeners.get('change')!({target:{value:'18'}});assert.equal(attempts,7);zoom.listeners.get('change')!({target:{value:'999'}});assert.equal(attempts,8);assert.equal(states.at(-1)!.zoom,12);
  const files=Array.from({length:500},(_,i)=>({status:'M',path:`file-${i}.txt`}));receive({data:{type:'details',session:'s',details:{commit:commits[0],parent:commits[1]!.oid,refs:[],message:commits[0]!.subject,files,stats:[]},parentIndex:0}});assert.equal(attempts,9);assert.equal(states.at(-1)!.fileScope,`details:${commits[0]!.oid}:${commits[1]!.oid}`);elements.get('details')!.children.at(-2)!.children[1]!.listeners.get('click')!({});assert.equal(attempts,10);assert.equal(states.at(-1)!.fileOffset,200);scroll();assert.equal(attempts,10);
  receive({data:{type:'reset',session:'expired'}});assert.equal(attempts,10);receive({data:{type:'reset',session:'s'}});assert.equal(attempts,11);assert.equal(states.at(-1)!.scrollTop,0);assert.equal(states.at(-1)!.fileScope,'');assert.equal(states.at(-1)!.fileOffset,0);receive({data:{type:'reset',session:'s'}});assert.equal(attempts,11,'Equal reset persists the same state once while still resetting the UI');assert.equal(elements.get('rows')!.children.length,0);
  // Defensive oversized state bypasses retention; it cannot suppress subsequent writes.
  receive({data:{type:'details',session:'s',details:{commit:{...commits[0],oid:'x'.repeat(3000)},parent:'',refs:[],message:'Fixture',files:[],stats:[]},parentIndex:0}});scroll();const oversized=attempts;assert.ok(JSON.stringify(states.at(-1)).length>2048);scroll();assert.equal(attempts,oversized+1);assert.equal(sent.filter(s=>s.type==='select').length,0);
});

test('History renderer restores bounded presentation state and applied filters without granting action authority',()=>{
  const commits=Array.from({length:100},(_,index)=>({oid:(index+1).toString(16).padStart(40,'0'),parents:[],subject:'Fixture',author:'Fixture',timestamp:1700000000})),graph=layoutGraph(commits);
  const files=Array.from({length:500},(_,index)=>({status:'M',path:`file-${index}.txt`}));
  const from=commits[1]!.oid,to=commits[0]!.oid;
  const load=(saved:Record<string,unknown>)=>{
    const elements=new Map(['viewport','rows','spacer','details','status','filters','compare','more','pagination','filter-disclosure','filter-summary','snapshot','zoom','workspace','cancel-read'].map(id=>[id,new Element()]));
    const fields=new Map(['ref','text','author','path','from','to'].map(name=>[name,new Element()]));
    const compareFields=new Map(['from','to'].map(name=>[name,new Element()]));
    Object.assign(elements.get('filters')!,{querySelector:(selector:string)=>fields.get(selector.slice(6,-1))});
    Object.assign(elements.get('compare')!,{querySelector:(selector:string)=>compareFields.get(selector.slice(6,-1))});
    let receive:((event:{data:unknown})=>void)|undefined,state:Record<string,unknown>|undefined;
    const sent:Record<string,unknown>[]=[],document={body:{dataset:{session:'s'}},getElementById:(id:string)=>elements.get(id),createElement:()=>new Element(),createElementNS:()=>new Element(),querySelectorAll:()=>[]};
    runInNewContext(readFileSync('media/history.js','utf8'),{document,window:{addEventListener:(type:string,callback:typeof receive)=>{if(type==='message')receive=callback;}},acquireVsCodeApi:()=>({getState:()=>saved,setState:(value:Record<string,unknown>)=>{state=value;},postMessage:(value:Record<string,unknown>)=>sent.push(value)})});
    const message=(value:Record<string,unknown>)=>receive!({data:{session:'s',...value}});
    message({type:'page',commits,rows:graph.rows,tips:[to],ref:'topic',refs:[],filters:{path:'new.txt',author:'Author',text:'needle',from:'2026-01-01',to:'2026-10-06'},hasMore:true});
    return {elements,fields,compareFields,message,sent,getState:()=>state};
  };
  const h=load({scrollTop:400,zoom:18,fileScope:`details:${to}:${from}`,fileOffset:200,oid:'forged',path:'forged'});
  assert.equal(h.elements.get('viewport')!.scrollTop,400);assert.equal(h.elements.get('zoom')!.value,'18');
  for(const [name,value] of [['ref','topic'],['path','new.txt'],['author','Author'],['text','needle'],['from','2026-01-01'],['to','2026-10-06']])assert.equal(h.fields.get(name!)!.value,value);
  h.message({type:'details',details:{commit:commits[0],parent:from,files,stats:[],refs:[],message:'Details'},parentIndex:0});
  assert.match(h.elements.get('details')!.children.at(-2)!.children[2]!.textContent,/201–400/);
  h.elements.get('details')!.children.at(-1)!.children[0]!.children[0]!.listeners.get('click')!({});assert.equal(h.sent.at(-1)?.index,200);assert.equal(h.sent.at(-1)?.path,undefined);
  assert.equal(h.getState()?.oid,undefined);assert.equal(h.getState()?.path,undefined);
  h.message({type:'reset'});assert.equal(h.getState()?.fileOffset,0);assert.equal(h.getState()?.scrollTop,0);
  const c=load({comparisonScope:`comparison:${from}:${to}`,comparisonExpanded:false,fileScope:`comparison:${from}:${to}`,fileOffset:200});
  c.message({type:'comparison',inputs:{from:'branch-A',to:'branch-B'},result:{from,to,files,stats:[],leftCommits:[],rightCommits:[],leftCount:0,rightCount:0}});
  assert.equal(c.compareFields.get('from')!.value,'branch-A');assert.equal(c.compareFields.get('to')!.value,'branch-B');
  assert.equal(c.elements.get('workspace')!.className,'split');assert.match(c.elements.get('details')!.children.at(-2)!.children[2]!.textContent,/201–400/);
  const invalid=load({scrollTop:Infinity,zoom:999,fileScope:'x'.repeat(257),fileOffset:-1});assert.equal(invalid.elements.get('viewport')!.scrollTop,0);assert.equal(invalid.elements.get('zoom')!.value,'12');
});

test('Filter disclosure adapts before an explicit choice and restores only presentation state',()=>{
  const load=(saved:Record<string,unknown>,compact:boolean)=>{
    const elements=new Map(['viewport','rows','spacer','details','status','filters','compare','more','pagination','filter-disclosure','filter-summary','snapshot','zoom','workspace','cancel-read'].map(id=>[id,new Element()])),summary=new Element();
    Object.assign(elements.get('filter-disclosure')!,{querySelector:()=>summary,contains:()=>false});
    let change:((event:{matches:boolean})=>void)|undefined,receive:((event:{data:unknown})=>void)|undefined,state:Record<string,unknown>|undefined;
    const sent:Record<string,unknown>[]=[],document={body:{dataset:{session:'s'}},getElementById:(id:string)=>elements.get(id),createElement:()=>new Element(),createElementNS:()=>new Element(),querySelectorAll:()=>[]};
    runInNewContext(readFileSync('media/history.js','utf8'),{document,window:{matchMedia:()=>({matches:compact,addEventListener:(_name:string,callback:typeof change)=>{change=callback;}}),addEventListener:(type:string,callback:typeof receive)=>{if(type==='message')receive=callback;}},acquireVsCodeApi:()=>({getState:()=>saved,setState:(value:Record<string,unknown>)=>{state=value;},postMessage:(value:Record<string,unknown>)=>sent.push(value)})});
    return {elements,summary,change:(matches:boolean)=>change!({matches}),message:(data:Record<string,unknown>)=>receive!({data:{session:'s',...data}}),state:()=>state,sent};
  };
  const h=load({},true),disclosure=h.elements.get('filter-disclosure')!;
  assert.equal(disclosure.open,false);h.change(false);assert.equal(disclosure.open,true);
  disclosure.listeners.get('toggle')!({});assert.equal(h.state()?.filtersExpanded,undefined,'Automatic responsive opening must not become an explicit saved choice');
  h.change(true);assert.equal(disclosure.open,false);h.summary.listeners.get('click')!({});disclosure.open=true;disclosure.listeners.get('toggle')!({});h.change(true);assert.equal(disclosure.open,true);
  assert.equal(h.state()?.filtersExpanded,true);assert.equal(load(h.state()!,true).elements.get('filter-disclosure')!.open,true);
  assert.equal(load({filtersExpanded:false},false).elements.get('filter-disclosure')!.open,false);
  h.message({type:'page',commits:[],rows:[],refs:[],tips:[],ref:'<img> topic',filters:{author:'Author',text:'needle'},hasMore:false});
  assert.equal(h.elements.get('filter-summary')!.textContent,'<img> topic · 2 active filters');assert.equal(h.sent.length,1);assert.equal(h.sent[0]!.type,'ready');
});

test('Details keeps identity and Copy before 10k literal refs, bounds lazy pages and discards stale local controls',()=>{
  const elements=new Map(['viewport','rows','spacer','details','status','filters','compare','more','pagination','filter-disclosure','filter-summary','snapshot','zoom','workspace','cancel-read'].map(id=>[id,new Element()]));
  const sent:Record<string,unknown>[]=[],tags:string[]=[];let receive:((event:{data:unknown})=>void)|undefined;
  const descendants=(node:Element):Element[]=>[node,...node.children.flatMap(descendants)];
  const all=()=>[...elements.values()].flatMap(descendants);
  const create=(tag:string)=>{tags.push(tag);const n=new Element();n.tag=tag;return n;};
  const document={body:{dataset:{session:'s'}},get activeElement(){return Element.active;},getElementById:(id:string)=>elements.get(id),createElement:create,createElementNS:(_ns:string,tag:string)=>create(tag),hasFocus:()=>true,
    querySelectorAll:(selector:string)=>all().filter(n=>selector==='[data-focus-key]'?Boolean(n.dataset.focusKey):selector==='.refs-toggle'?n.className==='refs-toggle':['button','input','select','textarea'].includes(n.tag))};
  runInNewContext(readFileSync('media/history.js','utf8'),{document,window:{addEventListener:(type:string,callback:typeof receive)=>{if(type==='message')receive=callback;}},acquireVsCodeApi:()=>({postMessage:(value:Record<string,unknown>)=>sent.push(value)})});
  const message=(data:Record<string,unknown>)=>receive!({data:{session:'s',...data}}),root=elements.get('details')!;
  const refs=Array.from({length:10000},(_,i)=>i===0?'refs/heads/<img onerror=alert(1)>':i===1?'refs/remotes/origin/main':i===2?'refs/tags/v1':i===3?'HEAD':`refs/heads/long-${i}-${'x'.repeat(300)}`);
  const commit={oid:'a'.repeat(40),parents:[],subject:'Subject',author:'Author <script>',email:'author@example.invalid',timestamp:1700000000};
  const show=(messageText='Subject\n\nBody\n',values=refs,oid=commit.oid)=>message({type:'details',details:{commit:{...commit,oid},refs:values,message:messageText,files:[],stats:[]},parentIndex:0});
  show();assert.equal(root.children[0]!.textContent,'Subject');
  assert.equal(root.children[1]!.children[0]!.textContent,'aaaaaaaa');assert.equal(root.children[1]!.children[0]!.title,commit.oid);
  const actions=root.children[2]!,section=root.children[3]!,preview=section.children[1]!,disclosure=section.children[2]!,summary=disclosure.children[0]!,expanded=disclosure.children[1]!;
  assert.equal(actions.className,'details-actions');assert.equal(preview.children.length,8);assert.equal(expanded.children.length,0);assert.equal(disclosure.open,false);
  assert.equal(preview.children[0]!.children[2]!.textContent,'<img onerror=alert(1)>');assert.equal(preview.children[0]!.title,refs[0]);
  assert.deepEqual(preview.children.slice(0,4).map(n=>n.children[1]!.textContent),['Branch','Remote','Tag','Ref']);
  assert.equal(tags.includes('img'),false);assert.equal(tags.includes('script'),false);assert.equal(root.children.find(n=>n.tag==='pre')!.textContent,'Body\n','the blank separator line after the subject is not shown');
  for(const [index,field]of ['hash','message'].entries()){actions.children[index]!.listeners.get('click')!({});assert.equal(sent.at(-1)?.type,'copy');assert.equal(sent.at(-1)?.oid,commit.oid);assert.equal(sent.at(-1)?.field,field);assert.equal(sent.at(-1)?.message,undefined);}
  const count=sent.length;disclosure.open=true;disclosure.listeners.get('toggle')!({});assert.equal(preview.hidden,true);assert.equal(expanded.children[1]!.children.length,200);
  const staleNext=expanded.children[0]!.children[1]!;staleNext.focus();staleNext.listeners.get('click')!({});assert.match(expanded.children[0]!.children[2]!.textContent,/201–400 of 10,000/);assert.equal(Element.active,expanded.children[0]!.children[1]);
  staleNext.listeners.get('click')!({});assert.match(expanded.children[0]!.children[2]!.textContent,/201–400/,'Detached controls cannot turn another page');
  message({type:'busy',busy:true});const next=expanded.children[0]!.children[1]!;assert.equal(next.disabled,true);next.listeners.get('click')!({});assert.match(expanded.children[0]!.children[2]!.textContent,/201–400/);
  let prevented=false;summary.listeners.get('click')!({preventDefault:()=>{prevented=true;}});assert.equal(prevented,true);assert.equal(summary.getAttribute('aria-disabled'),'true');
  actions.children[0]!.listeners.get('click')!({});assert.equal(sent.length,count);message({type:'busy',session:'expired',busy:false});assert.equal(next.disabled,true);message({type:'busy',busy:false});
  for(let i=1;i<49;i++)expanded.children[0]!.children[1]!.listeners.get('click')!({});
  assert.match(expanded.children[0]!.children[2]!.textContent,/9801–10000 of 10,000/);assert.equal(expanded.children[0]!.children[1]!.disabled,true);assert.equal(expanded.children[1]!.children.at(-1)!.title,refs[9999]);
  assert.equal(descendants(section).filter(n=>n.className.startsWith('ref-chip ')).length,208);assert.equal(sent.length,count,'Local disclosure/pages do not issue Git requests');
  disclosure.open=false;disclosure.listeners.get('toggle')!({});assert.equal(preview.hidden,false);assert.equal(expanded.children.length,0);
  disclosure.open=true;disclosure.listeners.get('toggle')!({});assert.match(expanded.children[0]!.children[2]!.textContent,/1–200/);
  message({type:'details',session:'expired',details:{}});assert.equal(root.children[3],section);
  show('Different first line\nBody',[], 'b'.repeat(40));assert.equal(root.children.find(n=>n.tag==='pre')!.textContent,'Different first line\nBody');assert.equal(root.children[3]!.children.length,3);assert.equal(root.children[3]!.children[2]!.textContent,'No containing refs.');
  actions.children[0]!.listeners.get('click')!({});expanded.children[0]!.children[1]!.listeners.get('click')!({});assert.equal(sent.length,count,'Old selection controls cannot act');
  show('Subject',refs.slice(0,8));assert.equal(root.children.some(n=>n.tag==='pre'),false);assert.equal(root.children[3]!.children.length,2);
  show('Subject \nBody',[]);assert.equal(root.children.find(n=>n.tag==='pre')!.textContent,'Subject \nBody','Only a literally equal subject is omitted');
  show('Subject\r\nBody',[]);assert.equal(root.children.find(n=>n.tag==='pre')!.textContent,'Subject\r\nBody','CR/whitespace semantics are preserved');
});

test('History cancel is read-only, session-bound and clears snapshot, graph and selection with honest live guidance',()=>{
  const ids=['viewport','rows','spacer','details','status','filters','compare','more','pagination','filter-disclosure','filter-summary','snapshot','zoom','workspace','cancel-read'];
  const elements=new Map(ids.map(id=>{const node=new Element();node.id=id;return[id,node] as const;}));
  const all=()=>{const nodes:Element[]=[];const visit=(node:Element)=>{nodes.push(node);node.children.forEach(visit);};elements.forEach(visit);return nodes;};
  const sent:Record<string,unknown>[]=[];let receive!: (event:{data:unknown})=>void;
  const document={body:{dataset:{session:'s'}},get activeElement(){return Element.active;},getElementById:(id:string)=>elements.get(id),createElement:(tag:string)=>{const node=new Element();node.tag=tag;return node;},createElementNS:(_ns:string,tag:string)=>{const node=new Element();node.tag=tag;return node;},hasFocus:()=>true,querySelectorAll:(selector:string)=>all().filter(node=>selector==='[data-focus-key]'?Boolean(node.dataset.focusKey):['button','input','select','textarea'].includes(node.tag))};
  runInNewContext(readFileSync('media/history.js','utf8'),{document,window:{addEventListener:(type:string,callback:typeof receive)=>{if(type==='message')receive=callback;}},acquireVsCodeApi:()=>({postMessage:(value:Record<string,unknown>)=>sent.push(value)})});
  const message=(value:Record<string,unknown>)=>receive({data:{session:'s',...value}}),cancel=elements.get('cancel-read')!,status=elements.get('status')!;
  message({type:'busy',busy:false});const idle=sent.length;cancel.listeners.get('click')!({});assert.equal(sent.length,idle);assert.equal(cancel.disabled,true);
  const commits=[{oid:'1'.padStart(40,'0'),parents:[],subject:'Fixture',author:'Fixture',timestamp:1700000000}];
  message({type:'page',commits,rows:layoutGraph(commits).rows,tips:[commits[0]!.oid],refs:[{name:'topic',oid:commits[0]!.oid}],filters:{},hasMore:true});
  elements.get('viewport')!.listeners.get('keydown')!({key:'Home',preventDefault:()=>undefined});assert.equal(elements.get('rows')!.children[0]!.getAttribute('aria-selected'),'true');
  message({type:'busy',busy:true,canCancel:false});assert.equal(cancel.disabled,true);const native=sent.length;cancel.listeners.get('click')!({});assert.equal(sent.length,native,'Native diff must not offer a false cancellation');
  message({type:'busy',busy:true,canCancel:true});assert.equal(cancel.disabled,false);assert.equal(elements.get('filters')!.disabled,true);message({type:'busy',session:'expired',busy:false});assert.equal(cancel.disabled,false);
  cancel.focus();cancel.listeners.get('click')!({});assert.equal(sent.at(-1)?.type,'cancel');assert.equal(sent.at(-1)?.session,'s');assert.equal(cancel.disabled,true);const once=sent.length;cancel.listeners.get('click')!({});assert.equal(sent.length,once);
  message({type:'reset'});assert.equal(elements.get('rows')!.children.length,0);assert.equal(elements.get('snapshot')!.textContent,'');assert.equal(elements.get('filter-summary')!.textContent,'No active snapshot');assert.equal(elements.get('viewport')!.getAttribute('aria-activedescendant'),undefined);assert.equal(elements.get('more')!.dataset.available,'false');assert.equal(elements.get('pagination')!.hidden,true);assert.equal(elements.get('details')!.children[0]!.className,'details-guidance');
  const guidance='Request cancelled. Git may still be stopping. Refresh to start a new query.';message({type:'cancelled',message:guidance});message({type:'busy',busy:false,canCancel:false});assert.equal(status.textContent,guidance);assert.equal(status.className,'');assert.equal(cancel.disabled,true);assert.equal(elements.get('filters')!.disabled,false);
});

test('History one-row margins cover fractional visible rectangles and preserve current actions after resize',()=>{
  const ids=['viewport','rows','spacer','details','status','filters','compare','more','pagination','filter-disclosure','filter-summary','snapshot','zoom','workspace','cancel-read'];
  const elements=new Map(ids.map(id=>[id,new Element()]));let receive!:(event:{data:unknown})=>void,resize!:()=>void;const sent:Record<string,unknown>[]=[];
  runInNewContext(readFileSync('media/history.js','utf8'),{document:{body:{dataset:{session:'s'}},getElementById:(id:string)=>elements.get(id),createElement:()=>new Element(),createElementNS:()=>new Element(),querySelectorAll:()=>[]},window:{addEventListener:(type:string,callback:unknown)=>{if(type==='message')receive=callback as typeof receive;else if(type==='resize')resize=callback as typeof resize;}},acquireVsCodeApi:()=>({postMessage:(value:Record<string,unknown>)=>sent.push(value)})});
  const commits=Array.from({length:2000},(_,i)=>({oid:(i+1).toString(16).padStart(40,'0'),parents:[],subject:'Commit '+i,author:'Fixture',timestamp:1700000000}));receive({data:{type:'page',session:'s',commits,rows:layoutGraph(commits).rows,tips:[commits[0]!.oid],refs:[],filters:{},hasMore:false}});
  const viewport=elements.get('viewport')!,rows=elements.get('rows')!;
  for(const height of [1,ROW-.5,ROW,ROW+.5,6*ROW-.5,6*ROW,6*ROW+.5,8*ROW-.5,8*ROW,12*ROW-.5,12*ROW,12*ROW+.25,17*ROW])for(const requested of [0,.5,ROW-.5,ROW,ROW+.5,2*ROW-.5,30*ROW+.25,1988*ROW,2000*ROW-1]){
    const old=[...rows.children];viewport.clientHeight=height;viewport.scrollTop=Math.max(0,Math.min(requested,2000*ROW-height));resize();
    const mounted=rows.children.map(row=>Number(row.getAttribute('aria-posinset'))-1),visible=commits.map((_,i)=>i).filter(i=>(i+1)*ROW>viewport.scrollTop&&i*ROW<viewport.scrollTop+height);
    assert.ok(mounted.length<=Math.ceil(height/ROW)+3,'Bounded mounted nodes after fractional resize');assert.equal(new Set(rows.children.map(r=>r.id)).size,mounted.length);assert.ok(visible.every(i=>mounted.includes(i)),'Every positive-intersection row must be mounted');
    if(visible[0]!>0)assert.ok(mounted.includes(visible[0]!-1),'One preceding row protects the synchronous scroll boundary');if(visible.at(-1)!<1999)assert.ok(mounted.includes(visible.at(-1)!+1),'One following row protects the partial trailing boundary');
    assert.deepEqual(mounted,Array.from({length:mounted.length},(_,i)=>mounted[0]!+i));assert.equal(rows.style.top,mounted[0]!*ROW+'px');assert.equal(elements.get('spacer')!.style.height,`${2000*ROW}px`);assert.ok(rows.children.every(r=>r.getAttribute('aria-setsize')==='2000'));
    const current=rows.children.find(r=>Number(r.getAttribute('aria-posinset'))===visible[0]!+1)!;current.listeners.get('click')!({});assert.equal(sent.at(-1)?.oid,commits[visible[0]!]!.oid);assert.equal(viewport.getAttribute('aria-activedescendant'),current.id);
    for(const removed of old.filter(r=>!rows.children.includes(r))){assert.equal(removed.isConnected,false);const count=sent.length;removed.listeners.get('click')!({});assert.equal(sent.length,count,'Detached resize slots cannot act');}
  }
});

test('History details render containing refs when they arrive and ignore lookups for another commit',()=>{
  const ids=['viewport','rows','spacer','details','status','filters','compare','more','pagination','filter-disclosure','filter-summary','snapshot','zoom','workspace','cancel-read'];
  const elements=new Map(ids.map(id=>[id,new Element()]));let receive!:(event:{data:unknown})=>void;
  const create=(tag:string)=>{const node=new Element();node.tag=tag;return node;};
  const document={body:{dataset:{session:'s'}},get activeElement(){return Element.active;},getElementById:(id:string)=>elements.get(id),createElement:create,createElementNS:(_ns:string,tag:string)=>create(tag),querySelectorAll:()=>[]};
  runInNewContext(readFileSync('media/history.js','utf8'),{document,window:{addEventListener:(type:string,callback:typeof receive)=>{if(type==='message')receive=callback;}},acquireVsCodeApi:()=>({postMessage:()=>undefined})});
  const commits=Array.from({length:2},(_,index)=>({oid:String(index+1).padStart(40,'0'),parents:[],author:'Fixture',email:'',timestamp:1700000000,subject:`Commit ${index}`}));
  receive({data:{type:'page',session:'s',commits,rows:layoutGraph(commits).rows,tips:[commits[0]!.oid],refs:[],filters:{},hasMore:false}});
  const details=(index:number)=>receive({data:{type:'details',session:'s',details:{commit:commits[index],message:`Commit ${index}`,files:[],stats:[]},parentIndex:0}});
  const section=()=>elements.get('details')!.children.find(node=>node.className==='details-refs')!;
  details(0);assert.match(section().children[1]!.textContent,/Finding containing refs/);assert.equal(section().getAttribute('aria-busy'),'true');
  receive({data:{type:'refs',session:'s',oid:commits[1]!.oid,refs:['refs/heads/other']}});assert.match(section().children[1]!.textContent,/Finding containing refs/,'refs for another commit are ignored');
  receive({data:{type:'refs',session:'s',oid:commits[0]!.oid,refs:['refs/heads/main','refs/tags/v1']}});
  assert.equal(section().children[0]!.textContent,'Containing refs · 2');assert.equal(section().getAttribute('aria-busy'),'false');
  details(1);receive({data:{type:'refs',session:'s',oid:commits[1]!.oid,refsError:'Git read timed out after 15000 ms.'}});
  assert.match(section().children[1]!.textContent,/Containing refs unavailable: Git read timed out/);
  receive({data:{type:'refs',session:'s',oid:commits[0]!.oid,refs:['refs/heads/main']}});assert.match(section().children[1]!.textContent,/unavailable/,'a late lookup for the previous commit does not overwrite');
  receive({data:{type:'details',session:'s',details:{commit:commits[0],message:'Commit 0',files:[],stats:[],refs:['refs/heads/main']},parentIndex:0}});assert.equal(section().children[0]!.textContent,'Containing refs · 1','stored details carry the result');
});
