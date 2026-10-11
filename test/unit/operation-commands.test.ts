import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as path from 'node:path';
import { operationBanner, operationStatus, operationTitle } from '../../src/conflicts/operation-text';
import type { OperationSummary } from '../../src/git/conflicts/conflict-contract';

type Pick={label:string;description?:string;run:()=>Promise<unknown>};
const summaryOf=(overrides:Partial<OperationSummary>):OperationSummary=>({repositoryId:'A',operation:'merging',title:'Merging feature into main',yours:{label:'Yours',detail:'main'},theirs:{label:'Theirs',detail:'feature'},
  sides:{yours:{stage:2,flag:'ours'},theirs:{stage:3,flag:'theirs'}},conflicts:0,editStop:false,canContinue:true,canSkip:false,canAbort:true,nativeOnly:false,...overrides});

function harness(options:{warning?:string;pick?:(items:Pick[])=>Pick|undefined}={}){
  const file=path.resolve(__dirname,'../../src/commands/operation.commands.js'),load=createRequire(file),exports:Record<string,unknown>={};
  const controls:{snapshot:unknown;action:string}[]=[],warnings:{message:string;items:string[]}[]=[],infos:string[]=[],executed:{id:string;args:unknown[]}[]=[],menus:{items:Pick[];title:string}[]=[],provided:string[]=[];
  const vscode={window:{showWarningMessage:async(message:string,...items:string[])=>{warnings.push({message,items});return options.warning;},showInformationMessage:async(message:string)=>{infos.push(message);},
    showQuickPick:async(items:Pick[],config:{title:string})=>{menus.push({items,title:config.title});return options.pick?.(items);}},
    commands:{executeCommand:async(id:string,...args:unknown[])=>{executed.push({id,args});}}};
  class OperationContext{summary(id:string){provided.push(id);return Promise.resolve(summaryOf({repositoryId:id}));}}
  class ConflictWatcher{dispose(){/* inert */}}
  const stubs:Record<string,unknown>={vscode,'./advanced.commands':{confirmAndControl:async(_advanced:unknown,snapshot:unknown,action:string)=>{controls.push({snapshot,action});return true;}},
    '../git/conflicts/operation-context':{OperationContext},'../conflicts/conflict-watcher':{ConflictWatcher}};
  runInNewContext(readFileSync(file,'utf8'),{exports,require:(name:string)=>name in stubs?stubs[name]:load(name)});
  const repos=[{id:'A',root:path.join('work','alpha')},{id:'B',root:path.join('work','beta')}];
  const snapshots=new Map<string,{operation:string;changes:{group:string;path:string}[]}>();
  const store=new Map<string,unknown>(),registry={active:repos[0],list:()=>repos,store};
  const fresh:{operation:string;conflicts:number}[]=[];
  const advanced={snapshot:async(id:string)=>{const value=snapshots.get(id)!;fresh.push({operation:value.operation,conflicts:value.changes.length});return {repositoryId:id,operation:value.operation,status:{changes:value.changes}};}};
  const opened:string[]=[],surfaces:Record<string,unknown>={conflictSources:new Map(),conflicts:{open:async(id:string)=>{opened.push(id);}}};
  const registered=new Map<string,(...args:unknown[])=>Promise<unknown>>(),subscriptions:unknown[]=[];
  (exports.registerOperation as (context:unknown,deps:unknown,command:unknown)=>void)({subscriptions},{registry,advanced,surfaces,logger:{info:()=>undefined,error:()=>undefined}},(id:string,action:(...args:unknown[])=>Promise<unknown>)=>registered.set(id,action));
  const state=(id:string,operation:string,conflicts:number)=>{const value={operation,changes:Array.from({length:conflicts},(_,index)=>({group:'conflicts',path:`f${index}`}))};snapshots.set(id,value);store.set(id,{...value});};
  return {exports,registered,subscriptions,surfaces,controls,warnings,infos,executed,menus,opened,provided,state,fresh,run:(id:string,...args:unknown[])=>registered.get(id)!(...args)};
}

test('the operation commands confirm through confirmAndControl, point to the Conflicts tab while files remain, and refuse what Git cannot do',async()=>{
  const h=harness({warning:'Resolve Conflicts…'});
  assert.deepEqual([...h.registered.keys()],['gitPro.operation.menu','gitPro.operation.continue','gitPro.operation.abort','gitPro.operation.skip']);
  assert.equal(h.subscriptions.length,1,'the conflict watcher belongs to the extension context');
  h.state('A','merging',2);
  assert.equal(await h.run('gitPro.operation.continue'),false);assert.equal(h.controls.length,0,'Continue never reaches Git while conflicts remain');
  assert.equal(h.warnings[0]!.message,'Git Pro: 2 conflicts remain. Resolve and stage them before continuing.');assert.deepEqual(h.opened,['A']);
  await h.run('gitPro.operation.abort');assert.equal(h.controls.at(-1)?.action,'abort');assert.equal((h.controls.at(-1)!.snapshot as {repositoryId:string}).repositoryId,'A');
  await assert.rejects(()=>h.run('gitPro.operation.skip'),/A merge has no commit to skip/);
  h.state('B','rebasing',0);await h.run('gitPro.operation.continue','B');assert.deepEqual([h.controls.at(-1)?.action,(h.controls.at(-1)!.snapshot as {repositoryId:string}).repositoryId],['continue','B'],'a banner or toast names its repository');
  await h.run('gitPro.operation.skip','B');assert.equal(h.controls.at(-1)?.action,'skip');
  await assert.rejects(()=>h.run('gitPro.operation.abort','gone'),/no longer open/);
  h.state('A','idle',0);await assert.rejects(()=>h.run('gitPro.operation.continue'),/No merge, rebase, cherry-pick or revert/);
  const count=h.controls.length;h.state('A','bisecting',0);await h.run('gitPro.operation.abort');assert.equal(h.controls.length,count);assert.match(h.infos.at(-1)!,/Bisect in progress\. Use native Git/);
});

test('the status-bar operation menu lists only what the state allows and runs the chosen action through the same confirmations',async()=>{
  const h=harness({pick:items=>items.find(item=>item.label.endsWith('Abort…'))});
  // The items are built in the vm context; Array.from brings their labels into this realm.
  const labels=(index:number)=>Array.from(h.menus[index]!.items,item=>item.label);
  h.state('A','merging',3);await h.run('gitPro.operation.menu');
  assert.deepEqual(labels(0),['$(list-unordered) Open Conflicts','$(debug-continue) Continue Merge…','$(circle-slash) Abort…','$(repo) Select Repository'],'a merge has no Skip');
  assert.equal(h.menus[0]!.title,'Git Pro: Merging feature into main · 3 conflicted files');assert.equal(h.menus[0]!.items[1]!.description,'Resolve and stage all conflicts first');
  assert.equal(h.controls.at(-1)?.action,'abort','the chosen Abort still goes through confirmAndControl');
  h.state('A','rebasing',0);await h.run('gitPro.operation.menu');
  assert.deepEqual(labels(1),['$(list-unordered) Open Conflicts','$(debug-continue) Continue Rebase…','$(debug-step-over) Skip Commit…','$(circle-slash) Abort…','$(repo) Select Repository']);
  h.state('A','bisecting',0);await h.run('gitPro.operation.menu');assert.deepEqual(labels(2),['$(source-control) Open Source Control','$(repo) Select Repository']);
  h.state('A','idle',2);await h.run('gitPro.operation.menu');assert.deepEqual(labels(3),['$(list-unordered) Open Conflicts','$(repo) Select Repository'],'idle conflicts have nothing to continue');
});

test('operation summaries are shared per status snapshot and source, never cached on failure, and bypassed for a caller-owned signal',async()=>{
  const h=harness(),cached=h.exports.cachedSummaries as (registry:unknown,sources:Map<string,unknown>,provider:{summary(id:string,signal?:AbortSignal):Promise<unknown>})=>{summary(id:string,signal?:AbortSignal):Promise<unknown>};
  let calls=0,fail=false;const store=new Map<string,object>([['A',{}]]),sources=new Map<string,unknown>();
  const provider=cached({store},sources,{summary:async()=>{calls++;if(fail)throw new Error('unreadable');return {calls};}});
  assert.equal(await provider.summary('A'),await provider.summary('A'));assert.equal(calls,1);
  sources.set('A',{kind:'stashPop',oid:'a'.repeat(40),selector:'stash@{0}'});await provider.summary('A');assert.equal(calls,2,'a recorded source relabels the operation');
  store.set('A',{});fail=true;await assert.rejects(provider.summary('A'));await new Promise(resolve=>setImmediate(resolve));fail=false;await provider.summary('A');assert.equal(calls,4,'a failure is retried');
  await provider.summary('A',new AbortController().signal);assert.equal(calls,5);await provider.summary('B');await provider.summary('B');assert.equal(calls,7,'no snapshot, no caching');
  assert.ok(h.surfaces.operation,'registerOperation provides the summary surface');await (h.surfaces.operation as {summary(id:string):Promise<unknown>}).summary('A');assert.deepEqual(h.provided,['A'],'built on the operation context');
});

test('operation wording follows §3.4 for every state and never lets an older summary relabel a new operation',()=>{
  const conflicted=operationBanner('merging',3,summaryOf({canContinue:false}))!;
  assert.equal(conflicted.text,'Merging feature into main · 3 conflicts');
  assert.deepEqual(conflicted.actions.map(item=>[item.id,item.label,item.primary??false,item.disabled??'']),[['resolve','Resolve…',true,''],['continue','Continue Merge…',false,'Resolve and stage all conflicts first'],['abort','Abort…',false,'']]);
  const resolved=operationBanner('merging',0,summaryOf({}))!;assert.equal(resolved.text,'Merging feature into main · all conflicts resolved');assert.deepEqual(resolved.actions.map(item=>[item.id,item.primary??false]),[['continue',true],['abort',false]]);
  const rebase=summaryOf({operation:'rebasing',title:'Rebasing feature onto main',progress:{current:3,total:7},yours:{label:'Yours',oid:'9f8e7d6c5b4a39281706f5e4d3c2b1a098765432',subject:'Add login',detail:''},canSkip:true,canContinue:false});
  assert.equal(operationBanner('rebasing',2,rebase)!.text,'Rebasing feature onto main · 3/7 · 9f8e7d6 Add login · 2 conflicts');
  assert.deepEqual(operationBanner('rebasing',2,rebase)!.actions.map(item=>item.id),['resolve','continue','skip','abort']);
  assert.equal(operationBanner('rebasing',2,rebase)!.actions.find(item=>item.id==='skip')!.label,'Skip Commit…');
  const edit=operationBanner('rebasing',0,{...rebase,editStop:true,canContinue:true})!;assert.deepEqual(edit.actions.map(item=>item.id),['continue','amend','abort']);assert.match(edit.text,/stopped to edit this commit$/);
  assert.equal(operationBanner('cherry-picking',1,summaryOf({operation:'cherry-picking',title:'Cherry-picking 9f8e7d6 onto main',canSkip:true,canContinue:false}))!.text,'Cherry-picking 9f8e7d6 onto main · 1 conflict');
  assert.deepEqual(operationBanner('reverting',0)!.actions.map(item=>item.label),['Continue Revert…','Skip…','Abort…'],'plain wording when no summary is ready');
  const stash=operationBanner('idle',2,summaryOf({operation:'idle',title:'Conflicts from applying stash@{0} (stash kept)',canContinue:false,canAbort:false}))!;
  assert.equal(stash.text,'Conflicts from applying stash@{0} (stash kept) · 2 conflicts');assert.deepEqual(stash.actions.map(item=>item.id),['resolve']);
  assert.equal(operationBanner('idle',0),undefined,'a clean idle repository has no banner');
  const bisect=operationBanner('bisecting',0)!;assert.equal(bisect.text,'Bisect in progress — finish in native Git');assert.deepEqual(bisect.actions.map(item=>item.id),['sourceControl']);
  assert.equal(operationTitle('rebasing',summaryOf({})),'Rebase in progress','a merge summary never names a rebase');
  assert.equal(operationBanner('rebasing',1,summaryOf({}))!.text,'Rebase in progress · 1 conflict');
  assert.equal(operationStatus('merging',1,summaryOf({})),'Merging feature into main · 1 conflicted file');assert.equal(operationStatus('idle',2),'Unresolved conflicts · 2 conflicted files');
});
