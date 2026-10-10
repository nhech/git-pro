import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { advancedFixture } from '../fixtures/advanced-fixture';
import { ConflictsService } from '../../src/git/conflicts/conflicts.service';

test('rename/rename conflict resolves each reviewed path without retaining the incoming duplicate',async()=>{
  const f=await advancedFixture();try{
    await f.commit('old.txt','base content\n','base');f.git(['switch','-c','feature']);f.git(['mv','old.txt','incoming.txt']);f.git(['commit','-m','incoming rename']);const feature=f.git(['rev-parse','HEAD']).trim();
    f.git(['switch','main']);f.git(['mv','old.txt','current.txt']);f.git(['commit','-m','current rename']);
    await assert.rejects(f.advanced.execute(await f.advanced.preview(f.id,{kind:'merge',oid:feature,strategy:'ff'})));
    const service=new ConflictsService(f.advanced),paths=(await f.advanced.snapshot(f.id)).status.changes.filter(change=>change.group==='conflicts').map(change=>change.path);
    assert.deepEqual([...paths].sort(),['current.txt','incoming.txt','old.txt']);
    for(const file of ['old.txt','current.txt','incoming.txt']){
      await service.resolve(await service.preview(f.id,file),'current');
      if((await f.advanced.snapshot(f.id)).status.changes.some(change=>change.group==='conflicts'&&change.path===file))await service.resolve(await service.preview(f.id,file),'mark');
    }
    assert.ok(!(await f.advanced.snapshot(f.id)).status.changes.some(change=>change.group==='conflicts'));
    await f.advanced.control(await f.advanced.snapshot(f.id),'continue');assert.equal((await f.advanced.snapshot(f.id)).operation,'idle');
    assert.equal(f.git(['ls-tree','--name-only','HEAD']).trim(),'current.txt');assert.equal(f.git(['show','HEAD:current.txt']),'base content\n');assert.equal(f.git(['rev-list','--parents','-n','1','HEAD']).trim().split(' ').length,3);
  }finally{await f.close();}
});

test('genuine symlink index type conflict rejects custom resolution without changing the index',async()=>{
  const f=await advancedFixture();try{
    f.git(['config','core.symlinks','false']);await f.commit('type.txt','base\n','base');f.git(['switch','-c','feature']);
    await writeFile(path.join(f.root,'type.txt'),'target.txt');const blob=f.git(['hash-object','-w','type.txt']).trim();f.git(['update-index','--cacheinfo',`120000,${blob},type.txt`]);f.git(['commit','-m','symlink type']);const feature=f.git(['rev-parse','HEAD']).trim();
    f.git(['switch','main']);await f.commit('type.txt','current regular file\n','current type');
    await assert.rejects(f.advanced.execute(await f.advanced.preview(f.id,{kind:'merge',oid:feature,strategy:'ff'})));
    const before=(await f.executor.read(f.root,{kind:'index'})).stdout;assert.match(before.toString(),/120000/);
    const service=new ConflictsService(f.advanced);await assert.rejects(service.preview(f.id,'type.txt'),/native Git.*symlink/);
    assert.deepEqual((await f.executor.read(f.root,{kind:'index'})).stdout,before);
    await f.advanced.control(await f.advanced.snapshot(f.id),'abort');assert.equal((await f.advanced.snapshot(f.id)).operation,'idle');assert.equal(f.git(['show','HEAD:type.txt']),'current regular file\n');
  }finally{await f.close();}
});
