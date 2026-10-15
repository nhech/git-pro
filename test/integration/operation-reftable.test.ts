import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { advancedFixture } from '../fixtures/advanced-fixture';
import { ConflictsService } from '../../src/git/conflicts/conflicts.service';
import { GitFailure } from '../../src/git/git-error-parser';
import type { ReadCommand } from '../../src/git/command-builders';
import type { ReadOptions } from '../../src/git/git-executor';

type Fixture = Awaited<ReturnType<typeof advancedFixture>>;
const conflict = (error: unknown) => error instanceof GitFailure && error.kind === 'conflict';
/**
 * The reftable layout (Git 2.45+, `git init --ref-format=reftable`): a `reftable` directory, and REBASE_HEAD, CHERRY_PICK_HEAD and REVERT_HEAD kept in the
 * tables rather than as files. Older Git cannot create it, so the pseudo-ref files move out and only Git's answer (`rev-parse`) still knows them. Run under a Git
 * that has reftable (GIT_DEFAULT_REF_FORMAT=reftable), the files are already absent and Git answers by itself.
 */
async function tables(f: Fixture, names: readonly string[]): Promise<string[]> {
  const gitDir = f.gitService.repository(f.id).gitDir, values = names.map(name => f.git(['rev-parse', name]).trim()), read = f.executor.read.bind(f.executor), asked: string[] = [];
  for (const name of names) await rm(path.join(gitDir, name), { force: true });
  await mkdir(path.join(gitDir, 'reftable'), { recursive: true });
  f.executor.read = async (root: string, command: ReadCommand, options?: ReadOptions) => {
    const index = command.kind === 'ref' ? names.indexOf(command.ref) : -1;
    if (command.kind === 'ref' && /_HEAD$/.test(command.ref)) asked.push(command.ref);
    return index < 0 ? read(root, command, options) : { stdout: Buffer.from(`${values[index]}\n`), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
  };
  return asked;
}

test('in a reftable repository a rebase conflict keeps Yours on the replayed commit: REBASE_HEAD comes from Git, not a file', async () => {
  const f = await advancedFixture(); try {
    await f.commit('f.txt', 'base\n', 'base'); f.git(['checkout', '-b', 'feature']); const mine = await f.commit('f.txt', 'MINE\n', 'mine');
    f.git(['checkout', 'main']); const main = await f.commit('f.txt', 'UP\n', 'up'); f.git(['checkout', 'feature']);
    await assert.rejects(f.advanced.execute(await f.advanced.preview(f.id, { kind: 'rebase', oid: main })), conflict);
    const asked = await tables(f, ['REBASE_HEAD']);
    const service = new ConflictsService(f.advanced), list = await service.list(f.id);
    assert.equal(list.snapshot.operation, 'rebasing'); assert.ok(asked.includes('REBASE_HEAD'), 'the executor was asked');
    assert.deepEqual(list.summary.sides, { yours: { stage: 3, flag: 'theirs' }, theirs: { stage: 2, flag: 'ours' } });
    assert.deepEqual([list.summary.yours.oid, list.summary.yours.subject], [mine, 'mine'], 'the banner names the replayed commit');
    assert.deepEqual([list.summary.canContinue, list.summary.canSkip, list.summary.canAbort], [false, true, true]);
    await service.acceptSide(await service.previewBatch(f.id, ['f.txt']), 'yours');
    assert.equal(await readFile(path.join(f.root, 'f.txt'), 'utf8'), 'MINE\n', 'Accept Yours keeps the replayed commit, not the upstream');
  } finally { await f.close(); }
});

test('in a reftable repository a cherry-pick or revert conflict is that operation, with its commit named, not idle conflicts', async () => {
  for (const kind of ['cherryPick', 'revert'] as const) {
    const f = await advancedFixture(); try {
      await f.commit('f.txt', 'base\n', 'base'); f.git(['checkout', '-b', 'other']); const other = await f.commit('f.txt', 'OTHER\n', 'other');
      f.git(['checkout', 'main']); const changed = await f.commit('f.txt', 'b\n', 'b'); await f.commit('f.txt', 'c\n', 'c');
      const target = kind === 'cherryPick' ? other : changed, name = kind === 'cherryPick' ? 'CHERRY_PICK_HEAD' : 'REVERT_HEAD';
      await assert.rejects(f.advanced.execute(await f.advanced.preview(f.id, { kind, oids: [target] })), conflict);
      await tables(f, [name]);
      const summary = (await new ConflictsService(f.advanced).list(f.id)).summary;
      assert.equal(summary.operation, kind === 'cherryPick' ? 'cherry-picking' : 'reverting', kind);
      assert.equal(summary.title, kind === 'cherryPick' ? `Cherry-picking ${other.slice(0, 7)} onto main` : `Reverting ${changed.slice(0, 7)} on main`);
      assert.deepEqual([summary.canSkip, summary.canAbort], [true, true], 'Skip and Abort are offered');
    } finally { await f.close(); }
  }
});
