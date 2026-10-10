import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { SafeLogger, type Logger } from '../../src/utils/logging';
import { GitExecutor } from '../../src/git/git-executor';
import { PathPolicy } from '../../src/security/paths';
import { fixture, gitExecutable } from '../fixtures/repository-fixture';

test('log levels separate routine detail from changes and failures', () => {
  const expected: Record<string, string[]> = { off: [], error: ['error'], info: ['info', 'error'], debug: ['debug', 'info', 'error'] };
  for (const [level, lines] of Object.entries(expected)) {
    const written: string[] = []; const logger = new SafeLogger(line => written.push(line), () => level);
    logger.debug('debug'); logger.info('info'); logger.error('error');
    assert.deepEqual(written.map(line => line.replace(/^\[[^\]]+\] /, '')).sort(), [...lines].sort(), level);
  }
});

function fakeGit(exitCode = 0): ChildProcess {
  const child = new EventEmitter() as ChildProcess, out = new PassThrough(), err = new PassThrough();
  Object.assign(child, { stdout: out, stderr: err, stdin: null, pid: undefined });
  setImmediate(() => { out.end(); err.end(); setImmediate(() => child.emit('close', exitCode)); });
  return child;
}

test('successful reads are debug detail while successful mutations and failures stay visible', async () => {
  const f = await fixture(); const lines: string[] = [];
  const logger: Logger = { info: line => lines.push(`info:${line}`), error: line => lines.push(`error:${line}`), debug: line => lines.push(`debug:${line}`) };
  let exitCode = 0;
  const executor = new GitExecutor(gitExecutable, new PathPolicy(() => [f.root], () => true), logger, () => fakeGit(exitCode), f.env);
  try {
    await executor.read(f.root, { kind: 'status' });
    assert.deepEqual(lines.map(line => line.replace(/\d+ms/, 'Nms')), ['debug:STATUS completed Nms']);
    lines.length = 0; await executor.mutate(f.root, { kind: 'stage', paths: ['a.txt'] });
    assert.deepEqual(lines.map(line => line.replace(/\d+ms/, 'Nms')), ['info:STAGE completed Nms']);
    lines.length = 0; exitCode = 128; await assert.rejects(executor.read(f.root, { kind: 'status' }));
    assert.equal(lines.length, 1); assert.match(lines[0]!, /^error:STATUS failed/);
  } finally { executor.dispose(); await f.cleanup(); }
});

test('loggers without a debug method still work with the executor', async () => {
  const f = await fixture(); const lines: string[] = [];
  const executor = new GitExecutor(gitExecutable, new PathPolicy(() => [f.root], () => true), { info: line => lines.push(line), error: line => lines.push(line) }, () => fakeGit(), f.env);
  try { await executor.read(f.root, { kind: 'status' }); assert.deepEqual(lines, []); await executor.mutate(f.root, { kind: 'stage', paths: ['a.txt'] }); assert.equal(lines.length, 1); }
  finally { executor.dispose(); await f.cleanup(); }
});
