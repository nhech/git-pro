import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { parsePlannerRequest } from '../../src/webviews/rebase/planner-protocol';
import { validateRebasePlan } from '../../src/git/rebase/rebase-plan';

test('planner protocol rejects arbitrary plans and bounds aggregate UTF-8 message data',()=>{
  const oid='a'.repeat(40);assert.equal(parsePlannerRequest({type:'action',session:'s',revision:1,oid,action:'edit'}).type,'action');
  for(const value of [{type:'execute',session:'s',revision:0,steps:[]},{type:'step',session:'s',revision:-1,oid,direction:'up'},{type:'move',session:'s',revision:0,oid,target:'--exec'},{type:'action',session:'s',revision:0,oid,action:'exec'}])assert.throws(()=>parsePlannerRequest(value));
  const commits=Array.from({length:20},(_,index)=>({oid:(index+1).toString(16).padStart(40,'0'),parent:oid,subject:'Fixture'}));
  assert.throws(()=>validateRebasePlan(commits,commits.map(commit=>({oid:commit.oid,action:'reword',message:'😀'.repeat(20000)}))),/Combined reword/);
});

test('host planner owns revisions/order, preserves busy ownership and cancels without returning a plan',async()=>{
  const file=path.resolve(__dirname,'../../src/webviews/rebase/rebase-planner.js'),load=createRequire(file),exports:Record<string,unknown>={};
  let receive:(raw:unknown)=>Promise<void>=async()=>undefined,closed:()=>void=()=>undefined;const sent:Record<string,unknown>[]=[];
  const panel={webview:{html:'',cspSource:'vscode-resource:',asWebviewUri:(uri:unknown)=>String(uri),postMessage:async(value:Record<string,unknown>)=>{sent.push(value);return true;},onDidReceiveMessage:(callback:typeof receive)=>{receive=callback;return{dispose:()=>undefined};}},onDidDispose:(callback:()=>void)=>{closed=callback;return{dispose:()=>undefined};},dispose:()=>closed()};
  const vscode={window:{createWebviewPanel:()=>panel},ViewColumn:{Active:1},Uri:{joinPath:(_uri:unknown,...parts:string[])=>parts.join('/')}};
  runInNewContext(readFileSync(file,'utf8'),{exports,require:(name:string)=>name==='vscode'?vscode:load(name)});
  type Steps=readonly {oid:string;action:string}[];
  type Planner={choose(preview:unknown,root:string,edit:(oid:string,initial?:string)=>Promise<string|undefined>,confirm?:(steps:Steps)=>Promise<boolean>):Promise<Steps|{native:Steps}|undefined>;dispose():void};
  const Constructor=exports.RebasePlanner as new(context:unknown)=>Planner,planner=new Constructor({extensionUri:'owned'});
  const a='a'.repeat(40),b='b'.repeat(40),c='c'.repeat(40),commits=[a,b,c].map(oid=>({oid,parent:'d'.repeat(40),subject:'<img onerror=evil()>'}));
  let release:(message:string|undefined)=>void=()=>undefined,confirmed=false;const result=planner.choose({commits,base:'d'.repeat(40),snapshot:{head:c}},'fixture',async()=>new Promise(resolve=>{release=resolve;}),async()=>confirmed);
  const session=/data-session="([^"]+)"/.exec(panel.webview.html)![1]!;
  const request=(value:Record<string,unknown>)=>receive({session,revision:0,...value});await request({type:'ready'});
  await request({type:'step',oid:a,direction:'down'});assert.deepEqual(Array.from((sent.at(-2)?.steps as {oid:string}[]).map(step=>step.oid)),[b,a,c]);
  await request({type:'step',oid:a,direction:'down'});assert.match(String(sent.at(-1)?.message),/Plan changed/);
  await request({type:'step',revision:1,oid:'e'.repeat(40),direction:'down'});assert.match(String(sent.at(-1)?.message),/outside/);
  const pending=request({type:'action',revision:1,oid:a,action:'reword'});await new Promise(resolve=>setImmediate(resolve));const falseBefore=sent.filter(item=>item.type==='busy'&&!item.busy).length;
  await request({type:'review',revision:1});assert.match(String(sent.at(-1)?.message),/Wait/);assert.equal(sent.filter(item=>item.type==='busy'&&!item.busy).length,falseBefore,'Rejected concurrent request cannot clear the editor owner busy state.');
  release('New subject\n\nBody');await pending;await request({type:'review',revision:2});assert.equal(sent.at(-1)?.busy,false);assert.match(panel.webview.html,/Interactive Rebase/,'Declining final confirmation retains the current panel.');confirmed=true;await request({type:'review',revision:2});const chosen=await result;assert.ok(Array.isArray(chosen));assert.ok(Object.isFrozen(chosen)&&chosen.every(Object.isFrozen));assert.equal(chosen[1]?.action,'reword');
  const native=planner.choose({commits,base:'d'.repeat(40),snapshot:{head:c}},'fixture',async()=>undefined),nativeSession=/data-session="([^"]+)"/.exec(panel.webview.html)![1]!;
  await receive({type:'step',session:nativeSession,revision:0,oid:a,direction:'down'});await receive({type:'native',session:nativeSession,revision:1});const fallback=await native;assert.ok(fallback&&'native' in fallback);assert.deepEqual(Array.from(fallback.native.map(step=>step.oid)),[b,a,c]);
  const canceled=planner.choose({commits,base:'d'.repeat(40),snapshot:{head:c}},'fixture',async()=>undefined);planner.dispose();assert.equal(await canceled,undefined);
});

class Element {
  children:Element[]=[];dataset:Record<string,string>={};attributes=new Map<string,string>();listeners=new Map<string,(event:Record<string,unknown>)=>void>();private text='';get textContent(){return this.text+this.children.map(c=>c.textContent).join('');}set textContent(value:string){this.text=value;this.children=[];}value='';draggable=false;id='';className='';isConnected=true;onFocus?:()=>void;onDisabled?:()=>void;private inactive=false;
  get disabled(){return this.inactive;}set disabled(value:boolean){this.inactive=value;if(value)this.onDisabled?.();}
  append(...nodes:Element[]){this.children.push(...nodes);}prepend(node:Element){this.children.unshift(node);}replaceChildren(){for(const child of this.children)child.isConnected=false;this.children=[];}setAttribute(key:string,value:string){this.attributes.set(key,value);}addEventListener(type:string,callback:(event:Record<string,unknown>)=>void){this.listeners.set(type,callback);}focus(){this.onFocus?.();}scrollIntoView(){}
}
test('real planner script uses text, captured drag identities and keyboard equivalents with busy/session checks',()=>{
  const ids=['commits','action','up','down','message','review','status','cancel','native','range','selected-title','subject','message-preview','action-help'],elements=new Map(ids.map(id=>[id,new Element()])),sent:Record<string,unknown>[]=[],tags:string[]=[];
  let receive:((event:{data:unknown})=>void)|undefined;
  runInNewContext(readFileSync('media/rebase.js','utf8'),{document:{body:{dataset:{session:'s'}},getElementById:(id:string)=>elements.get(id),createElement:(tag:string)=>{tags.push(tag);return new Element();},createElementNS:(_ns:string,tag:string)=>{tags.push(tag);return new Element();}},window:{addEventListener:(_type:string,callback:typeof receive)=>{receive=callback;}},acquireVsCodeApi:()=>({postMessage:(value:Record<string,unknown>)=>sent.push(value)})});
  const steps=Array.from({length:200},(_,index)=>({oid:(index+1).toString(16).padStart(40,'0'),action:'pick',subject:index?'Fixture':'<img onerror=evil()>'}));
  receive!({data:{type:'state',session:'s',revision:4,range:'Captured',steps}});receive!({data:{type:'busy',session:'s',busy:false}});
  const list=elements.get('commits')!;assert.equal(list.children.length,200);assert.ok(tags.every(tag=>['button','span','svg','path'].includes(tag)));assert.match(list.children[0]!.textContent,/<img/);
  list.listeners.get('keydown')!({key:'ArrowDown',preventDefault:()=>undefined});list.listeners.get('keydown')!({key:'ArrowDown',altKey:true,preventDefault:()=>undefined});assert.equal(sent.at(-1)?.oid,steps[1]!.oid);assert.equal(sent.at(-1)?.type,'step');assert.equal(sent.at(-1)?.revision,4);
  const transfer={setData:()=>undefined};list.children[0]!.listeners.get('dragstart')!({dataTransfer:transfer,preventDefault:()=>undefined});list.children[2]!.listeners.get('drop')!({preventDefault:()=>undefined});assert.equal(sent.at(-1)?.target,steps[2]!.oid);assert.equal(sent.at(-1)?.oid,steps[0]!.oid);
  const before=sent.length;list.children[2]!.listeners.get('drop')!({preventDefault:()=>undefined,dataTransfer:{getData:()=>steps[0]!.oid}});assert.equal(sent.length,before,'External drag text cannot forge an internal drag identity.');
  receive!({data:{type:'busy',session:'s',busy:true}});receive!({data:{type:'busy',session:'expired',busy:false}});list.listeners.get('keydown')!({key:'End',preventDefault:()=>undefined});assert.equal(sent.length,before);assert.equal(elements.get('review')!.disabled,true);
});

test('planner restores async keyboard focus, falls back to the list and respects moved or inactive focus',()=>{
  const ids=['commits','action','up','down','message','review','status','cancel','native','range','selected-title','subject','message-preview','action-help'];
  const elements=new Map(ids.map(id=>[id,new Element()])),body=new Element();let focused=true,receive:((event:{data:unknown})=>void)|undefined;
  const document={body:Object.assign(body,{dataset:{session:'s'}}),activeElement:body,hasFocus:()=>focused,getElementById:(id:string)=>elements.get(id),createElement:()=>new Element(),createElementNS:()=>new Element()};
  for(const [id,node] of elements){node.id=id;node.onFocus=()=>{document.activeElement=node;};node.onDisabled=()=>{if(document.activeElement===node)document.activeElement=body;};}
  runInNewContext(readFileSync('media/rebase.js','utf8'),{document,window:{addEventListener:(_type:string,callback:typeof receive)=>{receive=callback;}},acquireVsCodeApi:()=>({postMessage:()=>undefined})});
  const a='a'.repeat(40),b='b'.repeat(40),steps=[a,b].map(oid=>({oid,action:'pick',subject:'Fixture'}));
  const state=(value:unknown=steps)=>receive!({data:{type:'state',session:'s',revision:1,steps:value,range:'Captured'}});
  const busy=(value:boolean,session='s')=>receive!({data:{type:'busy',session,busy:value}});
  state();busy(false);const action=elements.get('action')!,list=elements.get('commits')!,down=elements.get('down')!;
  action.focus();busy(true);assert.equal(document.activeElement,body,'Disabling a focused select models native browser focus loss.');busy(true);state();busy(false);assert.equal(document.activeElement,action,'Repeated busy/state updates retain the original focus owner.');
  down.focus();busy(true);state([steps[1],steps[0]]);busy(false);assert.equal(down.disabled,true);assert.equal(document.activeElement,list,'Move Down at the last row falls back to the same selected commit list.');assert.equal(list.attributes.get('aria-activedescendant'),`commit-${a}`);
  const message=elements.get('message')!;state([{...steps[1],action:'reword',message:'Edited'},steps[0]]);list.listeners.get('keydown')!({key:'Home',preventDefault:()=>undefined});message.focus();busy(true);state();busy(false);assert.equal(message.disabled,true);assert.equal(document.activeElement,list,'Action change that disables Edit Message returns to the list.');
  const review=elements.get('review')!;review.focus();busy(true);receive!({data:{type:'error',session:'s',message:'Declined'}});busy(false);assert.equal(document.activeElement,review);
  review.focus();busy(true);busy(false,'expired');assert.equal(review.disabled,true);assert.equal(list.attributes.get('aria-busy'),'true');let prevented=false;list.listeners.get('keydown')!({key:'ArrowDown',preventDefault:()=>{prevented=true;}});assert.equal(prevented,true,'Busy list navigation must not scroll the browser.');busy(false);assert.equal(list.attributes.get('aria-busy'),'false');
  const outside=new Element();review.focus();busy(true);document.activeElement=outside;busy(false);assert.equal(document.activeElement,outside,'Loading must not steal a deliberately moved focus.');
  review.focus();busy(true);focused=false;busy(false);assert.equal(document.activeElement,body);focused=true;busy(false);assert.equal(document.activeElement,body,'Skipped restoration releases its saved reference.');
});

test('planner keeps hostile subjects literal and separates action guidance from exact commit identities',()=>{
  const ids=['commits','action','up','down','message','review','status','cancel','native','range','selected-title','subject','message-preview','action-help'];
  const elements=new Map(ids.map(id=>[id,new Element()])),sent:Record<string,unknown>[]=[];
  let receive:((event:{data:unknown})=>void)|undefined;
  runInNewContext(readFileSync('media/rebase.js','utf8'),{document:{body:{dataset:{session:'s'}},getElementById:(id:string)=>elements.get(id),createElement:()=>new Element(),createElementNS:()=>new Element()},window:{addEventListener:(_type:string,cb:typeof receive)=>{receive=cb;}},acquireVsCodeApi:()=>({postMessage:(v:Record<string,unknown>)=>sent.push(v)})});
  const hostile='<svg onload=evil()> & a very long literal subject',actions=['pick','reword','edit','squash','fixup','drop'];
  const steps=actions.map((action,index)=>({oid:(index+1).toString(16).padStart(40,'0'),action,subject:hostile,message:'Subject\n\nExact body'}));
  receive!({data:{type:'state',session:'s',revision:3,steps,range:'Captured'}});receive!({data:{type:'busy',session:'s',busy:false}});
  const list=elements.get('commits')!,before=sent.length;
  for(let index=0;index<steps.length;index++){
    const row=list.children[index]!,identity=row.children[0]!,subject=row.children[1]!,badge=identity.children[1]!,svg=badge.children[0]!,sha=identity.children[2]!;
    assert.equal(subject.className,'commit-subject');assert.equal(subject.textContent,hostile);assert.equal(subject.children.length,0,'Untrusted subject is never interpreted as HTML.');
    assert.equal(identity.children[0]!.textContent,`${index+1}.`);assert.equal(badge.children[1]!.textContent.toLowerCase(),steps[index]!.action);
    assert.equal(svg.attributes.get('aria-hidden'),'true');assert.equal(svg.attributes.get('focusable'),'false');assert.equal(sha.textContent,steps[index]!.oid.slice(0,8));
    assert.match(row.attributes.get('aria-label')!,new RegExp(steps[index]!.oid));
    row.listeners.get('click')!({});assert.equal(elements.get('message-preview')!.textContent,'Subject\n\nExact body');
    assert.equal(elements.get('message')!.disabled,steps[index]!.action!=='reword');
    const help=elements.get('action-help')!.textContent;assert.ok(help.length>20);if(index===1)assert.match(help,/file content stays unchanged/);if(index===5)assert.match(help,/Remove this commit/);
  }
  assert.equal(sent.length,before,'Selection, presentation and contextual guidance add no host requests.');
  const retained=elements.get('action-help')!.textContent;
  receive!({data:{type:'state',session:'expired',revision:4,steps:[steps[0]],range:'Wrong'}});assert.equal(elements.get('action-help')!.textContent,retained);
  receive!({data:{type:'busy',session:'s',busy:true}});list.children[0]!.listeners.get('click')!({});assert.equal(elements.get('action-help')!.textContent,retained);assert.equal(sent.length,before);
});
