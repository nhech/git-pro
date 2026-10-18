import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boundedInteger, conventionalHelp, conventionalTypes } from '../../src/utils/settings';
test('runtime settings reject malformed values and clamp bounds without NaN or fractional delays',()=>{
  for(const value of [undefined,'900',NaN,Infinity,null])assert.equal(boundedInteger(value,120,15,600),120);
  assert.equal(boundedInteger(-1,120,15,600),15);assert.equal(boundedInteger(1000,120,15,600),600);assert.equal(boundedInteger(120.6,120,15,600),121);
});

test('the commit types of the composer are lower-case words, without repeats, at most thirty',()=>{
  assert.deepEqual(conventionalTypes(['feat','fix','feat','my-type','Feat','x'.repeat(21),'1a','',5,null,{}]),['feat','fix','my-type']);
  assert.deepEqual(conventionalTypes('feat'),[]);assert.deepEqual(conventionalTypes(undefined),[]);assert.deepEqual(conventionalTypes([]),[]);
  assert.equal(conventionalTypes(Array.from({length:60},(_,index)=>`t${index}`)).length,30);
});

test('every type the setting offers by default is described in the Quick Pick that chooses one, and the list is a valid one',()=>{
  const manifest=JSON.parse(readFileSync('package.json','utf8')) as {contributes:{configuration:{properties:Record<string,{default:unknown}>}}};
  const defaults=manifest.contributes.configuration.properties['gitPro.commit.conventionalTypes']!.default;
  assert.deepEqual(conventionalTypes(defaults),defaults,'the default is its own cleaned list');
  for(const type of defaults as string[])assert.ok(conventionalHelp[type],`${type} has a description`);
  assert.deepEqual(Object.keys(conventionalHelp).sort(),[...(defaults as string[])].sort(),'and nothing is described that is not offered');
});
