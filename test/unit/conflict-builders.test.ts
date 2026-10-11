import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { buildMutationCommand, buildReadCommand } from '../../src/git/command-builders';
import { buildAdvancedMutation } from '../../src/git/advanced/advanced-builders';
import { GitExecutor } from '../../src/git/git-executor';
import { PathPolicy } from '../../src/security/paths';
import { silentLogger } from '../../src/utils/logging';
import { fixture, gitExecutable } from '../fixtures/repository-fixture';

const oid = 'a'.repeat(40), read = ['--no-pager', '-c', 'color.ui=false', '-c', 'core.fsmonitor=false'], mutation = ['--literal-pathspecs', '--no-pager', '-c', 'color.ui=false'];

test('side labels read the refs at one validated commit, branches first', () => {
  assert.deepEqual(buildReadCommand({ kind: 'pointsAt', oid }), [...read, 'for-each-ref', `--points-at=${oid}`, '--count=4', '--format=%(refname)%00', 'refs/heads/', 'refs/remotes/', 'refs/tags/']);
  for (const value of ['HEAD', '--all', 'a'.repeat(39), `${oid}\n`]) assert.throws(() => buildReadCommand({ kind: 'pointsAt', oid: value }), /object ID/);
});

test('Get from Branch restores the working tree only, from a pinned commit, with paths on stdin', () => {
  assert.deepEqual(buildMutationCommand({ kind: 'restoreFromSource', oid, paths: ['src/a.ts', 'old name.ts'] }), [...mutation, 'restore', `--source=${oid}`, '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul']);
  const args = buildMutationCommand({ kind: 'restoreFromSource', oid, paths: ['a'] });
  assert.equal(args.includes('--staged'), false, 'the index is untouched'); assert.equal(args.includes('--overlay'), false, 'tracked paths missing in the source are removed');
  for (const value of ['main', '--source=x', `${oid}:path`]) assert.throws(() => buildMutationCommand({ kind: 'restoreFromSource', oid: value, paths: ['a'] }), /object ID/);
  for (const paths of [[], ['/abs.txt'], ['C:/abs.txt'], ['../escape.txt'], ['a/../../b'], ['bad\0name'], Array.from({ length: 5001 }, (_, index) => `f${index}`)])
    assert.throws(() => buildMutationCommand({ kind: 'restoreFromSource', oid, paths }), /path/, JSON.stringify(paths.slice(0, 2)));
});

test('merge Continue commits an edited message with -m and Git\'s default cleanup, so a typed "#123" line survives', () => {
  const message = 'Merge branch feature\n\n#123 fix the login form\n';
  const args = buildAdvancedMutation({ kind: 'operationControl', operation: 'merging', action: 'continue', message });
  assert.deepEqual(args, [...mutation, 'commit', '-m', message]);
  assert.equal(args.some(arg => arg.startsWith('--cleanup')), false, '--cleanup=strip would delete "#123 fix"');
  assert.deepEqual(buildAdvancedMutation({ kind: 'operationControl', operation: 'merging', action: 'continue' }), [...mutation, 'commit', '--no-edit']);
  assert.deepEqual(buildAdvancedMutation({ kind: 'operationControl', operation: 'merging', action: 'abort' }), [...mutation, 'merge', '--abort']);
  assert.equal(buildAdvancedMutation({ kind: 'operationControl', operation: 'merging', action: 'continue', message: 'x'.repeat(65536) }).at(-1)!.length, 65536);
  for (const bad of ['', '  \n\t', 'nul\0byte', 'x'.repeat(65537)]) assert.throws(() => buildAdvancedMutation({ kind: 'operationControl', operation: 'merging', action: 'continue', message: bad }), /merge message/);
  for (const [operation, action] of [['merging', 'abort'], ['rebasing', 'continue'], ['cherry-picking', 'continue'], ['reverting', 'skip']] as const)
    assert.throws(() => buildAdvancedMutation({ kind: 'operationControl', operation, action, message: 'reviewed' }), /only to continuing a merge/, `${operation} ${action}`);
});

/** A Git process that records its stdin and exits 0. */
function recordingGit(inputs: Buffer[]): ChildProcess {
  const child = new EventEmitter() as ChildProcess, out = new PassThrough(), err = new PassThrough(), stdin = new PassThrough(), chunks: Buffer[] = [];
  stdin.on('data', (chunk: Buffer) => chunks.push(chunk)); stdin.on('end', () => inputs.push(Buffer.concat(chunks)));
  Object.assign(child, { stdout: out, stderr: err, stdin, pid: undefined });
  setImmediate(() => { out.end(); err.end(); setImmediate(() => child.emit('close', 0)); });
  return child;
}
test('Get from Branch is a bulk path mutation: one process, every path on stdin, nothing on the command line', async () => {
  const f = await fixture(), argvs: string[][] = [], inputs: Buffer[] = [];
  const executor = new GitExecutor(gitExecutable, new PathPolicy(() => [f.root], () => true), silentLogger, (_file, args) => { argvs.push([...args]); return recordingGit(inputs); }, f.env);
  try {
    const paths = Array.from({ length: 1200 }, (_, index) => `deep/${'d'.repeat(60)}/file-${index}.txt`);
    await executor.mutate(f.root, { kind: 'restoreFromSource', oid, paths });
    assert.equal(argvs.length, 1); assert.ok(argvs[0]!.join(' ').length < 300);
    assert.deepEqual(inputs[0]!.toString('utf8').split('\0').slice(0, -1), paths);
    await assert.rejects(executor.mutate(f.root, { kind: 'restoreFromSource', oid, paths: ['../outside.txt'] }), /Invalid|outside/);
    assert.equal(argvs.length, 1, 'a rejected path never starts Git');
  } finally { executor.dispose(); await f.cleanup(); }
});
