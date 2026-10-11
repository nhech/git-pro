import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as path from 'node:path';

const settle=()=>new Promise(resolve=>setImmediate(resolve));
type Snapshot={operation:string;changes:{group:string;path:string;status:string}[]};
function harness(mode='gitPro',answer?:string){
  const file=path.resolve(__dirname,'../../src/conflicts/conflict-watcher.js'),load=createRequire(file),exports:Record<string,unknown>={};
  const contexts=new Map<string,unknown>(),commands:{id:string;args:unknown[]}[]=[],toasts:{message:string;items:string[]}[]=[],errors:string[]=[];let setContextCalls=0;
  const vscode={
    Uri:{file:(fsPath:string)=>({scheme:'file',fsPath,toString:()=>`file:///${fsPath.replace(/\\/g,'/')}`})},
    workspace:{getConfiguration:()=>({get:(key:string)=>key==='conflicts.autoOpen'?mode:undefined})},
    window:{showInformationMessage:async(message:string,...items:string[])=>{toasts.push({message,items});return answer;}},
    commands:{executeCommand:async(id:string,...args:unknown[])=>{if(id==='setContext'){setContextCalls++;contexts.set(args[0] as string,args[1]);return;}commands.push({id,args});}}
  };
  runInNewContext(readFileSync(file,'utf8'),{exports,require:(name:string)=>name==='vscode'?vscode:load(name)});
  const repos=[{id:'A',root:path.join('work','alpha')},{id:'B',root:path.join('work','beta')}];
  let open=[...repos],active:typeof repos[number]|undefined=repos[0];const store=new Map<string,Snapshot>(),listeners=new Set<()=>void>();
  const registry={get active(){return active;},list:()=>open,store,onDidChange:(listener:()=>void)=>{listeners.add(listener);return {dispose:()=>listeners.delete(listener)};}};
  const opened:{id:string;options:unknown}[]=[],surfaces={conflictSources:new Map<string,unknown>(),conflicts:{open:async(id:string,options:unknown)=>{opened.push({id,options});}}};
  const fire=()=>{for(const listener of listeners)listener();};
  const watcher=new (exports.ConflictWatcher as new(registry:unknown,surfaces:unknown,logger:unknown)=>{dispose():void})(registry,surfaces,{info:()=>undefined,error:(message:string)=>errors.push(message)});
  const set=(id:string,operation:string,conflicts:number,extra:{group:string;path:string;status:string}[]=[])=>{store.set(id,{operation,changes:[...Array.from({length:conflicts},(_,index)=>({group:'conflicts',path:`dir/f${index}.ts`,status:'UU'})),...extra]});fire();};
  return {contexts,commands,toasts,errors,opened,surfaces,watcher,set,fire,store,repos,
    get setContextCalls(){return setContextCalls;},select:(id:string|undefined)=>{active=repos.find(repo=>repo.id===id);fire();},close:(id:string)=>{open=open.filter(repo=>repo.id!==id);store.delete(id);fire();}};
}
/** Arrays built in the vm context have that realm's prototype; Array.from brings them into this one. */
const uris=(value:unknown)=>Array.from(value as {toString():string}[],uri=>uri.toString());

test('the watcher keeps the operation, conflict and resource context keys for the manifest, as Uri objects capped at 500',async()=>{
  const h=harness();await settle();
  assert.equal(h.contexts.get('gitPro.operation'),'idle');assert.equal(h.contexts.get('gitPro.hasConflicts'),false);assert.deepEqual(uris(h.contexts.get('gitPro.conflictResources')),[]);
  h.set('A','merging',2,[{group:'working',path:'readme.md',status:'M'}]);await settle();
  assert.equal(h.contexts.get('gitPro.operation'),'merging');assert.equal(h.contexts.get('gitPro.hasConflicts'),true);
  assert.deepEqual(uris(h.contexts.get('gitPro.conflictResources')),[0,1].map(index=>`file:///${path.join('work','alpha','dir',`f${index}.ts`).replace(/\\/g,'/')}`),'only conflicted files, as file Uris');
  assert.ok((h.contexts.get('gitPro.conflictResources') as {scheme:string}[]).every(uri=>uri.scheme==='file'),'Uri objects, not strings');
  const calls=h.setContextCalls;h.fire();await settle();assert.equal(h.setContextCalls,calls,'an unrelated registry event sets nothing');
  h.set('B','idle',600);await settle();
  const resources=uris(h.contexts.get('gitPro.conflictResources'));assert.equal(resources.length,500,'N9 cap');assert.ok(resources[0]!.includes('alpha'),'the active repository comes first');
  assert.equal(h.contexts.get('gitPro.operation'),'merging','operation and hasConflicts follow the active repository');
  h.select('B');await settle();assert.equal(h.contexts.get('gitPro.operation'),'idle');assert.equal(h.contexts.get('gitPro.hasConflicts'),true);assert.ok(uris(h.contexts.get('gitPro.conflictResources'))[0]!.includes('beta'));
  h.surfaces.conflictSources.set('B',{kind:'stashPop',oid:'a'.repeat(40),selector:'stash@{0}'});
  h.close('B');await settle();assert.equal(h.surfaces.conflictSources.has('B'),false,'a closed repository forgets its recorded source');
  assert.equal(uris(h.contexts.get('gitPro.conflictResources')).length,2,'and its resources');assert.equal(h.contexts.get('gitPro.operation'),'idle','no active repository reads idle');
  h.watcher.dispose();
});

test('autoOpen always opens the tab in the background for conflicts that appear on the active repository; gitPro and never leave that to the failure path',async()=>{
  for(const mode of ['always','gitPro','never']){
    const h=harness(mode);h.set('A','idle',0);h.set('B','idle',0);await settle();
    h.set('A','merging',3);await settle();
    assert.deepEqual(h.opened.map(item=>JSON.stringify(item)),mode==='always'?[JSON.stringify({id:'A',options:{preserveFocus:true}})]:[],mode);
    h.set('A','merging',2);h.set('B','idle',1);await settle();assert.equal(h.opened.length,mode==='always'?1:0,'neither a count change nor another repository opens it again');
    h.watcher.dispose();
  }
  const first=harness('always');first.set('A','merging',4);await settle();assert.equal(first.opened.length,0,'conflicts present when the repository is first seen are not a transition');first.watcher.dispose();
});

test('when the last conflict of an operation is resolved the watcher offers Continue, which only runs the confirming command, and drops the recorded source',async()=>{
  const h=harness('gitPro','Continue Rebase…');h.set('A','rebasing',2);await settle();
  h.surfaces.conflictSources.set('A',{kind:'squash',oid:'b'.repeat(40)});
  h.set('A','rebasing',1);await settle();assert.equal(h.toasts.length,0);assert.equal(h.surfaces.conflictSources.has('A'),true);
  h.set('A','rebasing',0);await settle();await settle();
  assert.deepEqual(h.toasts.map(toast=>[toast.message,...toast.items]),[['Git Pro: All conflicts resolved in alpha.','Continue Rebase…']]);
  assert.deepEqual(h.commands.map(command=>JSON.stringify(command)),[JSON.stringify({id:'gitPro.operation.continue',args:['A']})],'Continue goes to the command, which confirms first');
  assert.equal(h.surfaces.conflictSources.has('A'),false);
  h.set('A','merging',1);h.set('A','idle',0);await settle();assert.equal(h.toasts.length,1,'an abort that clears conflicts is not a resolution');
  h.set('A','idle',2);h.set('A','idle',0);await settle();assert.equal(h.toasts.length,1,'idle stash conflicts have nothing to continue');
  h.watcher.dispose();
  const quiet=harness('never');quiet.set('A','merging',1);quiet.set('A','merging',0);await settle();assert.deepEqual(quiet.toasts.map(toast=>toast.items[0]),['Continue Merge…'],'never still shows the toast');assert.equal(quiet.commands.length,0,'dismissing runs nothing');
  quiet.watcher.dispose();
});
