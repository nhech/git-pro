import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { atLeast, minimumGit, parseGitVersion, readGitVersion, worktreeListZ } from '../../src/git/git-version';
import { parseWorktrees } from '../../src/git/tools/tools-parser';
import { GitExecutor } from '../../src/git/git-executor';
import { PathPolicy } from '../../src/security/paths';
import { silentLogger } from '../../src/utils/logging';
import { fixture, gitExecutable } from '../fixtures/repository-fixture';

test('Git versions are read from the forms real builds print', () => {
  for (const [output, expected] of [['git version 2.39.5\n', '2.39.5'], ['git version 2.36.0.windows.1\n', '2.36.0'], ['git version 2.39.5 (Apple Git-154)\n', '2.39.5'], ['git version 2.30\n', '2.30'], ['git version 2.45.0.rc1\n', '2.45.0']] as const) {
    assert.equal(parseGitVersion(output)?.text, expected, output);
  }
  for (const garbage of ['', 'hello', 'git version', 'git version x.y', 'something git version 2.39.5']) assert.equal(parseGitVersion(garbage), undefined, garbage);
});

test('the minimum is Git 2.32 and worktree list -z starts at 2.36', () => {
  const version = (text: string) => parseGitVersion(`git version ${text}`)!;
  assert.deepEqual({ ...minimumGit }, { major: 2, minor: 32 });
  assert.equal(atLeast(version('2.30.2'), minimumGit), false, 'Debian 11: no locked or prunable worktrees, no stash show --include-untracked');
  assert.equal(atLeast(version('2.31.8'), minimumGit), false);
  assert.equal(atLeast(version('2.32.0'), minimumGit), true);
  assert.equal(atLeast(version('3.0.0'), minimumGit), true, 'a later major is newer whatever its minor');
  assert.equal(atLeast(version('2.35.9'), worktreeListZ), false);
  assert.equal(atLeast(version('2.36.0'), worktreeListZ), true);
});

test('an executable that cannot run has no version, so it is never mistaken for an old one', async () => {
  assert.equal(await readGitVersion('/definitely/not/a/git/binary'), undefined);
});

test('worktree records parse the same from -z output and from the newline form of Git before 2.36', () => {
  const records = ['worktree /repo', 'HEAD ' + 'a'.repeat(40), 'branch refs/heads/main', '', 'worktree /repo linked', 'HEAD ' + 'b'.repeat(40), 'detached', 'locked in use', ''];
  const modern = parseWorktrees(Buffer.from(records.join('\0') + '\0'));
  const legacy = parseWorktrees(Buffer.from(records.join('\n') + '\n'));
  assert.deepEqual(legacy, modern);
  assert.deepEqual(legacy.map(item => [item.path, item.locked]), [['/repo', false], ['/repo linked', true]], 'a space in the path is data');
  assert.deepEqual(parseWorktrees(Buffer.alloc(0)), []);
  // Without -z a path holding a newline cannot be told from the next field, so it is refused rather than misread.
  assert.throws(() => parseWorktrees(Buffer.from('worktree /odd\nname\nHEAD ' + 'a'.repeat(40) + '\nbranch refs/heads/x\n\n')), /Unsupported/);
  assert.throws(() => parseWorktrees(Buffer.from('worktree /cut\nHEAD ' + 'a'.repeat(40))), /Truncated/);
});

/** A Git process that prints `stdout` and exits. */
function printing(stdout: string): ChildProcess {
  const child = new EventEmitter() as ChildProcess, out = new PassThrough(), err = new PassThrough();
  Object.assign(child, { stdout: out, stderr: err, stdin: null, pid: undefined });
  setImmediate(() => { out.end(stdout); err.end(); setImmediate(() => child.emit('close', 0)); });
  return child;
}

test('the executor asks for -z only when Git is 2.36 or newer, and asks for the version once', async () => {
  for (const [versionText, expectZ] of [['2.34.1', false], ['2.36.0', true], ['2.39.5', true], ['unrecognized output', true]] as const) {
    const f = await fixture(), argvs: string[][] = [];
    const executor = new GitExecutor(gitExecutable, new PathPolicy(() => [f.root], () => true), silentLogger, (_file, args) => {
      argvs.push([...args]); return printing(args.includes('--version') ? (versionText === 'unrecognized output' ? versionText : `git version ${versionText}`) + '\n' : '');
    }, f.env);
    try {
      await executor.read(f.root, { kind: 'worktrees' }); await executor.read(f.root, { kind: 'worktrees' });
      const listings = argvs.filter(args => args.includes('worktree'));
      assert.equal(listings.length, 2);
      for (const args of listings) assert.equal(args.includes('-z'), expectZ, `${versionText}: ${args.join(' ')}`);
      const asked = argvs.filter(args => args.includes('--version')).length;
      assert.equal(asked, versionText === 'unrecognized output' ? 2 : 1, 'a known version is cached; an unreadable one is asked again next time');
    } finally { await f.cleanup(); }
  }
});
