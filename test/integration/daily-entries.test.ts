import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, readlink, symlink, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { DailyError } from '../../src/git/git.service';
import { dailyFixture, options } from '../fixtures/daily-fixture';

test('a file added with git add -N cannot be discarded (it would be emptied) and folder discards leave it out', async () => {
  const f = await dailyFixture();
  try {
    await writeFile(path.join(f.root, 'base.txt'), 'base\n'); await f.git.stage(f.id, ['base.txt']); await f.git.commit(await f.git.preview(f.id), 'base', options);
    await writeFile(path.join(f.root, 'base.txt'), 'edited\n'); await writeFile(path.join(f.root, 'ita.txt'), 'precious content\n'); f.rawGit(['add', '-N', 'ita.txt']);
    const placeholder = (await f.git.state(f.id)).changes.find(change => change.path === 'ita.txt')!;
    assert.deepEqual([placeholder.group, placeholder.status], ['working', 'A'], 'Git reports it as a working-tree addition, the way the Changes view sees it');
    assert.deepEqual(await f.git.discardable(f.id, ['base.txt', 'ita.txt']), { targets: ['base.txt'], skipped: ['ita.txt'] });
    await assert.rejects(f.git.discard(await f.git.preview(f.id, ['ita.txt'])), /git add -N/);
    await assert.rejects(f.git.discard(await f.git.preview(f.id, ['base.txt', 'ita.txt'])), /git add -N/, 'the service refuses it even if a caller did not filter');
    assert.equal(await readFile(path.join(f.root, 'ita.txt'), 'utf8'), 'precious content\n', 'nothing was emptied');
    await f.git.discard(await f.git.preview(f.id, ['base.txt']));
    assert.equal(await readFile(path.join(f.root, 'base.txt'), 'utf8'), 'base\n'); assert.equal(await readFile(path.join(f.root, 'ita.txt'), 'utf8'), 'precious content\n');
  } finally { await f.close(); }
});

test('unstaging a copy keeps its source staged', async () => {
  const f = await dailyFixture();
  try {
    const body = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n') + '\n';
    await writeFile(path.join(f.root, 'a.txt'), body); await f.git.stage(f.id, ['a.txt']); await f.git.commit(await f.git.preview(f.id), 'base', options);
    f.rawGit(['config', 'status.renames', 'copies']);
    await writeFile(path.join(f.root, 'a.txt'), body + 'more\n'); await writeFile(path.join(f.root, 'b.txt'), body);
    await f.git.stage(f.id, ['a.txt', 'b.txt']);
    const copy = (await f.git.state(f.id)).changes.find(change => change.path === 'b.txt' && change.group === 'staged')!;
    assert.equal(copy.status, 'C', 'the fixture really produces a copy'); assert.equal(copy.originalPath, 'a.txt');
    await f.git.unstage(f.id, ['b.txt']);
    assert.deepEqual((await f.git.state(f.id)).changes.filter(change => change.group === 'staged').map(change => change.path), ['a.txt'], 'a.txt was not part of the selection, so it stays staged');
  } finally { await f.close(); }
});

test('a rename is still unstaged on both sides', async () => {
  const f = await dailyFixture();
  try {
    await writeFile(path.join(f.root, 'before.txt'), 'base\n'); await f.git.stage(f.id, ['before.txt']); await f.git.commit(await f.git.preview(f.id), 'base', options);
    const { rename } = await import('node:fs/promises'); await rename(path.join(f.root, 'before.txt'), path.join(f.root, 'after.txt'));
    await f.git.stage(f.id, ['before.txt', 'after.txt']);
    assert.equal((await f.git.state(f.id)).changes.find(change => change.path === 'after.txt' && change.group === 'staged')!.status, 'R');
    await f.git.unstage(f.id, ['after.txt']);
    assert.deepEqual((await f.git.state(f.id)).changes.filter(change => change.group === 'staged'), []);
  } finally { await f.close(); }
});

test('a symlink is an entry that stages and unstages without being followed', async () => {
  const f = await dailyFixture();
  try {
    await writeFile(path.join(f.root, 'base.txt'), 'base\n'); await f.git.stage(f.id, ['base.txt']); await f.git.commit(await f.git.preview(f.id), 'base', options);
    await mkdir(path.join(f.root, 'dir'));
    // A link to a folder and one to a file that really exists outside the repository (a dangling target would not exercise the link check): Git records only the link text for either.
    await writeFile(path.join(f.parent, 'outside-file.txt'), 'outside\n'); await writeFile(path.join(f.parent, 'outside-other.txt'), 'other\n');
    try { await symlink('dir', path.join(f.root, 'dirlink'), 'dir'); await symlink('../outside-file.txt', path.join(f.root, 'outlink')); }
    catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) return; throw error; }
    assert.ok((await lstat(path.join(f.root, 'dirlink'))).isSymbolicLink());
    await f.git.stage(f.id, ['dirlink', 'outlink']);
    assert.deepEqual(f.rawGit(['ls-files', '-s', '--', 'dirlink', 'outlink']).split('\n').filter(Boolean).map(line => line.split(/\s/)[0]), ['120000', '120000'], 'both are recorded as links');
    await f.git.unstage(f.id, ['dirlink', 'outlink']);
    assert.equal(f.rawGit(['ls-files', '--', 'dirlink', 'outlink']).trim(), '');
    assert.equal(await f.git.stageAll(f.id), 2, 'Stage All counts both links instead of failing on them');
    assert.equal((await f.git.state(f.id)).changes.filter(change => change.group === 'staged').length, 2);
    await assert.rejects(f.git.stage(f.id, ['dir/../../outside']), /path|outside/i, 'a path through a parent folder is still refused');
    // Unstage All, commit and Discard go through the same entry rule: a link whose target exists outside the repository is still just a link.
    assert.equal(await f.git.unstageAll(f.id), 2, 'Unstage All is not defeated by the link that leads outside');
    assert.equal(f.rawGit(['ls-files', '--', 'dirlink', 'outlink']).trim(), '');
    await f.git.stageAll(f.id); await f.git.commit(await f.git.preview(f.id), 'links', options);
    await unlink(path.join(f.root, 'outlink')); await symlink('../outside-other.txt', path.join(f.root, 'outlink'));
    await f.git.discard(await f.git.preview(f.id, ['outlink']));
    // Where Git is not allowed to make links (core.symlinks=false, the Windows default) it writes the link text into a plain file instead.
    const restored = await readlink(path.join(f.root, 'outlink')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'EINVAL') return readFile(path.join(f.root, 'outlink'), 'utf8'); throw error; });
    assert.equal(restored.trim(), '../outside-file.txt', 'Discard put the committed link back; the file outside was never touched');
    assert.equal(await readFile(path.join(f.parent, 'outside-file.txt'), 'utf8'), 'outside\n'); assert.equal(await readFile(path.join(f.parent, 'outside-other.txt'), 'utf8'), 'other\n');
  } finally { await f.close(); }
});

test('a repository Git does not track yet is not staged as an embedded repository, by Stage or by Stage All', async () => {
  const f = await dailyFixture();
  try {
    await writeFile(path.join(f.root, 'base.txt'), 'base\n'); await f.git.stage(f.id, ['base.txt']); await f.git.commit(await f.git.preview(f.id), 'base', options);
    await writeFile(path.join(f.root, 'base.txt'), 'edited\n');
    const nested = path.join(f.root, 'tools', 'lib'); await mkdir(nested, { recursive: true });
    f.rawGit(['init', '-b', 'main'], nested); await writeFile(path.join(nested, 'a.txt'), 'a\n'); f.rawGit(['add', 'a.txt'], nested); f.rawGit(['commit', '-m', 'nested'], nested);
    const listed = (await f.git.state(f.id)).changes.find(change => change.path.startsWith('tools/'));
    assert.equal(listed?.path, 'tools/lib/', 'Git lists an untracked repository as a directory with a trailing slash');
    await assert.rejects(f.git.stage(f.id, ['tools/lib/']), /does not track yet/);
    assert.equal(await f.git.stageAll(f.id), 1, 'Stage All stages the edited file and leaves the repository out');
    assert.equal(f.rawGit(['ls-files', '-s', '--', 'tools']).trim(), '', 'no gitlink was created');
    assert.deepEqual((await f.git.state(f.id)).changes.filter(change => change.group === 'staged').map(change => change.path), ['base.txt']);
  } finally { await f.close(); }
});

test('a submodule is a single entry: staging and unstaging work, registered or not, and discarding it is refused', async () => {
  const f = await dailyFixture();
  try {
    const source = path.join(f.parent, 'sub-source'); await mkdir(source);
    f.rawGit(['init', '-b', 'main'], source); await writeFile(path.join(source, 'lib.txt'), 'lib\n'); f.rawGit(['add', 'lib.txt'], source); f.rawGit(['commit', '-m', 'lib'], source);
    await writeFile(path.join(f.root, 'base.txt'), 'base\n'); await f.git.stage(f.id, ['base.txt']); await f.git.commit(await f.git.preview(f.id), 'base', options);
    f.rawGit(['-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'vendor']); f.rawGit(['commit', '-m', 'add submodule']);
    const inside = path.join(f.root, 'vendor');
    f.rawGit(['commit', '--allow-empty', '-m', 'newer'], inside);
    assert.ok((await f.git.state(f.id)).changes.some(change => change.path === 'vendor' && change.group === 'working'), 'the moved submodule is a working-tree change');
    await f.git.stage(f.id, ['vendor']);
    assert.ok((await f.git.state(f.id)).changes.some(change => change.path === 'vendor' && change.group === 'staged'));
    await f.git.unstage(f.id, ['vendor']);
    // VS Code opens submodules as repositories of their own; its root must still be an entry of this one.
    await f.git.registry.sync([f.root, inside].map(root => ({ root, onDidChange: () => ({ dispose() {} }) })));
    assert.equal(await f.git.stageAll(f.id), 1);
    await assert.rejects(f.git.stage(f.id, ['vendor/lib.txt']), /nested repositories/, 'files inside it still belong to the submodule');
    await f.git.unstage(f.id, ['vendor']);
    await assert.rejects(f.git.preview(f.id, ['vendor']), /submodule or nested repository/, 'Discard has nothing to restore in a submodule');
  } finally { await f.close(); }
});

test('amend with nothing staged changes only the message; a plain commit with nothing staged is still refused', async () => {
  const f = await dailyFixture();
  try {
    await writeFile(path.join(f.root, 'base.txt'), 'base\n'); await f.git.stage(f.id, ['base.txt']); await f.git.commit(await f.git.preview(f.id), 'first message', options);
    const count = f.rawGit(['rev-list', '--count', 'HEAD']), tree = f.rawGit(['rev-parse', 'HEAD^{tree}']);
    await assert.rejects(f.git.commit(await f.git.preview(f.id), 'again', options), (error: unknown) => error instanceof DailyError && error.code === 'empty-index');
    await f.git.commit(await f.git.preview(f.id), 'better message', { ...options, amend: true });
    assert.equal(f.rawGit(['log', '-1', '--format=%s']).trim(), 'better message');
    assert.equal(f.rawGit(['rev-list', '--count', 'HEAD']), count, 'the last commit was rewritten, not followed'); assert.equal(f.rawGit(['rev-parse', 'HEAD^{tree}']), tree, 'content is unchanged');
  } finally { await f.close(); }
});

test('amending in a repository with no commits says there is nothing to amend', async () => {
  const f = await dailyFixture();
  try {
    await assert.rejects(f.git.commit(await f.git.preview(f.id), 'x', { ...options, amend: true }), /no commit to amend/i);
  } finally { await f.close(); }
});
