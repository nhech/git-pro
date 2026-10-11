import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildToolsMutation, buildToolsRead } from '../../src/git/tools/tools-builders';
import { parseStashes, parseTags, parseWorktrees } from '../../src/git/tools/tools-parser';
import { redact } from '../../src/security/redaction';
import { readRepositoryToolsContext } from '../../src/views/tools/repository-tools-context';
import { GitFailure } from '../../src/git/git-error-parser';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const oid='a'.repeat(40);
/** The compiled ToolsCommands against a stand-in vscode and service: quick picks answer from `choices` in order, every modal confirms. */
function toolsCommands(options:{compare?:boolean;run?:()=>Promise<void>;conflicts?:boolean}={}){
  const choices:string[]=[],executed:unknown[][]=[],compared:unknown[][]=[];
  const vscode={window:{showQuickPick:async(items:readonly {label:string}[])=>{const wanted=choices.shift();return items.find(item=>item.label===wanted);},showWarningMessage:async(_text:string,_options:unknown,button:string)=>button,showInputBox:async()=>undefined},
    commands:{executeCommand:async(...args:unknown[])=>{executed.push(args);}}};
  const stash={selector:'stash@{0}',oid:'b'.repeat(40),subject:'WIP',timestamp:1},tag={name:'v1.0',oid:'c'.repeat(40),target:'d'.repeat(40),annotated:true};
  const repo={id:'owned',root:'/owned'},store={changes:options.conflicts===false?[]:[{group:'conflicts',path:'a.txt'}]};
  const tools={advanced:{git:{repository:()=>repo,registry:{active:repo,store:{get:()=>store}}}},stashes:async()=>[stash],tags:async()=>[tag],
    preview:async(_id:string,command:unknown)=>({snapshot:{repositoryId:'owned',head:oid},command,fingerprint:'',summary:[]}),pop:async()=>{await options.run?.();},execute:async()=>{await options.run?.();}};
  const history={compare:async()=>{throw new Error('Tag compare no longer uses the file quick pick.');}};
  const surfaces={conflictSources:new Map<string,unknown>(),...(options.compare===false?{}:{compare:{openRefs:async(...args:unknown[])=>{compared.push(args);},openWorktree:async()=>undefined}})};
  const source=path.resolve(__dirname,'../../src/commands/tools.commands.js'),load=createRequire(source),exports:Record<string,unknown>={};
  runInNewContext(readFileSync(source,'utf8'),{exports,require:(name:string)=>name==='vscode'?vscode:name==='./message-editor'?{editMessage:async()=>undefined}:load(name)});
  const commands=new (exports.ToolsCommands as new(...args:unknown[])=>{actions(category:unknown,id:unknown,key:unknown):Promise<void>})(tools,{},history,{add:()=>{throw new Error('No snapshot is needed.');}},surfaces);
  return {commands,choices,executed,compared,surfaces,stash,tag};
}
test('Tags → Compare With HEAD opens the Compare tab with the tag ref instead of a file quick pick',async()=>{
  const h=toolsCommands();h.choices.push('Compare With HEAD');
  await h.commands.actions('Tags','owned','v1.0');
  assert.deepEqual(h.compared,[['owned','refs/tags/v1.0','HEAD']]);assert.deepEqual(h.executed,[]);
  const missing=toolsCommands({compare:false});missing.choices.push('Compare With HEAD');
  await assert.rejects(missing.commands.actions('Tags','owned','v1.0'),/Compare tab is still starting/);
});
test('a stash Pop or Apply that stops on conflicts records its stash for the Conflicts tab; other outcomes record nothing',async()=>{
  const conflict=()=>Promise.reject(new GitFailure('conflict','CONFLICT (content): Merge conflict in a.txt'));
  for(const action of ['Pop','Apply']){
    const h=toolsCommands({run:conflict});h.choices.push(action,'Working tree only');
    await assert.rejects(h.commands.actions('Stashes','owned',h.stash.oid+h.stash.selector),GitFailure);
    assert.deepEqual(JSON.parse(JSON.stringify(h.surfaces.conflictSources.get('owned'))),{kind:action==='Pop'?'stashPop':'stashApply',oid:h.stash.oid,selector:'stash@{0}'});
  }
  for(const options of [{run:()=>Promise.reject(new Error('Stash list changed. Review pop again.'))},{run:conflict,conflicts:false},{}]){
    const h=toolsCommands(options);h.choices.push('Pop','Working tree only');
    await h.commands.actions('Stashes','owned',h.stash.oid+h.stash.selector).catch(()=>undefined);
    assert.equal(h.surfaces.conflictSources.size,0);
  }
});
test('repository tools reject injected selectors, helper URLs and malformed framed output',()=>{
  assert.throws(()=>buildToolsMutation({kind:'stashDrop',selector:'--all',expected:oid}));
  assert.throws(()=>buildToolsMutation({kind:'remoteAdd',name:'origin',url:'ext::command'}));
  assert.throws(()=>buildToolsMutation({kind:'tagRemoteDelete',name:'--all',url:'https://example.test/git',expected:oid}));
  assert.throws(()=>parseStashes(Buffer.from(`stash@{0}\0${oid}\0subject\0`)));
  assert.throws(()=>parseTags(Buffer.from(`refs/tags/a\0${oid}\0\0commit`)));
  assert.throws(()=>parseWorktrees(Buffer.from('worktree /repo\0HEAD invalid\0\0')));
  assert.equal(buildToolsRead({kind:'tags',prefix:'release/'}).at(-1),'refs/tags/release/*');
  assert.equal(buildToolsMutation({kind:'stashCreate',message:'data',untracked:true}).includes('--literal-pathspecs'),false);
  assert.equal(redact('ssh://user:SSH_SECRET_SENTINEL@example.test/repo').includes('SSH_SECRET_SENTINEL'),false);
  assert.equal(redact('https://example.test/repo?%74oken=ENCODED_SECRET_SENTINEL').includes('ENCODED_SECRET_SENTINEL'),false);
});
test('Repository Tools context menu resolves only a valid clicked group or row',()=>{
  assert.deepEqual(readRepositoryToolsContext({kind:'group',group:'Tags',repositoryId:'repo-1'}),{group:'Tags',repositoryId:'repo-1'});
  assert.deepEqual(readRepositoryToolsContext({kind:'row',group:'Worktrees',repositoryId:'repo-1',key:'C:/work/tree'}),{group:'Worktrees',repositoryId:'repo-1',key:'C:/work/tree'});
  assert.equal(readRepositoryToolsContext({label:'not a tools node'}),undefined);
  assert.throws(()=>readRepositoryToolsContext({kind:'row',group:'Tags',repositoryId:'repo-1'}),/Repository Tools/);
  assert.throws(()=>readRepositoryToolsContext({kind:'group',group:'Unknown',repositoryId:'repo-1'}),/Repository Tools/);
});
