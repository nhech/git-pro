import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { advancedFixture } from '../fixtures/advanced-fixture';
import { LeaseService } from '../../src/git/advanced/lease.service';
import { UndoService, UndoUnavailable, gitUndoBackend, type UndoMemento } from '../../src/git/undo/undo.service';

class Memory implements UndoMemento {
  readonly values = new Map<string, unknown>();
  get<T>(key: string, fallback: T): T { return (this.values.has(key) ? this.values.get(key) : fallback) as T; }
  async update(key: string, value: unknown): Promise<void> { this.values.set(key, JSON.parse(JSON.stringify(value))); }
}
const read = (f: { root: string }, file: string) => readFile(path.join(f.root, file), 'utf8');

test('a discard is undone from the copy Git Pro kept: unstaged edits come back, the index and the stash list are untouched', async () => {
  const f = await advancedFixture();
  try {
    await f.commit('a.ts', 'one\n', 'a'); await f.commit('b.ts', 'bee\n', 'b'); await f.commit('c.ts', 'see\n', 'c');
    const undo = new UndoService(gitUndoBackend(f.gitService), new Memory());
    await writeFile(path.join(f.root, 'a.ts'), 'two\n');                    // an unstaged edit
    await writeFile(path.join(f.root, 'b.ts'), 'bee2\n'); f.git(['add', 'b.ts']); await writeFile(path.join(f.root, 'b.ts'), 'bee3\n'); // staged, then edited again
    await rm(path.join(f.root, 'c.ts'));                                     // a tracked file deleted in the working tree
    await writeFile(path.join(f.root, 'new.txt'), 'untracked\n');
    const paths = ['a.ts', 'b.ts', 'c.ts'], before = { stash: f.git(['stash', 'list']), cached: f.git(['diff', '--cached']), head: f.git(['rev-parse', 'HEAD']) };

    // As the command does: the preview is taken before the question, the copy after the answer, and the discard checks the preview.
    const preview = await f.gitService.preview(f.id, paths);
    const entry = await undo.save(f.id, f.root, { kind: 'discard', label: 'Discarded 3 files', paths });
    assert.equal(entry.kind, 'discard'); assert.equal(f.git(['rev-parse', `refs/gitpro/undo/${entry.id}`]).trim(), (entry as { snapshot: string }).snapshot, 'a ref keeps the copy alive');
    assert.equal(f.git(['stash', 'list']), before.stash, 'a copy is not a stash'); assert.equal(f.git(['diff', '--cached']), before.cached, 'making it leaves the index alone');
    assert.equal(await read(f, 'a.ts'), 'two\n', 'and the files as they are');

    await f.gitService.discard(preview);
    assert.equal(await read(f, 'a.ts'), 'one\n'); assert.equal(await read(f, 'b.ts'), 'bee2\n'); assert.equal(await read(f, 'c.ts'), 'see\n');

    await f.gitService.restoreFromSource(await f.gitService.preview(f.id, [...(entry as { paths: readonly string[] }).paths]), (entry as { snapshot: string }).snapshot);
    assert.equal(await read(f, 'a.ts'), 'two\n', 'the unstaged edit is back'); assert.equal(await read(f, 'b.ts'), 'bee3\n', 'so is the edit made after staging');
    await assert.rejects(readFile(path.join(f.root, 'c.ts')), /ENOENT/, 'and the deleted file is deleted again');
    assert.equal(f.git(['diff', '--cached']), before.cached, 'the staged change was never touched'); assert.equal(f.git(['rev-parse', 'HEAD']), before.head); assert.equal(f.git(['stash', 'list']), before.stash);
    assert.equal(await read(f, 'new.txt'), 'untracked\n', 'an untracked file is not part of any of this');

    await undo.remove(f.id, f.root, entry.id);
    assert.equal(undo.list(f.id).length, 0); assert.throws(() => f.git(['rev-parse', '--verify', '--quiet', `refs/gitpro/undo/${entry.id}`]), 'the ref is let go with the copy');
  } finally { await f.close(); }
});

test('with nothing to copy, a discard has no copy and the save says so', async () => {
  const f = await advancedFixture();
  try {
    await f.commit('a.ts', 'one\n', 'a');
    const undo = new UndoService(gitUndoBackend(f.gitService), new Memory());
    await assert.rejects(undo.save(f.id, f.root, { kind: 'discard', label: 'Discarded a.ts', paths: ['a.ts'] }), UndoUnavailable);
    assert.equal(f.git(['for-each-ref', 'refs/gitpro']).trim(), '', 'no ref was made'); assert.deepEqual(undo.list(f.id), []);
  } finally { await f.close(); }
});

test('a hard reset is undone: HEAD goes back and the saved changes are applied again, even when they were never staged', async () => {
  const f = await advancedFixture();
  try {
    const first = await f.commit('a.ts', 'one\n', 'first'), second = await f.commit('a.ts', 'two\n', 'second');
    const undo = new UndoService(gitUndoBackend(f.gitService), new Memory());
    await writeFile(path.join(f.root, 'a.ts'), 'three\n'); await writeFile(path.join(f.root, 'b.ts'), 'bee\n'); f.git(['add', 'b.ts']);
    const entry = await undo.save(f.id, f.root, { kind: 'reset', label: 'Hard reset', head: second, branch: 'main' });
    assert.equal((entry as { snapshot?: string }).snapshot !== undefined, true);
    f.git(['reset', '--hard', first]);
    assert.equal(await read(f, 'a.ts'), 'one\n'); assert.equal(f.git(['status', '--porcelain']).trim(), '');
    // The undo: HEAD back to where it was (the reset the user reviews), then the saved changes.
    f.git(['reset', '--hard', (entry as { head: string }).head]); await f.gitService.applySafetyCopy(f.id, (entry as { snapshot: string }).snapshot);
    assert.equal(f.git(['rev-parse', 'HEAD']).trim(), second); assert.equal(await read(f, 'a.ts'), 'three\n'); assert.equal(await read(f, 'b.ts'), 'bee\n');
    assert.equal(f.git(['stash', 'list']), '', 'nothing was stashed or left in the stash list');
    // The copy keeps HEAD alive too: with the branch moved away and the reflog expired, the commit is still there.
    f.git(['reset', '--hard', first]); f.git(['reflog', 'expire', '--expire=now', '--all']); f.git(['gc', '--prune=now', '-q']);
    assert.equal(f.git(['cat-file', '-t', second]).trim(), 'commit'); assert.equal(f.git(['cat-file', '-t', (entry as { snapshot: string }).snapshot]).trim(), 'commit');
    // Nothing differs from HEAD: only HEAD is kept, and the save does not fail.
    f.git(['reset', '--hard', second]);
    const bare = await undo.save(f.id, f.root, { kind: 'reset', label: 'Hard reset', head: second });
    assert.equal((bare as { snapshot?: string }).snapshot, undefined); assert.equal(f.git(['rev-parse', `refs/gitpro/undo/${bare.id}`]).trim(), second);
  } finally { await f.close(); }
});

test('a force push is undone by a lease push of the old commit, which the copy kept alive after a garbage collection', async () => {
  const f = await advancedFixture();
  try {
    await f.commit('file.txt', 'base\n', 'root'); const remote = path.join(f.parent, 'remote.git'); await mkdir(remote); f.git(['init', '--bare'], remote); f.git(['remote', 'add', 'origin', remote]); f.git(['push', '-u', 'origin', 'main']);
    const old = f.git(['rev-parse', 'HEAD']).trim(), undo = new UndoService(gitUndoBackend(f.gitService), new Memory()), leases = new LeaseService(f.advanced);
    f.git(['commit', '--amend', '-m', 'rewritten']); const rewritten = f.git(['rev-parse', 'HEAD']).trim();
    const preview = await leases.preview(f.id, 'origin', 'main'); assert.equal(preview.expected, old);
    assert.equal(await undo.holds(f.root, preview.expected), true, 'the old commit is in this repository');
    const entry = await undo.save(f.id, f.root, { kind: 'push', label: 'Force pushed main to origin', remote: 'origin', url: preview.url, branch: 'main', oldTip: preview.expected, newTip: preview.source });
    await leases.push(preview); assert.equal(f.git(['rev-parse', 'refs/heads/main'], remote).trim(), rewritten);
    f.git(['reflog', 'expire', '--expire=now', '--all']); f.git(['update-ref', '-d', 'refs/remotes/origin/main']); f.git(['gc', '--prune=now', '-q']);
    assert.equal(f.git(['cat-file', '-t', old]).trim(), 'commit', 'only the copy keeps the old tip');
    // The undo: the same lease push, with the old commit as the replacement.
    const restore = await leases.preview(f.id, 'origin', 'main', (entry as { oldTip: string }).oldTip);
    assert.equal(restore.expected, rewritten); assert.equal(restore.source, old); assert.equal(restore.url, (entry as { url: string }).url);
    await leases.push(restore); assert.equal(f.git(['rev-parse', 'refs/heads/main'], remote).trim(), old, 'the remote branch is where it was');
    // Somebody pushed in between: the lease refuses, as for any force push.
    f.git(['commit', '--amend', '-m', 'again']); const again = await leases.preview(f.id, 'origin', 'main'); await leases.push(again);
    const outsider = path.join(f.parent, 'other'); f.git(['clone', '--branch', 'main', remote, outsider], f.parent); f.git(['config', 'commit.gpgsign', 'false'], outsider); f.git(['commit', '--allow-empty', '-m', 'someone else'], outsider); f.git(['push', 'origin', 'main'], outsider);
    const stale = await leases.preview(f.id, 'origin', 'main', old); f.git(['commit', '--allow-empty', '-m', 'someone else again'], outsider); f.git(['push', 'origin', 'main'], outsider);
    await assert.rejects(leases.push(stale)); assert.notEqual(f.git(['rev-parse', 'refs/heads/main'], remote).trim(), old);
    // A commit this repository does not have cannot be the replacement, and an old tip that is not here cannot be kept.
    await assert.rejects(leases.preview(f.id, 'origin', 'main', 'f'.repeat(40)));
    await assert.rejects(undo.save(f.id, f.root, { kind: 'push', label: 'x', remote: 'origin', url: preview.url, branch: 'main', oldTip: 'f'.repeat(40), newTip: old }), UndoUnavailable);
    await assert.rejects(leases.preview(f.id, 'origin', 'main', 'main'), /Invalid full object ID/);
  } finally { await f.close(); }
});
