import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, writeFile, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { advancedFixture } from '../fixtures/advanced-fixture';
import { ConflictsService } from '../../src/git/conflicts/conflicts.service';
test('conflict Current/Incoming, Accept Both and Mark Resolved preserve explicit stage semantics',async()=>{
  for(const choice of ['current','incoming','both'] as const){const f=await advancedFixture();try{
    await f.commit('file.txt','base\n','root');f.git(['checkout','-b','feature']);const feature=await f.commit('file.txt','incoming\n','feature');f.git(['checkout','main']);await f.commit('file.txt','current\n','main');
    await assert.rejects(f.advanced.execute(await f.advanced.preview(f.id,{kind:'merge',oid:feature,strategy:'ff'})));
    const conflicts=new ConflictsService(f.advanced),preview=await conflicts.preview(f.id,'file.txt');assert.equal(preview.entries.length,3);assert.equal(preview.markers,true);
    await assert.rejects(conflicts.resolve(preview,'mark'),/markers/);
    await conflicts.resolve(await conflicts.preview(f.id,'file.txt'),choice);
    assert.equal(await readFile(path.join(f.root,'file.txt'),'utf8'),choice==='both'?'current\nincoming\n':choice==='current'?'current\n':'incoming\n');
    assert.ok((await f.advanced.snapshot(f.id)).status.changes.some(item=>item.group==='conflicts'));
    await conflicts.resolve(await conflicts.preview(f.id,'file.txt'),'mark');assert.ok(!(await f.advanced.snapshot(f.id)).status.changes.some(item=>item.group==='conflicts'));
    await f.advanced.control(await f.advanced.snapshot(f.id),'continue');assert.equal((await f.advanced.snapshot(f.id)).operation,'idle');
  }finally{await f.close();}}
});
test('merge Continue with an edited message commits it with -m: hooks still run with GIT_EDITOR=false, and a typed "#123" line survives',async()=>{
  const f=await advancedFixture();try{
    await f.commit('file.txt','base\n','root');f.git(['checkout','-b','feature']);const feature=await f.commit('file.txt','incoming\n','feature');f.git(['checkout','main']);await f.commit('file.txt','current\n','main');
    await assert.rejects(f.advanced.execute(await f.advanced.preview(f.id,{kind:'merge',oid:feature,strategy:'ff'})));
    await writeFile(path.join(f.root,'file.txt'),'resolved\n');f.git(['add','file.txt']);
    const hooks=path.join(f.gitService.repository(f.id).gitDir,'hooks');
    for(const [name,body] of [['commit-msg','cp "$1" "$(git rev-parse --git-dir)/hook-message.txt"'],['prepare-commit-msg','printf "%s|%s" "$GIT_EDITOR" "$GIT_SEQUENCE_EDITOR" > "$(git rev-parse --git-dir)/hook-editor.txt"']]){const file=path.join(hooks,name!);await writeFile(file,`#!/bin/sh\n${body}\n`);await chmod(file,0o755);}
    const snapshot=await f.advanced.snapshot(f.id);
    await assert.rejects(f.advanced.control(snapshot,'continue',{mergeMessage:' \n '}),/merge message/);
    await assert.rejects(f.advanced.control(snapshot,'abort',{mergeMessage:'not for abort'}),/only to continuing a merge/);
    const message='Merge feature into main\n\n#123 fix the login form\n';
    await f.advanced.control(snapshot,'continue',{mergeMessage:message});
    assert.equal((await f.advanced.snapshot(f.id)).operation,'idle','a rejected message did not spend the reviewed snapshot');
    assert.equal(f.git(['log','-1','--format=%B']).trimEnd(),message.trimEnd());assert.equal(f.git(['rev-list','--parents','-n','1','HEAD']).trim().split(' ').length,3);
    const gitDir=f.gitService.repository(f.id).gitDir;
    assert.match(await readFile(path.join(gitDir,'hook-message.txt'),'utf8'),/^#123 fix the login form$/m,'the commit-msg hook ran and saw the kept line');
    // Git tells hooks GIT_EDITOR=":" when it opens no editor; the executor's editor-off environment (GIT_*EDITOR=false) is what reached Git.
    assert.equal(await readFile(path.join(gitDir,'hook-editor.txt'),'utf8'),':|false','no editor can open behind the owned message editor');
  }finally{await f.close();}
});
test('deleted and binary conflicts choose the correct side; stale edited preview is rejected',async()=>{
  const f=await advancedFixture();try{
    await f.commit('file.txt','base\n','root');f.git(['checkout','-b','feature']);const feature=await f.commit('file.txt','incoming\n','feature');f.git(['checkout','main']);f.git(['rm','file.txt']);f.git(['commit','-m','delete']);
    await assert.rejects(f.advanced.execute(await f.advanced.preview(f.id,{kind:'merge',oid:feature,strategy:'ff'})));
    const conflicts=new ConflictsService(f.advanced),preview=await conflicts.preview(f.id,'file.txt');assert.ok(!preview.entries.some(item=>item.stage===2));
    await writeFile(path.join(f.root,'file.txt'),'changed externally\n');await assert.rejects(conflicts.resolve(preview,'incoming'),/changed/);
    await conflicts.resolve(await conflicts.preview(f.id,'file.txt'),'current');await assert.rejects(readFile(path.join(f.root,'file.txt')),/ENOENT/);
    await f.advanced.control(await f.advanced.snapshot(f.id),'continue');
  }finally{await f.close();}
  const b=await advancedFixture();try{
    await b.commit('file.bin','\0base','root');b.git(['checkout','-b','feature']);const feature=await b.commit('file.bin','\0incoming','feature');b.git(['checkout','main']);await b.commit('file.bin','\0current','main');
    await assert.rejects(b.advanced.execute(await b.advanced.preview(b.id,{kind:'merge',oid:feature,strategy:'ff'})));
    const conflicts=new ConflictsService(b.advanced);assert.equal((await conflicts.preview(b.id,'file.bin')).text,undefined);await assert.rejects(conflicts.resolve(await conflicts.preview(b.id,'file.bin'),'both'),/UTF-8/);
    await conflicts.resolve(await conflicts.preview(b.id,'file.bin'),'incoming');assert.equal((await readFile(path.join(b.root,'file.bin'))).toString(),'\0incoming');
  }finally{await b.close();}
});
