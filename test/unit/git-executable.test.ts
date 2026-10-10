import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { mkdir, writeFile, chmod, realpath, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolveGitExecutable } from '../../src/git/git-executable';
import { fixture, gitExecutable } from '../fixtures/repository-fixture';

test('public Git bare name resolves to a machine executable and absolute configured Git remains usable', async () => {
  const executable = await realpath(gitExecutable);
  assert.equal(await resolveGitExecutable(gitExecutable, [], { PATH: '' }), executable);
  const discovered = await resolveGitExecutable('git', [], { PATH: path.dirname(gitExecutable) });
  assert.equal(discovered, executable);
  const version = spawnSync(discovered, ['--version'], { encoding: 'utf8', shell: false, windowsHide: true });
  assert.equal(version.status, 0); assert.match(version.stdout, /^git version /);
});

test('Git discovery rejects wrappers, arbitrary names, relative or empty PATH entries and oversized input', async () => {
  const env = { PATH: path.dirname(gitExecutable) };
  for (const name of ['git --version', './git', 'other-git', 'git\0', 'git\n', path.resolve('git.cmd'), path.resolve('git.bat'), path.resolve('git.ps1'), 'g'.repeat(32769)]) await assert.rejects(resolveGitExecutable(name, [], env), /absolute native Git path/);
  for (const PATH of ['', '.', `${path.dirname(gitExecutable)}${path.delimiter}`, `.${path.delimiter}${path.dirname(gitExecutable)}`, 'a'.repeat(65537)]) await assert.rejects(resolveGitExecutable('git', [], { PATH }), /absolute native Git path/);
});

test('Git discovery rejects the first workspace executable instead of switching to a later machine Git', async () => {
  const f = await fixture();
  try {
    const bin = path.join(f.root, 'bin'); await mkdir(bin);
    const name = process.platform === 'win32' ? 'git.exe' : 'git';
    const candidate = path.join(bin, name); await writeFile(candidate, 'fixture must never execute'); await chmod(candidate, 0o755);
    await assert.rejects(resolveGitExecutable('git', [f.root], { PATH: `${bin}${path.delimiter}${path.dirname(gitExecutable)}` }), /absolute native Git path/);
    const alias = path.join(f.parent, 'bin-alias'); await symlink(bin, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(resolveGitExecutable('git', [f.root], { PATH: `${alias}${path.delimiter}${path.dirname(gitExecutable)}` }), /absolute native Git path/);
    const machineAlias = path.join(f.root, 'machine-alias'); await symlink(path.dirname(gitExecutable), machineAlias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(resolveGitExecutable('git', [f.root], { PATH: machineAlias }), /absolute native Git path/);
    const workspaceAlias = path.join(f.parent, 'workspace-alias'); await symlink(f.root, workspaceAlias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(resolveGitExecutable('git', [workspaceAlias], { PATH: path.join(workspaceAlias, 'machine-alias') }), /absolute native Git path/);
    assert.equal(await resolveGitExecutable('git', [f.root], { PATH: path.dirname(gitExecutable) }), await realpath(gitExecutable));
  } finally { await f.cleanup(); }
});

test('Git discovery rejects missing files and directories without spawning a fallback locator', async () => {
  const f = await fixture();
  try {
    await assert.rejects(resolveGitExecutable(f.root, [], {}), /absolute native Git path/);
    await assert.rejects(resolveGitExecutable(path.join(f.root, 'missing'), [], {}), /absolute native Git path/);
    await assert.rejects(resolveGitExecutable('git', [], { PATH: f.home }), /absolute native Git path/);
  } finally { await f.cleanup(); }
});
