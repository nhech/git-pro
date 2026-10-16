import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advancedFixture } from '../fixtures/advanced-fixture';
import { buildReadCommand } from '../../src/git/command-builders';

test('branch tracking counts ahead and behind per local branch, names a deleted upstream and leaves even branches out', async () => {
  const f = await advancedFixture();
  try {
    const base = await f.commit('a.txt', 'base\n', 'base');
    for (const name of ['u-behind', 'ahead', 'behind', 'diverged', 'even', 'gone']) f.git(['branch', name, base]);
    const track = (name: string, remote: string, merge: string) => { f.git(['config', `branch.${name}.remote`, remote]); f.git(['config', `branch.${name}.merge`, merge]); };
    // u-behind is one commit past the base; the others follow a branch of their own (a local branch is an upstream when its remote is ".").
    f.git(['checkout', 'u-behind']); await f.commit('b.txt', 'b\n', 'B');
    f.git(['checkout', 'ahead']); await f.commit('c.txt', 'c\n', 'C');
    f.git(['checkout', 'diverged']); await f.commit('d.txt', 'd\n', 'D');
    f.git(['checkout', base]);
    track('ahead', '.', 'refs/heads/even'); track('behind', '.', 'refs/heads/u-behind'); track('diverged', '.', 'refs/heads/u-behind'); track('even', '.', 'refs/heads/gone'); track('gone', '.', 'refs/heads/absent');
    const refs = ['ahead', 'behind', 'diverged', 'even', 'gone', 'u-behind'].map(name => `refs/heads/${name}`);
    const found = await f.gitService.branchTracking(f.id, refs);
    assert.deepEqual(Object.fromEntries(found), { 'refs/heads/ahead': '↑1', 'refs/heads/behind': '↓1', 'refs/heads/diverged': '↑1 ↓1', 'refs/heads/gone': 'gone' });
    assert.deepEqual([...(await f.gitService.branchTracking(f.id, []))], [], 'no branches, no read');
    await assert.rejects(f.gitService.branchTracking(f.id, ['refs/remotes/origin/main']), /full local branch refs/);
  } finally { await f.close(); }
});

test('the tracking read takes up to 200 full local refs and nothing else', () => {
  const command = buildReadCommand({ kind: 'branchTracking', refs: ['refs/heads/main'] });
  assert.deepEqual(command.slice(-3), ['for-each-ref', '--format=%(refname)%00%(upstream:track,nobracket)', 'refs/heads/main']);
  const refs = Array.from({ length: 201 }, (_, index) => `refs/heads/b${index}`);
  assert.throws(() => buildReadCommand({ kind: 'branchTracking', refs }), /exceeds its bound/); assert.throws(() => buildReadCommand({ kind: 'branchTracking', refs: [] }), /exceeds its bound/);
  assert.throws(() => buildReadCommand({ kind: 'branchTracking', refs: ['main'] }), /full local branch refs/);
});

test('many branches with long names are counted in several reads, so the counts do not vanish with the bound of one read', async () => {
  const f = await advancedFixture();
  try {
    const base = await f.commit('a.txt', 'base\n', 'base');
    const names = Array.from({ length: 150 }, (_, index) => `feature/${'long-name-'.repeat(8)}${index}`);
    for (const name of names) f.git(['branch', name, base]);
    // 150 refs of about 100 bytes are past the 12,000 bytes one read takes. Two of them follow the first, which has moved on.
    f.git(['checkout', names[0]!]); await f.commit('b.txt', 'b\n', 'B'); f.git(['checkout', base]);
    for (const name of [names[1]!, names[149]!]) { f.git(['config', `branch.${name}.remote`, '.']); f.git(['config', `branch.${name}.merge`, `refs/heads/${names[0]!}`]); }
    const refs = names.map(name => `refs/heads/${name}`);
    assert.ok(Buffer.byteLength(refs.join('\0')) > 12000, 'the fixture is wider than one read');
    assert.throws(() => buildReadCommand({ kind: 'branchTracking', refs }), /exceeds its bound/);
    const found = await f.gitService.branchTracking(f.id, refs);
    assert.deepEqual(Object.fromEntries(found), { [refs[1]!]: '↓1', [refs[149]!]: '↓1' });
  } finally { await f.close(); }
});
