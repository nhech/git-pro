import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { advancedFixture } from '../fixtures/advanced-fixture';
import { OperationContext, readMergeMessage } from '../../src/git/conflicts/operation-context';
import { ConflictsService } from '../../src/git/conflicts/conflicts.service';
import { ToolsService } from '../../src/git/tools/tools.service';

type Fixture = Awaited<ReturnType<typeof advancedFixture>>;
/** main and feature both change file.txt; feature has two commits so a rebase stops at step 1 of 2. */
async function branches(f: Fixture): Promise<{ main: string; feature: string; first: string }> {
  await f.commit('file.txt', 'base\n', 'root'); f.git(['checkout', '-b', 'feature']);
  const first = await f.commit('file.txt', 'feature\n', 'Add login'); const feature = await f.commit('other.txt', 'second\n', 'Second feature commit');
  f.git(['checkout', 'main']); const main = await f.commit('file.txt', 'main\n', 'Bump deps'); return { main, feature, first };
}
const gitDir = (f: Fixture) => f.gitService.repository(f.id).gitDir;

test('a merge names both sides from MERGE_HEAD and the branch, and Continue opens once everything is staged', async () => {
  const f = await advancedFixture(); try {
    const { main, feature } = await branches(f);
    await assert.rejects(f.advanced.execute(await f.advanced.preview(f.id, { kind: 'merge', oid: feature, strategy: 'ff' })));
    const context = new OperationContext(f.advanced), summary = await context.summary(f.id);
    assert.equal(summary.title, 'Merging feature into main'); assert.equal(summary.operation, 'merging'); assert.equal(summary.conflicts, 1);
    assert.deepEqual(summary.yours, { label: 'Yours', ref: 'main', oid: main, detail: 'main' });
    assert.deepEqual(summary.theirs, { label: 'Theirs', ref: 'feature', oid: feature, subject: 'Second feature commit', detail: 'feature' });
    assert.deepEqual([summary.canContinue, summary.canSkip, summary.canAbort, summary.nativeOnly, summary.editStop], [false, false, true, false, false]);
    assert.equal(summary.progress, undefined); assert.equal(summary.source, undefined); assert.ok(Object.isFrozen(summary) && Object.isFrozen(summary.yours));
    // MERGE_MSG prefill for Edit Message…: Git's "# Conflicts:" block is a comment and goes; the subject stays. Git Pro merges the pinned OID.
    assert.match(await readFile(path.join(gitDir(f), 'MERGE_MSG'), 'utf8'), /^# Conflicts:$/m);
    assert.equal(await readMergeMessage(gitDir(f)), `Merge commit '${feature}'\n`);
    await writeFile(path.join(f.root, 'file.txt'), 'resolved\n'); f.git(['add', 'file.txt']);
    const resolved = await context.summary(f.id); assert.equal(resolved.conflicts, 0); assert.equal(resolved.canContinue, true);
  } finally { await f.close(); }
});

test('rebase labels follow WebStorm for both backends, with progress, and a hostile head-name is not shown', async () => {
  for (const backend of ['merge', 'apply'] as const) {
    const f = await advancedFixture(); try {
      const { main, first } = await branches(f); f.git(['checkout', 'feature']);
      if (backend === 'merge') await assert.rejects(f.advanced.execute(await f.advanced.preview(f.id, { kind: 'rebase', oid: main })));
      else assert.throws(() => f.git(['rebase', '--apply', main]), /Fixture Git failed/);
      const context = new OperationContext(f.advanced), summary = await context.summary(f.id), head = f.git(['rev-parse', 'HEAD']).trim();
      assert.equal(summary.operation, 'rebasing', backend); assert.equal(summary.title, 'Rebasing feature onto main', backend);
      assert.deepEqual(summary.progress, { current: 1, total: 2 }, backend);
      assert.deepEqual(summary.yours, { label: 'Yours', ref: 'feature', oid: first, subject: 'Add login', detail: `Rebasing ${first.slice(0, 7)} from feature` }, backend);
      assert.deepEqual(summary.theirs, { label: 'Theirs', ref: 'main', oid: head, detail: 'Already rebased commits and commits from main' }, backend);
      assert.deepEqual(summary.sides, { yours: { stage: 3, flag: 'theirs' }, theirs: { stage: 2, flag: 'ours' } });
      assert.deepEqual([summary.canSkip, summary.canAbort, summary.canContinue], [true, true, false]);
      const dir = path.join(gitDir(f), backend === 'merge' ? 'rebase-merge' : 'rebase-apply');
      for (const hostile of ['refs/heads/../../escape\n', 'refs/heads/main\nrefs/heads/other\n', 'refs/tags/v1\n', 'feature\n']) {
        await writeFile(path.join(dir, 'head-name'), hostile);
        const shown = await context.summary(f.id);
        assert.equal(shown.title, 'Rebasing commits onto main', JSON.stringify(hostile)); assert.equal(shown.yours.ref, undefined); assert.match(shown.yours.detail, /from the original branch$/);
      }
      await writeFile(path.join(dir, 'head-name'), 'detached HEAD\n'); assert.equal((await context.summary(f.id)).title, 'Rebasing detached HEAD onto main');
      await writeFile(path.join(dir, backend === 'merge' ? 'msgnum' : 'next'), '1; rm -rf /\n'); assert.equal((await context.summary(f.id)).progress, undefined, 'progress counters are digits only');
      await writeFile(path.join(gitDir(f), 'REBASE_HEAD'), 'not an object id\n'); const unknown = await context.summary(f.id);
      assert.equal(unknown.yours.oid, undefined); assert.equal(unknown.yours.detail, 'Commit being rebased from detached HEAD');
    } finally { await f.close(); }
  }
});

test('cherry-pick, revert, detached HEAD and native-only operations get their own titles', async () => {
  const f = await advancedFixture(); try {
    const { first } = await branches(f), context = new OperationContext(f.advanced);
    await assert.rejects(f.advanced.execute(await f.advanced.preview(f.id, { kind: 'cherryPick', oids: [first] })));
    const pick = await context.summary(f.id);
    assert.equal(pick.title, `Cherry-picking ${first.slice(0, 7)} onto main`); assert.deepEqual([pick.theirs.oid, pick.theirs.subject, pick.theirs.detail], [first, 'Add login', `Commit ${first.slice(0, 7)}`]);
    assert.deepEqual([pick.canSkip, pick.canContinue], [true, false]);
    await f.advanced.control(await f.advanced.snapshot(f.id), 'abort');
    const reverted = f.git(['rev-parse', 'HEAD']).trim(); await f.commit('file.txt', 'later\n', 'later');
    await assert.rejects(f.advanced.execute(await f.advanced.preview(f.id, { kind: 'revert', oids: [reverted] })));
    const revert = await context.summary(f.id); assert.equal(revert.title, `Reverting ${reverted.slice(0, 7)} on main`); assert.equal(revert.theirs.detail, `Before ${reverted.slice(0, 7)} (the reverted commit)`);
    await f.advanced.control(await f.advanced.snapshot(f.id), 'abort');
    f.git(['checkout', '--detach', 'HEAD']);
    await assert.rejects(f.advanced.execute(await f.advanced.preview(f.id, { kind: 'merge', oid: f.git(['rev-parse', 'feature']).trim(), strategy: 'ff' })));
    const detached = await context.summary(f.id); assert.equal(detached.title, 'Merging feature into detached HEAD'); assert.deepEqual([detached.yours.ref, detached.yours.detail], [undefined, 'detached HEAD']);
    const mergeHead = f.git(['rev-parse', 'MERGE_HEAD']);
    await writeFile(path.join(gitDir(f), 'MERGE_HEAD'), '--upload-pack=evil\n'); const hostile = await context.summary(f.id);
    assert.equal(hostile.title, 'Merging another commit into detached HEAD'); assert.equal(hostile.theirs.oid, undefined);
    await writeFile(path.join(gitDir(f), 'MERGE_HEAD'), mergeHead); await f.advanced.control(await f.advanced.snapshot(f.id), 'abort');
    f.git(['checkout', 'main']); f.git(['bisect', 'start']);
    const bisect = await context.summary(f.id);
    assert.equal(bisect.title, 'Bisect in progress — finish in native Git'); assert.deepEqual([bisect.nativeOnly, bisect.canAbort, bisect.canContinue], [true, false, false]);
    f.git(['bisect', 'reset']); const idle = await context.summary(f.id); assert.equal(idle.title, 'No merge conflicts'); assert.equal(idle.nativeOnly, false);
  } finally { await f.close(); }
});

test('idle conflicts take their source from the in-memory record or the stash label, otherwise read as unresolved', async () => {
  const f = await advancedFixture(); try {
    await f.commit('file.txt', 'base\n', 'root'); await writeFile(path.join(f.root, 'file.txt'), 'stash edit\n'); f.git(['stash', 'push', '-m', 'work']); await f.commit('file.txt', 'other\n', 'other');
    const tools = new ToolsService(f.advanced), stash = (await tools.stashes(f.id))[0]!;
    await assert.rejects(tools.pop(await tools.preview(f.id, { kind: 'stashApply', oid: stash.oid, index: false }), stash));
    const sources = new Map<string, { kind: 'stashPop'; oid: string; selector: string }>(), context = new OperationContext(f.advanced, sources);
    const unrecorded = await context.summary(f.id);
    assert.equal(unrecorded.title, 'Conflicts from applying a stash (stash kept)'); assert.deepEqual(unrecorded.source, { kind: 'stashMarkers' }); assert.equal(unrecorded.theirs.detail, 'Stashed changes');
    sources.set(f.id, { kind: 'stashPop', oid: stash.oid, selector: stash.selector });
    const recorded = await context.summary(f.id);
    assert.equal(recorded.title, 'Conflicts from applying stash@{0} (stash kept)'); assert.deepEqual(recorded.source, sources.get(f.id));
    assert.deepEqual([recorded.theirs.ref, recorded.theirs.oid, recorded.theirs.detail], ['stash@{0}', stash.oid, 'stash@{0} · Stashed changes']);
    assert.equal((await new ConflictsService(f.advanced, sources).list(f.id)).summary.title, recorded.title, 'the list uses the same context');
    sources.clear(); await writeFile(path.join(f.root, 'file.txt'), '<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs\n');
    assert.equal((await context.summary(f.id)).title, 'Unresolved conflicts');
  } finally { await f.close(); }
  const s = await advancedFixture(); try {
    const { feature } = await branches(s), sources = new Map<string, { kind: 'squash'; oid: string }>([[s.id, { kind: 'squash', oid: feature }]]);
    await assert.rejects(s.advanced.execute(await s.advanced.preview(s.id, { kind: 'merge', oid: feature, strategy: 'squash' })));
    const squash = await new OperationContext(s.advanced, sources).summary(s.id);
    assert.equal(squash.operation, 'idle', 'a squash merge writes no MERGE_HEAD'); assert.equal(squash.title, 'Squash-merging feature'); assert.deepEqual([squash.theirs.ref, squash.theirs.oid], ['feature', feature]);
    assert.equal((await new OperationContext(s.advanced).summary(s.id)).title, 'Unresolved conflicts', 'without the record nothing names the source');
  } finally { await s.close(); }
});
