import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { advancedFixture } from '../fixtures/advanced-fixture';
import { AdvancedService } from '../../src/git/advanced/advanced.service';
test('ordered cherry-pick/revert and merge-parent selection preserve exact parent outcomes',async()=>{
  const f=await advancedFixture();try{
    const root=await f.commit('base.txt','base\n','root');f.git(['checkout','-b','feature']);const a=await f.commit('a.txt','a\n','first');const b=await f.commit('b.txt','b\n','second');f.git(['checkout','main']);
    await f.advanced.execute(await f.advanced.preview(f.id,{kind:'cherryPick',oids:[a,b]}));assert.deepEqual(f.git(['log','-2','--format=%s']).trim().split('\n'),['second','first']);const picks=f.git(['log','-2','--format=%H']).trim().split('\n');
    await f.advanced.execute(await f.advanced.preview(f.id,{kind:'revert',oids:picks}));assert.equal(f.git(['ls-tree','--name-only','HEAD']).trim(),'base.txt');
    f.git(['reset','--hard',root]);f.git(['merge','--no-ff','--no-edit','feature']);const merge=f.git(['rev-parse','HEAD']).trim();await assert.rejects(f.advanced.preview(f.id,{kind:'revert',oids:[merge]}),/parent/);
    await f.advanced.execute(await f.advanced.preview(f.id,{kind:'revert',oids:[merge],parent:1}));assert.equal(f.git(['ls-tree','--name-only','HEAD']).trim(),'base.txt');
  }finally{await f.close();}
});
test('cherry-pick conflict continue/abort and revert conflict abort are state-backed',async()=>{
  const f=await advancedFixture();try{
    const root=await f.commit('file.txt','base\n','root');f.git(['checkout','-b','feature']);const feature=await f.commit('file.txt','feature\n','feature');f.git(['checkout','main']);const main=await f.commit('file.txt','main\n','main');
    await assert.rejects(f.advanced.execute(await f.advanced.preview(f.id,{kind:'cherryPick',oids:[feature]})));const fresh=new AdvancedService(f.gitService,f.coordinator);assert.equal((await fresh.snapshot(f.id)).operation,'cherry-picking');await fresh.control(await fresh.snapshot(f.id),'abort');assert.equal(f.git(['rev-parse','HEAD']).trim(),main);
    await assert.rejects(f.advanced.execute(await f.advanced.preview(f.id,{kind:'cherryPick',oids:[feature]})));await writeFile(path.join(f.root,'file.txt'),'resolved\n');f.git(['add','file.txt']);await fresh.control(await fresh.snapshot(f.id),'continue');assert.equal((await fresh.snapshot(f.id)).operation,'idle');
    await assert.rejects(f.advanced.execute(await f.advanced.preview(f.id,{kind:'revert',oids:[main]})));assert.equal((await fresh.snapshot(f.id)).operation,'reverting');await fresh.control(await fresh.snapshot(f.id),'abort');assert.equal(await fresh.resolve(f.id,'HEAD^1'),main);assert.notEqual(await fresh.resolve(f.id,'HEAD'),root);
  }finally{await f.close();}
});
