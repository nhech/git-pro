import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { advancedFixture } from '../fixtures/advanced-fixture';
import { AdvancedService } from '../../src/git/advanced/advanced.service';

test('advanced merge FF/no-ff/squash preserve distinct histories; conflicts resume after service recreation',async()=>{
  const f = await advancedFixture();
  try {
    const root = await f.commit('file.txt','base\n','root');f.git(['checkout','-b','feature']);const feature=await f.commit('feature.txt','feature\n','feature');f.git(['checkout','main']);
    const ffPreview=await f.advanced.preview(f.id,{kind:'merge',oid:feature,strategy:'ff-only'});assert.deepEqual(ffPreview.mergeContext,{headOnly:0,targetOnly:1});assert.ok(Object.isFrozen(ffPreview.mergeContext));await f.advanced.execute(ffPreview);assert.equal(f.git(['rev-parse','HEAD']).trim(),feature);
    f.git(['reset','--hard',root]);await f.advanced.execute(await f.advanced.preview(f.id,{kind:'merge',oid:feature,strategy:'no-ff'}));assert.equal(f.git(['rev-list','--parents','-1','HEAD']).trim().split(' ').length,3);
    f.git(['reset','--hard',root]);await f.advanced.execute(await f.advanced.preview(f.id,{kind:'merge',oid:feature,strategy:'squash'}));const squash=await f.advanced.snapshot(f.id);assert.equal(squash.head,root);assert.equal(squash.operation,'idle');assert.ok(squash.status.changes.some(change=>change.group==='staged'));
    f.git(['reset','--hard',root]);f.git(['checkout','feature']);const conflictTip=await f.commit('file.txt','feature\n','conflicting feature');f.git(['checkout','main']);const main=await f.commit('file.txt','main\n','conflicting main');
    const divergent=await f.advanced.preview(f.id,{kind:'merge',oid:conflictTip,strategy:'ff'});assert.deepEqual(divergent.mergeContext,{headOnly:1,targetOnly:2});await assert.rejects(f.advanced.execute(divergent));
    const recreated = new AdvancedService(f.gitService,f.coordinator), snapshot = await recreated.snapshot(f.id);assert.equal(snapshot.operation,'merging');
    await assert.rejects(recreated.control(snapshot,'continue'),/Resolve/);await recreated.control(await recreated.snapshot(f.id),'abort');assert.equal(f.git(['rev-parse','HEAD']).trim(),main);assert.equal(await readFile(path.join(f.root,'file.txt'),'utf8'),'main\n');
    await assert.rejects(f.advanced.execute(await f.advanced.preview(f.id,{kind:'merge',oid:conflictTip,strategy:'ff'})));
    await writeFile(path.join(f.root,'file.txt'),'resolved\n');f.git(['add','file.txt']);await recreated.control(await recreated.snapshot(f.id),'continue');assert.equal((await recreated.snapshot(f.id)).operation,'idle');
  } finally {await f.close();}
});
test('regular rebase conflict continue/skip/abort uses owned editor path with spaces and quotes',async()=>{
  const f = await advancedFixture();
  try {
    const root=await f.commit('file.txt','base\n','root');f.git(['checkout','-b','feature']);const feature=await f.commit('file.txt','feature\n','feature');f.git(['checkout','main']);const main=await f.commit('file.txt','main\n','main');f.git(['checkout','feature']);
    const start=async()=>{const preview=await f.advanced.preview(f.id,{kind:'rebase',oid:main});assert.equal(preview.rebaseContext?.localCount,1);assert.deepEqual(preview.rebaseContext?.candidates.map(commit=>commit.oid),[feature]);assert.ok(Object.isFrozen(preview.rebaseContext));await assert.rejects(f.advanced.execute(preview));assert.equal((await f.advanced.snapshot(f.id)).operation,'rebasing');};
    await start();await f.advanced.control(await f.advanced.snapshot(f.id),'abort');assert.equal(f.git(['rev-parse','HEAD']).trim(),feature);
    await start();await f.advanced.control(await f.advanced.snapshot(f.id),'skip');assert.equal(f.git(['rev-parse','HEAD']).trim(),main);
    f.git(['reset','--hard',feature]);await start();await writeFile(path.join(f.root,'file.txt'),'resolved\n');f.git(['add','file.txt']);await f.advanced.control(await f.advanced.snapshot(f.id),'continue');assert.equal((await f.advanced.snapshot(f.id)).operation,'idle');assert.equal(f.git(['rev-parse','HEAD^']).trim(),main);assert.notEqual(f.git(['rev-parse','HEAD']).trim(),root);
  } finally {await f.close();}
});
test('reset modes and stale HEAD/index/working/untracked snapshots do not mutate reviewed-away state',async()=>{
  for(const mode of ['soft','mixed','hard','keep'] as const){
    const f=await advancedFixture();try{
      const root=await f.commit('file.txt','base\n','root');await f.commit('file.txt','tip\n','tip');
      await f.advanced.execute(await f.advanced.preview(f.id,{kind:'reset',oid:root,mode}));assert.equal(f.git(['rev-parse','HEAD']).trim(),root);
      const status=await f.advanced.snapshot(f.id);assert.equal(status.status.changes.length>0,mode==='soft'||mode==='mixed');assert.equal(await readFile(path.join(f.root,'file.txt'),'utf8'),mode==='hard'||mode==='keep'?'base\n':'tip\n');
    }finally{await f.close();}
  }
  const f=await advancedFixture();try{
    const root=await f.commit('file.txt','base\n','root');const tip=await f.commit('file.txt','tip\n','tip');const preview=await f.advanced.preview(f.id,{kind:'reset',oid:root,mode:'hard'});
    await writeFile(path.join(f.root,'new.txt'),'untracked');await assert.rejects(f.advanced.execute(preview),/changed/);assert.equal(f.git(['rev-parse','HEAD']).trim(),tip);
    const current=await f.advanced.preview(f.id,{kind:'reset',oid:root,mode:'hard'});await writeFile(path.join(f.root,'new.txt'),'changed untracked');await assert.rejects(f.advanced.execute(current),/changed/);
    await mkdir(path.join(f.gitService.repository(f.id).gitDir,'rebase-apply'));await writeFile(path.join(f.gitService.repository(f.id).gitDir,'rebase-apply','applying'),'');await assert.rejects(f.advanced.control(await f.advanced.snapshot(f.id),'continue'),/git-am/);
  }finally{await f.close();}
});
test('snapshots and discard previews stay available with a 20 MiB unstaged file and a large untracked file',async()=>{
  const f=await advancedFixture();try{
    const head=await f.commit('big.txt','base\n','root'),line='0123456789abcdef'.repeat(4)+'\n',big=line.repeat(Math.ceil(20*1024*1024/line.length));
    await writeFile(path.join(f.root,'big.txt'),big);await writeFile(path.join(f.root,'large.log'),Buffer.alloc(6*1024*1024,97));
    // Both used to exceed a read or preview bound and refuse every snapshot-based action.
    const first=await f.advanced.snapshot(f.id);await f.advanced.preview(f.id,{kind:'reset',oid:head,mode:'mixed'});
    await writeFile(path.join(f.root,'large.log'),Buffer.alloc(6*1024*1024+1,97));
    assert.notEqual((await f.advanced.snapshot(f.id)).fingerprint,first.fingerprint,'a large untracked file is still identified');
    await writeFile(path.join(f.root,'big.txt'),big+'more\n');
    const preview=await f.gitService.preview(f.id,['big.txt']);await writeFile(path.join(f.root,'big.txt'),big);
    await assert.rejects(f.gitService.discard(preview),/changed/,'the streamed digest still detects a later edit');
    await f.gitService.discard(await f.gitService.preview(f.id,['big.txt']));assert.equal(await readFile(path.join(f.root,'big.txt'),'utf8'),'base\n');
  }finally{await f.close();}
});
