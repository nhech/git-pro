import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { advancedFixture } from '../fixtures/advanced-fixture';
import { gitExecutable } from '../fixtures/repository-fixture';

// macOS file systems refuse a name that is not valid UTF-8 ("Illegal byte sequence"), so there the merge cannot check such a file out; the preview only reads names from Git.
const holdsAnyName = process.platform === 'linux';

test('previewing a merge of a branch with a path that is not UTF-8 lists no files instead of failing, and the merge itself still works', async () => {
  const f = await advancedFixture();
  try {
    const base = await f.commit('a.txt', 'a\n', 'base');
    const run = (args: string[], input?: Buffer | string) => { const result = spawnSync(gitExecutable, args, { cwd: f.root, env: f.env, input, windowsHide: true }); if (result.status) throw new Error(`${args[0]} ${result.stderr}`); return result.stdout.toString('utf8').trim(); };
    // `caf\xe9.txt` (Latin-1) cannot be written on every file system, so the commit is built from a tree.
    const blob = run(['hash-object', '-w', '--stdin'], 'x\n'), kept = run(['rev-parse', 'HEAD:a.txt']);
    const tree = run(['mktree', '-z'], Buffer.concat([Buffer.from(`100644 blob ${kept}\ta.txt\x00100644 blob ${blob}\tcaf`), Buffer.from([0xe9]), Buffer.from('.txt\0')]));
    const latin = run(['commit-tree', tree, '-p', base, '-m', 'latin1 name']); f.git(['branch', 'latin', latin]);
    const preview = await f.advanced.preview(f.id, { kind: 'merge', oid: latin, strategy: 'ff', source: 'refs/heads/latin' });
    assert.deepEqual(preview.files, []); assert.equal(preview.filesNote, 'nonUtf8Path');
    if (process.platform === 'darwin') return;
    await f.advanced.execute(preview);
    assert.equal(f.git(['rev-parse', 'HEAD']).trim(), latin, 'the merge went ahead; only the list of files was withheld');
  } finally { await f.close(); }
});

test('an edit to a file whose name is not UTF-8 is part of the fingerprint, so a hard reset reviewed before it is refused', { skip: holdsAnyName ? false : 'this file system cannot hold a file name that is not UTF-8 (Windows and macOS)' }, async () => {
  const f = await advancedFixture();
  try {
    const head = await f.commit('a.txt', 'a\n', 'base');
    const raw = Buffer.concat([Buffer.from(f.root + path.sep), Buffer.from('f'), Buffer.from([0xff]), Buffer.from('.txt')]);
    await writeFile(raw, 'v1\n'); f.git(['add', '-A']); f.git(['commit', '-m', 'raw name']);
    await writeFile(raw, 'v2\n');
    const preview = await f.advanced.preview(f.id, { kind: 'reset', oid: head, mode: 'hard' });
    await writeFile(raw, 'v3\n');
    await assert.rejects(f.advanced.execute(preview), /changed/, 'the edit made after the review is not silently discarded');
    assert.equal(await readFile(raw, 'utf8'), 'v3\n');
  } finally { await f.close(); }
});
