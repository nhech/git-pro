import {test} from 'node:test';
import assert from 'node:assert/strict';
import {configuredBranchRefs,displayBranchOutput} from '../../src/git/branch-display';
import {buildReadCommand,type ReadCommand} from '../../src/git/command-builders';
const oid='a'.repeat(40),ref='refs/heads/topic',keys=Buffer.from('branch.topic.merge\0');
const row=(hash=oid,upstream='',worktree='')=>Buffer.from(`${ref}\0${hash}\0${upstream}\0${worktree}\n`);

test('branch key inventory is framed, UTF-8 safe and bounded; full-ref argv rejects patterns/options',()=>{
  assert.deepEqual(configuredBranchRefs(Buffer.from('branch.Topic.日本語.merge\0branch.Topic.日本語.merge\0')),['refs/heads/Topic.日本語']);
  for(const invalid of [Buffer.from('branch.topic.merge'),Buffer.from('branch.topic.merge\0\0'),Buffer.from('branch.bad*.merge\0'),Buffer.from([0xff,0]),Buffer.from('branch..merge\0'),Buffer.from('x'.repeat(65537)),Buffer.from(Array.from({length:201},(_,i)=>`branch.b${i}.merge\0`).join(''))])assert.equal(configuredBranchRefs(invalid),undefined);
  assert.equal(configuredBranchRefs(Buffer.from(`branch.${'a'.repeat(12000)}.merge\0`)),undefined);
  for(const refs of [[],['--all'],['refs/remotes/x'],['refs/heads/a*'],['refs/heads/x\ny'],Array.from({length:201},(_,i)=>`refs/heads/${i}`),[`refs/heads/${'a'.repeat(12000)}`]])assert.throws(()=>buildReadCommand({kind:'branchUpstreams',refs}));
});

test('selective display preserves Git upstream/worktree fields and propagates cancellation',async()=>{
  const calls:ReadCommand[]=[];
  const actual=await displayBranchOutput(async command=>{calls.push(command);return command.kind==='branchUpstreamKeys'?keys:command.kind==='branchIdentities'?row():row(oid,'origin/topic');});
  assert.deepEqual(actual,row(oid,'origin/topic'));assert.deepEqual(calls.map(command=>command.kind),['branchUpstreamKeys','branchIdentities','branchUpstreams','branchUpstreamKeys']);
  const failure=new Error('cancelled');await assert.rejects(displayBranchOutput(async()=>{throw failure;}),error=>error===failure);
});

test('config changes, missing/changed refs or worktrees fall back to a fresh complete read',async()=>{
  for(const mode of ['config','new-config','oid','worktree','missing','malformed','dense']){
    let inventories=0;const calls:string[]=[],expected=Buffer.from('fresh complete fallback');
    const result=await displayBranchOutput(async command=>{
      calls.push(command.kind);
      if(command.kind==='branches')return expected;
      if(command.kind==='branchUpstreamKeys'){
        inventories++;
        if(mode==='dense')return Buffer.from(Array.from({length:201},(_,i)=>`branch.b${i}.merge\0`).join(''));
        if(mode==='new-config')return inventories===1?Buffer.alloc(0):keys;
        return mode==='config'&&inventories===2?Buffer.alloc(0):keys;
      }
      if(command.kind==='branchIdentities')return mode==='malformed'?Buffer.from('broken\n'):row();
      if(mode==='missing')return Buffer.alloc(0);
      return row(mode==='oid'?'b'.repeat(40):oid,'origin/topic',mode==='worktree'?'/linked':'');
    });
    assert.deepEqual(result,expected,mode);assert.equal(calls.at(-1),'branches',mode);
    if(mode==='dense')assert.deepEqual(calls,['branchUpstreamKeys','branches']);
  }
});
