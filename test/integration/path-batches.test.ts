import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { GitService } from '../../src/git/git.service';
import type { DailyBackend } from '../../src/git/daily-backend';
import { GitExecutor } from '../../src/git/git-executor';
import { chunkPaths } from '../../src/git/argv-chunks';
import { PathPolicy } from '../../src/security/paths';
import { RepositoryRegistry } from '../../src/repositories/repository-registry';
import { RepositoryStore } from '../../src/state/repository-store';
import { OperationCoordinator } from '../../src/state/operation-coordinator';
import { Emitter } from '../../src/utils/events';
import { silentLogger } from '../../src/utils/logging';
import { recoveryFor } from '../../src/utils/recovery';
import { fixture, gitExecutable } from '../fixtures/repository-fixture';

test('staging, unstaging and discarding more files than fit on one command line works', async () => {
  const f = await fixture(); const event = new Emitter<void>(); const stageBatches: number[] = [];
  const policy = new PathPolicy(() => [f.parent], () => true);
  const executor = new GitExecutor(gitExecutable, policy, silentLogger, undefined, f.env);
  const store = new RepositoryStore(); const registry = new RepositoryRegistry(policy, executor, store, silentLogger, 60_000, { debounceMs: 60_000 });
  const coordinator = new OperationCoordinator(() => policy.checkTrust());
  // Like the built-in API (splitInChunks in VS Code's git extension), this backend splits a long path list into several Git processes itself.
  const backend: DailyBackend = {
    stage: async (root, files) => { stageBatches.push(files.length); for (const batch of chunkPaths(files)) f.git(['--literal-pathspecs', 'add', '--', ...batch], root); },
    commit: async () => undefined, fetch: async () => undefined, push: async () => undefined, createBranch: async () => undefined, checkout: async () => undefined,
    deleteBranch: async () => undefined, setUpstream: async () => undefined, remotes: async () => []
  };
  try {
    // About 140 characters per path keeps the whole path under Windows' 260-character limit while 820 of them exceed 100,000 characters.
    const count = 820, files = Array.from({ length: count }, (_, index) => `packages/package-name-${String(index % 25).padStart(3, '0')}-with-a-descriptive-suffix/source/components/widgets/specialized/widget-component-with-a-long-name-${String(index).padStart(5, '0')}.ts`);
    assert.ok(files.join(' ').length > 100_000, 'the selection cannot fit one command line on any platform we support');
    for (const directory of new Set(files.map(file => path.dirname(file)))) await mkdir(path.join(f.root, directory), { recursive: true });
    for (let start = 0; start < count; start += 100) await Promise.all(files.slice(start, start + 100).map(file => writeFile(path.join(f.root, file), `export const value = '${file}';\n`)));
    f.git(['add', '-A']); f.git(['commit', '-q', '-m', 'base']);
    for (let start = 0; start < count; start += 100) await Promise.all(files.slice(start, start + 100).map(file => appendFile(path.join(f.root, file), '// edited\n')));
    await registry.sync([{ root: f.root, onDidChange: event.event }]);
    const git = new GitService(registry, executor, policy, coordinator, backend), id = registry.active!.id;
    const staged = async () => (await git.state(id)).changes.filter(change => change.group === 'staged').length;
    const working = async () => (await git.state(id)).changes.filter(change => change.group === 'working').length;
    assert.equal(await working(), count);

    await git.stage(id, files);
    assert.deepEqual(stageBatches, [count], 'one backend call, so VS Code refreshes its status once');
    assert.equal(await staged(), count); assert.equal(await working(), 0);

    await git.unstage(id, files);
    assert.equal(await staged(), 0); assert.equal(await working(), count);

    const preview = await git.preview(id, files);
    assert.notEqual(preview.working, '', 'the scoped working digest covers every batch');
    await git.discard(preview);
    assert.equal((await git.state(id)).changes.length, 0);
    assert.equal(await readFile(path.join(f.root, files[count - 1]!), 'utf8'), `export const value = '${files[count - 1]}';\n`);
  } finally { coordinator.dispose(); registry.dispose(); executor.dispose(); store.dispose(); event.dispose(); await f.cleanup(); }
});

test('Stage All and Unstage All are no-ops on a clean tree and handle more than one 5000-path group', async () => {
  const f = await fixture(); const event = new Emitter<void>(); const stageCalls: number[] = []; let failAfter = Number.POSITIVE_INFINITY;
  const policy = new PathPolicy(() => [f.parent], () => true);
  const executor = new GitExecutor(gitExecutable, policy, silentLogger, undefined, f.env);
  const store = new RepositoryStore(); const registry = new RepositoryRegistry(policy, executor, store, silentLogger, 60_000, { debounceMs: 60_000 });
  const coordinator = new OperationCoordinator(() => policy.checkTrust());
  const backend: DailyBackend = {
    stage: async (root, files) => { if (failAfter-- <= 0) throw new Error('Git: index.lock exists'); stageCalls.push(files.length); for (const batch of chunkPaths(files)) f.git(['--literal-pathspecs', 'add', '--', ...batch], root); },
    commit: async () => undefined, fetch: async () => undefined, push: async () => undefined, createBranch: async () => undefined, checkout: async () => undefined,
    deleteBranch: async () => undefined, setUpstream: async () => undefined, remotes: async () => []
  };
  try {
    await writeFile(path.join(f.root, 'base.txt'), 'base\n'); f.git(['add', '-A']); f.git(['commit', '-q', '-m', 'base']);
    await registry.sync([{ root: f.root, onDidChange: event.event }]);
    const git = new GitService(registry, executor, policy, coordinator, backend), id = registry.active!.id;
    assert.equal(await git.stageAll(id), 0); assert.equal(await git.unstageAll(id), 0); assert.deepEqual(stageCalls, []);

    // Tracked files missing from the working tree: staging deletions writes no objects, which keeps this fast on Windows.
    const count = 5050, files = Array.from({ length: count }, (_, index) => `many/${String(index).padStart(5, '0')}.txt`), blob = f.git(['hash-object', '-w', 'base.txt']).trim();
    const indexed = spawnSync(gitExecutable, ['update-index', '--index-info'], { cwd: f.root, env: f.env, input: files.map(file => `100644 ${blob}\t${file}\n`).join('') });
    assert.equal(indexed.status, 0, String(indexed.stderr)); f.git(['commit', '-q', '-m', 'many']);
    assert.equal(await git.stageAll(id), count);
    assert.deepEqual(stageCalls, [5000, 50], 'one backend call per 5000-path group');
    const groups = async () => { const changes = (await git.state(id)).changes; return { staged: changes.filter(change => change.group === 'staged').length, working: changes.filter(change => change.group === 'working').length }; };
    assert.deepEqual(await groups(), { staged: count, working: 0 });
    assert.equal(await git.unstageAll(id), count);
    assert.deepEqual(await groups(), { staged: 0, working: count });

    // A later group failing must say that the first group already took effect.
    failAfter = 1;
    const failure = await git.stageAll(id).then(() => undefined, (error: unknown) => error);
    assert.ok(failure instanceof Error && /Batches 1-1 of 2 were already applied/.test(failure.message), String(failure));
    assert.match(recoveryFor(failure).message, /Batches 1-1 of 2 were already applied/);
    assert.deepEqual(await groups(), { staged: 5000, working: 50 });
  } finally { coordinator.dispose(); registry.dispose(); executor.dispose(); store.dispose(); event.dispose(); await f.cleanup(); }
});
