import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { advancedFixture } from '../fixtures/advanced-fixture';
import { GitFailure } from '../../src/git/git-error-parser';

const conflict = (error: unknown) => error instanceof GitFailure && error.kind === 'conflict';

test('a named merge keeps the pinned OID but names the branch, and the default Continue commits it without Git\'s "# Conflicts:" block', async () => {
  const f = await advancedFixture(); try {
    await f.commit('run.sh', 'base\n', 'base'); f.git(['checkout', '-b', 'feature']); const feature = await f.commit('run.sh', 'feature\n', 'feature work');
    f.git(['checkout', 'main']); await f.commit('run.sh', 'main\n', 'main work');
    await assert.rejects(f.advanced.execute(await f.advanced.preview(f.id, { kind: 'merge', oid: feature, strategy: 'ff', source: 'refs/heads/feature' })), conflict);
    const gitDir = f.gitService.repository(f.id).gitDir;
    assert.match(await readFile(path.join(gitDir, 'MERGE_MSG'), 'utf8'), /^Merge branch 'feature'\n\n# Conflicts:\n#\trun\.sh\n/);
    assert.equal(f.git(['rev-parse', 'MERGE_HEAD']).trim(), feature, 'the merge ran on the reviewed OID');
    await writeFile(path.join(f.root, 'run.sh'), 'resolved\n'); f.git(['add', 'run.sh']);
    await f.advanced.control(await f.advanced.snapshot(f.id), 'continue');
    assert.equal(f.git(['log', '-1', '--format=%B']).trimEnd(), "Merge branch 'feature'", 'no comment lines in the permanent message');
    assert.equal(f.git(['rev-parse', 'HEAD^2']).trim(), feature);
    // Another checked-out branch is named as Git names it, and so is a remote-tracking branch.
    f.git(['checkout', '-b', 'develop', 'feature~1']); await f.commit('d.txt', 'develop\n', 'develop work');
    f.git(['update-ref', 'refs/remotes/origin/topic', feature]);
    await f.advanced.execute(await f.advanced.preview(f.id, { kind: 'merge', oid: feature, strategy: 'ff', source: 'refs/remotes/origin/topic' }));
    assert.equal(f.git(['log', '-1', '--format=%B']).trimEnd(), "Merge remote-tracking branch 'origin/topic' into develop");
    // A caller cannot name another target: the snapshot's branch is used.
    f.git(['reset', '--hard', 'HEAD~1']);
    await f.advanced.execute(await f.advanced.preview(f.id, { kind: 'merge', oid: feature, strategy: 'no-ff', source: 'refs/heads/feature', into: 'main' }));
    assert.equal(f.git(['log', '-1', '--format=%B']).trimEnd(), "Merge branch 'feature' into develop");
  } finally { await f.close(); }
});

test('Continue on a merge started outside Git Pro drops the "# Conflicts:" block from Git\'s prepared message too', async () => {
  const f = await advancedFixture(); try {
    await f.commit('a.txt', 'base\n', 'base'); f.git(['checkout', '-b', 'side']); await f.commit('a.txt', 'side\n', 'side');
    f.git(['checkout', 'main']); await f.commit('a.txt', 'main\n', 'main');
    assert.throws(() => f.git(['merge', 'side']), /Fixture Git failed/);
    await writeFile(path.join(f.root, 'a.txt'), 'both\n'); f.git(['add', 'a.txt']);
    await f.advanced.control(await f.advanced.snapshot(f.id), 'continue');
    assert.equal(f.git(['log', '-1', '--format=%B']).trimEnd(), "Merge branch 'side'");
  } finally { await f.close(); }
});

test('a message the user wrote with "#" lines survives the default Continue: only the appended "# Conflicts:" block is removed', async () => {
  const f = await advancedFixture(); try {
    await f.commit('a.txt', 'base\n', 'base'); f.git(['checkout', '-b', 'side']); await f.commit('a.txt', 'side\n', 'side');
    f.git(['checkout', 'main']); await f.commit('a.txt', 'main\n', 'main');
    assert.throws(() => f.git(['merge', 'side', '-m', '#123 merge side', '-m', '#45 also fixes this']), /Fixture Git failed/);
    await writeFile(path.join(f.root, 'a.txt'), 'both\n'); f.git(['add', 'a.txt']);
    await f.advanced.control(await f.advanced.snapshot(f.id), 'continue');
    assert.equal(f.git(['log', '-1', '--format=%B']).trimEnd(), '#123 merge side\n\n#45 also fixes this', 'the lines the user typed are the permanent message');
  } finally { await f.close(); }
});
