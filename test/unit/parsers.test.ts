import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStatus } from '../../src/git/git-parser';
import { parseGitError } from '../../src/git/git-error-parser';
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
