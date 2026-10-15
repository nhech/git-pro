import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { refuseGitMetadata } from '../../src/security/paths';

test('Git metadata is refused by name, through a link into the repository or into an unregistered nested repository, and only for real aliases of .git', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'git-pro-metadata-')));
  try {
    const repo = { root, gitDir: path.join(root, '.git'), commonDir: path.join(root, '.git') };
    await mkdir(path.join(root, '.git'), { recursive: true }); await writeFile(path.join(root, '.git', 'config'), '[core]\n');
    await mkdir(path.join(root, 'nested', '.git'), { recursive: true }); await writeFile(path.join(root, 'nested', '.git', 'config'), '[core]\n');
    for (const folder of ['.git.bak', '.git.orig', '.github', '.gitignore-folder', 'docs']) { await mkdir(path.join(root, folder)); await writeFile(path.join(root, folder, 'file'), 'x\n'); }
    const check = (relative: string) => refuseGitMetadata(repo, relative, path.join(root, ...relative.split('/')));
    // Names Windows resolves to .git are refused; names that merely start with ".git" are ordinary folders (the old pattern refused every one of these).
    for (const name of ['.git/config', '.GIT/config', '.git /config', '.git./config', '.git::$INDEX_ALLOCATION/config']) await assert.rejects(check(name), /Git metadata/, name);
    for (const name of ['.git.bak/file', '.git.orig/file', '.github/file', '.gitignore-folder/file', 'docs/file']) assert.equal(await check(name), path.join(root, ...name.split('/')), `${name} is an ordinary file`);
    // A repository nested in this one is not registered, so it is no gitDir of ours, but its .git is metadata all the same.
    await assert.rejects(check('nested/.git/config'), /Git metadata/);
    let linked = true; try { await symlink(path.join(root, 'nested', '.git'), path.join(root, 'link'), 'junction'); } catch { linked = false; }
    if (linked) await assert.rejects(check('link/config'), /Git metadata/, 'a link into a nested .git leads to metadata, whatever the link is called');
  } finally { await rm(root, { recursive: true, force: true }); }
});
