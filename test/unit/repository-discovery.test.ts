import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { discoverRepositories } from '../../src/repositories/repository-discovery';
import type { PathPolicy } from '../../src/security/paths';

/** A policy that accepts every root except those named by `refuse`, as an unreadable or removed folder would be. */
const policy = (refuse: readonly string[] = []) => ({ authorizeRoot: async (root: string) => { if (refuse.some(name => root.endsWith(name))) throw new Error('EACCES'); return root; } }) as unknown as PathPolicy;

async function tree(layout: readonly string[]): Promise<{ root: string; cleanup(): Promise<void> }> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'git-pro-discovery-')));
  for (const repository of layout) await mkdir(path.join(root, repository, '.git'), { recursive: true });
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('discovery finds repositories down to the requested depth and honours the extra ignored folder names', async () => {
  const t = await tree(['one', 'group/two', 'group/deep/three', 'vendor/four']);
  try {
    const found = (await discoverRepositories([t.root], policy(), { maxDepth: 1 })).map(root => path.relative(t.root, root).replace(/\\/g, '/')).sort();
    assert.deepEqual(found, ['one'], 'depth 1 is the immediate sub-folders only, like the built-in Git default');
    const deeper = (await discoverRepositories([t.root], policy(), { maxDepth: 3 })).map(root => path.relative(t.root, root).replace(/\\/g, '/')).sort();
    assert.deepEqual(deeper, ['group/deep/three', 'group/two', 'one', 'vendor/four']);
    const ignored = (await discoverRepositories([t.root], policy(), { maxDepth: 3, ignoredFolders: ['vendor', 'deep'] })).map(root => path.relative(t.root, root).replace(/\\/g, '/')).sort();
    assert.deepEqual(ignored, ['group/two', 'one'], 'git.repositoryScanIgnoredFolders names are skipped at any depth');
  } finally { await t.cleanup(); }
});

test('one folder that cannot be authorized or read does not stop the scan', async () => {
  const t = await tree(['locked/inner', 'good']);
  try {
    // `locked` is refused by the policy; a second root that does not exist fails in readdir. Both used to reject the whole scan.
    const found = (await discoverRepositories([t.root, path.join(t.root, 'removed-folder')], policy(['locked']), { maxDepth: 3 })).map(root => path.relative(t.root, root).replace(/\\/g, '/')).sort();
    assert.deepEqual(found, ['good'], 'repositories elsewhere are still found, and nothing inside the refused folder is');
  } finally { await t.cleanup(); }
});

test('ignored folder names compare the way the file system does: case-insensitively on Windows and macOS, exactly elsewhere', async () => {
  const t = await tree(['Vendor/one', 'one']);
  try {
    const found = (await discoverRepositories([t.root], policy(), { maxDepth: 3, ignoredFolders: ['vendor'] })).map(root => path.relative(t.root, root).replace(/\\/g, '/')).sort();
    assert.deepEqual(found, process.platform === 'win32' || process.platform === 'darwin' ? ['one'] : ['Vendor/one', 'one']);
  } finally { await t.cleanup(); }
});
