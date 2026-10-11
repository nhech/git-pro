import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const vscode = { __esModule: true, Uri: { from: (parts: { scheme: string; path: string; query?: string }) => ({ ...parts, toString: () => `${parts.scheme}:${parts.path}` }) } };
const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown }, original = loader._load;
loader._load = function (request: string, ...rest: unknown[]) { return request === 'vscode' ? vscode : original.call(this, request, ...rest); };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ConflictSnapshots, CONFLICT_SCHEME } = require('../../src/documents/conflict-snapshots') as typeof import('../../src/documents/conflict-snapshots');
loader._load = original;
type Uri = { scheme: string; path: string; query?: string };
const set = (prefix: string, size = 1) => ['base', 'yours', 'theirs'].map(name => ({ content: Buffer.from(`${prefix}:${name}`.padEnd(size, '.')), label: 'src/deep/app.ts' }));
const read = (snapshots: InstanceType<typeof ConflictSnapshots>, uri: Uri) => snapshots.provideTextDocumentContent(uri as never);

test('conflict snapshots are opaque read-only text URIs that carry only an id and the basename', () => {
  const snapshots = new ConflictSnapshots(), uris = snapshots.pinSet('C:/repo/src/deep/app.ts', set('one')) as unknown as Uri[];
  assert.equal(uris.length, 3);
  for (const uri of uris) { assert.equal(uri.scheme, CONFLICT_SCHEME); assert.match(uri.path, /^\/[0-9a-f-]{36}\/app\.ts$/); assert.equal(uri.query, undefined); }
  assert.deepEqual(uris.map(uri => read(snapshots, uri)), ['one:base', 'one:yours', 'one:theirs']);
  assert.equal(snapshots.has(uris[0] as never), true);
  assert.throws(() => read(snapshots, { scheme: CONFLICT_SCHEME, path: '/00000000-0000-4000-8000-000000000000/app.ts' }), /expired/);
  for (const content of [Buffer.from([0x61, 0, 0x62]), Buffer.from([0xff, 0xfe, 0x41]), Buffer.alloc(5 * 1024 * 1024 + 1, 0x61)])
    assert.throws(() => snapshots.pinSet('other', [{ content: Buffer.from('fine'), label: 'a.txt' }, { content, label: 'a.txt' }]), /Unsupported text revision|encoded data was not valid/);
  assert.equal(snapshots.size, 3, 'a refused set adds nothing, not even its valid members');
  assert.deepEqual((snapshots.pinSet('empty', [{ content: Buffer.alloc(0), label: 'new.ts' }]) as unknown as Uri[]).map(uri => read(snapshots, uri)), [''], 'an absent base (AA) is empty text');
  snapshots.dispose(); assert.equal(snapshots.size, 0);
});

test('snapshots stay within 24 entries and 48 MiB, never evict a pinned set and free a set once its merge tab closes', () => {
  const snapshots = new ConflictSnapshots({ entries: 6, bytes: 64 });
  const first = snapshots.pinSet('first', set('a')) as unknown as Uri[], second = snapshots.pinSet('second', set('b')) as unknown as Uri[];
  assert.throws(() => snapshots.pinSet('third', set('c')), /Too many merge editors are open/, 'two open merge editors fill the bound');
  assert.equal(snapshots.size, 6);
  for (const uri of [...first, ...second]) assert.ok(read(snapshots, uri));
  snapshots.release('first');
  const third = snapshots.pinSet('third', set('c')) as unknown as Uri[];
  assert.equal(snapshots.size, 6);
  for (const uri of first) assert.throws(() => read(snapshots, uri), /expired/, 'the released set was evicted');
  for (const uri of [...second, ...third]) assert.ok(read(snapshots, uri), 'pinned sets are never evicted to make room');
  // Replacing a set unpins the previous one first, so reopening the same file never needs room for both.
  const again = snapshots.pinSet('third', set('d')) as unknown as Uri[];
  for (const uri of third) assert.throws(() => read(snapshots, uri), /expired/);
  assert.deepEqual(again.map(uri => read(snapshots, uri)), ['d:base', 'd:yours', 'd:theirs']);
  const bytes = new ConflictSnapshots({ entries: 24, bytes: 30 });
  bytes.pinSet('one', set('x', 10));
  assert.throws(() => bytes.pinSet('two', set('y', 10)), /Too many merge editors/, 'the byte bound applies as well');
  bytes.release('one'); assert.equal((bytes.pinSet('two', set('y', 10)) as unknown as Uri[]).length, 3);
});
