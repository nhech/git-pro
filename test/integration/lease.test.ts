import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { advancedFixture } from '../fixtures/advanced-fixture';
import { LeaseService } from '../../src/git/advanced/lease.service';
test('explicit force lease pins remote OID and rejects a remote update even after background fetch',async()=>{
  const f=await advancedFixture();try{
    await f.commit('file.txt','base\n','root');const remote=path.join(f.parent,'remote.git');await mkdir(remote);f.git(['init','--bare'],remote);f.git(['remote','add','origin',remote]);f.git(['push','-u','origin','main']);
    f.git(['commit','--amend','-m','rewrite root']);const source=f.git(['rev-parse','HEAD']).trim(),leases=new LeaseService(f.advanced),preview=await leases.preview(f.id,'origin','main');assert.notEqual(preview.expected,source);await leases.push(preview);assert.equal(f.git(['rev-parse','refs/heads/main'],remote).trim(),source);
    f.git(['commit','--amend','-m','second rewrite']);const stale=await leases.preview(f.id,'origin','main');
    const outsider=path.join(f.parent,'other');f.git(['clone','--branch','main',remote,outsider],f.parent);f.git(['config','commit.gpgsign','false'],outsider);f.git(['commit','--allow-empty','-m','someone else'],outsider);f.git(['push','origin','main'],outsider);const advanced=f.git(['rev-parse','refs/heads/main'],remote).trim();f.git(['fetch','origin']);
    await assert.rejects(leases.push(stale));assert.equal(f.git(['rev-parse','refs/heads/main'],remote).trim(),advanced);
    const changed=await leases.preview(f.id,'origin','main');f.git(['remote','set-url','--push','origin',path.join(f.parent,'different.git')]);await assert.rejects(leases.push(changed),/URL changed/);
  }finally{await f.close();}
});
