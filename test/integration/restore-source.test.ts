import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { advancedFixture } from '../fixtures/advanced-fixture';

test('GitService.restoreFromSource gets the reviewed files from a pinned commit: updates, recreates and removes them, and leaves the index alone', async () => {
  const f = await advancedFixture(); try {
    await f.commit('kept.txt', 'branch\n', 'root'); await writeFile(path.join(f.root, 'only-branch.txt'), 'from branch\n'); f.git(['add', 'only-branch.txt']); f.git(['commit', '-m', 'branch files']);
    const branch = f.git(['rev-parse', 'HEAD']).trim();
    f.git(['rm', '-q', 'only-branch.txt']); await writeFile(path.join(f.root, 'kept.txt'), 'current\n'); await writeFile(path.join(f.root, 'only-current.txt'), 'new here\n'); f.git(['add', '.']); f.git(['commit', '-m', 'current']);
    await writeFile(path.join(f.root, 'kept.txt'), 'unsaved local edit\n'); await writeFile(path.join(f.root, 'only-current.txt'), 'staged edit\n'); f.git(['add', 'only-current.txt']);
    const index = f.git(['ls-files', '--stage']), staged = f.git(['diff', '--cached', '--name-only']);
    const paths = ['kept.txt', 'only-branch.txt', 'only-current.txt'];
    await f.gitService.restoreFromSource(await f.gitService.preview(f.id, paths), branch);
    assert.equal(await readFile(path.join(f.root, 'kept.txt'), 'utf8'), 'branch\n', 'local edits to a reviewed file are replaced');
    assert.equal(await readFile(path.join(f.root, 'only-branch.txt'), 'utf8'), 'from branch\n', 'a file only in the branch is recreated');
    await assert.rejects(readFile(path.join(f.root, 'only-current.txt')), /ENOENT/, 'a tracked file the branch lacks is removed');
    assert.equal(f.git(['ls-files', '--stage']), index, 'the index is untouched'); assert.equal(f.git(['diff', '--cached', '--name-only']), staged);
  } finally { await f.close(); }
});

test('Get from Branch refuses a stale review, an operation in progress, conflicted targets and an unpinned source', async () => {
  const f = await advancedFixture(); try {
    await f.commit('file.txt', 'base\n', 'root'); f.git(['checkout', '-b', 'feature']); const feature = await f.commit('file.txt', 'feature\n', 'feature');
    f.git(['checkout', 'main']); await f.commit('file.txt', 'main\n', 'main');
    await writeFile(path.join(f.root, 'file.txt'), 'reviewed\n'); const preview = await f.gitService.preview(f.id, ['file.txt']);
    await writeFile(path.join(f.root, 'file.txt'), 'edited after review\n');
    await assert.rejects(f.gitService.restoreFromSource(preview, feature), /changed/); assert.equal(await readFile(path.join(f.root, 'file.txt'), 'utf8'), 'edited after review\n');
    assert.throws(() => f.gitService.restoreFromSource(preview, 'feature'), /object ID/, 'only a pinned commit');
    f.git(['checkout', '--', 'file.txt']);
    const idle = await f.gitService.preview(f.id, ['file.txt']);
    await assert.rejects(f.advanced.execute(await f.advanced.preview(f.id, { kind: 'merge', oid: feature, strategy: 'ff' })));
    await assert.rejects(f.gitService.restoreFromSource(idle, feature), /operation is in progress/);
    await f.advanced.control(await f.advanced.snapshot(f.id), 'abort');
    await writeFile(path.join(f.root, 'file.txt'), 'stash me\n'); f.git(['stash', 'push', '-m', 'work']); await f.commit('file.txt', 'other\n', 'other');
    assert.throws(() => f.git(['stash', 'apply']), /Fixture Git failed/);
    await assert.rejects(f.gitService.restoreFromSource(await f.gitService.preview(f.id, ['file.txt']), feature), /Resolve the conflicts in the selected files first/);
  } finally { await f.close(); }
});
