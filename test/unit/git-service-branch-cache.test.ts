import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fixture, gitExecutable } from '../fixtures/repository-fixture';
import { GitExecutor } from '../../src/git/git-executor';
import { GitService } from '../../src/git/git.service';
import type { DailyBackend } from '../../src/git/daily-backend';
import { PathPolicy } from '../../src/security/paths';
import { RepositoryRegistry } from '../../src/repositories/repository-registry';
import { RepositoryStore } from '../../src/state/repository-store';
import { OperationCoordinator } from '../../src/state/operation-coordinator';
import { Emitter } from '../../src/utils/events';
import { silentLogger } from '../../src/utils/logging';

/** Real Git behind a real registry; `invalidateThrottleMs` stands in for its 10 s window so the trailing reload is observable. */
async function branchCacheFixture() {
  const f = await fixture(), event = new Emitter<void>(), policy = new PathPolicy(() => [f.parent], () => true);
  const executor = new GitExecutor(gitExecutable, policy, silentLogger, undefined, f.env), store = new RepositoryStore(), coordinator = new OperationCoordinator(() => policy.checkTrust());
  const registry = new RepositoryRegistry(policy, executor, store, silentLogger, 600_000, { invalidateThrottleMs: 300, debounceMs: 10 });
  await writeFile(path.join(f.root, 'a.txt'), 'a\n'); f.git(['add', 'a.txt']); f.git(['commit', '-qm', 'a']);
  await registry.sync([{ root: f.root, onDidChange: event.event }]);
  const service = new GitService(registry, executor, policy, coordinator, new Proxy({}, { get: () => () => { throw new Error('No backend action is expected.'); } }) as DailyBackend), id = registry.active!.id;
  const names = async () => (await service.branchSearchSnapshot(id)).map(branch => branch.name).join(',');
  const close = async () => { registry.dispose(); coordinator.dispose(); executor.dispose(); store.dispose(); event.dispose(); await f.cleanup(); };
  return { ...f, event, executor, registry, service, id, names, close };
}

test('a registry refresh drops the display branch cache, so the Branches view Refresh shows a branch made in a terminal', async () => {
  const f = await branchCacheFixture();
  try {
    const first = await f.service.branchSearchSnapshot(f.id);
    assert.equal(await f.service.branchSearchSnapshot(f.id), first, 'reads between invalidations still share one snapshot');
    f.git(['branch', 'created-in-terminal']);
    // The view reloads on onDidInvalidate, as BranchesProvider does; GitService subscribed first, as in activate().
    const views: Promise<string>[] = []; f.registry.onDidInvalidate(() => { views.push(f.names()); });
    await f.registry.refresh(f.id);
    assert.ok(views.length > 0, 'an explicit refresh invalidates');
    assert.equal(await views.at(-1), 'created-in-terminal,main');
  } finally { await f.close(); }
});

test('a read that started before an invalidation is not reused after it', async () => {
  const f = await branchCacheFixture();
  try {
    // Hold the first answer after Git produced it, so it describes the refs from before the new branch.
    const original = f.executor.read.bind(f.executor); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    f.executor.read = async (root, command, options) => { const result = await original(root, command, options); if (command.kind === 'branches' || command.kind === 'branchIdentities') await gate; return result; };
    const stale = f.names();
    await new Promise(resolve => setTimeout(resolve, 200));
    f.executor.read = original;
    f.git(['branch', 'created-in-terminal']); await f.registry.refresh(f.id);
    const fresh = f.names(); release();
    assert.equal(await stale, 'main'); assert.equal(await fresh, 'created-in-terminal,main');
  } finally { await f.close(); }
});

test('the trailing invalidation of a burst reads the refs again instead of the snapshot cached by its first one', async () => {
  const f = await branchCacheFixture();
  try {
    const views: string[] = []; let pending: Promise<void> = Promise.resolve();
    f.registry.onDidInvalidate(() => { pending = f.names().then(value => { views.push(value); }); });
    f.event.fire(); await pending; assert.deepEqual(views, ['main'], 'the first change in a window reloads at once');
    f.git(['branch', 'second-change']); f.event.fire();
    await new Promise(resolve => setTimeout(resolve, 600)); await pending;
    assert.equal(views.at(-1), 'main,second-change', 'the trailing reload sees the later ref change');
  } finally { await f.close(); }
});
