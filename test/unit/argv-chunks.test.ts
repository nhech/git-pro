import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { ARGV_PATH_BUDGET, chunkPaths } from '../../src/git/argv-chunks';
import { GitExecutor } from '../../src/git/git-executor';
import { GitFailure } from '../../src/git/git-error-parser';
import { PathPolicy } from '../../src/security/paths';
import { silentLogger } from '../../src/utils/logging';
import { fixture, gitExecutable } from '../fixtures/repository-fixture';

/** A Git process that exits immediately. */
function fakeGit(exitCode = 0, stderr = ''): ChildProcess {
  const child = new EventEmitter() as ChildProcess, out = new PassThrough(), err = new PassThrough();
  Object.assign(child, { stdout: out, stderr: err, stdin: null, pid: undefined });
  setImmediate(() => { if (stderr) err.write(stderr); out.end(); err.end(); setImmediate(() => child.emit('close', exitCode)); });
  return child;
}
const names = (count: number, length = 100) => Array.from({ length: count }, (_, index) => `${`packages/pkg-${index}/`.padEnd(length - 8, 'd')}/f${String(index).padStart(5, '0')}.ts`);

test('path batches preserve order, fit the budget and never split a path', () => {
  const paths = names(5000, 80);
  for (const budget of [1000, 24_000, ARGV_PATH_BUDGET]) {
    const batches = chunkPaths(paths, budget);
    assert.deepEqual(batches.flat(), paths, 'concatenating the batches restores the input');
    for (const batch of batches) assert.ok(batch.length > 0 && batch.reduce((total, value) => total + value.length + 3, 0) <= Math.max(budget, 83), `batch of ${batch.length} exceeds ${budget}`);
  }
  assert.deepEqual(chunkPaths([], 100), []);
  assert.deepEqual(chunkPaths(['a'.repeat(500), 'b'], 100), [['a'.repeat(500)], ['b']], 'an oversized path still travels alone');
  assert.equal(chunkPaths(['a', 'b'], 100).length, 1);
});

test('the default budget leaves room under the Windows command-line limit', () => {
  const windows = 24_000;
  for (const batch of chunkPaths(names(5000, 60), windows)) assert.ok(`git --literal-pathspecs --no-pager -c color.ui=false restore --staged -- ${batch.join(' ')}`.length < 32_767);
  assert.ok(ARGV_PATH_BUDGET <= 100_000 && ARGV_PATH_BUDGET >= windows);
});

/** A Git process that records what it read from stdin and exits: how paths reach Git is what these tests measure. */
function recordingGit(inputs: Buffer[], exitCode = 0, stderr = ''): ChildProcess {
  const child = fakeGit(exitCode, stderr), stdin = new PassThrough(), chunks: Buffer[] = [];
  stdin.on('data', (chunk: Buffer) => chunks.push(chunk)); stdin.on('end', () => inputs.push(Buffer.concat(chunks)));
  Object.assign(child, { stdin }); return child;
}

test('a bulk path mutation is one process that reads every path, in order, from stdin', async () => {
  const f = await fixture(); const argvs: string[][] = [], inputs: Buffer[] = [];
  const executor = new GitExecutor(gitExecutable, new PathPolicy(() => [f.root], () => true), silentLogger, (_file, args) => { argvs.push([...args]); return recordingGit(inputs); }, f.env);
  try {
    const paths = names(1500, 140); // 210 KB of paths: far beyond any command line
    for (const kind of ['stage', 'unstage', 'unstageUnborn', 'discard', 'deleteConflict'] as const) {
      argvs.length = 0; inputs.length = 0;
      assert.equal((await executor.mutate(f.root, { kind, paths })).exitCode, 0);
      assert.equal(argvs.length, 1, `${kind} ran ${argvs.length} process(es)`);
      assert.ok(argvs[0]!.includes('--literal-pathspecs') && argvs[0]!.includes('--pathspec-from-file=-') && argvs[0]!.includes('--pathspec-file-nul'));
      assert.ok(argvs[0]!.join(' ').length < 300, 'no path is on the command line');
      assert.deepEqual(inputs[0]!.toString('utf8').split('\0').slice(0, -1), paths);
    }
    argvs.length = 0; inputs.length = 0; await executor.mutate(f.root, { kind: 'acceptConflict', side: 'theirs', paths: paths.slice(0, 3) });
    assert.ok(argvs[0]!.includes('--theirs')); assert.deepEqual(inputs[0]!.toString('utf8'), paths.slice(0, 3).map(value => `${value}\0`).join(''));
  } finally { executor.dispose(); await f.cleanup(); }
});

test('every path is validated before Git starts, and a failure applies nothing', async () => {
  const f = await fixture(); let launched = 0;
  const executor = new GitExecutor(gitExecutable, new PathPolicy(() => [f.root], () => true), silentLogger, () => { launched++; return recordingGit([], 128, 'fatal: pathspec did not match any files'); }, f.env);
  try {
    const paths = names(200, 100);
    await assert.rejects(executor.mutate(f.root, { kind: 'stage', paths: [...paths, '../escape.txt'] }), /Invalid|outside/);
    await assert.rejects(executor.mutate(f.root, { kind: 'stage', paths: [...paths, 'bad\0name'] }));
    await assert.rejects(executor.mutate(f.root, { kind: 'stage', paths: Array.from({ length: 5001 }, (_, index) => `f${index}`) }), /between 1 and 5000/);
    assert.equal(launched, 0, 'a rejected path prevents Git from running at all');
    await assert.rejects(executor.mutate(f.root, { kind: 'discard', paths }), (error: unknown) => error instanceof GitFailure && /did not match/.test(error.message) && !/already applied/.test(error.message));
    assert.equal(launched, 1);
  } finally { executor.dispose(); await f.cleanup(); }
});

test('stdin pathspecs stay literal with real Git', async () => {
  const f = await fixture();
  const executor = new GitExecutor(gitExecutable, new PathPolicy(() => [f.root], () => true), silentLogger, undefined, f.env);
  try {
    // "[1]" would match "1" as a glob; the bracketed file is the only one that may change.
    for (const name of ['x [1].txt', 'x 1.txt']) await writeFile(path.join(f.root, name), 'base\n');
    f.git(['add', '-A']); f.git(['commit', '-q', '-m', 'base']);
    for (const name of ['x [1].txt', 'x 1.txt']) await writeFile(path.join(f.root, name), 'edited\n');
    await executor.mutate(f.root, { kind: 'stage', paths: ['x [1].txt'] });
    assert.equal(f.git(['diff', '--cached', '--name-only']).trim(), 'x [1].txt');
    await executor.mutate(f.root, { kind: 'unstage', paths: ['x [1].txt'] }); assert.equal(f.git(['diff', '--cached', '--name-only']).trim(), '');
    await executor.mutate(f.root, { kind: 'discard', paths: ['x [1].txt'] });
    assert.equal(f.git(['diff', '--name-only']).trim(), 'x 1.txt');
  } finally { executor.dispose(); await f.cleanup(); }
});

test('batched authorization checks every path and returns the same results as one-by-one', async () => {
  const f = await fixture(); let trusted = true;
  try {
    const policy = new PathPolicy(() => [f.root], () => trusted);
    await mkdir(path.join(f.root, 'src', 'deep'), { recursive: true });
    const present = ['a.txt', 'src/b.txt', 'src/deep/c.txt']; for (const name of present) await writeFile(path.join(f.root, name), name);
    const requested = [...present, 'removed/later.txt', ...names(200, 60)];
    assert.deepEqual(await policy.authorizeFiles(f.root, requested), await Promise.all(requested.map(name => policy.authorizeFile(f.root, name))));
    assert.deepEqual(await policy.authorizeFiles(f.root, []), []);
    await mkdir(path.join(f.home, 'outside'));
    await symlink(path.join(f.home, 'outside'), path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const bad of ['../home', 'linked/missing.txt', '\0', '/absolute']) await assert.rejects(policy.authorizeFiles(f.root, [...present, bad, ...names(100, 60)]));
    await assert.rejects(policy.authorizeFiles(f.home, present), /outside/);
    trusted = false; await assert.rejects(policy.authorizeFiles(f.root, present), /trusted/);
  } finally { await f.cleanup(); }
});
