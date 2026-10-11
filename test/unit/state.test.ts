import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { detectConflictOperation, detectOperation, rebasePaused } from '../../src/state/operation-state';
import { OperationCoordinator } from '../../src/state/operation-coordinator';
import { RepositoryStore } from '../../src/state/repository-store';
import { parseStatus } from '../../src/git/git-parser';
import { fixture } from '../fixtures/repository-fixture';

test('rebase takes precedence over cherry-pick; git am and sequencer distinct', async () => {
  const f = await fixture(); const metadata = path.join(f.parent, 'markers'); await mkdir(metadata);
  try {
    await writeFile(path.join(metadata, 'CHERRY_PICK_HEAD'), 'hash');
    await mkdir(path.join(metadata, 'rebase-merge'));
    assert.equal(await detectOperation(metadata), 'rebasing');
    await rm(path.join(metadata, 'rebase-merge'), { recursive: true });
    assert.equal(await detectOperation(metadata), 'cherry-picking');
    await rm(path.join(metadata, 'CHERRY_PICK_HEAD'));
    await mkdir(path.join(metadata, 'rebase-apply'));
    assert.equal(await detectOperation(metadata), 'applying-mail');
    await writeFile(path.join(metadata, 'rebase-apply', 'rebasing'), '');
    assert.equal(await detectOperation(metadata), 'rebasing');
    await rm(path.join(metadata, 'rebase-apply'), { recursive: true });
    await mkdir(path.join(metadata, 'sequencer')); await writeFile(path.join(metadata, 'sequencer', 'todo'), 'revert hash message\n');
    assert.equal(await detectOperation(metadata), 'reverting');
  } finally { await f.cleanup(); }
});
test('conflicts a command ran at a rebase stop belong to that command; the rebase keeps its own conflicts', async () => {
  const f = await fixture(); const metadata = path.join(f.parent, 'markers'); await mkdir(metadata);
  const put = (name: string, value = `${'a'.repeat(40)}\n`) => writeFile(path.join(metadata, name), value);
  try {
    await mkdir(path.join(metadata, 'rebase-merge')); await put('REBASE_HEAD');
    assert.equal(await detectConflictOperation(metadata, true), 'rebasing', 'a conflicting rebase step: REBASE_HEAD and no amend file');
    await put('CHERRY_PICK_HEAD'); assert.equal(await detectConflictOperation(metadata, true), 'rebasing', 'older Git also writes CHERRY_PICK_HEAD for the same commit');
    await put('MERGE_HEAD', `${'c'.repeat(40)}\n`); assert.equal(await detectConflictOperation(metadata, true), 'rebasing', 'a rebase -r merge step keeps REBASE_HEAD');
    await rm(path.join(metadata, 'MERGE_HEAD'));
    await put('CHERRY_PICK_HEAD', `${'b'.repeat(40)}\n`); assert.equal(await detectConflictOperation(metadata, true), 'cherry-picking', 'another commit picked at the stop');
    await put('rebase-merge/amend'); await put('CHERRY_PICK_HEAD'); assert.equal(await detectConflictOperation(metadata, true), 'cherry-picking', 'an edit stop never has conflicts of its own');
    await rm(path.join(metadata, 'CHERRY_PICK_HEAD')); await put('MERGE_HEAD', `${'c'.repeat(40)}\n`);
    assert.equal(await detectConflictOperation(metadata, true), 'merging');
    await rm(path.join(metadata, 'MERGE_HEAD'));
    assert.equal(await detectConflictOperation(metadata, true), 'idle', 'a stash apply at the stop leaves no marker: idle conflicts, Yours is HEAD');
    let read = 0; assert.equal(await detectConflictOperation(metadata, () => { read++; return false; }), 'rebasing', 'an edit stop without conflicts is the rebase'); assert.equal(read, 1);
    await rm(path.join(metadata, 'rebase-merge', 'amend')); await rm(path.join(metadata, 'REBASE_HEAD'));
    assert.equal(await detectConflictOperation(metadata, true), 'idle', 'break and exec stops delete REBASE_HEAD');
    await put('REVERT_HEAD'); assert.equal(await detectConflictOperation(metadata, false), 'reverting', 'a rebase never writes REVERT_HEAD');
    assert.equal(await detectOperation(metadata), 'rebasing', 'the bare state is unchanged'); assert.equal(await rebasePaused(metadata), true);
    await rm(path.join(metadata, 'rebase-merge'), { recursive: true });
    assert.equal(await detectConflictOperation(metadata, true), 'reverting'); assert.equal(await rebasePaused(metadata), false);
  } finally { await f.cleanup(); }
});
test('commonDir queue survives failure and refreshes before next operation', async () => {
  const queue = new OperationCoordinator(() => {}); const events: string[] = [];
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  const first = queue.run('shared', async () => { events.push('first'); await barrier; throw new Error('expected'); }, async () => { events.push('refresh1'); });
  const failed = assert.rejects(first, /expected/);
  const second = queue.run('shared', async () => { events.push('second'); return 2; }, async () => { events.push('refresh2'); });
  await Promise.resolve(); assert.deepEqual(events, ['first']); release(); await failed;
  assert.equal(await second, 2); assert.deepEqual(events, ['first', 'refresh1', 'second', 'refresh2']); queue.dispose();
  await assert.rejects(queue.run('shared', async () => 0, async () => {}), /disposed/);
});
test('store keeps repositories isolated and increments immutable snapshots', () => {
  const store = new RepositoryStore(); const status = parseStatus(Buffer.from('# branch.head main\0'));
  store.update('a', status, 'idle'); store.update('b', status, 'merging'); store.update('a', status, 'rebasing');
  assert.equal(store.get('a')?.version, 2); assert.equal(store.get('b')?.operation, 'merging');
  assert.ok(Object.isFrozen(store.get('a'))); store.remove('a'); assert.equal(store.get('a'), undefined); store.dispose();
});
test('failed refresh does not hide the original operation failure', async () => {
  const queue = new OperationCoordinator(() => {});
  await assert.rejects(queue.run('shared', async () => { throw new Error('operation conflict'); }, async () => { throw new Error('refresh failed'); }), /operation conflict/);
  assert.equal(await queue.run('shared', async () => 3, async () => {}), 3); queue.dispose();
});
