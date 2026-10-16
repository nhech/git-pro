import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ViewedStore, viewedId, type ViewedMemento } from '../../src/webviews/compare/viewed-store';

function memento(initial?: unknown) {
  const values = new Map<string, unknown>(initial === undefined ? [] : [['gitPro.compare.viewed', initial]]); let writes = 0;
  const value: ViewedMemento = { get: <T>(key: string) => values.get(key) as T | undefined, update: async (key, next) => { writes++; values.set(key, structuredClone(next)); } };
  return { value, values, get writes() { return writes; } };
}

test('viewed marks are kept per comparison and survive a new store over the same state', () => {
  const state = memento(), store = new ViewedStore(state.value);
  assert.deepEqual([...store.load('one')], []);
  store.save('one', new Set(['a.ts', 'b\0c.ts'])); store.save('two', new Set(['z.ts']));
  assert.deepEqual([...new ViewedStore(state.value).load('one')], ['a.ts', 'b\0c.ts']); assert.deepEqual([...new ViewedStore(state.value).load('two')], ['z.ts']);
  store.save('one', new Set()); assert.deepEqual([...store.load('one')], [], 'a comparison with nothing left marked is forgotten'); assert.deepEqual(Object.keys(state.values.get('gitPro.compare.viewed') as object), ['two']);
});

test('only the 30 most recent comparisons and 5000 files each are kept, and stored data that is not ours is ignored', () => {
  const state = memento(), store = new ViewedStore(state.value); let tick = 1_000_000;
  const now = Date.now; Date.now = () => tick++;
  try {
    for (let index = 0; index < 35; index++) store.save(`comparison-${index}`, new Set([`f${index}.ts`]));
    const kept = Object.keys(state.values.get('gitPro.compare.viewed') as object); assert.equal(kept.length, 30); assert.ok(kept.includes('comparison-34')); assert.ok(!kept.includes('comparison-0'), 'the oldest are dropped');
    store.save('big', new Set(Array.from({ length: 6000 }, (_, index) => `file${index}.ts`))); assert.equal(store.load('big').size, 5000);
    store.save('long', new Set(['x'.repeat(5000), 'short.ts'])); assert.deepEqual([...store.load('long')], ['short.ts'], 'a path longer than any path is not stored');
  } finally { Date.now = now; }
  for (const odd of ['text', 5, null, [], { one: 'nope' }, { one: { at: 1, files: 'nope' } }, { one: { at: 1, files: [1, null, 'ok.ts'] } }]) assert.doesNotThrow(() => new ViewedStore(memento(odd).value).load('one'), JSON.stringify(odd));
  assert.deepEqual([...new ViewedStore(memento({ one: { at: 1, files: [1, null, 'ok.ts'] } }).value).load('one')], ['ok.ts']);
  const none = new ViewedStore(undefined); none.save('one', new Set(['a.ts'])); assert.deepEqual([...none.load('one')], [], 'without a workspace state nothing is kept and nothing fails');
});

test('a renamed file is marked by its old and its new path', () => {
  assert.equal(viewedId({ path: 'a.ts' }), 'a.ts'); assert.equal(viewedId({ path: 'new.ts', originalPath: 'old.ts' }), 'old.ts\0new.ts');
});
