import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHistorySearch } from '../../src/git/history/history-search';
import { parseHistoryAction } from '../../src/webviews/graph/history-protocol';
import { buildHistoryRead } from '../../src/git/history/history-builders';

const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

test('prefixes in the Text box become the filters of their fields, and the rest stays the message text', () => {
  assert.deepEqual(plain(parseHistorySearch('fix crash author:alice file:src/app.ts since:2026-01-01 until:2026-02-01')), { author: 'alice', path: 'src/app.ts', from: '2026-01-01', to: '2026-02-01', text: 'fix crash' });
  assert.deepEqual(plain(parseHistorySearch('author:alice')), { author: 'alice' }, 'a search that is only a prefix has no message text');
  assert.deepEqual(plain(parseHistorySearch('author:"Alice Smith" fix  the   thing')), { author: 'Alice Smith', text: 'fix the thing' }, 'a quoted value may hold spaces, and the words left are joined by one space');
  assert.deepEqual(plain(parseHistorySearch('Author:Bob PATH:docs')), { author: 'Bob', path: 'docs' }, 'a prefix may be written in any case');
  // Synonyms.
  assert.deepEqual(plain(parseHistorySearch('path:a after:2026-01-01 before:2026-03-01')), { path: 'a', from: '2026-01-01', to: '2026-03-01' });
  assert.deepEqual(plain(parseHistorySearch('from:2026-01-01 to:2026-03-01')), { from: '2026-01-01', to: '2026-03-01' });
  // message: and grep: are the plain words, kept in place among them.
  assert.deepEqual(plain(parseHistorySearch('fix message:login grep:"session timeout" now')), { text: 'fix login session timeout now' });
  assert.deepEqual(plain(parseHistorySearch('msg:crash author:a')), { text: 'crash', author: 'a' });
  // A prefix repeated keeps its last value.
  assert.deepEqual(plain(parseHistorySearch('author:a author:b')), { author: 'b' });
});

test('text that only looks like a prefix is searched as it is', () => {
  for (const text of ['fix crash', 'https://example.com/page', 'note: this', 'author: alice', 'author:', 'coauthor:alice', 'x-author:alice', 'unknown:value', 'file:"', 'author:""', 'the path:', 'reverts to: main', '']) assert.equal(parseHistorySearch(text), undefined, text);
  assert.deepEqual(plain(parseHistorySearch('see https://example.com author:alice')), { author: 'alice', text: 'see https://example.com' }, 'only a word that starts with a known prefix is one');
  assert.deepEqual(plain(parseHistorySearch('author:alice note: keep')), { author: 'alice', text: 'note: keep' });
  assert.deepEqual(plain(parseHistorySearch('author:" " fix')), { text: 'fix' }, 'a blank value filters nothing');
});

test('History query actions move prefixes into the fields they stand for, over what those fields held', () => {
  const query = (fields: Record<string, string>) => parseHistoryAction({ type: 'query', session: 's', ref: 'HEAD', text: '', author: '', path: '', from: '', to: '', ...fields });
  assert.deepEqual(plain(query({ text: 'fix author:alice file:src' })), { type: 'query', session: 's', ref: 'HEAD', filters: { author: 'alice', path: 'src', text: 'fix' } });
  assert.deepEqual(plain(query({ text: 'author:alice', author: 'bob', path: 'docs' })), { type: 'query', session: 's', ref: 'HEAD', filters: { author: 'alice', path: 'docs' } }, 'the typed prefix wins over a field, and the other fields stay');
  assert.deepEqual(plain(query({ text: 'since:2026-01-01', from: '2025-01-01', to: '2026-12-31' })), { type: 'query', session: 's', ref: 'HEAD', filters: { from: '2026-01-01', to: '2026-12-31' } });
  assert.deepEqual(plain(query({ text: 'fix: crash', author: 'bob' })), { type: 'query', session: 's', ref: 'HEAD', filters: { text: 'fix: crash', author: 'bob' } }, 'plain text is untouched');
  assert.deepEqual(plain(query({})), { type: 'query', session: 's', ref: 'HEAD', filters: {} });
  // What a prefix produces is still checked where Git is run: a bad date or a path outside the repository is refused.
  assert.throws(() => buildHistoryRead({ kind: 'history', tips: ['a'.repeat(40)], offset: 0, limit: 25, filters: (query({ text: 'since:last-week' }) as { filters: object }).filters }), /valid YYYY-MM-DD/);
  const args = buildHistoryRead({ kind: 'history', tips: ['a'.repeat(40)], offset: 0, limit: 25, filters: (query({ text: 'login author:a.b since:2026-01-01 file:src/x.ts' }) as { filters: object }).filters });
  assert.ok(args.includes('--author=a\\.b') && args.includes('--fixed-strings') && args.includes('--grep=login') && args.includes('--since=2026-01-01T00:00:00Z'));
  assert.deepEqual(args.slice(args.indexOf('--') + 1), ['src/x.ts']);
});
