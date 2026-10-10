import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, chmod, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { advancedFixture } from '../fixtures/advanced-fixture';
import { FileActionsService } from '../../src/git/files/file-actions.service';
test('stage/unstage/revert selected text hunks preserve other hunks and reject stale content',async()=>{
  const f=await advancedFixture();try{
    const file="[x] quote's file.txt",lines=Array.from({length:30},(_,i)=>`line ${i}`),original=lines.join('\n')+'\n';await f.commit(file,original,'base');lines[2]='first edit';lines[24]='second edit';const edited=lines.join('\n')+'\n';await writeFile(path.join(f.root,file),edited);
    const actions=new FileActionsService(f.advanced),preview=await actions.hunks(f.id,file,'stage');assert.equal(preview.hunks.length,2);await actions.apply(preview,0);const index=f.git(['show',`:${file}`]);assert.match(index,/first edit/);assert.doesNotMatch(index,/second edit/);assert.match(f.git(['diff','--',file]),/second edit/);
    await actions.apply(await actions.hunks(f.id,file,'unstage'),0);assert.equal(f.git(['show',`:${file}`]),original);
    await actions.apply(await actions.hunks(f.id,file,'revert'),1);assert.doesNotMatch(f.git(['diff','--',file]),/second edit/);assert.match(f.git(['diff','--',file]),/first edit/);assert.equal(f.git(['show',`:${file}`]),original);
    const stale=await actions.hunks(f.id,file,'stage');await writeFile(path.join(f.root,file),edited+'later edit\n');await assert.rejects(actions.apply(stale,0),/state changed/);assert.equal(f.git(['show',`:${file}`]),original);
  }finally{await f.close();}
});
test('Commit File commits full selected working content and preserves unrelated staged entries; hooks and stale state reject',async()=>{
  const f=await advancedFixture();try{
    await f.commit('chosen.txt','base chosen\n','base');await f.commit('other.txt','base other\n','other');await writeFile(path.join(f.root,'chosen.txt'),'staged chosen\n');await writeFile(path.join(f.root,'other.txt'),'staged other\n');f.git(['add','chosen.txt','other.txt']);await writeFile(path.join(f.root,'chosen.txt'),'full working chosen\n');
    const actions=new FileActionsService(f.advanced);await actions.commit(await actions.commitPreview(f.id,'chosen.txt'),'one file\n\n$() `literal`');assert.equal(f.git(['show','HEAD:chosen.txt']),'full working chosen\n');assert.equal(f.git(['show','HEAD:other.txt']),'base other\n');assert.equal(f.git(['show',':other.txt']),'staged other\n');assert.equal(f.git(['diff','--cached','--name-only']).trim(),'other.txt');
    await writeFile(path.join(f.root,'chosen.txt'),'next\n');const stale=await actions.commitPreview(f.id,'chosen.txt'),head=f.git(['rev-parse','HEAD']);await writeFile(path.join(f.root,'chosen.txt'),'newer\n');await assert.rejects(actions.commit(stale,'stale'),/state changed/);assert.equal(f.git(['rev-parse','HEAD']),head);
    const hooks=path.join(f.root,'.git','hooks');await mkdir(hooks,{recursive:true});const hook=path.join(hooks,'pre-commit');await writeFile(hook,'#!/bin/sh\nexit 1\n');await chmod(hook,0o755);await assert.rejects(actions.commit(await actions.commitPreview(f.id,'chosen.txt'),'hook rejected'));assert.equal(f.git(['rev-parse','HEAD']),head);assert.equal(f.git(['show',':other.txt']),'staged other\n');
  }finally{await f.close();}
});
test('hunk actions patch the selected file under diff.noprefix and diff.mnemonicPrefix',async()=>{
  const f=await advancedFixture();try{
    // The root a.txt already holds the edited text, so a patch stripped of "sub/" would apply cleanly to the wrong file.
    await f.commit('a.txt','x\nNEW\nz\n','root');await mkdir(path.join(f.root,'sub'));await f.commit('sub/a.txt','x\nOLD\nz\n','base');
    f.git(['config','diff.noprefix','true']);f.git(['config','diff.mnemonicPrefix','true']);
    await writeFile(path.join(f.root,'sub','a.txt'),'x\nNEW\nz\n');
    const actions=new FileActionsService(f.advanced);
    await actions.apply(await actions.hunks(f.id,'sub/a.txt','stage'),0);
    assert.equal(f.git(['show',':sub/a.txt']),'x\nNEW\nz\n');assert.equal(f.git(['show',':a.txt']),'x\nNEW\nz\n');
    await actions.apply(await actions.hunks(f.id,'sub/a.txt','unstage'),0);
    assert.equal(f.git(['show',':sub/a.txt']),'x\nOLD\nz\n');
    await actions.apply(await actions.hunks(f.id,'sub/a.txt','revert'),0);
    assert.equal(await readFile(path.join(f.root,'sub','a.txt'),'utf8'),'x\nOLD\nz\n');assert.equal(await readFile(path.join(f.root,'a.txt'),'utf8'),'x\nNEW\nz\n');
  }finally{await f.close();}
});
