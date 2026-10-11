import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { advancedFixture } from '../fixtures/advanced-fixture';
import { ConflictsService } from '../../src/git/conflicts/conflicts.service';
import { GitFailure } from '../../src/git/git-error-parser';
import { ToolsService } from '../../src/git/tools/tools.service';
import type { MutationCommand } from '../../src/git/command-builders';
import { InteractiveService, type RebaseJobInfo, type RebaseJournal } from '../../src/git/rebase/interactive.service';

type Fixture = Awaited<ReturnType<typeof advancedFixture>>;
/**
 * main and feature diverge so that integrating them leaves every XY code: UU and a binary UU, AA, DU, UD, and AU/UA/DD from a rename/rename.
 * Each file has its own content so rename detection cannot pair the wrong files.
 */
async function divergent(f: Fixture): Promise<{ main: string; feature: string }> {
  const put = (file: string, content: string) => writeFile(path.join(f.root, file), content);
  for (const name of ['uu', 'ud', 'du', 'dd']) await put(`${name}.txt`, `${name} base\n`);
  await put('bin.dat', '\0bin base');f.git(['add','.']);f.git(['commit','-m','root']);
  f.git(['checkout','-b','feature']);await put('uu.txt','uu feature\n');f.git(['rm','-q','ud.txt']);await put('du.txt','du feature\n');f.git(['mv','dd.txt','dd-feature.txt']);await put('aa.txt','aa feature\n');await put('bin.dat','\0bin feature');
  f.git(['add','.']);f.git(['commit','-m','feature work']);const feature=f.git(['rev-parse','HEAD']).trim();
  f.git(['checkout','main']);await put('uu.txt','uu main\n');await put('ud.txt','ud main\n');f.git(['rm','-q','du.txt']);f.git(['mv','dd.txt','dd-main.txt']);await put('aa.txt','aa main\n');await put('bin.dat','\0bin main');
  f.git(['add','.']);f.git(['commit','-m','main work']);return {main:f.git(['rev-parse','HEAD']).trim(),feature};
}
const conflicted = async (f: Fixture) => (await f.advanced.snapshot(f.id)).status.changes.filter(change => change.group === 'conflicts').map(change => change.path).sort();
const content = (f: Fixture, file: string) => readFile(path.join(f.root, file), 'utf8').catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
const all = ['aa.txt', 'bin.dat', 'dd-feature.txt', 'dd-main.txt', 'dd.txt', 'du.txt', 'ud.txt', 'uu.txt'];
/** Working files after choosing main's side (Git --ours in a merge) or feature's side for every path. */
const mainSide: Record<string, string | null> = { 'aa.txt': 'aa main\n', 'bin.dat': '\0bin main', 'dd-feature.txt': null, 'dd-main.txt': 'dd base\n', 'dd.txt': null, 'du.txt': null, 'ud.txt': 'ud main\n', 'uu.txt': 'uu main\n' };
const featureSide: Record<string, string | null> = { 'aa.txt': 'aa feature\n', 'bin.dat': '\0bin feature', 'dd-feature.txt': 'dd base\n', 'dd-main.txt': null, 'dd.txt': null, 'du.txt': 'du feature\n', 'ud.txt': null, 'uu.txt': 'uu feature\n' };
async function assertSide(f: Fixture, expected: Record<string, string | null>, message: string) {
  for (const [file, value] of Object.entries(expected)) assert.equal(await content(f, file), value, `${message}: ${file}`);
  assert.deepEqual(await conflicted(f), [], `${message}: nothing left to resolve`);
  // Resolved and staged in one step (owner decision Q2): every remaining index entry is stage 0 and matches the working file.
  assert.doesNotMatch(f.git(['ls-files','--stage']), /^\d+ [a-f0-9]+ [123]\t/m); assert.equal(f.git(['diff','--name-only']).trim(), '', `${message}: working tree equals the index`);
}

test('a merge lists every conflict kind with Yours/Theirs columns, and bulk Accept Theirs or Yours resolves and stages each in one step', async () => {
  for (const side of ['theirs', 'yours'] as const) {
    const f = await advancedFixture();try{
      const {feature}=await divergent(f);
      await assert.rejects(f.advanced.execute(await f.advanced.preview(f.id,{kind:'merge',oid:feature,strategy:'ff'})),(error:unknown)=>error instanceof GitFailure&&error.kind==='conflict');
      const service=new ConflictsService(f.advanced),list=await service.list(f.id),rows=Object.fromEntries(list.rows.map(row=>[row.path,row]));
      assert.deepEqual(list.rows.map(row=>row.path),all);assert.equal(list.truncated,false);assert.ok(Object.isFrozen(list.rows)&&list.rows.every(row=>Object.isFrozen(row)));
      assert.deepEqual(Object.fromEntries(list.rows.map(row=>[row.path,[row.code,row.kind,row.yours,row.theirs]])),{
        'aa.txt':['AA','bothAdded','added','added'],'bin.dat':['UU','bothModified','modified','modified'],'dd-feature.txt':['UA','addedByThem','absent','added'],'dd-main.txt':['AU','addedByUs','added','absent'],
        'dd.txt':['DD','bothDeleted','deleted','deleted'],'du.txt':['DU','deletedByUs','deleted','modified'],'ud.txt':['UD','deletedByThem','modified','deleted'],'uu.txt':['UU','bothModified','modified','modified']});
      assert.deepEqual(rows['uu.txt']!.markers,{present:true,blocks:1});assert.equal(rows['uu.txt']!.mergeable,true);assert.equal(rows['aa.txt']!.mergeable,true);
      assert.equal(rows['bin.dat']!.binary,true);assert.equal(rows['bin.dat']!.markers,null);assert.equal(rows['bin.dat']!.mergeable,false,'Merge… is for text');
      assert.equal(rows['dd.txt']!.workingFile,false);assert.equal(rows['du.txt']!.workingFile,true,'Git leaves the modified side in the tree');assert.equal(rows['du.txt']!.mergeable,false);
      assert.ok(list.rows.every(row=>row.unsupported===undefined));
      assert.equal(list.summary.title,'Merging feature into main');assert.equal(list.summary.conflicts,8);assert.deepEqual(list.summary.sides,{yours:{stage:2,flag:'ours'},theirs:{stage:3,flag:'theirs'}});
      const batch=await service.previewBatch(f.id,all);assert.deepEqual(batch.rows.map(row=>row.path),all);
      await service.acceptSide(batch,side);
      await assertSide(f,side==='theirs'?featureSide:mainSide,`merge accept ${side}`);
      await assert.rejects(service.acceptSide(batch,side),/expired/,'a batch is single use');
      await f.advanced.control(await f.advanced.snapshot(f.id),'continue');assert.equal((await f.advanced.snapshot(f.id)).operation,'idle');
      assert.equal(f.git(['show','HEAD:uu.txt']),side==='theirs'?'uu feature\n':'uu main\n');
    }finally{await f.close();}
  }
});

test('during a rebase Accept Yours keeps the replayed commit: rm and restore flip with the sides (D3, N3)', async () => {
  const f = await advancedFixture();try{
    const {main}=await divergent(f);f.git(['checkout','feature']);
    await assert.rejects(f.advanced.execute(await f.advanced.preview(f.id,{kind:'rebase',oid:main})),(error:unknown)=>error instanceof GitFailure&&error.kind==='conflict');
    const service=new ConflictsService(f.advanced),list=await service.list(f.id),rows=Object.fromEntries(list.rows.map(row=>[row.path,row]));
    assert.equal(list.snapshot.operation,'rebasing');assert.deepEqual(list.summary.sides,{yours:{stage:3,flag:'theirs'},theirs:{stage:2,flag:'ours'}});
    // Git's codes are relative to HEAD (the upstream) during a rebase; the kinds and columns are the user's point of view.
    assert.deepEqual([rows['du.txt']!.code,rows['du.txt']!.kind,rows['du.txt']!.yours,rows['du.txt']!.theirs],['DU','deletedByThem','modified','deleted']);
    assert.deepEqual([rows['ud.txt']!.code,rows['ud.txt']!.kind,rows['ud.txt']!.yours,rows['ud.txt']!.theirs],['UD','deletedByUs','deleted','modified']);
    assert.deepEqual([rows['dd-main.txt']!.kind,rows['dd-feature.txt']!.kind],['addedByThem','addedByUs']);
    await service.acceptSide(await service.previewBatch(f.id,all),'yours');
    // du.txt (Git DU) restores Git --theirs; ud.txt (Git UD) has no Yours version, so it is removed.
    await assertSide(f,featureSide,'rebase accept yours');
    await f.advanced.control(await f.advanced.snapshot(f.id),'continue');assert.equal((await f.advanced.snapshot(f.id)).operation,'idle');
    assert.equal(f.git(['rev-parse','HEAD^']).trim(),main);assert.equal(f.git(['show','HEAD:du.txt']),'du feature\n');assert.equal(f.git(['show','HEAD:uu.txt']),'uu feature\n');
    assert.match(f.git(['ls-tree','--name-only','HEAD']),/dd-feature\.txt/);assert.doesNotMatch(f.git(['ls-tree','--name-only','HEAD']),/^ud\.txt$/m);
  }finally{await f.close();}
});

test('cherry-pick, revert and stash apply conflicts accept the side named in WebStorm terms', async () => {
  const pick = await advancedFixture();try{
    const {feature}=await divergent(pick);
    await assert.rejects(pick.advanced.execute(await pick.advanced.preview(pick.id,{kind:'cherryPick',oids:[feature]})),(error:unknown)=>error instanceof GitFailure&&error.kind==='conflict');
    const service=new ConflictsService(pick.advanced);assert.equal((await service.list(pick.id)).summary.title,`Cherry-picking ${feature.slice(0,7)} onto main`);
    await service.acceptSide(await service.previewBatch(pick.id,all),'theirs');await assertSide(pick,featureSide,'cherry-pick accept theirs');
  }finally{await pick.close();}
  const revert = await advancedFixture();try{
    await revert.commit('file.txt','a\n','root');const reverted=await revert.commit('file.txt','b\n','b');await revert.commit('file.txt','c\n','c');
    await assert.rejects(revert.advanced.execute(await revert.advanced.preview(revert.id,{kind:'revert',oids:[reverted]})),(error:unknown)=>error instanceof GitFailure&&error.kind==='conflict');
    const service=new ConflictsService(revert.advanced),list=await service.list(revert.id);assert.equal(list.summary.title,`Reverting ${reverted.slice(0,7)} on main`);
    await service.acceptSide(await service.previewBatch(revert.id,['file.txt']),'theirs');assert.equal(await content(revert,'file.txt'),'a\n','Theirs is the content before the reverted commit');assert.deepEqual(await conflicted(revert),[]);
  }finally{await revert.close();}
  const stash = await advancedFixture();try{
    await stash.commit('file.txt','base\n','root');await writeFile(path.join(stash.root,'file.txt'),'stash edit\n');stash.git(['stash','push','-m','work']);await stash.commit('file.txt','other\n','other');
    const tools=new ToolsService(stash.advanced),saved=(await tools.stashes(stash.id))[0]!;
    await assert.rejects(tools.execute(await tools.preview(stash.id,{kind:'stashApply',oid:saved.oid,index:false})),(error:unknown)=>error instanceof GitFailure&&error.kind==='conflict');
    const service=new ConflictsService(stash.advanced,new Map([[stash.id,{kind:'stashApply' as const,oid:saved.oid,selector:saved.selector}]])),list=await service.list(stash.id);
    assert.equal(list.snapshot.operation,'idle');assert.equal(list.summary.title,'Conflicts from applying stash@{0} (stash kept)');assert.deepEqual(list.summary.sides.yours,{stage:2,flag:'ours'});
    await service.acceptSide(await service.previewBatch(stash.id,['file.txt']),'theirs');
    assert.equal(await content(stash,'file.txt'),'stash edit\n');assert.equal(stash.git(['diff','--cached','--name-only']).trim(),'file.txt');assert.equal((await tools.stashes(stash.id))[0]!.oid,saved.oid,'the stash is kept');
  }finally{await stash.close();}
});

test('a cherry-pick run at an interactive edit stop owns its conflicts: Yours stays the edited commit, and Continue/Abort act on the cherry-pick', async () => {
  const f = await advancedFixture();try{
    const jobs=new Map<string,RebaseJobInfo>(),journal:RebaseJournal={get:async id=>jobs.get(id),put:async(id,job)=>{if(job)jobs.set(id,job);else jobs.delete(id);}};
    const interactive=new InteractiveService(f.advanced,path.join(f.parent,'jobs'),{node:process.execPath,helper:path.resolve('media/helpers/rebase-editor.cjs')},journal);f.advanced.setEditorJobs(interactive);
    const base=await f.commit('f.txt','base\n','base');f.git(['switch','-c','other']);const other=await f.commit('f.txt','OTHER\n','other');f.git(['switch','main']);const mine=await f.commit('f.txt','MINE\n','mine');
    await interactive.execute(await interactive.preview(f.id,base),[{oid:mine,action:'edit'}]);assert.equal((await f.advanced.snapshot(f.id)).operation,'rebasing');
    assert.throws(()=>f.git(['cherry-pick',other]),/Fixture Git failed/);
    // Git: rebase-merge, REBASE_HEAD (the edited commit) and CHERRY_PICK_HEAD; stage 2 is HEAD (MINE), stage 3 the picked commit (OTHER).
    const service=new ConflictsService(f.advanced),list=await service.list(f.id),row=list.rows[0]!;
    assert.equal(list.snapshot.operation,'cherry-picking');assert.deepEqual(list.summary.sides,{yours:{stage:2,flag:'ours'},theirs:{stage:3,flag:'theirs'}});
    assert.equal(list.summary.title,`Cherry-picking ${other.slice(0,7)} onto main (rebase paused)`);
    assert.deepEqual([list.summary.yours.oid,list.summary.yours.detail,list.summary.theirs.oid],[mine,'main (rebase paused)',other],'the labels name HEAD and the picked commit, never REBASE_HEAD');
    assert.deepEqual([row.kind,row.yours,row.theirs],['bothModified','modified','modified']);
    const blobs=await service.stageBlobs(f.id,'f.txt');assert.equal((blobs.sides.yours.stage===2?blobs.ours:blobs.theirs).toString(),'MINE\n','the merge editor\'s left pane is the user\'s content');
    await service.acceptSide(await service.previewBatch(f.id,['f.txt']),'yours');assert.equal(await content(f,'f.txt'),'MINE\n','Accept Yours keeps the edited commit');
    assert.equal(f.git(['show',':f.txt']),'MINE\n');
    await f.advanced.control(await f.advanced.snapshot(f.id),'abort');
    const stop=await f.advanced.snapshot(f.id);assert.equal(stop.operation,'rebasing','cherry-pick --abort returns to the edit stop');assert.equal(await f.advanced.isEditStop(stop),true);
    await f.advanced.control(stop,'continue');assert.equal((await f.advanced.snapshot(f.id)).operation,'idle');assert.equal(f.git(['show','HEAD:f.txt']),'MINE\n');
  }finally{await f.close();}
});

test('a stale review, a reused batch and invalid selections are refused without touching the files', async () => {
  const f = await advancedFixture();try{
    const {feature}=await divergent(f);await assert.rejects(f.advanced.execute(await f.advanced.preview(f.id,{kind:'merge',oid:feature,strategy:'ff'})));
    const service=new ConflictsService(f.advanced),batch=await service.previewBatch(f.id,['uu.txt','aa.txt']);
    await writeFile(path.join(f.root,'uu.txt'),'edited after review\n');
    await assert.rejects(service.acceptSide(batch,'theirs'),/changed/);assert.equal(await content(f,'uu.txt'),'edited after review\n');assert.match(await content(f,'aa.txt')??'',/<<<<<<<|aa main/);
    assert.deepEqual(await conflicted(f),all,'nothing was resolved');
    for(const paths of [[],['uu.txt','uu.txt'],['ua-missing.txt'],Array.from({length:101},(_,index)=>`f${index}`)])await assert.rejects(service.previewBatch(f.id,paths),/Select/,JSON.stringify(paths.slice(0,2)));
    await assert.rejects(service.acceptSide(await service.previewBatch(f.id,['uu.txt']),'both' as 'yours'),/Yours or Theirs/);
    const blobs=await service.stageBlobs(f.id,'uu.txt');assert.deepEqual([blobs.base.toString(),blobs.ours.toString(),blobs.theirs.toString()],['uu base\n','uu main\n','uu feature\n']);assert.deepEqual(blobs.sides,{yours:{stage:2,flag:'ours'},theirs:{stage:3,flag:'theirs'}});
    assert.equal((await service.stageBlobs(f.id,'aa.txt')).base.length,0,'an absent stage is an empty buffer');
  }finally{await f.close();}
});

test('bulk Mark Resolved refuses the whole batch for markers, binary files and missing files, and stages a clean batch at once (N13, N14)', async () => {
  const f = await advancedFixture();try{
    const {feature}=await divergent(f);await assert.rejects(f.advanced.execute(await f.advanced.preview(f.id,{kind:'merge',oid:feature,strategy:'ff'})));
    const service=new ConflictsService(f.advanced);await writeFile(path.join(f.root,'uu.txt'),'merged by hand\n');
    await assert.rejects(service.markResolved(await service.previewBatch(f.id,['uu.txt','aa.txt'])),/Conflict markers remain in aa\.txt/);
    await assert.rejects(service.markResolved(await service.previewBatch(f.id,['uu.txt','bin.dat'])),/bin\.dat is binary\. Choose Accept Yours or Accept Theirs/);
    await assert.rejects(service.markResolved(await service.previewBatch(f.id,['uu.txt','dd.txt'])),/dd\.txt has no working file/);
    assert.deepEqual(await conflicted(f),all,'a refused batch stages nothing');
    const list=await service.list(f.id);assert.deepEqual(list.rows.find(row=>row.path==='uu.txt')!.markers,{present:false,blocks:0});
    // DU: the working file is feature's modified copy with no markers, but staging it would silently drop main's deletion; a side must be chosen.
    await assert.rejects(service.markResolved(await service.previewBatch(f.id,['uu.txt','du.txt'])),/du\.txt: Mark Resolved would keep only the version Git left in the working tree\. Choose Accept Yours or Accept Theirs/);
    await writeFile(path.join(f.root,'aa.txt'),'aa merged\n');await service.markResolved(await service.previewBatch(f.id,['uu.txt','aa.txt']));
    assert.deepEqual(await conflicted(f),['bin.dat','dd-feature.txt','dd-main.txt','dd.txt','du.txt','ud.txt']);assert.equal(f.git(['show',':uu.txt']),'merged by hand\n');assert.equal(f.git(['show',':aa.txt']),'aa merged\n');
  }finally{await f.close();}
});

test('when a later step fails after an earlier one took effect, the error says so (partiallyApplied)', async () => {
  const f = await advancedFixture();try{
    const {feature}=await divergent(f);await assert.rejects(f.advanced.execute(await f.advanced.preview(f.id,{kind:'merge',oid:feature,strategy:'ff'})));
    const service=new ConflictsService(f.advanced),mutate=f.executor.mutate.bind(f.executor),kinds:string[]=[];
    f.executor.mutate=async(root:string,command:MutationCommand,options={})=>{kinds.push(command.kind);if(command.kind==='stage')throw new GitFailure('locked','fatal: Unable to create index.lock: File exists.',128);return mutate(root,command,options);};
    await assert.rejects(service.acceptSide(await service.previewBatch(f.id,['uu.txt','ud.txt']),'theirs'),(error:unknown)=>error instanceof GitFailure&&error.kind==='locked'&&/Batches 1-1 of 3 were already applied/.test(error.message)&&error.partial?.applied===1&&error.partial.total===3);
    assert.deepEqual(kinds,['acceptConflict','stage'],'nothing runs after the failure');
    assert.equal(await content(f,'uu.txt'),'uu feature\n','the restore took effect');assert.ok((await conflicted(f)).includes('uu.txt'),'and was not staged');
    f.executor.mutate=mutate;
    await service.acceptSide(await service.previewBatch(f.id,['uu.txt','ud.txt']),'theirs');
    assert.ok(!(await conflicted(f)).some(file=>file==='uu.txt'||file==='ud.txt'),'a fresh review completes the batch');
  }finally{await f.close();}
});

test('rows Git Pro leaves to native Git are listed with the reason and refused for every action', async () => {
  const f = await advancedFixture();try{
    f.git(['config','core.symlinks','false']);await f.commit('type.txt','base\n','base');f.git(['switch','-c','feature']);
    await writeFile(path.join(f.root,'type.txt'),'target.txt');const blob=f.git(['hash-object','-w','type.txt']).trim();f.git(['update-index','--cacheinfo',`120000,${blob},type.txt`]);f.git(['commit','-m','symlink type']);const feature=f.git(['rev-parse','HEAD']).trim();
    f.git(['switch','main']);await f.commit('type.txt','current regular file\n','current type');
    await assert.rejects(f.advanced.execute(await f.advanced.preview(f.id,{kind:'merge',oid:feature,strategy:'ff'})));
    const service=new ConflictsService(f.advanced),row=(await service.list(f.id)).rows[0]!;
    assert.equal(row.unsupported,'Use native Git: symlink');assert.equal(row.mergeable,false);assert.equal(row.markers,null);
    const before=f.git(['ls-files','--stage']);
    await assert.rejects(service.previewBatch(f.id,['type.txt']),/type\.txt: Use native Git: symlink/);assert.equal(f.git(['ls-files','--stage']),before);
  }finally{await f.close();}
});
