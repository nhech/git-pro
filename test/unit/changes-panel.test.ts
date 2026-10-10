import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as path from 'node:path';

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
