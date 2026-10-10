import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as path from 'node:path';
import { parseStatus, sameStatus, type StatusSnapshot } from '../../src/git/git-parser';

test('native mixed and separate collections keep untracked actions distinct and partial tracked changes in both groups', async () => {
  const file=path.resolve(__dirname,'../../src/git/builtin-git.adapter.js'),load=createRequire(file),exports:Record<string,unknown>={};
  const disposable={dispose:()=>undefined},onChange=()=>disposable;
  class EventEmitter { readonly event=onChange; fire():void{} dispose():void{} }
  const root=path.resolve('owned-adapter-fixture');
  const entry=(name:string,status:number)=>({uri:{fsPath:path.resolve(root,name)},status});
  const state={HEAD:undefined,indexChanges:[entry('partial.txt',0),entry('added.txt',1)],workingTreeChanges:[entry('partial.txt',5),entry('deleted.txt',6),entry('notes.txt',7)],untrackedChanges:[] as ReturnType<typeof entry>[],mergeChanges:[entry('conflict.txt',18)],onDidChange:onChange};
  const repo={rootUri:{scheme:'file',fsPath:root},state};
  const api={repositories:[repo],onDidOpenRepository:onChange,onDidCloseRepository:onChange};
  const vscode={EventEmitter,workspace:{getConfiguration:()=>({get:()=>undefined})},extensions:{getExtension:()=>({activate:async()=>({enabled:true,getAPI:()=>api,onDidChangeEnablement:onChange})})}};
  runInNewContext(readFileSync(file,'utf8'),{exports,require:(name:string)=>name==='vscode'?vscode:load(name),process});
  type Adapter={initialize():Promise<void>;repositories():{snapshot():StatusSnapshot}[];dispose():void};
  const Constructor=exports.BuiltinGitAdapter as new()=>Adapter,adapter=new Constructor();await adapter.initialize();
  const handle=adapter.repositories()[0]!;
  const expected=[{path:'partial.txt',status:'M',group:'staged'},{path:'added.txt',status:'A',group:'staged'},{path:'partial.txt',status:'M',group:'working'},{path:'deleted.txt',status:'D',group:'working'},{path:'notes.txt',status:'?',group:'untracked'},{path:'conflict.txt',status:'UU',group:'conflicts'}];
  const mixed=handle.snapshot();assert.deepEqual(JSON.parse(JSON.stringify(mixed.changes)),expected);
  assert.ok(Object.isFrozen(mixed)&&Object.isFrozen(mixed.changes)&&mixed.changes.every(Object.isFrozen));
  state.workingTreeChanges=state.workingTreeChanges.filter(c=>c.status!==7);state.untrackedChanges=[entry('notes.txt',7)];
  assert.deepEqual(JSON.parse(JSON.stringify(handle.snapshot().changes)),expected);
  state.workingTreeChanges.push(entry('../outside.txt',5));state.untrackedChanges.push(entry('../outside-new.txt',7));
  assert.deepEqual(JSON.parse(JSON.stringify(handle.snapshot().changes)),expected);
  adapter.dispose();
});

test('API snapshots of staged renames and conflicts equal the owned porcelain read, and hidden untracked files disable them', async () => {
  const file=path.resolve(__dirname,'../../src/git/builtin-git.adapter.js'),load=createRequire(file),exports:Record<string,unknown>={};
  const disposable={dispose:()=>undefined},onChange=()=>disposable;
  class EventEmitter { readonly event=onChange; fire():void{} dispose():void{} }
  const root=path.resolve('owned-adapter-fixture'),uri=(name:string)=>({fsPath:path.resolve(root,name)});
  const entry=(name:string,status:number,original=name)=>({uri:uri(name),originalUri:uri(original),status});
  const oid='b'.repeat(40),hash='c'.repeat(40);
  // VS Code reports a staged rename with the source as originalUri, also on the working-tree side of the same file.
  const state={HEAD:{name:'main',commit:oid},indexChanges:[entry('renamed.txt',3,'old.txt')],workingTreeChanges:[entry('renamed.txt',5,'old.txt'),entry('plain.txt',5)],untrackedChanges:[entry('new.txt',7)],
    mergeChanges:[entry('ours.txt',12),entry('theirs.txt',13),entry('deleted-us.txt',14),entry('deleted-them.txt',15),entry('both-added.txt',16),entry('both-deleted.txt',17),entry('both.txt',18)],onDidChange:onChange};
  const api={repositories:[{rootUri:{scheme:'file',fsPath:root},state}],onDidOpenRepository:onChange,onDidCloseRepository:onChange};
  const settings={untrackedChanges:undefined as string|undefined};
  const vscode={EventEmitter,workspace:{getConfiguration:(section:string)=>({get:(key:string)=>section==='git'&&key==='untrackedChanges'?settings.untrackedChanges:undefined})},extensions:{getExtension:()=>({activate:async()=>({enabled:true,getAPI:()=>api,onDidChangeEnablement:onChange})})}};
  runInNewContext(readFileSync(file,'utf8'),{exports,require:(name:string)=>name==='vscode'?vscode:load(name),process});
  type Adapter={initialize():Promise<void>;repositories():{snapshot():StatusSnapshot|undefined}[];dispose():void};
  const adapter=new (exports.BuiltinGitAdapter as new()=>Adapter)();await adapter.initialize();
  const conflict=(xy:string,name:string)=>`u ${xy} N... 100644 100644 100644 100644 ${hash} ${hash} ${hash} ${name}`;
  const owned=parseStatus(Buffer.from([`# branch.oid ${oid}`,'# branch.head main',`2 RM N... 100644 100644 100644 ${hash} ${hash} R100 renamed.txt`,'old.txt',`1 .M N... 100644 100644 100644 ${hash} ${hash} plain.txt`,
    conflict('AU','ours.txt'),conflict('UA','theirs.txt'),conflict('DU','deleted-us.txt'),conflict('UD','deleted-them.txt'),conflict('AA','both-added.txt'),conflict('DD','both-deleted.txt'),conflict('UU','both.txt'),'? new.txt'].map(record=>`${record}\0`).join('')));
  const handle=adapter.repositories()[0]!,snapshot=handle.snapshot()!;
  assert.ok(sameStatus(snapshot,owned),JSON.stringify(snapshot.changes));
  settings.untrackedChanges='hidden';assert.equal(handle.snapshot(),undefined,'a snapshot without untracked files would disagree with every owned read');
  adapter.dispose();
});
