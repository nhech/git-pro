import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kindLabels, mergeBlocker, parseConflictsRequest } from '../../src/webviews/conflicts/conflicts-protocol';

const session = '12345678-1234-4234-9234-123456789abc', key = (index: number) => `${String(index).padStart(2, '0')}${'A'.repeat(41)}`;

test('Conflicts requests need the panel session, opaque bounded keys and a revision for anything that acts; extra fields are dropped', () => {
  assert.throws(() => parseConflictsRequest(undefined), /Invalid Conflicts request/);
  assert.throws(() => parseConflictsRequest([]), /Invalid Conflicts request/);
  assert.throws(() => parseConflictsRequest({ type: 'ready', session: 'not-a-session' }), /session expired/);
  assert.deepEqual(parseConflictsRequest({ type: 'ready', session, path: 'src/app.ts' }), { type: 'ready', session });
  assert.deepEqual(parseConflictsRequest({ type: 'refresh', session, revision: 'x' }), { type: 'refresh', session });
  assert.deepEqual(parseConflictsRequest({ type: 'columnLayout', session, command: 'workbench.action.quit' }), { type: 'columnLayout', session }, 'a view preference: no revision, no command from the webview');
  assert.deepEqual(parseConflictsRequest({ type: 'select', session, keys: [] }), { type: 'select', session, keys: [] });
  assert.deepEqual(parseConflictsRequest({ type: 'setting', session, groupByDirectory: true, extra: 1 }), { type: 'setting', session, groupByDirectory: true });
  assert.throws(() => parseConflictsRequest({ type: 'setting', session, groupByDirectory: 'yes' }), /Invalid Conflicts setting/);

  const resolve = { type: 'resolve', session, revision: 3, action: 'acceptTheirs', keys: [key(1), key(2)], paths: ['../escape'] };
  assert.deepEqual(parseConflictsRequest(resolve), { type: 'resolve', session, revision: 3, action: 'acceptTheirs', keys: [key(1), key(2)] }, 'paths from the webview are never read');
  for (const revision of [undefined, -1, 1.5, '3', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => parseConflictsRequest({ ...resolve, revision }), /Conflicts changed/, String(revision));
  assert.throws(() => parseConflictsRequest({ ...resolve, keys: [] }), /1–100/);
  assert.throws(() => parseConflictsRequest({ ...resolve, keys: Array.from({ length: 101 }, (_, index) => key(index % 100).slice(0, 40) + String(index).padStart(3, '0')) }), /1–100/);
  assert.throws(() => parseConflictsRequest({ ...resolve, keys: [key(1), key(1)] }), /1–100/, 'duplicates');
  assert.throws(() => parseConflictsRequest({ ...resolve, keys: ['src/app.ts'] }), /1–100/, 'a path is not a key');
  assert.throws(() => parseConflictsRequest({ ...resolve, keys: [`${key(1)}=`] }), /1–100/, 'fixed length');
  assert.throws(() => parseConflictsRequest({ ...resolve, action: 'acceptBoth' }), /Unknown Conflicts action/);
  assert.equal(parseConflictsRequest({ ...resolve, keys: Array.from({ length: 100 }, (_, index) => key(index)) }).type, 'resolve');

  assert.deepEqual(parseConflictsRequest({ type: 'open', session, revision: 0, action: 'compareYoursTheirs', key: key(4), path: 'x' }), { type: 'open', session, revision: 0, action: 'compareYoursTheirs', key: key(4) });
  assert.deepEqual(parseConflictsRequest({ type: 'open', session, revision: 0, action: 'merge', key: key(4), keys: [key(4), key(5)] }), { type: 'open', session, revision: 0, action: 'merge', key: key(4), keys: [key(4), key(5)] });
  assert.throws(() => parseConflictsRequest({ type: 'open', session, revision: 0, action: 'merge', key: key(4), keys: [key(5)] }), /Invalid conflict selection/, 'the sequence includes the row');
  assert.throws(() => parseConflictsRequest({ type: 'open', session, revision: 0, action: 'file', key: key(4), keys: [key(4)] }), /Invalid conflict selection/, 'only Merge… takes a sequence');
  assert.throws(() => parseConflictsRequest({ type: 'open', session, revision: 0, action: 'file', key: 'bad' }), /Invalid conflict row/);
  for (const action of ['continue', 'abort', 'skip', 'dropStash', 'close', 'scm']) assert.deepEqual(parseConflictsRequest({ type: 'operation', session, revision: 2, action }), { type: 'operation', session, revision: 2, action });
  assert.throws(() => parseConflictsRequest({ type: 'operation', session, revision: 2, action: 'reset' }), /Unknown Conflicts action/);
  assert.throws(() => parseConflictsRequest({ type: 'diff', session, revision: 2 }), /Unknown Conflicts action/);
});

test('Merge… is explained by kind for rows it cannot open', () => {
  const row = { kind: 'bothModified' as const, binary: false, workingFile: true, mergeable: true };
  assert.equal(mergeBlocker({ ...row, kind: 'deletedByThem', mergeable: false }), 'Deleted by them — choose Accept Yours or Accept Theirs.');
  assert.equal(mergeBlocker({ ...row, binary: true, mergeable: false }), 'Binary file — choose Accept Yours or Accept Theirs.');
  assert.equal(mergeBlocker({ ...row, mergeable: false, unsupported: 'Use native Git: symlink' }), 'Use native Git: symlink');
  assert.equal(mergeBlocker({ ...row, workingFile: false, mergeable: false }), 'No working file — choose Accept Yours or Accept Theirs.');
  assert.deepEqual(Object.keys(kindLabels).sort(), ['addedByThem', 'addedByUs', 'bothAdded', 'bothDeleted', 'bothModified', 'deletedByThem', 'deletedByUs']);
});
