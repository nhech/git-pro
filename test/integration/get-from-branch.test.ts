import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { GitService } from '../../src/git/git.service';
import type { DailyBackend } from '../../src/git/daily-backend';
import { GitExecutor } from '../../src/git/git-executor';
import { PathPolicy } from '../../src/security/paths';
import { RepositoryRegistry } from '../../src/repositories/repository-registry';
import { RepositoryStore } from '../../src/state/repository-store';
import { OperationCoordinator } from '../../src/state/operation-coordinator';
import { Emitter } from '../../src/utils/events';
import { silentLogger } from '../../src/utils/logging';
import { parseChangedFiles } from '../../src/git/history/history-parser';
import { fixture, gitExecutable } from '../fixtures/repository-fixture';

/** Real Git behind GitService; Get from Branch never reaches the built-in backend, so it refuses to be called. */
async function getFromBranchFixture() {
  const f = await fixture(), event = new Emitter<void>();
  const policy = new PathPolicy(() => [f.parent], () => true);
  const executor = new GitExecutor(gitExecutable, policy, silentLogger, undefined, f.env);
  const store = new RepositoryStore(), registry = new RepositoryRegistry(policy, executor, store, silentLogger, 60_000), coordinator = new OperationCoordinator(() => policy.checkTrust());
  const backend = new Proxy({}, { get: () => () => { throw new Error('Get from Branch must not use the built-in Git backend.'); } }) as DailyBackend;
  await registry.sync([{ root: f.root, onDidChange: event.event }]);
  const git = new GitService(registry, executor, policy, coordinator, backend), id = registry.active!.id;
  const write = (file: string, content: string) => writeFile(path.join(f.root, file), content), read = (file: string) => readFile(path.join(f.root, file), 'utf8');
  const exists = (file: string) => access(path.join(f.root, file)).then(() => true, () => false);
  const index = () => ({ stage: f.git(['ls-files', '--stage', '-z']), cached: f.git(['diff', '--cached', '--binary']), head: f.git(['rev-parse', 'HEAD']) });
  // Base on main, a `side` branch at the base, then main renames, edits, deletes and adds.
  await write('old.txt', 'old\n'); await write('keep.txt', 'keep\n'); await write('gone.txt', 'gone\n');
  f.git(['add', '.']); f.git(['commit', '-m', 'base']); f.git(['branch', 'side']);
  f.git(['mv', 'old.txt', 'new.txt']); await write('keep.txt', 'changed\n'); f.git(['rm', '-q', 'gone.txt']); await write('added.txt', 'added\n');
  f.git(['add', '.']); f.git(['commit', '-m', 'main']);
  const side = f.git(['rev-parse', 'side']).trim();
  const close = async () => { coordinator.dispose(); registry.dispose(); executor.dispose(); store.dispose(); event.dispose(); await f.cleanup(); };
  return { ...f, rawGit: f.git, git, id, side, write, read, exists, index, close };
}

test('Get from Branch restores changed and branch-only files, deletes what the branch lacks, follows both sides of a rename and leaves the index untouched', async () => {
  const f = await getFromBranchFixture();
  try {
    await f.write('keep.txt', 'local edit\n'); await f.write('staged.txt', 'staged\n'); f.rawGit(['add', 'staged.txt']);
    const before = f.index();
    // The Compare tab's working-tree rows: `git diff <branch>`, so a rename reads branch name → working-tree name.
    const rows = parseChangedFiles(Buffer.from(f.rawGit(['diff', f.side, '--no-ext-diff', '--no-textconv', '-M', '-l1000', '--name-status', '-z', '--']), 'utf8'));
    const chosen = rows.filter(row => row.path !== 'staged.txt');
    assert.deepEqual(chosen.map(row => [row.status, row.originalPath ?? null, row.path]), [['A', null, 'added.txt'], ['D', null, 'gone.txt'], ['M', null, 'keep.txt'], ['R100', 'old.txt', 'new.txt']]);
    const paths = [...new Set(chosen.flatMap(row => row.originalPath && row.originalPath !== row.path ? [row.originalPath, row.path] : [row.path]))];
    await f.git.restoreFromSource(await f.git.preview(f.id, paths), f.side);
    assert.equal(await f.read('keep.txt'), 'keep\n'); assert.equal(await f.read('old.txt'), 'old\n'); assert.equal(await f.read('gone.txt'), 'gone\n');
    assert.equal(await f.exists('new.txt'), false); assert.equal(await f.exists('added.txt'), false);
    assert.equal(await f.read('staged.txt'), 'staged\n', 'An unselected file is left alone');
    assert.deepEqual(f.index(), before, 'restore --worktree changes neither the index nor HEAD');
  } finally { await f.close(); }
});

test('Get from Branch refuses an untracked or ignored file that `git diff <branch>` shows as the branch\'s, since Git could not give it back', async () => {
  const f = await getFromBranchFixture();
  try {
    // gone.txt is deleted on main and in side; an untracked file of that name is not in the index, so the diff still lists `D gone.txt`.
    await f.write('gone.txt', 'PRECIOUS untracked\n');
    assert.match(f.rawGit(['diff', f.side, '--name-status', '--', 'gone.txt']), /^D\tgone\.txt/);
    await assert.rejects(f.git.restoreFromSource(await f.git.preview(f.id, ['gone.txt', 'keep.txt']), f.side), /gone\.txt is not tracked by Git\. Get from Branch would overwrite it/);
    assert.equal(await f.read('gone.txt'), 'PRECIOUS untracked\n'); assert.equal(await f.read('keep.txt'), 'changed\n', 'nothing in the batch ran');
    await f.write('.gitignore', 'gone.txt\n'); f.rawGit(['add', '.gitignore']); f.rawGit(['commit', '-qm', 'ignore']);
    await assert.rejects(f.git.restoreFromSource(await f.git.preview(f.id, ['gone.txt']), f.side), /gone\.txt is not tracked by Git/, 'an ignored file is not in the status either');
    assert.equal(await f.read('gone.txt'), 'PRECIOUS untracked\n');
  } finally { await f.close(); }
});

test('Get from Branch refuses an intent-to-add file: `ls-files` lists it, but Git stored none of its content', async () => {
  const f = await getFromBranchFixture();
  try {
    // ita.txt is not in side, so restoring it from side deletes it; `git add -N` left only an empty placeholder entry in the index.
    await f.write('ita.txt', 'PRECIOUS intent to add\n'); f.rawGit(['add', '-N', 'ita.txt']);
    assert.match(f.rawGit(['ls-files', '--stage', '--', 'ita.txt']), /\tita\.txt/, 'the index lists the path like a tracked file');
    await assert.rejects(f.git.restoreFromSource(await f.git.preview(f.id, ['ita.txt', 'keep.txt']), f.side), /ita\.txt is only marked for adding \(git add -N\)\. Get from Branch would overwrite or delete it, and Git keeps no copy to restore it from\./);
    assert.equal(await f.read('ita.txt'), 'PRECIOUS intent to add\n'); assert.equal(await f.read('keep.txt'), 'changed\n', 'nothing in the batch ran');
    // Moved on disk and re-added with -N: status pairs the intent-to-add path with the deleted one as a working-tree rename.
    f.rawGit(['rm', '-q', '--cached', 'ita.txt']); await f.write('long.txt', 'a long enough line\nto be detected\nas a rename by status\n'); f.rawGit(['add', 'long.txt']); f.rawGit(['commit', '-qm', 'long']);
    await rm(path.join(f.root, 'long.txt')); await f.write('moved.txt', 'a long enough line\nto be detected\nas a rename by status\n'); f.rawGit(['add', '-N', 'moved.txt']);
    assert.match(f.rawGit(['status', '--porcelain=v2', '--', 'moved.txt', 'long.txt']), /^2 \.R /m);
    await assert.rejects(f.git.restoreFromSource(await f.git.preview(f.id, ['long.txt', 'moved.txt']), f.side), /moved\.txt is only marked for adding/);
    assert.equal(await f.exists('moved.txt'), true);
    f.rawGit(['add', 'moved.txt']); await f.git.restoreFromSource(await f.git.preview(f.id, ['moved.txt']), f.side);
    assert.equal(await f.exists('moved.txt'), false, 'once staged, Git holds the content and the restore runs');
  } finally { await f.close(); }
});

test('Get from Branch refuses reviewed content that changed, a running operation, and more than 5000 paths', async () => {
  const f = await getFromBranchFixture();
  try {
    const reviewed = await f.git.preview(f.id, ['keep.txt']);
    await f.write('keep.txt', 'edited after review\n');
    await assert.rejects(f.git.restoreFromSource(reviewed, f.side), /reviewed content changed/);
    assert.equal(await f.read('keep.txt'), 'edited after review\n');
    await assert.rejects(f.git.preview(f.id, Array.from({ length: 5001 }, (_, index) => `f${index}.txt`)), /between 1 and 5000/);
    const valid = await f.git.preview(f.id, ['keep.txt']);
    await assert.rejects(f.git.restoreFromSource({ ...valid, paths: Array.from({ length: 5001 }, (_, index) => `f${index}.txt`) }, f.side), /between 1 and 5000/);
    await assert.rejects(async () => f.git.restoreFromSource(valid, 'side'), /full object ID/);
    // A real merge stop: MERGE_HEAD makes the repository non-idle for a fresh review and for a review taken before it.
    f.rawGit(['checkout', '--', 'keep.txt']); f.rawGit(['switch', '-q', '-c', 'clash', 'side']); await f.write('keep.txt', 'clash\n'); f.rawGit(['commit', '-qam', 'clash']); f.rawGit(['switch', '-q', 'main']);
    const idle = await f.git.preview(f.id, ['keep.txt']);
    const merge = (await import('node:child_process')).spawnSync(gitExecutable, ['merge', 'clash'], { cwd: f.root, env: f.env, encoding: 'utf8', windowsHide: true });
    assert.equal(merge.status, 1, merge.stderr);
    await assert.rejects(f.git.preview(f.id, ['keep.txt']), /operation is in progress/);
    await assert.rejects(f.git.restoreFromSource(idle, f.side), /operation is in progress/);
    assert.match(await f.read('keep.txt'), /<<<<<<< /, 'The conflicted file is untouched');
  } finally { await f.close(); }
});
