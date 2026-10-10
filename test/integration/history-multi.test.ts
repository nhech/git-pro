import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advancedFixture } from '../fixtures/advanced-fixture';
import { HistoryService } from '../../src/git/history/history.service';
import { PathPolicy } from '../../src/security/paths';
import { layoutGraph } from '../../src/webviews/graph/graph-layout';
test('multi-ref graph pins disconnected tips and shared parents, preserves labels and bounds queued reads',async()=>{
  const f=await advancedFixture(),history=new HistoryService(f.registry,f.executor,new PathPolicy(()=>[f.parent],()=>true));try{
    const base=await f.commit('base.txt','base\n','base');f.git(['switch','-c','topic']);const topic=await f.commit('topic.txt','topic\n','topic');f.git(['switch','main']);const main=await f.commit('main.txt','main\n','main');
    const query=await history.pin(f.id,'main\ntopic'),page=await history.page(query);assert.deepEqual(new Set(page.commits.map(commit=>commit.oid)),new Set([base,topic,main]));assert.deepEqual(query.refs?.map(ref=>ref.name),['main','topic']);assert.equal(layoutGraph(page.commits).rows.length,3);
    f.git(['branch','-f','topic','main']);assert.ok((await history.page(query)).commits.some(commit=>commit.oid===topic));const shared=await history.pin(f.id,'main\ntopic');assert.equal(shared.tips.length,1);assert.equal(shared.refs?.length,2);
    for(let i=0;i<32;i++)f.git(['branch',`many-${i}`]);const many=await history.pin(f.id,Array.from({length:32},(_,i)=>`many-${i}`).join('\n'));assert.equal(many.refs?.length,32);assert.equal(many.tips.length,1);
    await assert.rejects(history.pin(f.id,Array(129).fill('main').join('\n')),/at most 128/);await assert.rejects(history.pin(f.id,'main\ntopic',{path:'main.txt',follow:true}),/one ref/);
  }finally{history.dispose();await f.close();}
});
