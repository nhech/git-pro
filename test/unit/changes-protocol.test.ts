import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChangesAction } from '../../src/views/changes/changes-protocol';

const session='12345678-1234-4234-9234-123456789abc';
test('Changes view protocol allows only bounded row identities and fixed actions',()=>{
  assert.deepEqual(parseChangesAction({type:'action',session,action:'discard',keys:['YQ','Yg']}),{type:'action',session,action:'discard',keys:['YQ','Yg']});
  assert.deepEqual(parseChangesAction({type:'toggle',session,key:'YQ'}),{type:'toggle',session,key:'YQ'});
  for(const value of [
    {type:'action',session,action:'exec',key:'YQ'},
    {type:'action',session,action:'diff',key:'../../README'},
    {type:'action',session,action:'stage',keys:Array.from({length:101},(_,i)=>String(i))},
    {type:'action',session,action:'stage',keys:['YQ','YQ']},
    {type:'action',session:'expired',action:'stage',key:'YQ'},
    {type:'action',session,action:'diff'}
  ])assert.throws(()=>parseChangesAction(value));
});

test('Changes view protocol carries conflict row actions by identity and banner actions by fixed name only',()=>{
  for(const action of ['merge','acceptYours','acceptTheirs','openConflicts'] as const)assert.deepEqual(parseChangesAction({type:'action',session,action,keys:['YQ']}),{type:'action',session,action,keys:['YQ']});
  for(const action of ['resolve','continue','skip','abort','amend','sourceControl'] as const)assert.deepEqual(parseChangesAction({type:'operation',session,action,path:'/etc/passwd',revision:9}),{type:'operation',session,action},'unknown fields are dropped');
  for(const value of [
    {type:'operation',session,action:'exec'},{type:'operation',session,action:'dropStash'},{type:'operation',session},
    {type:'operation',session:'expired',action:'abort'},
    {type:'action',session,action:'acceptYours'},
    {type:'action',session,action:'merge',keys:['../app.ts']},
    {type:'action',session,action:'acceptTheirs',keys:Array.from({length:101},(_,i)=>`K${i}`)}
  ])assert.throws(()=>parseChangesAction(value),JSON.stringify(value));
});
