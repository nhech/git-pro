import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { parseStatus } from '../../src/git/git-parser';
import { GitFailure, parseGitError, parseMutationError } from '../../src/git/git-error-parser';
import { GitExecutor } from '../../src/git/git-executor';
import { PathPolicy } from '../../src/security/paths';
import { silentLogger } from '../../src/utils/logging';
import { fixture, gitExecutable } from '../fixtures/repository-fixture';
const oid = 'a'.repeat(40);
test('status keeps staged and working changes independent with special paths', () => {
  const input = `# branch.oid ${oid}\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +3 -2\0` +
    `1 MM N... 100644 100644 100644 ${oid} ${oid} space\ttab\nfile.txt\0? 新 file.txt\0`;
  const status = parseStatus(Buffer.from(input));
  assert.equal(status.ahead, 3); assert.equal(status.behind, 2); assert.equal(status.changes.length, 3);
  assert.equal(status.changes[0]?.path, 'space\ttab\nfile.txt');
  assert.deepEqual(status.changes.slice(0, 2).map(change => change.group), ['staged', 'working']);
  assert.ok(Object.isFrozen(status.changes));
});
test('status parses rename pair, unmerged, ignored and unborn', () => {
  const input = '# branch.oid (initial)\0# branch.head main\0' +
    `2 R. N... 100644 100644 100644 ${oid} ${oid} R100 new name\0old name\0` +
    `u UU N... 100644 100644 100644 100644 ${oid} ${oid} ${oid} conflicted\0! ignored\0`;
  const status = parseStatus(Buffer.from(input));
  assert.equal(status.oid, undefined); assert.equal(status.ahead, undefined);
  assert.equal(status.changes[0]?.originalPath, 'old name'); assert.equal(status.changes[1]?.group, 'conflicts');
});
test('truncated or malformed records rejected, not incomplete success', () => {
  for (const input of ['? bad', '1 bad\0', '# branch.ab invalid\0', `2 R. N... 100644 100644 100644 ${oid} ${oid} R100 new\0`]) {
    assert.throws(() => parseStatus(Buffer.from(input)));
  }
  assert.throws(() => parseStatus(Buffer.from([0x3f, 0x20, 0xff, 0x00])), /encoded data/);
});
test('error classification uses safe redacted messages', () => {
  assert.equal(parseGitError('fatal: not a git repository', 128).kind, 'repository');
  assert.equal(parseGitError('Authentication failed https://user:SECRET@host/repo', 128).kind, 'auth');
  assert.equal(parseGitError('Authentication failed https://user:SECRET@host/repo', 128).message.includes('SECRET'), false);
  assert.equal(parseGitError('cannot create index.lock', 128).kind, 'locked');
});

test('a merge-family mutation that exits 1 with CONFLICT lines on stdout is a conflict, whatever stderr says', () => {
  const merge = Buffer.from('Auto-merging aa.txt\nCONFLICT (add/add): Merge conflict in aa.txt\nAuto-merging uu.txt\nCONFLICT (content): Merge conflict in uu.txt\nAutomatic merge failed; fix conflicts and then commit the result.\n');
  for (const kind of ['merge', 'integrate', 'stashApply', 'cherryPick', 'revert', 'rebase', 'interactiveRebase', 'operationControl']) {
    const failure = parseMutationError(kind, merge, '', 1);
    assert.equal(failure.kind, 'conflict', kind); assert.equal(failure.message, 'Git stopped with 2 conflicts.'); assert.equal(failure.exitCode, 1);
    assert.equal(failure.message.includes('uu.txt'), false, 'stdout paths never become the message');
  }
  assert.equal(parseMutationError('merge', Buffer.from('CONFLICT (content): Merge conflict in a\n'), '', 1).message, 'Git stopped with 1 conflict.');
  assert.equal(parseMutationError('rebase', merge, 'error: could not apply 1a2b3c4... feature\nhint: Resolve all conflicts manually', 1).message, 'error: could not apply 1a2b3c4... feature\nhint: Resolve all conflicts manually', 'stderr stays the diagnostic when Git wrote one');
  // Git prints an Auto-merging line per content-merged path, sorted, so the first CONFLICT can sit far past any prefix.
  const late = Buffer.from(`${Array.from({ length: 400 }, (_, index) => `Auto-merging src/module-${String(index).padStart(4, '0')}/index.ts\n`).join('')}CONFLICT (modify/delete): z.txt deleted in HEAD and modified in feature.\n`);
  assert.ok(late.length > 8192); assert.equal(parseMutationError('merge', late, '', 1).kind, 'conflict');
  for (const [kind, stdout, code] of [['stage', merge, 1], ['commitFile', merge, 1], ['reset', merge, 1], ['merge', merge, 128], ['merge', Buffer.from('Already up to date.\n'), 1], ['merge', Buffer.from('note: CONFLICT (content) mentioned mid-line\n'), 1]] as const)
    assert.equal(parseMutationError(kind, stdout, '', code).kind, 'unknown', `${kind} ${code} ${stdout.toString().slice(0, 30)}`);
  assert.equal(parseMutationError('stage', Buffer.alloc(0), 'error: path is unmerged', 1).kind, 'conflict', 'stderr classification is unchanged');
  assert.equal(parseMutationError('merge', Buffer.alloc(0), 'fatal: index.lock exists', 128).kind, 'locked');
});
/** A Git process that writes this stdout and exits. */
function scriptedGit(stdout: string, exitCode: number): ChildProcess {
  const child = new EventEmitter() as ChildProcess, out = new PassThrough(), err = new PassThrough();
  Object.assign(child, { stdout: out, stderr: err, stdin: null, pid: undefined });
  setImmediate(() => { out.end(stdout); err.end(); setImmediate(() => child.emit('close', exitCode)); });
  return child;
}
test('the executor classifies conflicts from stdout for mutations only; a read with the same output stays a plain failure', async () => {
  const f = await fixture(), stdout = 'Auto-merging a.txt\nCONFLICT (content): Merge conflict in a.txt\n';
  const executor = new GitExecutor(gitExecutable, new PathPolicy(() => [f.root], () => true), silentLogger, () => scriptedGit(stdout, 1), f.env);
  try {
    await assert.rejects(executor.mutate(f.root, { kind: 'merge', oid, strategy: 'ff' }), (error: unknown) => error instanceof GitFailure && error.kind === 'conflict' && error.message === 'Git stopped with 1 conflict.');
    await assert.rejects(executor.mutate(f.root, { kind: 'stashApply', oid, index: false }), (error: unknown) => error instanceof GitFailure && error.kind === 'conflict');
    await assert.rejects(executor.read(f.root, { kind: 'status' }), (error: unknown) => error instanceof GitFailure && error.kind === 'unknown');
  } finally { executor.dispose(); await f.cleanup(); }
});

test('range message records alternate a full object ID and a raw message and reject malformed framing', async () => {
  const { parseRangeMessages } = await import('../../src/git/history/history-parser');
  const a = 'a'.repeat(40), b = 'b'.repeat(64);
  assert.deepEqual(parseRangeMessages(Buffer.from(`${a}\0First\n\nBody ünï\n\0${b}\0\0`)), [{ oid: a, message: 'First\n\nBody ünï\n' }, { oid: b, message: '' }]);
  assert.deepEqual(parseRangeMessages(Buffer.alloc(0)), []);
  assert.throws(() => parseRangeMessages(Buffer.from(`${a}\0message`)), /Truncated/);
  assert.throws(() => parseRangeMessages(Buffer.from(`${a}\0message\0${b}\0`)), /framing/);
  assert.throws(() => parseRangeMessages(Buffer.from('not-an-oid\0message\0')), /object ID/);
  assert.throws(() => parseRangeMessages(Buffer.from([...Buffer.from(`${a}\0`), 0xff, 0x00])), TypeError);
});
