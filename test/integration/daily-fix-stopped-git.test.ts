import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fixture, gitExecutable } from '../fixtures/repository-fixture';
import { GitExecutor } from '../../src/git/git-executor';
import { GitFailure } from '../../src/git/git-error-parser';
import { PathPolicy } from '../../src/security/paths';
import { recoveryFor } from '../../src/utils/recovery';
import { silentLogger } from '../../src/utils/logging';

/** A pre-commit hook that never finishes on its own: its `sleep` is a separate process (under MSYS2 on Windows, outside Git's Windows process tree). */
const hook = '#!/bin/sh\nsleep 40 &\necho $! > .git/hook-sleep.pid\nif [ -r /proc/$!/winpid ]; then cat /proc/$!/winpid > .git/hook-sleep.pid; fi\nwait\n';
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function gone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 50 && alive(pid); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  return !alive(pid);
}

test('a timed-out commit stops its hook too; a lock it leaves is named with what to do, and never removed by Git Pro', async () => {
  const f = await fixture(), executor = new GitExecutor(gitExecutable, new PathPolicy(() => [f.parent], () => true), silentLogger, undefined, f.env);
  const lock = path.join(f.root, '.git', 'index.lock');
  try {
    await writeFile(path.join(f.root, 'a.txt'), 'a\n'); f.git(['add', 'a.txt']); f.git(['commit', '-m', 'a']);
    await writeFile(path.join(f.root, '.git', 'hooks', 'pre-commit'), hook, { mode: 0o755 });
    await writeFile(path.join(f.root, 'a.txt'), 'b\n');
    const started = Date.now();
    const failure = await executor.mutate(f.root, { kind: 'commitFile', paths: ['a.txt'], message: 'never' }, { timeoutMs: 2_000 }).then(() => undefined, (error: unknown) => error);
    assert.ok(failure instanceof GitFailure && failure.kind === 'timeout', String(failure));
    assert.ok(Date.now() - started < 10_000, 'the timeout does not wait for the hook');
    const sleeper = Number((await readFile(path.join(f.root, '.git', 'hook-sleep.pid'), 'utf8')).trim());
    assert.ok(sleeper > 0 && await gone(sleeper), 'the hook\'s own child process is stopped with Git');
    if (process.platform !== 'win32') {
      // SIGTERM lets Git remove its own lock, so the next action simply works.
      assert.equal(existsSync(lock), false); assert.equal(failure.lockFile, undefined); assert.doesNotMatch(recoveryFor(failure).message, /lock file/);
      await executor.mutate(f.root, { kind: 'stage', paths: ['a.txt'] });
      return;
    }
    // Windows can only force-kill, so Git leaves its lock: the error says that Git Pro stopped Git, names the file, and leaves removing it to the user.
    assert.ok(existsSync(lock)); assert.equal(failure.lockFile, lock); assert.ok(failure.message.includes(lock));
    const timedOut = recoveryFor(failure).message;
    assert.match(timedOut, /^Git operation timed out\.\nGit Pro stopped the Git process, and it left the lock file /); assert.ok(timedOut.includes(lock));
    assert.match(timedOut, /Check that no Git process is still running, then delete that file yourself\. Git Pro will not remove lock files\./); assert.match(timedOut, /state may have changed/);
    const next = await executor.mutate(f.root, { kind: 'stage', paths: ['a.txt'] }).then(() => undefined, (error: unknown) => error);
    assert.ok(next instanceof GitFailure && next.kind === 'locked', String(next));
    for (const error of [next, Object.assign(new Error('Failed to execute git'), { stderr: next.message, exitCode: 128 })]) {
      const shown = recoveryFor(error).message;
      assert.doesNotMatch(shown, /busy with another operation/); assert.ok(shown.startsWith(`A Git process that Git Pro stopped earlier left the lock file ${lock}.`), shown);
      assert.match(shown, /delete that file yourself/); assert.ok(existsSync(lock), 'Git Pro never removes the lock');
    }
    // Once the user removed it, a lock that another process takes later is a different file and keeps Git's "another operation" reading.
    await rm(lock); await writeFile(lock, '');
    const other = await executor.mutate(f.root, { kind: 'stage', paths: ['a.txt'] }).then(() => undefined, (error: unknown) => error);
    assert.ok(other instanceof GitFailure && other.kind === 'locked'); assert.match(recoveryFor(other).message, /^Git is busy with another operation\./);
  } finally { executor.dispose(); await rm(lock, { force: true }); await f.cleanup(); }
});

test('POSIX: a stopped Git process group gets SIGTERM first and SIGKILL only after a grace period', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture(), marker = path.join(f.parent, 'terminated');
  let pid: number | undefined;
  // Ignores SIGTERM (records it) like a stuck hook would; only SIGKILL ends it.
  const executor = new GitExecutor(gitExecutable, new PathPolicy(() => [f.root], () => true), silentLogger, () => {
    const child = spawn(process.execPath, ['-e', `process.on('SIGTERM',()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'TERM'));setInterval(()=>{},1000)`], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    pid = child.pid; return child;
  });
  try {
    const started = Date.now();
    await assert.rejects(executor.read(f.root, { kind: 'status' }, { timeoutMs: 300 }), (error: unknown) => error instanceof GitFailure && error.kind === 'timeout');
    const elapsed = Date.now() - started;
    assert.ok(existsSync(marker), 'SIGTERM came first'); assert.ok(elapsed >= 2_000, `SIGKILL waited for the grace period (${elapsed}ms)`); assert.ok(elapsed < 8_000);
    assert.ok(pid && !alive(pid));
  } finally { executor.dispose(); await f.cleanup(); }
});
