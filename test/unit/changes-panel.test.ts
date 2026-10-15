import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as path from 'node:path';

type Change={group:string;path:string;status:string};
type Row={key:string;kind:string;group?:string;label:string;status?:string;conflict?:{mergeable:boolean;workingFile:boolean}};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
/** Values built inside the vm context have that realm's prototypes; compare their JSON. */
const same=(actual:unknown,expected:unknown,message?:string)=>assert.equal(JSON.stringify(actual),JSON.stringify(expected),message);
/** The real panel against a recorded command bus and late-bound surfaces; the provider labels conflicts with their kind as the real one does. */
async function conflictHarness(root:string,operation:string,changes:Change[],surfaces:Record<string,unknown>={}){
  const file=path.resolve(__dirname,'../../src/views/changes/changes-panel.js'),load=createRequire(file),exports:Record<string,unknown>={};
  const sent:Record<string,unknown>[]=[],commands:{id:string;args:unknown[]}[]=[];let receive:(value:unknown)=>void=()=>undefined;
  const disposable={dispose:()=>undefined},onChange=()=>disposable;
  const vscode={workspace:{onDidChangeConfiguration:onChange,getConfiguration:()=>({get:()=> 'status'})},Uri:{file:(value:string)=>`file:${value}`,joinPath:(_root:unknown,...parts:string[])=>parts.join('/')},commands:{executeCommand:async(id:string,...args:unknown[])=>{commands.push({id,args});}}};
  runInNewContext(readFileSync(file,'utf8'),{exports,Buffer,setTimeout,clearTimeout,require:(name:string)=>name==='vscode'?vscode:load(name)});
  const repo={id:'repo-A',root},nodes=changes.map(change=>({kind:'file',repositoryId:repo.id,change})),groups=[...new Set(changes.map(change=>change.group))].map(group=>({kind:'group',group}));
  const store=new Map([[repo.id,{changes,operation}]]),registry={active:repo,list:()=>[repo],store,errors:new Map(),onDidChange:onChange};
  const kinds:Record<string,string>={UU:'Both modified',DU:'Deleted by us',DD:'Both deleted'};
  const provider={onDidChangeTreeData:onChange,getChildren:(node?:{group:string})=>node?nodes.filter(item=>item.change.group===node.group):groups,
    getTreeItem:(node:{kind:string;group?:string;change?:Change})=>({label:node.kind==='file'?node.change!.path:node.group,description:node.kind==='file'?node.change!.group==='conflicts'?kinds[node.change!.status]:'Modified':'1'})};
  const view={webview:{html:'',cspSource:'owned:',asWebviewUri:(uri:unknown)=>String(uri),onDidReceiveMessage:(callback:typeof receive)=>{receive=callback;return disposable;},postMessage:async(value:Record<string,unknown>)=>{sent.push(value);return true;}},onDidDispose:onChange};
  const holder={conflictSources:new Map(),...surfaces};
  const panel=new (exports.ChangesPanel as new(context:unknown,registry:unknown,provider:unknown,surfaces:unknown)=>{resolveWebviewView(view:unknown):void;dispose():void})({extensionUri:'owned'},registry,provider,holder);
  panel.resolveWebviewView(view);
  // The first render reads working files with lstat and may wait for an operation summary, so wait for its state.
  for(let i=0;i<200&&!sent.some(value=>value.type==='state');i++)await new Promise(resolve=>setTimeout(resolve,10));
  await settle();
  const session=/data-session="([^"]+)"/.exec(view.webview.html)![1]!;
  const state=()=>sent.filter(value=>value.type==='state').at(-1)!;
  const rows=()=>state().rows as Row[],key=(label:string)=>rows().find(row=>row.label===label)!.key;
  // Every request answers with a command or a message; wait for one (bounded) rather than a fixed number of turns.
  const request=async(message:Record<string,unknown>)=>{const marks=[sent.length,commands.length];receive({session,...message});for(let i=0;i<200&&sent.length===marks[0]&&commands.length===marks[1];i++)await new Promise(resolve=>setTimeout(resolve,10));await settle();await settle();};
  return {panel,sent,commands,state,rows,key,request,view,session,store,repo};
}

test('Changes host group actions resolve only the current group while header actions remain repository-wide',async()=>{
  const file=path.resolve(__dirname,'../../src/views/changes/changes-panel.js'),load=createRequire(file),exports:Record<string,unknown>={};
  const sent:Record<string,unknown>[]=[],commands:{id:string;args:unknown[]}[]=[];let receive:(value:unknown)=>void=()=>undefined;
  const disposable={dispose:()=>undefined},onChange=()=>disposable;
  const vscode={workspace:{onDidChangeConfiguration:onChange,getConfiguration:()=>({get:()=> 'status'})},Uri:{file:(value:string)=>value,joinPath:(_root:unknown,...parts:string[])=>parts.join('/')},commands:{executeCommand:async(id:string,...args:unknown[])=>{commands.push({id,args});}}};
  runInNewContext(readFileSync(file,'utf8'),{exports,Buffer,require:(name:string)=>name==='vscode'?vscode:load(name)});
  const repo={id:'repo-A',root:'fixture'},fileNode=(group:string,name:string)=>({kind:'file',repositoryId:repo.id,change:{group,path:name,status:'M'}});
  const working=fileNode('working','tracked.txt'),untracked=fileNode('untracked','new.txt'),staged=fileNode('staged','staged.txt');
  const groups=['working','untracked','staged'].map(group=>({kind:'group',group}));
  const registry={active:repo,store:new Map([[repo.id,{changes:[working.change,untracked.change,staged.change]}]]),errors:new Map(),onDidChange:onChange};
  const provider={onDidChangeTreeData:onChange,getChildren:(node?:{group:string})=>node?[working,untracked,staged].filter(file=>file.change.group===node.group):groups,getTreeItem:(node:{kind:string;group?:string;change?:{path:string}})=>({label:node.kind==='file'?node.change!.path:node.group,description:node.kind==='file'?'Modified':'1'})};
  const view={webview:{html:'',cspSource:'owned:',asWebviewUri:(uri:unknown)=>String(uri),onDidReceiveMessage:(callback:typeof receive)=>{receive=callback;return disposable;},postMessage:async(value:Record<string,unknown>)=>{sent.push(value);return true;}},onDidDispose:onChange};
  type Panel={resolveWebviewView(view:unknown):void;dispose():void};
  const Constructor=exports.ChangesPanel as new(context:unknown,registry:unknown,provider:unknown)=>Panel,panel=new Constructor({extensionUri:'owned'},registry,provider);
  panel.resolveWebviewView(view);await new Promise(resolve=>setImmediate(resolve));
  const session=/data-session="([^"]+)"/.exec(view.webview.html)![1]!;
  const groupRows=sent.at(-1)!.rows as {kind:string;group:string;key:string}[],key=(group:string)=>groupRows.find(row=>row.kind==='group'&&row.group===group)!.key;
  const request=async(action:string,rowKey?:string)=>{receive({type:'action',session,action,...(rowKey?{key:rowKey,keys:[rowKey]}:{})});await new Promise(resolve=>setImmediate(resolve));};
  await request('stageAll',key('working'));assert.equal(commands.at(-1)?.id,'gitPro.stage');assert.deepEqual(Array.from(commands.at(-1)!.args[1] as unknown[]),[working]);
  await request('stageAll',key('untracked'));assert.deepEqual(Array.from(commands.at(-1)!.args[1] as unknown[]),[untracked]);
  await request('unstageAll',key('staged'));assert.equal(commands.at(-1)?.id,'gitPro.unstage');assert.deepEqual(Array.from(commands.at(-1)!.args[1] as unknown[]),[staged]);
  const before=commands.length;await request('stageAll',key('staged'));assert.equal(commands.length,before);assert.match(String(sent.at(-1)?.message),/unavailable/);
  await request('stageAll','stale-key');assert.equal(commands.length,before);assert.match(String(sent.at(-1)?.message),/stale/);
  await request('stageAll');assert.equal(commands.at(-1)?.id,'gitPro.stageAll');assert.equal(commands.at(-1)?.args.length,0);
  panel.dispose();
});

test('Changes rows for very long or wide-character paths keep short identities that the protocol accepts',async()=>{
  const file=path.resolve(__dirname,'../../src/views/changes/changes-panel.js'),load=createRequire(file),exports:Record<string,unknown>={};
  const sent:Record<string,unknown>[]=[],commands:{id:string;args:unknown[]}[]=[];let receive:(value:unknown)=>void=()=>undefined;
  const disposable={dispose:()=>undefined},onChange=()=>disposable;
  const vscode={workspace:{onDidChangeConfiguration:onChange,getConfiguration:()=>({get:()=> 'status'})},Uri:{file:(value:string)=>value,joinPath:(_root:unknown,...parts:string[])=>parts.join('/')},commands:{executeCommand:async(id:string,...args:unknown[])=>{commands.push({id,args});}}};
  runInNewContext(readFileSync(file,'utf8'),{exports,Buffer,require:(name:string)=>name==='vscode'?vscode:load(name)});
  const repo={id:'repo-A',root:'fixture'};
  const long=`${'deeply-nested-directory/'.repeat(80)}file.txt`,wide=`${'文件夹'.repeat(200)}/文件.txt`;
  const files=[long,wide].map(name=>({kind:'file',repositoryId:repo.id,change:{group:'working',path:name,status:'M'}})),groups=[{kind:'group',group:'working'}];
  const registry={active:repo,store:new Map([[repo.id,{changes:files.map(item=>item.change)}]]),errors:new Map(),onDidChange:onChange};
  const provider={onDidChangeTreeData:onChange,getChildren:(node?:{group:string})=>node?files:groups,getTreeItem:(node:{kind:string;group?:string;change?:{path:string}})=>({label:node.kind==='file'?node.change!.path:node.group,description:'1'})};
  const view={webview:{html:'',cspSource:'owned:',asWebviewUri:(uri:unknown)=>String(uri),onDidReceiveMessage:(callback:typeof receive)=>{receive=callback;return disposable;},postMessage:async(value:Record<string,unknown>)=>{sent.push(value);return true;}},onDidDispose:onChange};
  const panel=new (exports.ChangesPanel as new(context:unknown,registry:unknown,provider:unknown)=>{resolveWebviewView(view:unknown):void;dispose():void})({extensionUri:'owned'},registry,provider);
  panel.resolveWebviewView(view);await new Promise(resolve=>setImmediate(resolve));
  const session=/data-session="([^"]+)"/.exec(view.webview.html)![1]!;receive({type:'ready',session});await new Promise(resolve=>setImmediate(resolve));
  const rows=(sent.filter(value=>Array.isArray(value.rows)).at(-1)!.rows as {kind:string;key:string;label:string}[]).filter(row=>row.kind==='file');
  assert.equal(rows.length,2);assert.ok(rows.every(row=>row.key.length<=64),'identities do not grow with the path');
  for(const row of rows){
    receive({type:'action',session,action:'stage',key:row.key,keys:[row.key]});await new Promise(resolve=>setImmediate(resolve));
    assert.equal(commands.at(-1)?.id,'gitPro.stage');assert.equal((commands.at(-1)!.args[0] as {change:{path:string}}).change.path,row.label);
  }
  // The inline Open File action opens the row's own file through the authorizing command.
  receive({type:'action',session,action:'open',key:rows[0]!.key,keys:[rows[0]!.key]});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(commands.at(-1)?.id,'gitPro.openFile');assert.equal(JSON.stringify(commands.at(-1)!.args),JSON.stringify([repo.id,rows[0]!.label]));
  panel.dispose();
});

test('Changes conflict rows carry their kind, Merge… eligibility and working-file presence, and route Merge…, Accept and Open in Conflicts by row identity',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'git-pro-changes-conflicts-'));
  try{
    await writeFile(path.join(root,'app.ts'),'<<<<<<< HEAD\n');await writeFile(path.join(root,'old.ts'),'kept\n');
    const h=await conflictHarness(root,'merging',[{group:'conflicts',path:'app.ts',status:'UU'},{group:'conflicts',path:'old.ts',status:'DU'},{group:'conflicts',path:'gone.ts',status:'DD'},{group:'working',path:'readme.md',status:'M'}]);
    const conflict=(label:string)=>h.rows().find(row=>row.label===label)!;
    assert.deepEqual([conflict('app.ts').status,conflict('old.ts').status,conflict('gone.ts').status],['Both modified','Deleted by us','Both deleted']);
    assert.equal(JSON.stringify([conflict('app.ts').conflict,conflict('old.ts').conflict,conflict('gone.ts').conflict]),JSON.stringify([{mergeable:true,workingFile:true},{mergeable:false,workingFile:true},{mergeable:false,workingFile:false}]),'lstat decides Open File; only UU and AA merge');
    assert.equal(conflict('readme.md').conflict,undefined,'other rows carry no conflict data');
    await h.request({type:'action',action:'merge',key:h.key('app.ts')});same(h.commands.at(-1),{id:'gitPro.conflicts.merge',args:[h.repo.id,['app.ts']]},'Merge… names the repository and the path, never a webview value');
    const before=h.commands.length;await h.request({type:'action',action:'merge',key:h.key('old.ts')});assert.equal(h.commands.length,before);assert.match(String(h.sent.at(-1)?.message),/Accept Yours or Accept Theirs/);
    await h.request({type:'action',action:'diff',key:h.key('app.ts')});assert.equal(h.commands.at(-1)?.id,'gitPro.conflicts.merge','a conflicted file never reaches Diff');
    await h.request({type:'action',action:'diff',key:h.key('old.ts')});same(h.commands.at(-1),{id:'gitPro.conflicts.open',args:[h.repo.id,{select:['old.ts']}]});
    await h.request({type:'action',action:'acceptYours',key:h.key('app.ts'),keys:[h.key('app.ts'),h.key('old.ts')]});
    same(h.commands.at(-1),{id:'gitPro.conflicts.acceptYours',args:[h.repo.id,['app.ts','old.ts']]},'the Conflicts command confirms; the sidebar never overwrites in one click');
    await h.request({type:'action',action:'acceptTheirs',keys:[h.key('gone.ts')]});same(h.commands.at(-1),{id:'gitPro.conflicts.acceptTheirs',args:[h.repo.id,['gone.ts']]});
    const count=h.commands.length;await h.request({type:'action',action:'acceptYours',keys:[h.key('app.ts'),h.key('readme.md')]});
    assert.equal(h.commands.length,count,'Accept is refused for a selection with a non-conflict row');assert.match(String(h.sent.at(-1)?.message),/current conflicts only/);
    await h.request({type:'action',action:'openConflicts',keys:[h.key('app.ts'),h.key('gone.ts')]});same(h.commands.at(-1),{id:'gitPro.conflicts.open',args:[h.repo.id,{select:['app.ts','gone.ts']}]});
    await h.request({type:'action',action:'openConflicts',key:h.key('conflicts'),keys:[h.key('conflicts')]});same(h.commands.at(-1),{id:'gitPro.conflicts.open',args:[h.repo.id]},'the group opens the whole tab');
    await h.request({type:'action',action:'openConflicts',keys:[h.key('readme.md')]});assert.match(String(h.sent.at(-1)?.message),/current conflicts only/);
    h.panel.dispose();
  }finally{await rm(root,{recursive:true,force:true});}
});

test('Changes banner comes from the operation summary and its buttons act only while offered',async()=>{
  const summary={repositoryId:'repo-A',operation:'merging',title:'Merging feature into main',yours:{label:'Yours',detail:'main'},theirs:{label:'Theirs',detail:'feature'},sides:{yours:{stage:2,flag:'ours'},theirs:{stage:3,flag:'theirs'}},conflicts:1,editStop:false,canContinue:false,canSkip:false,canAbort:true,nativeOnly:false};
  const h=await conflictHarness('fixture-missing','merging',[{group:'conflicts',path:'app.ts',status:'UU'}],{operation:{summary:async()=>summary}});
  const banner=h.state().operation as {text:string;name:string;actions:{id:string;disabled?:string}[]};
  assert.equal(banner.text,'Merging feature into main · 1 conflict');assert.equal(banner.name,'Merge in progress');
  same(banner.actions.map(item=>[item.id,Boolean(item.disabled)]),[['resolve',false],['continue',true],['abort',false]]);
  await h.request({type:'operation',action:'resolve'});same(h.commands.at(-1),{id:'gitPro.conflicts.open',args:['repo-A']});
  await h.request({type:'operation',action:'abort'});same(h.commands.at(-1),{id:'gitPro.operation.abort',args:['repo-A']},'Abort goes to the command that confirms first');
  const before=h.commands.length;
  await h.request({type:'operation',action:'continue'});assert.equal(h.commands.length,before);assert.equal(h.sent.at(-1)?.message,'Resolve and stage all conflicts first.');
  await h.request({type:'operation',action:'skip'});assert.equal(h.commands.length,before,'a merge offers no Skip');assert.match(String(h.sent.at(-1)?.message),/Review the banner again/);
  await h.request({type:'operation',action:'exec'});assert.equal(h.commands.length,before);assert.match(String(h.sent.at(-1)?.message),/Invalid Changes view request/);
  h.panel.dispose();
});

test('Changes rows never wait long for a slow operation summary and pick up its wording once it arrives',async()=>{
  let release:(value:unknown)=>void=()=>undefined;const pending=new Promise(resolve=>{release=resolve;});
  const summary={repositoryId:'repo-A',operation:'rebasing',title:'Rebasing feature onto main',progress:{current:3,total:7},yours:{label:'Yours',oid:'9f8e7d6c5b4a39281706f5e4d3c2b1a098765432',subject:'Add login',detail:'Rebasing 9f8e7d6 from feature'},theirs:{label:'Theirs',detail:'main'},sides:{yours:{stage:3,flag:'theirs'},theirs:{stage:2,flag:'ours'}},conflicts:2,editStop:false,canContinue:false,canSkip:true,canAbort:true,nativeOnly:false};
  const calls:string[]=[];
  const h=await conflictHarness('fixture-missing','rebasing',[{group:'conflicts',path:'a.ts',status:'UU'},{group:'conflicts',path:'b.ts',status:'UU'}],{operation:{summary:(id:string)=>{calls.push(id);return pending;}}});
  // The summary is still pending here, so the plain wording must appear once the 300 ms wait lapses.
  for(let i=0;i<200&&(h.state()?.operation as {text:string}|undefined)?.text!=='Rebase in progress · 2 conflicts';i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal((h.state().operation as {text:string}).text,'Rebase in progress · 2 conflicts','plain wording first');assert.equal(h.rows().length,3,'the rows did not wait');
  release(summary);
  // The re-render reads working files with lstat, so wait for its result instead of a fixed number of turns.
  const worded='Rebasing feature onto main · 3/7 · 9f8e7d6 Add login · 2 conflicts';
  for(let i=0;i<200&&(h.state().operation as {text:string}).text!==worded;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal((h.state().operation as {text:string}).text,worded);
  same((h.state().operation as {actions:{id:string}[]}).actions.map(item=>item.id),['resolve','continue','skip','abort']);
  assert.ok(calls.length>=2&&calls.length<=3,'one re-render once the summary arrives');
  h.panel.dispose();
});

test('the Changes view allows scripts by nonce only, never by origin', async () => {
  const h = await conflictHarness('fixture-missing', 'merging', [{ group: 'conflicts', path: 'a.ts', status: 'UU' }]);
  const html = h.view.webview.html;
  assert.match(html, /script-src 'nonce-[0-9a-f]{32}';/);
  assert.doesNotMatch(html, /script-src[^;]*owned:/, 'the webview origin must not be a script source');
  h.panel.dispose();
});
