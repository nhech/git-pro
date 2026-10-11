import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as path from 'node:path';

type Item={text:string;tooltip:string|undefined;command:string|undefined;name?:string;accessibilityInformation:{label:string}|undefined;visible:boolean};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
/** Read through a call: an assertion on the property itself would narrow it for the rest of the test. */
const label=(item:Item)=>item.accessibilityInformation?.label;
function harness(summary?:(id:string)=>Promise<unknown>){
  const file=path.resolve(__dirname,'../../src/statusbar/statusbar.controller.js'),load=createRequire(file),exports:Record<string,unknown>={};
  const item:Item={text:'',tooltip:undefined,command:undefined,accessibilityInformation:undefined,visible:false};
  const listeners=new Set<()=>void>();
  const vscode={StatusBarAlignment:{Left:1},window:{createStatusBarItem:()=>Object.assign(item,{show:()=>{item.visible=true;},hide:()=>{item.visible=false;},dispose:()=>undefined})}};
  runInNewContext(readFileSync(file,'utf8'),{exports,Date,require:(name:string)=>name==='vscode'?vscode:load(name)});
  const repo={id:'repo',root:path.join('work','demo')},store=new Map<string,Record<string,unknown>>();
  const registry={get active(){return store.size?repo:undefined;},store,onDidChange:(listener:()=>void)=>{listeners.add(listener);return {dispose:()=>listeners.delete(listener)};}};
  const surfaces={conflictSources:new Map(),...(summary?{operation:{summary}}:{})};
  const controller=new (exports.StatusbarController as new(registry:unknown,lastFetched:unknown,onDidFetch:unknown,surfaces:unknown)=>{dispose():void})(registry,()=>undefined,undefined,surfaces);
  const set=(snapshot:Record<string,unknown>)=>{store.set(repo.id,{head:'main',upstream:undefined,changes:[],refreshedAt:0,operation:'idle',...snapshot});for(const listener of listeners)listener();};
  return {item,set,controller};
}
const conflicts=(count:number)=>Array.from({length:count},(_,index)=>({group:'conflicts',path:`f${index}.ts`,status:'UU'}));

test('status bar shows the operation and the conflict count, and its click opens the operation menu only while one needs attention',()=>{
  const {item,set,controller}=harness();
  assert.equal(item.visible,false,'no repository, no item');
  set({upstream:'origin/main',ahead:1,behind:0});
  assert.equal(item.text,'$(git-branch) main ↑1 ↓0');assert.equal(item.command,'gitPro.selectRepository');assert.equal(label(item),undefined);
  assert.match(String(item.tooltip),/^demo\nOutgoing\/incoming relative to origin\/main/);
  set({upstream:'origin/main',ahead:1,behind:0,operation:'merging',changes:conflicts(3)});
  assert.equal(item.text,'$(git-branch) main ↑1 ↓0 MERGING $(warning) 3');assert.equal(item.command,'gitPro.operation.menu');
  assert.match(String(item.tooltip),/^Merge in progress · 3 conflicted files · Click for actions\ndemo\n/);
  assert.equal(label(item),'Git Pro: main, Merge in progress · 3 conflicted files');
  set({operation:'merging',changes:[]});assert.equal(item.text,'$(git-branch) main MERGING');assert.equal(item.command,'gitPro.operation.menu','Continue is still to be done');
  assert.match(String(item.tooltip),/^Merge in progress · all conflicts resolved · Click for actions/);
  set({changes:conflicts(1)});assert.equal(item.text,'$(git-branch) main $(warning) 1','stash and squash conflicts leave the state idle');assert.equal(item.command,'gitPro.operation.menu');
  assert.match(String(item.tooltip),/^Unresolved conflicts · 1 conflicted file · Click for actions/);
  set({operation:'bisecting'});assert.equal(item.command,'gitPro.operation.menu');assert.match(String(item.tooltip),/^Bisect in progress — finish in native Git · Click for actions/);
  set({});assert.equal(item.command,'gitPro.selectRepository');assert.equal(label(item),undefined);
  controller.dispose();
});

test('status bar tooltip names the branches once the operation summary arrives, and an older summary never overwrites newer state',async()=>{
  const pending:((value:unknown)=>void)[]=[];
  const {item,set,controller}=harness(()=>new Promise(resolve=>pending.push(resolve)));
  set({operation:'merging',changes:conflicts(2)});assert.match(String(item.tooltip),/^Merge in progress · 2 conflicted files/);
  pending.shift()!({repositoryId:'repo',operation:'merging',title:'Merging feature into main',yours:{label:'Yours',detail:'main'},theirs:{label:'Theirs',detail:'feature'},conflicts:2,editStop:false,canContinue:false,canSkip:false,canAbort:true,nativeOnly:false});await settle();
  assert.match(String(item.tooltip),/^Merging feature into main · 2 conflicted files · Click for actions\ndemo/);assert.equal(label(item),'Git Pro: main, Merging feature into main · 2 conflicted files');
  set({operation:'merging',changes:conflicts(1)});const stale=pending.shift()!;set({operation:'merging',changes:[]});
  stale({repositoryId:'repo',operation:'merging',title:'Merging old into main',conflicts:1,editStop:false,canContinue:false,canSkip:false,canAbort:true,nativeOnly:false,yours:{label:'Yours',detail:''},theirs:{label:'Theirs',detail:''}});await settle();
  assert.match(String(item.tooltip),/^Merge in progress · all conflicts resolved/,'the superseded summary is dropped');
  pending.shift()!(Promise.reject(new Error('unreadable')));await settle();assert.match(String(item.tooltip),/^Merge in progress/,'a failed summary keeps the plain wording');
  controller.dispose();
});
