import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { advancedFixture } from '../fixtures/advanced-fixture';
import { gitExecutable } from '../fixtures/repository-fixture';
import { ConflictsService } from '../../src/git/conflicts/conflicts.service';
import { GitFailure } from '../../src/git/git-error-parser';

type Fixture = Awaited<ReturnType<typeof advancedFixture>>;
const conflict = (error: unknown) => error instanceof GitFailure && error.kind === 'conflict';
const content = (f: Fixture, file: string) => readFile(path.join(f.root, file), 'utf8');
const usual = { yours: { stage: 2, flag: 'ours' }, theirs: { stage: 3, flag: 'theirs' } }, rebase = { yours: { stage: 3, flag: 'theirs' }, theirs: { stage: 2, flag: 'ours' } };
/** feature (two commits) and main both change f.txt, so rebasing feature onto main stops on its first commit. */
async function rebaseStop(f: Fixture, setup: () => Promise<void> = async () => undefined): Promise<void> {
  await f.commit('f.txt', 'base\n', 'base'); await f.commit('o.txt', 'o base\n', 'o base'); await f.commit('s.txt', 's base\n', 's base');
  f.git(['checkout', '-b', 'other']); await f.commit('o.txt', 'OTHER\n', 'other');
  f.git(['checkout', '-b', 'feature', 'main']); await f.commit('f.txt', 'MINE\n', 'mine'); await f.commit('x.txt', 'x\n', 'second');
  f.git(['checkout', 'main']); await f.commit('f.txt', 'UP\n', 'up'); await setup(); f.git(['checkout', 'feature']);
  await assert.rejects(f.advanced.execute(await f.advanced.preview(f.id, { kind: 'rebase', oid: f.git(['rev-parse', 'main']).trim() })), conflict);
  assert.equal((await f.advanced.snapshot(f.id)).operation, 'rebasing');
}

test('a merge run after committing a rebase step by hand owns its conflicts: Yours is HEAD, and Abort aborts the merge, not the rebase', async () => {
  const f = await advancedFixture(); try {
    await rebaseStop(f);
    // `git commit` at the stop keeps REBASE_HEAD; the merge then writes MERGE_HEAD beside it.
    await writeFile(path.join(f.root, 'f.txt'), 'RESOLVED\n'); f.git(['add', 'f.txt']); f.git(['commit', '--no-edit']);
    await f.commit('o.txt', 'MINE-O\n', 'mine o');
    assert.throws(() => f.git(['merge', 'other']), /Fixture Git failed/);
    const service = new ConflictsService(f.advanced), list = await service.list(f.id);
    assert.equal(list.snapshot.operation, 'merging'); assert.deepEqual(list.summary.sides, usual);
    assert.equal(list.summary.title, 'Merging other into feature (rebase paused)');
    await service.acceptSide(await service.previewBatch(f.id, ['o.txt']), 'yours');
    assert.equal(await content(f, 'o.txt'), 'MINE-O\n', 'Accept Yours keeps HEAD, not the merged branch');
    await f.advanced.control(await f.advanced.snapshot(f.id), 'abort');
    const after = await f.advanced.snapshot(f.id);
    assert.equal(after.operation, 'rebasing', 'merge --abort returns to the paused rebase'); assert.equal(await content(f, 'o.txt'), 'MINE-O\n');
    assert.equal(f.git(['log', '-1', '--format=%s']).trim(), 'mine o', 'the hand-made commits stay');
  } finally { await f.close(); }
});

test('a stash applied after staging a rebase step\'s resolution owns its conflicts as idle ones: Yours is HEAD, Theirs the stash', async () => {
  const f = await advancedFixture(); try {
    await rebaseStop(f, async () => {
      await f.commit('s.txt', 'S UP\n', 'up s');
      f.git(['checkout', 'feature']); await writeFile(path.join(f.root, 's.txt'), 'STASHED\n'); f.git(['stash', 'push', '-m', 'work']); f.git(['checkout', 'main']);
    });
    await writeFile(path.join(f.root, 'f.txt'), 'RESOLVED\n'); f.git(['add', 'f.txt']);
    assert.throws(() => f.git(['stash', 'apply']), /Fixture Git failed/);
    const service = new ConflictsService(f.advanced), list = await service.list(f.id);
    assert.deepEqual(list.rows.map(row => row.path), ['s.txt']);
    assert.equal(list.snapshot.operation, 'idle'); assert.deepEqual(list.summary.sides, usual);
    assert.equal(list.summary.title, 'Conflicts from applying a stash (stash kept) · rebase of feature paused');
    assert.equal((await service.context.summary(f.id)).operation, 'idle', 'the banner reads the same operation');
    await service.acceptSide(await service.previewBatch(f.id, ['s.txt']), 'yours');
    assert.equal(await content(f, 's.txt'), 'S UP\n', 'Accept Yours keeps HEAD, not the stash');
  } finally { await f.close(); }
});

test('a rebase -r merge step that stops on conflicts stays the rebase: Yours is the replayed side', async () => {
  const f = await advancedFixture(); try {
    await f.commit('f.txt', 'base\n', 'base');
    f.git(['checkout', '-b', 'b']); await f.commit('f.txt', 'B\n', 'B');
    f.git(['checkout', '-b', 'a', 'main']); await f.commit('f.txt', 'A\n', 'A');
    assert.throws(() => f.git(['merge', 'b']), /Fixture Git failed/); await writeFile(path.join(f.root, 'f.txt'), 'AB\n'); f.git(['add', 'f.txt']); f.git(['commit', '--no-edit']);
    f.git(['checkout', 'main']); await f.commit('u.txt', 'u\n', 'unrelated'); f.git(['checkout', 'a']);
    assert.throws(() => f.git(['rebase', '--rebase-merges', 'main']), /Fixture Git failed/);
    const snapshot = await f.advanced.snapshot(f.id);
    assert.equal(snapshot.operation, 'rebasing', 'REBASE_HEAD and MERGE_HEAD at a merge step, the last done step a merge');
    assert.deepEqual((await new ConflictsService(f.advanced).list(f.id)).summary.sides, rebase);
    await f.advanced.control(snapshot, 'abort'); assert.equal((await f.advanced.snapshot(f.id)).operation, 'idle');
  } finally { await f.close(); }
});

test('a squash or fixup that stops on conflicts is still the rebase: Yours is the replayed side, and Continue, Skip and Abort stay available', async () => {
  const f = await advancedFixture(); try {
    const base = await f.commit('f.txt', 'base\n', 'base');
    await f.commit('a.txt', 'one\n', 'one'); await f.commit('f.txt', 'MINE\n', 'two'); await f.commit('f.txt', 'MINE-3\n', 'three');
    // drop the middle commit and fixup the last into the first: the last commit's change to f.txt no longer applies, so the fixup stops on a conflict.
    const script = path.join(f.parent, 'todo.cjs'), forward = (value: string) => value.replace(/\\/g, '/');
    // The editor script avoids backslashes so that it reads the same whatever shell Git runs it through.
    await writeFile(script, "const fs=require('fs');const NL=String.fromCharCode(10);const file=process.argv[2];const lines=fs.readFileSync(file,'utf8').split(NL).filter(l=>/^pick /.test(l));fs.writeFileSync(file,[lines[0],'drop '+lines[1].slice(5),'fixup '+lines[2].slice(5)].join(NL)+NL);");
    const sequence = `"${forward(process.execPath)}" "${forward(script)}"`;
    const result = spawnSync(gitExecutable, ['rebase', '-i', base], { cwd: f.root, env: { ...f.env, GIT_SEQUENCE_EDITOR: sequence, GIT_EDITOR: 'true' }, windowsHide: true, encoding: 'utf8' });
    assert.notEqual(result.status, 0, 'the fixup conflicts');
    assert.match(await readFile(path.join(f.root, '.git', 'rebase-merge', 'done'), 'utf8'), /^fixup /m);
    const snapshot = await f.advanced.snapshot(f.id);
    assert.equal(snapshot.operation, 'rebasing', 'REBASE_HEAD and rebase-merge/amend are both there, but the last step was a fixup, not an edit stop');
    assert.deepEqual((await new ConflictsService(f.advanced).list(f.id)).summary.sides, rebase, 'Yours is the commit being replayed (stage 3), not the commit it was squashed into');
    await f.advanced.control(snapshot, 'abort'); assert.equal((await f.advanced.snapshot(f.id)).operation, 'idle');
  } finally { await f.close(); }
});
