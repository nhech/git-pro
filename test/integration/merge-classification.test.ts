import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { advancedFixture } from '../fixtures/advanced-fixture';
import { GitFailure } from '../../src/git/git-error-parser';
import { GitService } from '../../src/git/git.service';
import { ToolsService } from '../../src/git/tools/tools.service';
import { recoveryFor } from '../../src/utils/recovery';
import { isConflictFailure } from '../../src/conflicts/surfaces';
import type { DailyBackend } from '../../src/git/daily-backend';

type Fixture = Awaited<ReturnType<typeof advancedFixture>>;
/** `git merge` writes its CONFLICT lines to stdout and nothing to stderr: before stdout was read these all reported "Git could not complete the operation." */
const conflict = (error: unknown) => error instanceof GitFailure && error.kind === 'conflict' && error.exitCode === 1 && isConflictFailure(error) && recoveryFor(error).command === 'gitPro.conflicts.open' && !/file\.txt/.test(error.message);
async function diverged(f: Fixture): Promise<string> {
  await f.commit('file.txt', 'base\n', 'root'); f.git(['checkout', '-b', 'feature']); const feature = await f.commit('file.txt', 'feature\n', 'feature');
  f.git(['checkout', 'main']); await f.commit('file.txt', 'main\n', 'main'); return feature;
}
const conflicts = async (f: Fixture) => (await f.advanced.snapshot(f.id)).status.changes.filter(change => change.group === 'conflicts').length;

test('a Git Pro merge and a squash merge that stop on conflicts are conflict failures', async () => {
  for (const strategy of ['ff', 'no-ff', 'squash'] as const) {
    const f = await advancedFixture(); try {
      const feature = await diverged(f);
      await assert.rejects(f.advanced.execute(await f.advanced.preview(f.id, { kind: 'merge', oid: feature, strategy })), conflict, strategy);
      const snapshot = await f.advanced.snapshot(f.id); assert.equal(snapshot.operation, strategy === 'squash' ? 'idle' : 'merging'); assert.equal(await conflicts(f), 1);
    } finally { await f.close(); }
  }
});

test('a pull that merges, and stash apply and pop, stop as conflict failures', async () => {
  const f = await advancedFixture(); try {
    const remote = path.join(f.parent, 'origin.git'); await mkdir(remote); f.git(['init', '--bare', '-b', 'main'], remote);
    await f.commit('file.txt', 'base\n', 'root'); f.git(['remote', 'add', 'origin', remote]); f.git(['push', '-u', 'origin', 'main']);
    await f.commit('file.txt', 'remote\n', 'remote change'); f.git(['push', 'origin', 'main']); f.git(['reset', '--hard', 'HEAD~1']); await f.commit('file.txt', 'local\n', 'local change');
    const unsupported = async (): Promise<never> => { throw new Error('Unexpected daily backend action.'); };
    // The remote-tracking ref is already current, so the fetch the pull starts with has nothing to do.
    const backend: DailyBackend = { stage: unsupported, commit: unsupported, push: unsupported, createBranch: unsupported, checkout: unsupported, deleteBranch: unsupported, setUpstream: unsupported, fetch: async () => {}, remotes: async () => [{ name: 'origin', fetchUrl: remote, pushUrl: remote }] };
    const git = new GitService(f.registry, f.executor, f.policy, f.coordinator, backend);
    await assert.rejects(git.pull(f.id, 'merge'), conflict); assert.equal((await f.advanced.snapshot(f.id)).operation, 'merging');
    f.git(['merge', '--abort']);
    await writeFile(path.join(f.root, 'file.txt'), 'stashed\n'); f.git(['stash', 'push', '-m', 'work']); await f.commit('file.txt', 'other\n', 'other');
    const tools = new ToolsService(f.advanced), stash = (await tools.stashes(f.id))[0]!;
    await assert.rejects(tools.execute(await tools.preview(f.id, { kind: 'stashApply', oid: stash.oid, index: false })), conflict);
    assert.equal((await f.advanced.snapshot(f.id)).operation, 'idle'); assert.equal(await conflicts(f), 1);
    f.git(['reset', '--hard']);
    await assert.rejects(tools.pop(await tools.preview(f.id, { kind: 'stashApply', oid: stash.oid, index: false }), stash), conflict); assert.equal((await tools.stashes(f.id))[0]!.oid, stash.oid, 'pop keeps the stash');
  } finally { await f.close(); }
});

test('rebase, cherry-pick, revert and a rebase Continue that meets the next conflict stay conflict failures; other merge failures do not', async () => {
  const f = await advancedFixture(); try {
    const feature = await diverged(f), reverted = f.git(['rev-parse', 'main']).trim();
    await assert.rejects(f.advanced.execute(await f.advanced.preview(f.id, { kind: 'cherryPick', oids: [feature] })), conflict); await f.advanced.control(await f.advanced.snapshot(f.id), 'abort');
    const main = await f.commit('file.txt', 'later\n', 'later');
    await assert.rejects(f.advanced.execute(await f.advanced.preview(f.id, { kind: 'revert', oids: [reverted] })), conflict); await f.advanced.control(await f.advanced.snapshot(f.id), 'abort');
    f.git(['checkout', 'feature']); await f.commit('file.txt', 'feature again\n', 'second feature');
    await assert.rejects(f.advanced.execute(await f.advanced.preview(f.id, { kind: 'rebase', oid: main })), conflict);
    await writeFile(path.join(f.root, 'file.txt'), 'resolved\n'); f.git(['add', 'file.txt']);
    await assert.rejects(f.advanced.control(await f.advanced.snapshot(f.id), 'continue'), conflict, 'the next replayed commit conflicts with the resolution');
    await f.advanced.control(await f.advanced.snapshot(f.id), 'abort');
    f.git(['checkout', 'main']); await writeFile(path.join(f.root, 'file.txt'), 'dirty\n');
    await assert.rejects(f.executor.mutate(f.root, { kind: 'merge', oid: feature, strategy: 'ff' }), (error: unknown) => error instanceof GitFailure && error.kind !== 'conflict', 'local changes that would be overwritten are not a conflict');
  } finally { await f.close(); }
});
