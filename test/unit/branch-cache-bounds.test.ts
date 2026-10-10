import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GitService} from '../../src/git/git.service';
import type {GitExecutor} from '../../src/git/git-executor';
import type {RepositoryRegistry,RepositoryDescriptor} from '../../src/repositories/repository-registry';
import type {PathPolicy} from '../../src/security/paths';
import type {OperationCoordinator} from '../../src/state/operation-coordinator';
import type {DailyBackend} from '../../src/git/daily-backend';
import type {ReadCommand} from '../../src/git/command-builders';

const oid='a'.repeat(40);
function harness(names:string[]){
  const repositories=['one','two','three'].map(id=>({id,root:id})) as RepositoryDescriptor[];
  const output=Buffer.from(names.map(name=>`refs/heads/${name}\0${oid}\0\0\n`).join(''));
  const reads:string[]=[];
  const executor={read:async(root:string,command:ReadCommand)=>{reads.push(root);return{stdout:command.kind==='branchUpstreamKeys'?Buffer.alloc(0):output};}} as unknown as GitExecutor;
  const registry={list:()=>repositories} as unknown as RepositoryRegistry;
  return{service:new GitService(registry,executor,{} as PathPolicy,{} as OperationCoordinator,{} as DailyBackend),output,reads};
}

test('executor-bounded large branch metadata remains usable and immutable but is not retained in display cache',async()=>{
  const names=Array.from({length:10000},(_,i)=>`topic-${String(i).padStart(5,'0')}${'x'.repeat(1000)}`),h=harness(names);
  assert.ok(h.output.length<16*1024*1024,'Fixture remains within the real executor output cap');
  const first=await h.service.branchSearchSnapshot('one'),calls=h.reads.length;
  assert.equal(first.length,10000);assert.equal(first[4999]!.name,names[4999]);assert.equal(first[4999]!.ref,`refs/heads/${names[4999]}`);assert.equal(first[4999]!.oid,oid);
  assert.equal(Object.isFrozen(first),true);assert.equal(Object.isFrozen(first[4999]),true);
  const next=await h.service.branchSearchSnapshot('one');assert.notEqual(next,first);assert.ok(h.reads.length>calls);assert.deepEqual(next,first);
});

test('ordinary branch display snapshots share reads and retain at most two repository owners',async()=>{
  const h=harness(['topic','日本語']);
  const first=await h.service.branchSearchSnapshot('one'),calls=h.reads.length;
  assert.equal(await h.service.branchSearchSnapshot('one'),first);assert.equal(h.reads.length,calls);
  await h.service.branchSearchSnapshot('two');await h.service.branchSearchSnapshot('three');const before=h.reads.length;
  assert.deepEqual(await h.service.branchSearchSnapshot('one'),first);assert.ok(h.reads.length>before);
});
