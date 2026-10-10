import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm, rmdir, symlink } from 'node:fs/promises';
import * as path from 'node:path';
import { advancedFixture } from '../fixtures/advanced-fixture';
import { ToolsService } from '../../src/git/tools/tools.service';

test('stash create, indexed apply, pop and branch preserve identities and reject changed lists',async()=>{
  const f=await advancedFixture();try{
    await f.commit('file.txt','base\n','root');const tools=new ToolsService(f.advanced);
    await writeFile(path.join(f.root,'file.txt'),'staged\n');f.git(['add','file.txt']);await writeFile(path.join(f.root,'new.txt'),'untracked\n');
    await tools.execute(await tools.preview(f.id,{kind:'stashCreate',message:'saved $() `text`',untracked:true}));
    assert.equal(f.git(['status','--porcelain']).trim(),'','stash push must leave no untracked files');
    const first=(await tools.stashes(f.id))[0]!;assert.match(first.subject,/saved \$\(\)/);assert.equal((await tools.stashDetails(f.id,first)).length,2);
    await tools.execute(await tools.preview(f.id,{kind:'stashApply',oid:first.oid,index:true}));assert.equal(f.git(['diff','--cached','--name-only']).trim(),'file.txt');
    f.git(['reset','--hard']);f.git(['clean','-fd']);
    const stale=await tools.preview(f.id,{kind:'stashDrop',selector:first.selector,expected:first.oid});await writeFile(path.join(f.root,'file.txt'),'second\n');f.git(['stash','push','-m','second']);
    await assert.rejects(tools.execute(stale),/state changed/);await assert.rejects(tools.preview(f.id,{kind:'stashDrop',selector:first.selector,expected:first.oid}),/selector changed/);assert.equal((await tools.stashes(f.id)).length,2);
    const second=(await tools.stashes(f.id))[0]!;await tools.pop(await tools.preview(f.id,{kind:'stashApply',oid:second.oid,index:false}),second);assert.equal((await tools.stashes(f.id)).length,1);assert.equal(await readFile(path.join(f.root,'file.txt'),'utf8'),'second\n');
    f.git(['reset','--hard']);const remaining=(await tools.stashes(f.id))[0]!;await tools.execute(await tools.preview(f.id,{kind:'stashBranch',selector:remaining.selector,expected:remaining.oid,name:'saved-work'}));assert.equal(f.git(['branch','--show-current']).trim(),'saved-work');assert.equal((await tools.stashes(f.id)).length,0);
  }finally{await f.close();}
});

test('conflicted stash pop retains its original stash',async()=>{
  const f=await advancedFixture();try{
    await f.commit('file.txt','base\n','root');await writeFile(path.join(f.root,'file.txt'),'stash version\n');f.git(['stash','push','-m','conflict']);await f.commit('file.txt','other version\n','other');
    const tools=new ToolsService(f.advanced),stash=(await tools.stashes(f.id))[0]!;
    await assert.rejects(tools.pop(await tools.preview(f.id,{kind:'stashApply',oid:stash.oid,index:false}),stash));assert.equal((await tools.stashes(f.id))[0]!.oid,stash.oid);assert.match(f.git(['status','--porcelain']),/UU/);
  }finally{await f.close();}
});

test('annotated and lightweight tags use explicit remote refs and expected-OID deletion',async()=>{
  const f=await advancedFixture();try{
    const oid=await f.commit('file.txt','base\n','root'),tools=new ToolsService(f.advanced);const remote=path.join(f.parent,'tags.git');await mkdir(remote);f.git(['init','--bare'],remote);
    await tools.execute(await tools.preview(f.id,{kind:'remoteAdd',name:'origin',url:remote}));
    await tools.execute(await tools.preview(f.id,{kind:'tagCreate',name:'v1',oid}));await tools.execute(await tools.preview(f.id,{kind:'tagCreate',name:'v2',oid,message:'release\n\n$() `data`'}));
    const tags=await tools.tags(f.id);assert.equal(tags.length,2);assert.equal(tags.find(tag=>tag.name==='v2')!.annotated,true);assert.equal(tags.find(tag=>tag.name==='v2')!.target,oid);assert.match(await tools.tagMessage(f.id,'v2'),/\$\(\)/);
    await tools.execute(await tools.preview(f.id,{kind:'tagPush',url:await tools.pushUrl(f.id,'origin'),tags}));assert.equal(f.git(['rev-parse','refs/tags/v1'],remote).trim(),oid);
    await tools.execute(await tools.remoteTagDeletePreview(f.id,remote,'v1'));assert.equal(f.git(['for-each-ref','--format=%(refname)','refs/tags/v1'],remote).trim(),'');
    const v2=tags.find(tag=>tag.name==='v2')!;await tools.execute(await tools.preview(f.id,{kind:'tagDelete',name:v2.name,expected:v2.oid}));assert.equal((await tools.tags(f.id)).length,1);
    await f.commit('later.txt','later\n','later');await tools.execute(await tools.preview(f.id,{kind:'tagCheckout',oid:await tools.tagCommit(f.id,tags[0]!)}));assert.equal(f.git(['rev-parse','HEAD']).trim(),oid);assert.equal(f.git(['branch','--show-current']).trim(),'');
    await tools.execute(await tools.preview(f.id,{kind:'tagBranch',oid,name:'from-tag'}));assert.equal(f.git(['branch','--show-current']).trim(),'from-tag');
  }finally{await f.close();}
});

test('remote edits reject stale config and worktree mutations cannot bypass scoped review',async()=>{
  const f=await advancedFixture();try{
    const oid=await f.commit('file.txt','base\n','root'),tools=new ToolsService(f.advanced);
    await tools.execute(await tools.preview(f.id,{kind:'remoteAdd',name:'origin',url:'https://example.test/repo.git'}));
    const preview=await tools.preview(f.id,{kind:'remoteRename',name:'origin',newName:'upstream'});f.git(['remote','set-url','origin','https://example.test/changed.git']);await assert.rejects(tools.execute(preview),/state changed/);
    await tools.execute(await tools.preview(f.id,{kind:'remoteSetUrl',name:'origin',url:'ssh://git@example.test/repo.git',push:true}));assert.equal((await tools.remotes(f.id))[0]!.push[0],'ssh://git@example.test/repo.git');
    await tools.execute(await tools.preview(f.id,{kind:'remoteRename',name:'origin',newName:'upstream'}));await tools.execute(await tools.preview(f.id,{kind:'remoteRemove',name:'upstream'}));assert.equal((await tools.remotes(f.id)).length,0);
    assert.equal((await tools.worktrees(f.id))[0]!.head,oid);await assert.rejects(tools.preview(f.id,{kind:'worktreeRemove',destination:f.root}),/scoped worktree/);
  }finally{await f.close();}
});

test('remote prune removes only reviewed stale tracking refs and rejects a changed dry run',async()=>{
  const f=await advancedFixture();try{
    const oid=await f.commit('file.txt','base\n','root'),tools=new ToolsService(f.advanced),remote=path.join(f.parent,'prune.git');await mkdir(remote);f.git(['init','--bare'],remote);f.git(['remote','add','origin',remote]);f.git(['push','origin',`${oid}:refs/heads/main`,`${oid}:refs/heads/old`,`${oid}:refs/heads/another`]);f.git(['fetch','origin']);
    f.git(['update-ref','-d','refs/heads/old'],remote);const stale=await tools.preview(f.id,{kind:'remotePrune',remote:'origin'});assert.match(stale.summary.join('\n'),/old/);
    f.git(['update-ref','-d','refs/heads/another'],remote);await assert.rejects(tools.execute(stale),/state changed/);assert.equal(f.git(['rev-parse','refs/remotes/origin/old']).trim(),oid);
    await tools.execute(await tools.preview(f.id,{kind:'remotePrune',remote:'origin'}));assert.equal(f.git(['for-each-ref','--format=%(refname)','refs/remotes/origin']).trim(),'refs/remotes/origin/main');
  }finally{await f.close();}
});

test('explicit non-current branch push keeps checkout, pins source and rejects stale branch tips',async()=>{
  const f=await advancedFixture();try{
    const first=await f.commit('file.txt','first\n','first');f.git(['branch','topic']);const second=await f.commit('file.txt','second\n','second'),tools=new ToolsService(f.advanced),remote=path.join(f.parent,'branch-push.git');await mkdir(remote);f.git(['init','--bare'],remote);f.git(['remote','add','origin',remote]);
    await tools.execute(await tools.preview(f.id,{kind:'branchPush',url:remote,localBranch:'topic',destination:'review/topic',source:first}));assert.equal(f.git(['rev-parse','refs/heads/review/topic'],remote).trim(),first);assert.equal(f.git(['branch','--show-current']).trim(),'main');
    const stale=await tools.preview(f.id,{kind:'branchPush',url:remote,localBranch:'topic',destination:'review/topic',source:first});f.git(['update-ref','refs/heads/topic',second]);await assert.rejects(tools.execute(stale),/branch changed/);assert.equal(f.git(['rev-parse','refs/heads/review/topic'],remote).trim(),first);
  }finally{await f.close();}
});
test('an untracked link to a directory outside the repository leaves snapshots usable but blocks stashing untracked files',async()=>{
  const f=await advancedFixture();try{
    const head=await f.commit('file.txt','base\n','root'),tools=new ToolsService(f.advanced);
    const outside=path.join(f.parent,'outside'),other=path.join(f.parent,'other');
    for(const directory of [outside,other]){await mkdir(directory);await writeFile(path.join(directory,'lib.js'),'outside\n');}
    // A junction on Windows (no privilege needed), a directory symlink elsewhere; Git lists the files behind a junction and the link itself otherwise.
    const link=path.join(f.root,'linked');await symlink(outside,link,'junction');
    const first=await f.advanced.snapshot(f.id);assert.equal(first.external.length,1);assert.match(first.external[0]!,/^linked/);
    await f.advanced.preview(f.id,{kind:'reset',oid:head,mode:'mixed'});
    await tools.preview(f.id,{kind:'stashCreate',message:'tracked only',untracked:false});
    await assert.rejects(tools.preview(f.id,{kind:'stashCreate',message:'with untracked',untracked:true}),/link outside the repository/);
    // Retargeting the link is a change even though no content behind it is read.
    await rm(link,{recursive:false,force:true}).catch(()=>rmdir(link));await symlink(other,link,'junction');
    assert.notEqual((await f.advanced.snapshot(f.id)).fingerprint,first.fingerprint);
    assert.equal(await readFile(path.join(outside,'lib.js'),'utf8'),'outside\n');
  }finally{await f.close();}
});
