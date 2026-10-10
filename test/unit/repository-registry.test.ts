import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { GitExecutor } from '../../src/git/git-executor';
import type { ReadCommand } from '../../src/git/command-builders';
import { PathPolicy } from '../../src/security/paths';
import { RepositoryRegistry, type RegistryOptions } from '../../src/repositories/repository-registry';
import { RepositoryStore } from '../../src/state/repository-store';
import { parseStatus, type StatusSnapshot } from '../../src/git/git-parser';
import { silentLogger } from '../../src/utils/logging';
import { Emitter } from '../../src/utils/events';

const oid = 'a'.repeat(40);
const bytes = (...records: string[]) => Buffer.from(records.map(record => `${record}\0`).join(''));
const clean = () => bytes(`# branch.oid ${oid}`, '# branch.head main');
const dirty = () => bytes(`# branch.oid ${oid}`, '# branch.head main', '? new.txt');
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(condition: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Condition was not reached.'); await sleep(10); }
}

/** Real directories and watchers, scripted `git status` output: no Git process is involved. */
async function harness(options: RegistryOptions = {}, intervalMs = 60_000, repositories = 1) {
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), 'git-pro-registry-')));
  const roots: string[] = [];
  for (let index = 0; index < repositories; index++) {
    const root = path.join(parent, `repo${index}`); await mkdir(path.join(root, '.git'), { recursive: true }); roots.push(root);
  }
  const state = { output: clean(), reads: 0, inFlight: 0, peak: 0, failure: undefined as Error | undefined, hold: undefined as Promise<void> | undefined,
    holds: new Map<string, Promise<void>>(), readsBy: new Map<string, number>() };
  const executor = { read: async (root: string, command: ReadCommand) => {
    if (command.kind !== 'status') return { stdout: Buffer.from('.git\n') };
    state.reads++; state.readsBy.set(root, (state.readsBy.get(root) ?? 0) + 1); state.inFlight++; state.peak = Math.max(state.peak, state.inFlight);
    try { const gate = state.holds.get(root) ?? state.hold; if (gate) await gate; if (state.failure) throw state.failure; return { stdout: state.output }; }
    finally { state.inFlight--; }
  } } as unknown as GitExecutor;
  const store = new RepositoryStore(), api = new Emitter<void>(); let apiSnapshot: StatusSnapshot = parseStatus(clean());
  const registry = new RepositoryRegistry(new PathPolicy(() => [parent], () => true), executor, store, silentLogger, intervalMs, options);
  const counts = { changed: 0, invalidated: 0 };
  registry.onDidChange(() => counts.changed++); registry.onDidInvalidate(() => counts.invalidated++);
  await registry.sync(roots.map(root => ({ root, onDidChange: api.event, snapshot: () => apiSnapshot })));
  const reset = () => { counts.changed = 0; counts.invalidated = 0; state.reads = 0; state.peak = 0; state.readsBy.clear(); };
  return {
    roots, state, store, registry, api, counts, reset, ids: registry.list().map(repo => repo.id),
    setApi: (snapshot: StatusSnapshot) => { apiSnapshot = snapshot; },
    close: async () => { registry.dispose(); store.dispose(); api.dispose(); await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  };
}

test('identical status reads publish nothing, while an explicit refresh still reloads ref-derived views', async () => {
  const h = await harness();
  try {
    const id = h.ids[0]!, installed = h.store.get(id)!; h.reset();
    await h.registry.refresh(id);
    assert.equal(h.state.reads, 1); assert.equal(h.counts.changed, 0, 'unchanged status is not a change'); assert.equal(h.counts.invalidated, 1);
    assert.equal(h.store.get(id), installed, 'identity-based consumers can skip the same snapshot');
    h.state.output = dirty(); await h.registry.refresh(id);
    assert.equal(h.counts.changed, 1); assert.equal(h.counts.invalidated, 2, 'a change also invalidates ref-derived views');
    assert.equal(h.store.get(id)!.version, installed.version + 1); assert.equal(h.store.get(id)!.changes.length, 1);
    await h.registry.refresh(id); assert.equal(h.counts.changed, 1);
  } finally { await h.close(); }
});

test('an operation marker is a change even when status bytes are identical', async () => {
  const h = await harness();
  try {
    const id = h.ids[0]!; h.reset();
    await writeFile(path.join(h.roots[0]!, '.git', 'MERGE_HEAD'), oid); await h.registry.refresh(id);
    assert.equal(h.store.get(id)!.operation, 'merging'); assert.equal(h.counts.changed, 1);
    await rm(path.join(h.roots[0]!, '.git', 'MERGE_HEAD')); await h.registry.refresh(id);
    assert.equal(h.store.get(id)!.operation, 'idle'); assert.equal(h.counts.changed, 2);
  } finally { await h.close(); }
});

test('API snapshots publish only real differences and the owned read reconciles them', async () => {
  const h = await harness({ invalidateThrottleMs: 30, debounceMs: 10 });
  try {
    const id = h.ids[0]!, installed = h.store.get(id)!; h.reset();
    h.setApi(parseStatus(clean())); h.api.fire();
    assert.equal(h.counts.changed, 0); assert.equal(h.store.get(id), installed, 'an equal API snapshot keeps the owned snapshot');
    await until(() => h.state.reads === 1); await sleep(60);
    h.reset();
    h.setApi(parseStatus(dirty())); h.api.fire();
    assert.equal(h.counts.changed, 1, 'a different API snapshot is shown immediately'); assert.equal(h.store.get(id)!.changes.length, 1);
    await until(() => h.counts.changed === 2); assert.equal(h.store.get(id)!.changes.length, 0, 'the owned read is authoritative');
  } finally { await h.close(); }
});

test('built-in API activity reloads ref-derived views at once, then at most once per throttle window', async () => {
  const h = await harness({ invalidateThrottleMs: 150, debounceMs: 10 });
  try {
    h.reset();
    h.api.fire();
    assert.equal(h.counts.invalidated, 1, 'an isolated event reloads immediately, like the old unconditional events did');
    for (let index = 0; index < 4; index++) h.api.fire();
    assert.equal(h.counts.invalidated, 1, 'a burst inside the window waits');
    await until(() => h.counts.invalidated === 2);
    await sleep(400);
    assert.equal(h.counts.invalidated, 2, 'one trailing reload, then quiet'); assert.equal(h.counts.changed, 0, 'equal status never notifies status consumers');
    h.api.fire(); assert.equal(h.counts.invalidated, 3, 'once the window has passed the next event is immediate again');
  } finally { await h.close(); }
});

test('ref-file changes in the git directory reload ref-derived views even when no API event arrives', async () => {
  const h = await harness({ invalidateThrottleMs: 60_000 });
  try {
    h.reset();
    await writeFile(path.join(h.roots[0]!, '.git', 'packed-refs'), '# pack-refs with: peeled fully-peeled sorted\n');
    await until(() => h.counts.invalidated >= 1);
    assert.equal(h.counts.changed, 0);
  } finally { await h.close(); }
});

test('an unchanged safety-net poll still revalidates ref-derived views, at the throttle cadence', async () => {
  const h = await harness({ debounceMs: 10, invalidateThrottleMs: 40 }, 40);
  try {
    h.reset(); await until(() => h.counts.invalidated >= 2, 3000);
    assert.equal(h.counts.changed, 0, 'status consumers are told nothing');
  } finally { await h.close(); }
});

test('status failures notify once per distinct message and recovery clears them', async () => {
  const h = await harness();
  try {
    const id = h.ids[0]!; h.reset();
    h.state.failure = new Error('status failed'); await h.registry.refresh(id);
    assert.equal(h.counts.changed, 1); assert.match(h.registry.errors.get(id)!, /status failed/);
    await h.registry.refresh(id); assert.equal(h.counts.changed, 1, 'the same failure is not re-announced');
    h.state.failure = new Error('different failure'); await h.registry.refresh(id); assert.equal(h.counts.changed, 2);
    h.state.failure = undefined; await h.registry.refresh(id);
    assert.equal(h.counts.changed, 3); assert.equal(h.registry.errors.has(id), false); assert.equal(h.store.get(id)!.changes.length, 0);
  } finally { await h.close(); }
});

test('background refreshes across repositories are bounded globally', async () => {
  const h = await harness({ maxConcurrentReads: 2, debounceMs: 10 }, 60_000, 5);
  try {
    h.reset(); let release!: () => void; h.state.hold = new Promise<void>(resolve => { release = resolve; });
    h.api.fire(); // the shared API event signals every repository at once
    await until(() => h.state.inFlight === 2); await sleep(80);
    assert.equal(h.state.inFlight, 2, 'the other three wait for a free slot');
    release(); await until(() => h.state.reads === 5);
    assert.equal(h.state.peak, 2);
  } finally { await h.close(); }
});

test('an explicit refresh never waits behind background reads of other repositories', async () => {
  const h = await harness({ maxConcurrentReads: 2, debounceMs: 10 }, 60_000, 4);
  try {
    h.reset(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    h.state.holds.set(h.roots[0]!, gate); h.state.holds.set(h.roots[1]!, gate);
    h.api.fire(); // repositories 0 and 1 take both slots and stall; 2 and 3 queue
    await until(() => h.state.inFlight === 2); await sleep(60);
    const started = Date.now(); await h.registry.refresh(h.ids[3]!);
    assert.ok(Date.now() - started < 1000, 'the read a mutation is waiting for ran at once');
    assert.equal(h.state.readsBy.get(h.roots[3]!), 1);
    release(); await until(() => h.state.readsBy.get(h.roots[2]!) === 1); await sleep(150);
    assert.equal(h.state.readsBy.get(h.roots[3]!), 1, 'its queued background read was dropped as redundant');
    assert.equal(h.state.readsBy.get(h.roots[0]!), 1); assert.equal(h.state.readsBy.get(h.roots[1]!), 1);
  } finally { await h.close(); }
});

test('safety-net polling pauses while inactive and wake() catches up immediately', async () => {
  let active = false;
  const h = await harness({ isActive: () => active, debounceMs: 10 }, 40);
  try {
    h.reset(); await sleep(300);
    assert.equal(h.state.reads, 0, 'no polling reads while the window is inactive');
    h.registry.wake(); await until(() => h.state.reads === 1); await sleep(200);
    assert.equal(h.state.reads, 1, 'wake() is one catch-up read, not a resumed poll');
    active = true; await until(() => h.state.reads >= 2);
  } finally { await h.close(); }
});

test('unchanged polls back off instead of repeating at the base interval', async () => {
  const h = await harness({ debounceMs: 10 }, 60);
  try {
    h.reset(); await sleep(700);
    assert.ok(h.state.reads >= 1, 'polling still happens');
    assert.ok(h.state.reads <= 4, `expected backoff, saw ${h.state.reads} reads in 0.7 s at a 60 ms base interval (about 11 without it)`);
  } finally { await h.close(); }
});

test('wake() skips repositories that were checked within the last interval', async () => {
  const h = await harness({ debounceMs: 10 }, 60_000, 2);
  try {
    h.reset(); h.registry.wake(); await sleep(150);
    assert.equal(h.state.reads, 0, 'both repositories were read moments ago');
  } finally { await h.close(); }
});

test('a throwing status listener does not swallow the invalidation that follows it', async () => {
  const h = await harness();
  try {
    const id = h.ids[0]!; h.reset();
    const bad = h.registry.onDidChange(() => { throw new Error('listener failed'); });
    h.state.output = dirty();
    await assert.rejects(h.registry.refresh(id), /listener failed/);
    assert.equal(h.counts.invalidated, 1, 'views of refs and stashes are still told to reload');
    bad.dispose(); h.state.output = clean(); await h.registry.refresh(id);
    assert.equal(h.store.get(id)!.changes.length, 0, 'and the registry keeps working afterwards');
  } finally { await h.close(); }
});

test('an API snapshot that owned reads keep reverting stops being shown, so each event no longer rebuilds views twice', async () => {
  const h = await harness({ invalidateThrottleMs: 30, debounceMs: 10 });
  try {
    const id = h.ids[0]!; h.state.output = dirty(); await h.registry.refresh(id);
    // Like `git.untrackedChanges: hidden` or VS Code's status limit: the API omits a change that git status reports.
    h.setApi(parseStatus(clean()));
    for (let round = 0; round < 2; round++) {
      const reads = h.state.reads; h.api.fire();
      assert.equal(h.store.get(id)!.changes.length, 0, 'the lossy snapshot is shown first');
      await until(() => h.state.reads > reads && h.store.get(id)!.changes.length === 1);
    }
    h.reset();
    // Waiting on an explicit refresh also waits for the read the event scheduled.
    h.api.fire(); assert.equal(h.store.get(id)!.changes.length, 1, 'the lossy snapshot is no longer installed');
    await until(() => h.state.reads === 1); await h.registry.refresh(id);
    assert.equal(h.counts.changed, 0); assert.equal(h.store.get(id)!.changes.length, 1);
  } finally { await h.close(); }
});

test('an API snapshot confirmed by the owned read keeps being shown immediately', async () => {
  const h = await harness({ invalidateThrottleMs: 30, debounceMs: 10 });
  try {
    const id = h.ids[0]!;
    for (const output of [dirty, clean, dirty, clean]) {
      h.reset(); h.state.output = output(); h.setApi(parseStatus(output())); h.api.fire();
      assert.equal(h.counts.changed, 1, 'shown before the owned read'); await until(() => h.state.reads === 1); await h.registry.refresh(id);
      assert.equal(h.counts.changed, 1, 'the owned read agrees, so nothing is rebuilt again');
    }
    assert.equal(h.store.get(id)!.changes.length, 0);
  } finally { await h.close(); }
});

test('a poll that comes due while a slow status read runs does not queue a second read behind it', async () => {
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), 'git-pro-registry-'))), root = path.join(parent, 'repo');
  await mkdir(path.join(root, '.git'), { recursive: true });
  const reads: [number, number][] = [], started = Date.now();
  const executor = { read: async (_root: string, command: ReadCommand) => {
    if (command.kind !== 'status') return { stdout: Buffer.from('.git\n') };
    const start = Date.now() - started; await sleep(250); reads.push([start, Date.now() - started]); return { stdout: clean() };
  } } as unknown as GitExecutor;
  const store = new RepositoryStore(), api = new Emitter<void>();
  const registry = new RepositoryRegistry(new PathPolicy(() => [parent], () => true), executor, store, silentLogger, 80, { debounceMs: 5, invalidateThrottleMs: 50 });
  try {
    await registry.sync([{ root, onDidChange: api.event }]); reads.length = 0;
    await sleep(2000);
    // Every poll-driven read starts at least one interval after the previous one ends (backoff only lengthens that).
    const backToBack = reads.slice(1).filter(([start], index) => start - reads[index]![1] < 40).length;
    assert.ok(reads.length >= 2, 'polling continued'); assert.equal(backToBack, 0, JSON.stringify(reads));
  } finally { registry.dispose(); store.dispose(); api.dispose(); await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('background reads wait while a mutation runs on the repository and resume afterwards', async () => {
  let busy = false;
  const h = await harness({ isBusy: () => busy, debounceMs: 10, invalidateThrottleMs: 30 });
  try {
    const id = h.ids[0]!; await sleep(60); h.reset(); busy = true;
    // Like the index watcher firing while a mutation rewrites the index.
    for (let index = 0; index < 5; index++) { h.api.fire(); await sleep(15); }
    await sleep(100); assert.equal(h.state.reads, 0, 'no status read races the running mutation');
    // The mutation's own refresh runs while it is still registered as busy.
    await h.registry.refresh(id); assert.equal(h.state.reads, 1, 'an explicit refresh is never deferred, and nothing queues behind it');
    busy = false; await sleep(80);
    assert.equal(h.state.reads, 1, 'requests made during the mutation are covered by its refresh');
    h.state.output = dirty(); h.api.fire();
    await until(() => h.state.reads === 2); await until(() => h.store.get(id)!.changes.length === 1);
    assert.equal(h.state.reads, 2, 'a request after the mutation still gets its read');
  } finally { await h.close(); }
});
