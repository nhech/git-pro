import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCompareAction } from '../../src/webviews/compare/compare-protocol';

const a = 'a'.repeat(40), s = 'session';
test('Compare protocol accepts only session-bound, revision-carrying actions on indexes and full OIDs', () => {
  assert.deepEqual(parseCompareAction({ type: 'ready', session: s, revision: 'ignored', path: '../x' }), { type: 'ready', session: s });
  assert.deepEqual(parseCompareAction({ type: 'refresh', session: s }), { type: 'refresh', session: s });
  for (const type of ['swap', 'openAll', 'allChanges'] as const) assert.deepEqual(parseCompareAction({ type, session: s, revision: 3, ref: 'main' }), { type, session: s, revision: 3 });
  assert.deepEqual(parseCompareAction({ type: 'page', session: s, revision: 1, side: 'right', offset: 50, tip: '--all' }), { type: 'page', session: s, revision: 1, side: 'right', offset: 50 });
  assert.deepEqual(parseCompareAction({ type: 'selectCommit', session: s, revision: 0, oid: a }), { type: 'selectCommit', session: s, revision: 0, oid: a });
  assert.deepEqual(parseCompareAction({ type: 'filesMode', session: s, revision: 2, mode: 'tips' }), { type: 'filesMode', session: s, revision: 2, mode: 'tips' });
  assert.deepEqual(parseCompareAction({ type: 'filesPage', session: s, revision: 2, offset: 400 }), { type: 'filesPage', session: s, revision: 2, offset: 400 });
  for (const type of ['diff', 'localDiff', 'openFile'] as const) assert.deepEqual(parseCompareAction({ type, session: s, revision: 2, index: 7, path: '/etc/passwd' }), { type, session: s, revision: 2, index: 7 });
  assert.deepEqual(parseCompareAction({ type: 'getFromBranch', session: s, revision: 2, indexes: [3, 1] }), { type: 'getFromBranch', session: s, revision: 2, indexes: [3, 1] });
});

test('Compare protocol rejects forged sessions, revisions, offsets, indexes, OIDs and unknown actions', () => {
  const rejected: unknown[] = [
    undefined, null, 'ready', { type: 'ready' }, { type: 'ready', session: '' }, { type: 'ready', session: 'x'.repeat(101) },
    { type: 'swap', session: s }, { type: 'swap', session: s, revision: -1 }, { type: 'swap', session: s, revision: 1.5 }, { type: 'swap', session: s, revision: '1' },
    { type: 'page', session: s, revision: 0, side: 'both', offset: 25 }, { type: 'page', session: s, revision: 0, side: 'left', offset: 26 }, { type: 'page', session: s, revision: 0, side: 'left', offset: -25 }, { type: 'page', session: s, revision: 0, side: 'left', offset: 1_000_025 },
    { type: 'selectCommit', session: s, revision: 0, oid: 'HEAD' }, { type: 'selectCommit', session: s, revision: 0, oid: '--all' }, { type: 'copyRevision', session: s, revision: 0, oid: `${a}:secret` }, { type: 'showInHistory', session: s, revision: 0 },
    { type: 'filesMode', session: s, revision: 0, mode: 'merge-base' }, { type: 'filesPage', session: s, revision: 0, offset: 100 },
    { type: 'diff', session: s, revision: 0, index: -1 }, { type: 'diff', session: s, revision: 0, index: 1_000_000 }, { type: 'localDiff', session: s, revision: 0, index: '1' },
    { type: 'getFromBranch', session: s, revision: 0, indexes: [] }, { type: 'getFromBranch', session: s, revision: 0, indexes: [1, 1] }, { type: 'getFromBranch', session: s, revision: 0, indexes: Array.from({ length: 101 }, (_, index) => index) },
    { type: 'getFromBranch', session: s, revision: 0, indexes: ['1'] }, { type: 'getFromBranch', session: s, revision: 0, indexes: 'all' },
    { type: 'compare', session: s, revision: 0, from: 'a', to: 'b' }, { type: 'mutate', session: s, revision: 0 }
  ];
  for (const value of rejected) assert.throws(() => parseCompareAction(value), Error, JSON.stringify(value));
});

test('Compare protocol takes a bounded name fragment and a set of change types for the file filter, and nothing else', () => {
  assert.deepEqual(parseCompareAction({ type: 'filter', session: s, revision: 2, text: '  src/app  ', statuses: 'RA', path: '/etc' }), { type: 'filter', session: s, revision: 2, text: 'src/app', statuses: 'AR' }, 'trimmed, types sorted');
  assert.deepEqual(parseCompareAction({ type: 'filter', session: s, revision: 0, text: '', statuses: '' }), { type: 'filter', session: s, revision: 0, text: '', statuses: '' });
  for (const bad of [{ text: 'x'.repeat(201), statuses: '' }, { text: 7, statuses: '' }, { text: '', statuses: 'X' }, { text: '', statuses: 'AA' }, { text: '', statuses: 'AMDRA' }, { text: '', statuses: ['A'] }, { text: 'a\u0000b', statuses: '' }, { text: 'tab\there', statuses: '' }, { statuses: '' }, { text: '' }])
    assert.throws(() => parseCompareAction({ type: 'filter', session: s, revision: 1, ...bad }), /Unknown Compare action/, JSON.stringify(bad));
  assert.throws(() => parseCompareAction({ type: 'filter', session: s, text: '', statuses: '' }), /Invalid Compare revision/);
});
