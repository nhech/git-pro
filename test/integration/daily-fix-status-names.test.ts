import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitExecutable } from '../fixtures/repository-fixture';
import { dailyFixture, options } from '../fixtures/daily-fixture';

/** `f\xe9.txt`: Latin-1 bytes, not UTF-8. Linux file systems keep such names; Windows and macOS translate or refuse them. */
const latin1Name = Buffer.from([0x66, 0xe9, 0x2e, 0x74, 0x78, 0x74]);

test('a file name that is not UTF-8 leaves the rest of the repository usable: status, stage, review and commit', async (t) => {
  const f = await dailyFixture();
  try {
    await writeFile(path.join(f.root, 'a.txt'), 'a\n'); await f.git.stage(f.id, ['a.txt']); await f.git.commit(await f.git.preview(f.id), 'base', options);
    try { writeFileSync(Buffer.concat([Buffer.from(`${f.root}${path.sep}`), latin1Name]), 'latin1 name\n'); } catch { t.skip('this file system refuses names that are not UTF-8'); return; }
    const raw = spawnSync(gitExecutable, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], { cwd: f.root, env: f.env, windowsHide: true }).stdout;
    if (!raw.includes(Buffer.concat([Buffer.from('? '), latin1Name]))) { t.skip('this file system stored the name as UTF-8'); return; }
    await writeFile(path.join(f.root, 'a.txt'), 'a2\n');

    const registry = f.git.registry;
    await registry.refresh(f.id);
    assert.equal(registry.errors.get(f.id), undefined, 'one such name no longer disables the repository');
    const shown = registry.store.get(f.id)!;
    assert.deepEqual(shown.changes, [{ path: 'a.txt', status: 'M', group: 'working' }]);
    assert.deepEqual(shown.omitted, [{ group: 'untracked', status: '?' }], 'the entry is set aside, not renamed');

    await f.git.stage(f.id, ['a.txt']);
    const before = await f.git.preview(f.id);
    assert.deepEqual(before.status.changes.map(change => `${change.group}:${change.path}`), ['staged:a.txt']);
    // Staged outside Git Pro, the file is still part of the reviewed index: a commit reviewed before that is stale.
    f.rawGit(['add', '-A']);
    const after = await f.git.preview(f.id);
    assert.notEqual(after.index, before.index); assert.deepEqual(after.status.omitted, [{ status: 'A', group: 'staged' }]);
    await assert.rejects(f.git.commit(before, 'stale', options), /changed/);
    await f.git.commit(after, 'both', options);
    assert.equal(f.rawGit(['status', '--porcelain']), '');
    assert.ok(spawnSync(gitExecutable, ['ls-files', '-z'], { cwd: f.root, env: f.env, windowsHide: true }).stdout.equals(Buffer.concat([Buffer.from('a.txt\0'), latin1Name, Buffer.from('\0')])));
  } finally { await f.close(); }
});
