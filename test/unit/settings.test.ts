import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundedInteger } from '../../src/utils/settings';
test('runtime settings reject malformed values and clamp bounds without NaN or fractional delays',()=>{
  for(const value of [undefined,'900',NaN,Infinity,null])assert.equal(boundedInteger(value,120,15,600),120);
  assert.equal(boundedInteger(-1,120,15,600),15);assert.equal(boundedInteger(1000,120,15,600),600);assert.equal(boundedInteger(120.6,120,15,600),121);
});
