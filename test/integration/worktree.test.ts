import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, open, rename, utimes } from 'node:fs/promises';
import * as path from 'node:path';
import { advancedFixture } from '../fixtures/advanced-fixture';
import { ToolsService } from '../../src/git/tools/tools.service';
import { WorktreeService } from '../../src/git/tools/worktree.service';
import { PathPolicy, containsPath } from '../../src/security/paths';

test('scoped worktree creation/removal rejects primary, locked, dirty and changed destinations',async()=>{
  const f=await advancedFixture();try{
    const oid=await f.commit('file.txt','base\n','root'),tools=new ToolsService(f.advanced),service=new WorktreeService(tools,new PathPolicy(()=>[f.parent],()=>true)),destination=path.join(f.parent,'linked');
    const stale=await service.preview(f.id,{kind:'worktreeAdd',destination,oid});await mkdir(destination);await writeFile(path.join(destination,'foreign.txt'),'preserve');await assert.rejects(service.execute(stale),/empty regular directory/);
    const linked=path.join(f.parent,'actual-linked');await service.execute(await service.preview(f.id,{kind:'worktreeAdd',destination:linked,oid,branch:'linked-branch'}));assert.equal((await tools.worktrees(f.id)).length,2);
    await assert.rejects(service.execute(await service.preview(f.id,{kind:'worktreeAdd',destination:path.join(f.parent,'duplicate-branch'),oid,branch:'linked-branch'})));assert.equal((await tools.worktrees(f.id)).length,2);
    await assert.rejects(service.preview(f.id,{kind:'worktreeRemove',destination:f.root}),/primary or active/);
    f.git(['worktree','lock',linked]);await assert.rejects(service.preview(f.id,{kind:'worktreeRemove',destination:linked}),/Locked/);f.git(['worktree','unlock',linked]);
    await writeFile(path.join(linked,'file.txt'),'dirty\n');await assert.rejects(service.preview(f.id,{kind:'worktreeRemove',destination:linked}),/contains changes/);f.git(['reset','--hard'],linked);
    const remove=await service.preview(f.id,{kind:'worktreeRemove',destination:linked});await writeFile(path.join(linked,'untracked.txt'),'keep');await assert.rejects(service.execute(remove),/contains changes/);f.git(['clean','-fd'],linked);
    await service.execute(await service.preview(f.id,{kind:'worktreeRemove',destination:linked}));assert.equal((await tools.worktrees(f.id)).length,1);
    const restricted=new WorktreeService(tools,new PathPolicy(()=>[f.root],()=>true));await assert.rejects(restricted.preview(f.id,{kind:'worktreeAdd',destination:path.join(f.parent,'outside'),oid}),/outside the workspace/);
  }finally{await f.close();}
});

test('worktree prune reviews expired missing metadata without deleting a moved working directory',async()=>{
  const f=await advancedFixture(undefined,true);try{
    const oid=await f.commit('file.txt','base\n','root'),tools=new ToolsService(f.advanced),service=new WorktreeService(tools,f.policy);
    const source=path.join(f.parent,'prunable'),destination=path.join(f.parent,'moved-worktree');await service.execute(await service.preview(f.id,{kind:'worktreeAdd',destination:source,oid},await service.approveDestination(source)));
    assert.ok(containsPath(f.parent,source)&&containsPath(f.parent,destination));await rename(source,destination);
    const old=new Date('2000-01-01T00:00:00Z');await utimes(path.join(f.root,'.git','worktrees','prunable','gitdir'),old,old);
    const preview=await service.preview(f.id,{kind:'worktreePrune'});assert.ok(preview.details.length>1,'Dry run exposes the exact metadata removal and owner scope');await service.execute(preview);assert.equal((await tools.worktrees(f.id)).length,1);
    assert.equal(f.git(['rev-parse','HEAD']).trim(),oid);await writeFile(path.join(destination,'preserved.txt'),'working directory remains');
  }finally{await f.close();}
});

test('exact external destination grant creates/removes only a registered clean linked tree without broadening reads',async()=>{
  const f=await advancedFixture(undefined,true);try{
    const oid=await f.commit('file.txt','base\n','root'),tools=new ToolsService(f.advanced),service=new WorktreeService(tools,f.policy),destination=path.join(f.parent,'external-linked');
    assert.equal(await service.destinationNeedsApproval(destination),true);
    await assert.rejects(service.preview(f.id,{kind:'worktreeAdd',destination,oid}),/outside the workspace/);
    const grant=await service.approveDestination(destination);
    await assert.rejects(service.preview(f.id,{kind:'worktreeAdd',destination:path.join(f.parent,'wrong-target'),oid},grant),/does not match/);
    await assert.rejects(service.preview(f.id,{kind:'worktreeAdd',destination,oid},{destination}),/approval expired/);
    await service.execute(await service.preview(f.id,{kind:'worktreeAdd',destination,oid,branch:'external-linked'},grant));
    await assert.rejects(f.executor.read(destination,{kind:'status'}),/outside the workspace/);
    const removeGrant=await service.approveDestination(destination);
    const linkFile=path.join(destination,'.git'),originalLink=await readFile(linkFile);const unrelated=path.join(f.parent,'unrelated-repository');await mkdir(unrelated);f.git(['init','-b','main'],unrelated);
    const rewriteLink=async(content:string|Buffer)=>{assert.ok(containsPath(f.parent,linkFile));const handle=await open(linkFile,'r+');try{await handle.truncate(0);await handle.writeFile(content);}finally{await handle.close();}};
    await rewriteLink(`gitdir: ${path.join(unrelated,'.git').replace(/\\/g,'/')}\n`);
    await assert.rejects(service.preview(f.id,{kind:'worktreeRemove',destination},removeGrant),/no longer shares/);await rewriteLink(originalLink);
    await rewriteLink(`gitdir: ${path.join(f.root,'.git').replace(/\\/g,'/')}\n`);
    await assert.rejects(service.preview(f.id,{kind:'worktreeRemove',destination},removeGrant),/metadata does not belong/);await rewriteLink(originalLink);
    await writeFile(path.join(destination,'file.txt'),'dirty\n');await assert.rejects(service.preview(f.id,{kind:'worktreeRemove',destination},removeGrant),/contains changes/);f.git(['reset','--hard'],destination);
    f.git(['worktree','lock',destination]);await assert.rejects(service.preview(f.id,{kind:'worktreeRemove',destination},removeGrant),/Locked/);f.git(['worktree','unlock',destination]);
    const prune=await service.preview(f.id,{kind:'worktreePrune'});assert.match(prune.details[0]!,/Administrative metadata only/);
    await service.execute(await service.preview(f.id,{kind:'worktreeRemove',destination},removeGrant));assert.equal((await tools.worktrees(f.id)).length,1);
    await assert.rejects(f.executor.read(f.home,{kind:'status'}),/outside the workspace/);
  }finally{await f.close();}
});
