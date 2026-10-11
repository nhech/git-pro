import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { loadWithVscode } from './compare-loader';

const a = 'a'.repeat(40), b = 'b'.repeat(40);
interface FakeUri { scheme: string; path: string; query: string; fragment: string; toString(): string }
type Provider = { add(repositoryId: string, oid: string, file: string): FakeUri; provideTextDocumentContent(uri: FakeUri, token?: unknown): Promise<string>; dispose(): void; readonly size: number };
const vscode = { Uri: { from: ({ scheme, path: value, query = '', fragment = '' }: { scheme: string; path: string; query?: string; fragment?: string }): FakeUri => ({ scheme, path: value, query, fragment, toString: () => `${scheme}:${value}${query ? `?${query}` : ''}` }) } };
function provider(revision: (id: string, oid: string | undefined, file: string, signal?: AbortSignal) => Promise<Buffer>, capacity?: number): Provider {
  const exports = loadWithVscode(path.resolve(__dirname, '../../src/documents/blob-provider.js'), vscode);
  const Constructor = exports.BlobProvider as new (history: unknown, capacity?: number) => Provider;
  return capacity === undefined ? new Constructor({ revision }) : new Constructor({ revision }, capacity);
}

test('blob URIs are opaque tokens: a uuid and the basename, with no repository path, revision or query', () => {
  const reads: unknown[] = [], blobs = provider(async (...args) => { reads.push(args); return Buffer.from('content'); });
  const uri = blobs.add('repo-id', a, 'src/secret dir/app.ts');
  assert.equal(uri.scheme, 'git-pro-blob'); assert.match(uri.path, /^\/[0-9a-f-]{36}\/app\.ts$/); assert.equal(uri.query, '');
  for (const leak of ['src', 'secret', 'repo-id', a]) assert.equal(uri.toString().includes(leak), false, `URI must not carry ${leak}`);
  assert.equal(reads.length, 0, 'Adding a side reads nothing: content is fetched when VS Code opens it');
  assert.equal(blobs.add('repo-id', a, 'src/secret dir/app.ts').path, uri.path, 'The same side reuses its token');
  assert.notEqual(blobs.add('repo-id', b, 'src/secret dir/app.ts').path, uri.path);
  for (const [oid, file] of [['HEAD', 'a.txt'], [a, '../outside.txt'], [a, '/abs.txt'], [a, 'x\0y']] as const) assert.throws(() => blobs.add('repo-id', oid, file));
});

test('blob content is read lazily through HistoryService.revision with the pinned token data and cancellation', async () => {
  const reads: { id: string; oid: string | undefined; file: string; signal?: AbortSignal }[] = [];
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const blobs = provider(async (id, oid, file, signal) => { reads.push({ id, oid, file, ...(signal ? { signal } : {}) }); await gate; return Buffer.from('héllo\n'); });
  const uri = blobs.add('repo-id', a, 'dir/file.txt');
  let cancel!: () => void; const token = { onCancellationRequested: (listener: () => void) => { cancel = listener; return { dispose: () => undefined }; } };
  const pending = blobs.provideTextDocumentContent(uri, token);
  assert.deepEqual(reads.map(read => [read.id, read.oid, read.file]), [['repo-id', a, 'dir/file.txt']]);
  cancel(); assert.equal(reads[0]!.signal?.aborted, true, 'Closing the side before it loads cancels the Git read');
  release(); assert.equal(await pending, 'héllo\n');
  await assert.rejects(blobs.provideTextDocumentContent({ ...uri, query: 'path=../x' }), /expired/, 'Query data is never accepted');
  await assert.rejects(blobs.provideTextDocumentContent({ ...uri, scheme: 'git-pro-revision' }), /expired/);
  await assert.rejects(blobs.provideTextDocumentContent({ ...uri, path: '/unknown/file.txt' }), /expired/);
  const failing = provider(async () => { throw new Error('Revision exceeds the 5 MiB text diff limit.'); });
  await assert.rejects(failing.provideTextDocumentContent(failing.add('repo-id', a, 'big.bin')), /5 MiB/, 'Bounds of HistoryService.revision apply to every side');
  blobs.dispose(); assert.equal(blobs.size, 0); await assert.rejects(blobs.provideTextDocumentContent(uri), /expired/);
});

test('blob tokens are bounded to 4096 with least-recently-used eviction', async () => {
  const blobs = provider(async () => Buffer.from('x'));
  const first = blobs.add('repo-id', a, 'file-0.txt'), second = blobs.add('repo-id', a, 'file-1.txt');
  for (let index = 2; index < 4096; index++) blobs.add('repo-id', a, `file-${index}.txt`);
  assert.equal(blobs.size, 4096);
  blobs.add('repo-id', a, 'file-0.txt'); // Reuse moves the first token to the most recent end.
  blobs.add('repo-id', a, 'file-4096.txt');
  assert.equal(blobs.size, 4096);
  assert.equal(await blobs.provideTextDocumentContent(first), 'x', 'A recently reused token survives');
  await assert.rejects(blobs.provideTextDocumentContent(second), /expired/, 'The least recently used token is evicted');
  assert.notEqual(blobs.add('repo-id', a, 'file-1.txt').path, second.path, 'An evicted side gets a new token');
});
