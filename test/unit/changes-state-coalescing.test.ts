import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as path from 'node:path';

const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
type Row={kind:string;key:string;label:string};
type State={type:string;session:string;rows?:Row[];message?:string;repository?:string};
type Snapshot={changes:{group:string;path:string;status:string}[];version:number};
function fixture(){
  const file=path.resolve(__dirname,'../../src/views/changes/changes-panel.js'),load=createRequire(file),exports:Record<string,unknown>={};
  const registryListeners:(()=>void)[]=[],providerListeners:(()=>void)[]=[],configurationListeners:((event:{affectsConfiguration:(key:string)=>boolean})=>void)[]=[];
  const disposable={dispose:()=>undefined};let grouping='status',constructed=0;
  const repo={id:'repo-A',root:'fixture/A'},registry={active:repo as typeof repo|undefined,store:new Map<string,Snapshot>([[repo.id,{version:1,changes:[{group:'working',path:'a.txt',status:'M'}]}]]),errors:new Map<string,string>(),onDidChange:(callback:()=>void)=>{registryListeners.push(callback);return disposable;}};
  const vscode={workspace:{getConfiguration:()=>({get:()=>grouping}),onDidChangeConfiguration:(callback:typeof configurationListeners[number])=>{configurationListeners.push(callback);return disposable;}},Uri:{file:(value:string)=>value,joinPath:(_root:unknown,...parts:string[])=>parts.join('/')},commands:{executeCommand:async()=>undefined}};
  const provider={onDidChangeTreeData:(callback:()=>void)=>{providerListeners.push(callback);return disposable;},getChildren:(node?:{kind:string;group?:string})=>{const current=registry.active,changes=current?registry.store.get(current.id)?.changes??[]:[];return node?changes.map(change=>({kind:'file',repositoryId:current!.id,change})):[{kind:'group',group:'working'}];},getTreeItem:(node:{kind:string;group?:string;change?:{path:string}})=>{constructed++;return {label:node.kind==='file'?node.change!.path:'Working Tree',description:node.kind==='file'?'Modified':'1'};}};
  runInNewContext(readFileSync(file,'utf8'),{exports,Buffer,require:(name:string)=>name==='vscode'?vscode:load(name)});
  type Panel={resolveWebviewView(view:unknown):void;dispose():void;readonly selection:unknown[]};
  const Constructor=exports.ChangesPanel as new(context:unknown,registry:unknown,provider:unknown)=>Panel,panel=new Constructor({extensionUri:'owned'},registry,provider);
  const views:{sent:State[];receive:(value:unknown)=>void;disposed:()=>void;session:()=>string;setPost:(handler:(value:State)=>Promise<boolean>)=>void;view:{badge?:{value:number}}}[]=[];
  function resolve(){
    const sent:State[]=[];let receive:(value:unknown)=>void=()=>undefined,disposed:()=>void=()=>undefined,post:((value:State)=>Promise<boolean>)|undefined;
    const view:{badge?:{value:number};webview:{html:string;cspSource:string;asWebviewUri:(value:unknown)=>string;onDidReceiveMessage:(callback:typeof receive)=>typeof disposable;postMessage:(value:State)=>Promise<boolean>};onDidDispose:(callback:()=>void)=>typeof disposable}={webview:{html:'',cspSource:'owned:',asWebviewUri:value=>String(value),onDidReceiveMessage:callback=>{receive=callback;return disposable;},postMessage:async value=>{sent.push(value);return post?post(value):true;}},onDidDispose:callback=>{disposed=callback;return disposable;}};
    const result={sent,receive:(value:unknown)=>receive(value),disposed:()=>disposed(),session:()=>/data-session="([^"]+)"/.exec(view.webview.html)![1]!,setPost:(handler:(value:State)=>Promise<boolean>)=>{post=handler;},view};views.push(result);panel.resolveWebviewView(view);return result;
  }
  return {panel,registry,repo,resolve,views,get constructed(){return constructed;},fire:()=>{for(const callback of providerListeners)callback();for(const callback of registryListeners)callback();},group:(value:string)=>{grouping=value;for(const callback of configurationListeners)callback({affectsConfiguration:key=>key==='gitPro.changes.groupBy'});for(const callback of providerListeners)callback();}};
}

test('Changes skips duplicate and inactive-root rebuilds but replaces stale row actions after active updates',async()=>{
  const f=fixture(),v=f.resolve();await settle();assert.equal(f.constructed,2);const key=v.sent[0]!.rows!.find(row=>row.kind==='file')!.key;
  v.receive({type:'select',session:v.session(),keys:[key]});await settle();assert.equal(f.panel.selection.length,1);
  f.registry.store.set('repo-B',{version:99,changes:[]});for(let i=0;i<30;i++)f.fire();await settle();assert.equal(f.constructed,2);assert.equal(v.sent.length,1);assert.equal(f.panel.selection.length,1);
  f.registry.store.set(f.repo.id,{version:2,changes:[{group:'working',path:'b.txt',status:'M'}]});f.fire();await settle();assert.equal(f.constructed,4);assert.equal(v.sent.length,2);assert.equal(f.panel.selection.length,0);
  v.receive({type:'select',session:v.session(),keys:[key]});await settle();assert.equal(v.sent.at(-1)!.type,'error');assert.match(v.sent.at(-1)!.message!,/stale/);f.panel.dispose();
});

test('Changes invalidates grouping, error presence, loading and repository transitions',async()=>{
  const f=fixture(),v=f.resolve();await settle();f.group('folder');await settle();assert.equal(v.sent.length,2);assert.equal(f.constructed,4);f.group('folder');await settle();assert.equal(v.sent.length,2);
  f.registry.errors.set(f.repo.id,'status failed');f.fire();await settle();assert.equal(v.sent.at(-1)!.message,'status failed');assert.equal(v.view.badge,undefined);
  f.registry.errors.set(f.repo.id,'');f.fire();await settle();assert.equal(v.sent.at(-1)!.rows!.length,2);assert.equal(v.view.badge,undefined);
  f.registry.errors.delete(f.repo.id);f.fire();await settle();assert.equal(v.view.badge!.value,1);
  f.registry.store.delete(f.repo.id);f.fire();await settle();assert.match(v.sent.at(-1)!.message!,/Loading/);
  f.registry.active=undefined;f.fire();await settle();assert.equal(v.sent.at(-1)!.repository,'No repository');
  f.registry.active={id:'repo-C',root:'fixture/C'};f.registry.store.set('repo-C',{version:1,changes:[]});f.fire();await settle();assert.equal(v.sent.at(-1)!.repository,'C');assert.equal(v.sent.at(-1)!.message,'Working tree clean');f.panel.dispose();
});

test('Changes retries false and rejected posts and forces renderer ready/new-view delivery',async()=>{
  const f=fixture(),v=f.resolve();await settle();v.setPost(async()=>false);v.receive({type:'ready',session:v.session()});await settle();assert.equal(v.sent.length,2);f.fire();await settle();assert.equal(v.sent.length,3);
  v.setPost(async()=>{throw new Error('frame unavailable');});f.fire();await settle();assert.equal(v.sent.length,4);v.setPost(async()=>true);f.fire();await settle();assert.equal(v.sent.length,5);f.fire();await settle();assert.equal(v.sent.length,5);
  v.receive({type:'ready',session:v.session()});await settle();assert.equal(v.sent.length,6);const oldSession=v.session();v.disposed();const next=f.resolve();await settle();assert.notEqual(next.session(),oldSession);assert.equal(next.sent.length,1);f.fire();await settle();assert.equal(next.sent.length,1);f.panel.dispose();f.fire();await settle();assert.equal(next.sent.length,1);
});

test('Changes reserves in-flight state and an older failed post cannot invalidate a newer delivery',async()=>{
  const f=fixture(),v=f.resolve();await settle();let complete:(value:boolean)=>void=()=>undefined;v.setPost(()=>new Promise<boolean>(resolve=>{complete=resolve;}));
  f.registry.store.set(f.repo.id,{version:2,changes:[{group:'working',path:'pending.txt',status:'M'}]});f.fire();f.fire();await settle();assert.equal(v.sent.length,2);assert.equal(f.constructed,4);
  v.setPost(async()=>true);v.receive({type:'ready',session:v.session()});await settle();assert.equal(v.sent.length,3);complete(false);await settle();f.fire();await settle();assert.equal(v.sent.length,3);
  f.registry.store.set(f.repo.id,{version:3,changes:[{group:'working',path:'fresh.txt',status:'M'}]});f.fire();await settle();assert.equal(v.sent.length,4);assert.ok(v.sent.at(-1)!.rows!.some(row=>row.label==='fresh.txt'));f.panel.dispose();
});
