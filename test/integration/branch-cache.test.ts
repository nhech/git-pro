import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advancedFixture } from '../fixtures/advanced-fixture';
import {writeFile} from 'node:fs/promises';
import * as path from 'node:path';
import {GitExecutor} from '../../src/git/git-executor';
import {PathPolicy} from '../../src/security/paths';
import {gitExecutable} from '../fixtures/repository-fixture';
import {spawn} from 'node:child_process';
import {silentLogger} from '../../src/utils/logging';
test('bounded display branch cache is immutable and fresh safety reads see external ref updates',async()=>{
  const f=await advancedFixture();try{
    const first=await f.commit('file.txt','first\n','first');f.git(['branch','topic']);const cached=await f.gitService.branchSearchSnapshot(f.id);assert.equal(cached.find(branch=>branch.name==='topic')!.oid,first);
    const second=await f.commit('file.txt','second\n','second');f.git(['update-ref','refs/heads/topic',second]);assert.equal((await f.gitService.branchSearchSnapshot(f.id)).find(branch=>branch.name==='topic')!.oid,first);
    assert.equal((await f.gitService.branches(f.id)).find(branch=>branch.name==='topic')!.oid,second);assert.throws(()=>{(cached[0]! as {oid:string}).oid=second;});
  }finally{await f.close();}
});

test('display snapshot equals full Git semantics for includes, custom fetch refs and linked worktrees',async()=>{
  const f=await advancedFixture();try{
    const oid=await f.commit('file.txt','first\n','first');
    for(const name of ['local','Remote.Dotted','missing','included','custom','remoteOnly','日本語'])f.git(['branch',name]);
    f.git(['remote','add','origin',path.join(f.parent,'unused')]);f.git(['update-ref','refs/remotes/origin/main',oid]);
    for(const name of ['local','日本語']){f.git(['config',`branch.${name}.remote`,'.']);f.git(['config',`branch.${name}.merge`,'refs/heads/main']);}
    f.git(['config','branch.Remote.Dotted.remote','origin']);f.git(['config','branch.Remote.Dotted.merge','refs/heads/main']);
    f.git(['config','branch.missing.remote','origin']);f.git(['config','branch.missing.merge','refs/heads/absent']);
    f.git(['config','branch.remoteOnly.remote','origin']);
    f.git(['config','remote.custom.url',path.join(f.parent,'custom-unused')]);f.git(['config','remote.custom.fetch','+refs/heads/*:refs/custom/*']);
    f.git(['update-ref','refs/custom/topic',oid]);f.git(['config','branch.custom.remote','custom']);f.git(['config','branch.custom.merge','refs/heads/topic']);
    const include=path.join(f.parent,'included.config');await writeFile(include,'[branch "included"]\n remote = .\n merge = refs/heads/main\n');f.git(['config','include.path',include]);
    f.git(['worktree','add',path.join(f.parent,'linked tree'),'local']);
    const full=await f.gitService.branches(f.id);assert.deepEqual(await f.gitService.branchSearchSnapshot(f.id),full);
    assert.equal(full.find(branch=>branch.name==='Remote.Dotted')!.upstream,'origin/main');
    assert.ok(full.find(branch=>branch.name==='local')!.worktree);assert.equal(full.find(branch=>branch.name==='custom')!.upstream,'custom/topic');
  }finally{await f.close();}
});

test('dense branch tracking config uses the unchanged full recipe before identity enumeration',async()=>{
  const f=await advancedFixture();try{
    await f.commit('file.txt','first\n','first');
    const include=path.join(f.parent,'dense.config');await writeFile(include,Array.from({length:201},(_,i)=>`[branch "unused-${i}"]\n remote = .\n merge = refs/heads/main\n`).join(''));
    f.git(['config','include.path',include]);const full=await f.gitService.branches(f.id);
    const original=f.executor.read.bind(f.executor),calls:string[]=[];
    f.executor.read=async(root,command,options)=>{calls.push(command.kind);return original(root,command,options);};
    assert.deepEqual(await f.gitService.branchSearchSnapshot(f.id),full);
    // Registry status refresh may interleave independently with display reads.
    assert.deepEqual(calls.filter(kind=>kind.startsWith('branch')),['branchUpstreamKeys','branches']);
  }finally{await f.close();}
});

test('empty exit 1 is accepted only for key-only queries; diagnostics, other reads and cancellation still reject',async()=>{
  const f=await advancedFixture();try{
    const empty=await f.executor.read(f.root,{kind:'branchUpstreamKeys'});assert.equal(empty.exitCode,1);assert.equal(empty.stdout.length,0);
    const signal=AbortSignal.abort();await assert.rejects(f.executor.read(f.root,{kind:'branchUpstreamKeys'},{signal}),/cancelled/);
    for(const diagnostic of [false,true]){
      const executor=new GitExecutor(gitExecutable,new PathPolicy(()=>[f.root],()=>true),silentLogger,()=>spawn(process.execPath,['-e',`${diagnostic?'process.stderr.write("bad config");':''}process.exit(1)`],{stdio:['ignore','pipe','pipe'],windowsHide:true}));
      try{await assert.rejects(executor.read(f.root,{kind:diagnostic?'branchUpstreamKeys':'branchIdentities'}));}finally{executor.dispose();}
    }
    await writeFile(path.join(f.root,'.git','config'),'[broken\n');await assert.rejects(f.executor.read(f.root,{kind:'branchUpstreamKeys'}));
  }finally{await f.close();}
});
