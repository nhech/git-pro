import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, writeFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { advancedFixture } from '../fixtures/advanced-fixture';
import { ConflictsService } from '../../src/git/conflicts/conflicts.service';
import { GitFailure } from '../../src/git/git-error-parser';
import { recoveryFor } from '../../src/utils/recovery';
import type { MutationCommand } from '../../src/git/command-builders';

type Fixture = Awaited<ReturnType<typeof advancedFixture>>;
const conflict = (error: unknown) => error instanceof GitFailure && error.kind === 'conflict';
const conflicted = async (f: Fixture) => (await f.advanced.snapshot(f.id)).status.changes.filter(change => change.group === 'conflicts').map(change => change.path).sort();
const content = (f: Fixture, file: string) => readFile(path.join(f.root, file), 'utf8');
const put = async (f: Fixture, file: string, value: string) => { await mkdir(path.dirname(path.join(f.root, file)), { recursive: true }); await writeFile(path.join(f.root, file), value); };
/** Commits files with explicit index modes; where the file system has an executable bit, the working files get the same modes. */
async function commit(f: Fixture, files: Record<string, string>, message: string, executable: readonly string[] = [], plain: readonly string[] = []) {
  for (const [file, value] of Object.entries(files)) await put(f, file, value);
  if (process.platform !== 'win32') for (const [list, bits] of [[executable, 0o755], [plain, 0o644]] as const) for (const file of list) await chmod(path.join(f.root, file), bits);
  f.git(['add', '--', ...Object.keys(files)]);
  if (executable.length) f.git(['update-index', '--chmod=+x', '--', ...executable]);
  if (plain.length) f.git(['update-index', '--chmod=-x', '--', ...plain]);
  f.git(['commit', '-m', message]);
}

test('Resolve Conflict refuses Mark Resolved for binary and one-sided rows; their Accept stages the chosen side itself, so a rebase keeps the replayed commit (N13)', async () => {
  const f = await advancedFixture(); try {
    await commit(f, { 'logo.bin': '\0base', 'keep.txt': 'keep base\n', 'gone.txt': 'gone base\n', 'app.txt': 'app base\n' }, 'base');
    f.git(['checkout', '-b', 'feature']); await put(f, 'logo.bin', '\0MINE'); await put(f, 'app.txt', 'app mine\n'); f.git(['rm', '-q', 'keep.txt', 'gone.txt']); f.git(['add', '.']); f.git(['commit', '-m', 'my logo, drop keep and gone']);
    f.git(['checkout', 'main']); await commit(f, { 'logo.bin': '\0UPSTREAM', 'keep.txt': 'keep upstream\n', 'gone.txt': 'gone upstream\n', 'app.txt': 'app upstream\n' }, 'upstream');
    const upstream = f.git(['rev-parse', 'HEAD']).trim(); f.git(['checkout', 'feature']);
    await assert.rejects(f.advanced.execute(await f.advanced.preview(f.id, { kind: 'rebase', oid: upstream })), conflict);
    const service = new ConflictsService(f.advanced), before = f.git(['ls-files', '--stage']);
    // The working files are Git's stage-2 copies: the upstream's, during a rebase. Staging them would drop the replayed commit's changes silently.
    await assert.rejects(service.resolve(await service.preview(f.id, 'logo.bin'), 'mark'), /logo\.bin is binary\. Choose Accept Yours or Accept Theirs/);
    await assert.rejects(service.resolve(await service.preview(f.id, 'keep.txt'), 'mark'), /keep\.txt: Mark Resolved would keep only the version Git left in the working tree/);
    assert.equal(f.git(['ls-files', '--stage']), before, 'a refused Mark Resolved stages nothing');
    // During a rebase Yours is the replayed commit, Git --theirs ('incoming'); Theirs is the upstream, Git --ours ('current').
    await service.resolve(await service.preview(f.id, 'logo.bin'), 'incoming');
    assert.equal(f.git(['show', ':logo.bin']), '\0MINE', 'Accept Yours staged the replayed binary');
    await service.resolve(await service.preview(f.id, 'keep.txt'), 'incoming');
    await service.resolve(await service.preview(f.id, 'gone.txt'), 'current');
    assert.equal(f.git(['show', ':gone.txt']), 'gone upstream\n', 'Accept Theirs of a one-sided row is staged too');
    await service.resolve(await service.preview(f.id, 'app.txt'), 'incoming');
    assert.deepEqual(await conflicted(f), ['app.txt'], 'a text both-sides Accept leaves staging to Mark Resolved');
    assert.equal(await content(f, 'app.txt'), 'app mine\n');
    await service.resolve(await service.preview(f.id, 'app.txt'), 'mark'); assert.deepEqual(await conflicted(f), []);
    await f.advanced.control(await f.advanced.snapshot(f.id), 'continue');
    assert.equal(f.git(['show', 'HEAD:logo.bin']), '\0MINE'); assert.equal(f.git(['show', 'HEAD:app.txt']), 'app mine\n'); assert.equal(f.git(['show', 'HEAD:gone.txt']), 'gone upstream\n');
    assert.doesNotMatch(f.git(['ls-tree', '--name-only', 'HEAD']), /^keep\.txt$/m, 'the replayed deletion survived');
    assert.equal(f.git(['log', '-1', '--format=%s']).trim(), 'my logo, drop keep and gone');
  } finally { await f.close(); }
});

for (const filemode of process.platform === 'win32' ? [false] : [false, true]) {
  test(`Accept stages the chosen side's file mode, not the unmerged entry's (core.filemode=${filemode})`, async () => {
    const script = 'bin dir/rün me.sh';
    const merge = await advancedFixture(); try {
      merge.git(['config', 'core.filemode', String(filemode)]);
      await commit(merge, { [script]: 'base\n', 'plain.sh': 'base\n' }, 'base', [], [script, 'plain.sh']);
      merge.git(['checkout', '-b', 'feature']); await commit(merge, { [script]: 'feature\n', 'plain.sh': 'feature\n' }, 'feature edits', ['plain.sh']);
      merge.git(['checkout', 'main']); await commit(merge, { [script]: 'main\n', 'plain.sh': 'main\n' }, 'main makes it executable', [script]);
      const feature = merge.git(['rev-parse', 'feature']).trim();
      for (const [side, scriptMode, plainMode, scriptContent] of [['theirs', '100644', '100755', 'feature\n'], ['yours', '100755', '100644', 'main\n']] as const) {
        await assert.rejects(merge.advanced.execute(await merge.advanced.preview(merge.id, { kind: 'merge', oid: feature, strategy: 'ff' })), conflict);
        const service = new ConflictsService(merge.advanced);
        await service.acceptSide(await service.previewBatch(merge.id, [script, 'plain.sh']), side);
        assert.equal(merge.git(['ls-files', '--stage', '--', script]).split(' ')[0], scriptMode, `Accept ${side}: ${script}`);
        assert.equal(merge.git(['ls-files', '--stage', '--', 'plain.sh']).split(' ')[0], plainMode, `Accept ${side}: plain.sh`);
        assert.equal(merge.git(['show', `:${script}`]), scriptContent);
        merge.git(['merge', '--abort']);
      }
    } finally { await merge.close(); }
    const rebase = await advancedFixture(); try {
      rebase.git(['config', 'core.filemode', String(filemode)]);
      await commit(rebase, { 'run.sh': 'base\n', 'tool.bin': '\0base' }, 'base', [], ['run.sh', 'tool.bin']);
      rebase.git(['checkout', '-b', 'feature']); await commit(rebase, { 'run.sh': 'mine\n', 'tool.bin': '\0mine' }, 'make them executable', ['run.sh', 'tool.bin']);
      rebase.git(['checkout', 'main']); await commit(rebase, { 'run.sh': 'upstream\n', 'tool.bin': '\0upstream' }, 'upstream edits');
      const upstream = rebase.git(['rev-parse', 'HEAD']).trim(); rebase.git(['checkout', 'feature']);
      await assert.rejects(rebase.advanced.execute(await rebase.advanced.preview(rebase.id, { kind: 'rebase', oid: upstream })), conflict);
      const service = new ConflictsService(rebase.advanced);
      await service.acceptSide(await service.previewBatch(rebase.id, ['run.sh']), 'yours');
      assert.equal(rebase.git(['ls-files', '--stage', '--', 'run.sh']).split(' ')[0], '100755', 'Accept Yours keeps the replayed commit\'s executable bit');
      // The per-file Accept of a binary row stages it as well, at the same mode.
      await service.resolve(await service.preview(rebase.id, 'tool.bin'), 'incoming');
      assert.equal(rebase.git(['ls-files', '--stage', '--', 'tool.bin']).split(' ')[0], '100755');
      await rebase.advanced.control(await rebase.advanced.snapshot(rebase.id), 'continue');
      assert.match(rebase.git(['ls-tree', 'HEAD', '--', 'run.sh', 'tool.bin']), /^100755 blob [a-f0-9]+\trun\.sh\n100755 blob [a-f0-9]+\ttool\.bin\n$/);
    } finally { await rebase.close(); }
  });
}

test('a bulk Accept whose restore fails part-way says the batch already took effect (N2); one that changed nothing reports the plain failure', async () => {
  const f = await advancedFixture(); try {
    await commit(f, { 'a.txt': 'a base\n', 'b.txt': 'b base\n', 'c.txt': 'c base\n' }, 'base');
    f.git(['checkout', '-b', 'feature']); await commit(f, { 'a.txt': 'a feature\n', 'b.txt': 'b feature\n', 'c.txt': 'c feature\n' }, 'feature');
    f.git(['checkout', 'main']); await commit(f, { 'a.txt': 'a main\n', 'b.txt': 'b main\n', 'c.txt': 'c main\n' }, 'main');
    await assert.rejects(f.advanced.execute(await f.advanced.preview(f.id, { kind: 'merge', oid: f.git(['rev-parse', 'feature']).trim(), strategy: 'ff' })), conflict);
    const service = new ConflictsService(f.advanced), mutate = f.executor.mutate.bind(f.executor), locked = new GitFailure('unknown', "error: unable to unlink old 'b.txt': Permission denied", 255);
    // As with b.txt held open on Windows: restore replaced a.txt and c.txt before it failed on b.txt.
    let partial = true;
    f.executor.mutate = async (root: string, command: MutationCommand, options = {}) => {
      if (command.kind !== 'acceptConflict') return mutate(root, command, options);
      if (partial) await mutate(root, { ...command, paths: command.paths.filter(file => file !== 'b.txt') }, options);
      throw locked;
    };
    await assert.rejects(service.acceptSide(await service.previewBatch(f.id, ['a.txt', 'b.txt', 'c.txt']), 'theirs'), (error: unknown) => error instanceof GitFailure && error.partial?.applied === 1 && error.partial.total === 2
      && /unable to unlink old 'b\.txt'/.test(error.message) && /Batches 1-1 of 2 were already applied; refresh and review before retrying\./.test(recoveryFor(error).message));
    assert.deepEqual([await content(f, 'a.txt'), await content(f, 'c.txt')], ['a feature\n', 'c feature\n'], 'the files that changed');
    assert.deepEqual(await conflicted(f), ['a.txt', 'b.txt', 'c.txt'], 'and nothing was staged');
    partial = false;
    await assert.rejects(service.acceptSide(await service.previewBatch(f.id, ['b.txt']), 'theirs'), (error: unknown) => error === locked, 'nothing changed: the failure as Git reported it');
    f.executor.mutate = mutate;
    await service.acceptSide(await service.previewBatch(f.id, ['a.txt', 'b.txt', 'c.txt']), 'theirs');
    assert.deepEqual(await conflicted(f), []); assert.equal(f.git(['show', ':b.txt']), 'b feature\n');
  } finally { await f.close(); }
});
