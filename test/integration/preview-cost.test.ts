import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { GitService } from '../../src/git/git.service';
import type { DailyBackend } from '../../src/git/daily-backend';
import { DiffService } from '../../src/git/diff/diff.service';
import { GitExecutor } from '../../src/git/git-executor';
import { PathPolicy } from '../../src/security/paths';
import { RepositoryRegistry } from '../../src/repositories/repository-registry';
import { RepositoryStore } from '../../src/state/repository-store';
import { OperationCoordinator } from '../../src/state/operation-coordinator';
import { Emitter } from '../../src/utils/events';
import { silentLogger } from '../../src/utils/logging';
import { fixture, gitExecutable } from '../fixtures/repository-fixture';

/** First non-option word of a Git argv, e.g. `status` or `ls-files`. */
function subcommand(args: readonly string[]): string {
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (value === '-c') { index++; continue; }
    if (!value.startsWith('-')) return value;
  }
  return '';
}

async function costFixture() {
  const f = await fixture(); const event = new Emitter<void>(); const calls: string[] = [];
  const policy = new PathPolicy(() => [f.parent], () => true);
  const executor = new GitExecutor(gitExecutable, policy, silentLogger, (file, args, options) => { calls.push(subcommand(args)); return spawn(file, [...args], options); }, f.env);
  const store = new RepositoryStore(); const registry = new RepositoryRegistry(policy, executor, store, silentLogger, 60_000, { debounceMs: 60_000 }); // watcher-triggered reads would race the call counts below
  const coordinator = new OperationCoordinator(() => policy.checkTrust());
  const backend: DailyBackend = {
    stage: async (root, files) => { f.git(['--literal-pathspecs', 'add', '--', ...files], root); },
    commit: async (root, message) => { f.git(['commit', '-m', message], root); },
    fetch: async () => undefined, push: async () => undefined, createBranch: async () => undefined, checkout: async () => undefined, deleteBranch: async () => undefined, setUpstream: async () => undefined,
    remotes: async () => []
  };
  await registry.sync([{ root: f.root, onDidChange: event.event }]);
  const git = new GitService(registry, executor, policy, coordinator, backend); const id = registry.active!.id;
  const close = async () => { coordinator.dispose(); registry.dispose(); executor.dispose(); store.dispose(); event.dispose(); await f.cleanup(); };
  return { ...f, rawGit: f.git, git, id, calls, close };
}
const options = { amend: false, signoff: false, noVerify: false };

/** The two reads behind the refs fingerprint run in parallel, so their spawn order is not fixed. */
const settled = (calls: readonly string[]) => calls.join(' ').replace(/config for-each-ref/g, 'for-each-ref config').split(' ');
test('a preview needs the status it already reads plus branch refs, never the whole index or working tree', async () => {
  const f = await costFixture();
  try {
    await writeFile(path.join(f.root, 'tracked.txt'), 'one\n'); f.rawGit(['add', 'tracked.txt']); f.rawGit(['commit', '-m', 'base']);
    await writeFile(path.join(f.root, 'tracked.txt'), 'two\n'); await writeFile(path.join(f.root, 'staged.txt'), 'staged\n'); f.rawGit(['add', 'staged.txt']); await writeFile(path.join(f.root, 'new.txt'), 'new\n');
    f.calls.length = 0;
    const preview = await f.git.preview(f.id);
    assert.deepEqual(settled(f.calls), ['status', 'for-each-ref', 'config']);
    assert.equal(preview.working, '', 'working content is only fingerprinted for scoped discard previews');
    assert.deepEqual(preview.status.changes.map(change => `${change.group}:${change.path}`).sort(), ['staged:staged.txt', 'untracked:new.txt', 'working:tracked.txt']);
    f.calls.length = 0;
    const discard = await f.git.preview(f.id, ['tracked.txt']);
    assert.deepEqual(settled(f.calls), ['status', 'diff', 'for-each-ref', 'config'], 'a discard preview adds only the scoped working diff');
    assert.notEqual(discard.working, '');
  } finally { await f.close(); }
});

test('an unrelated 20 MiB unstaged edit no longer blocks committing what is staged', async () => {
  const f = await costFixture();
  try {
    await writeFile(path.join(f.root, 'big.txt'), 'seed\n'); f.rawGit(['add', 'big.txt']); f.rawGit(['commit', '-m', 'base']);
    const line = `${'x'.repeat(79)}\n`; await writeFile(path.join(f.root, 'big.txt'), line.repeat(Math.ceil(20 * 1024 * 1024 / line.length)));
    await writeFile(path.join(f.root, 'small.txt'), 'small\n'); await f.git.stage(f.id, ['small.txt']);
    const result = await f.git.commit(await f.git.preview(f.id), 'small only', options);
    assert.equal(f.rawGit(['rev-parse', 'HEAD']).trim(), result.oid);
    assert.equal(f.rawGit(['show', '--name-only', '--format=', 'HEAD']).trim(), 'small.txt');
    assert.ok((await f.git.preview(f.id)).status.changes.some(change => change.path === 'big.txt' && change.group === 'working'), 'the large edit is untouched');
  } finally { await f.close(); }
});

test('commit and click-to-diff avoid whole-repository reads and repeated status runs', async () => {
  const f = await costFixture();
  try {
    await writeFile(path.join(f.root, 'a.txt'), 'a\n'); await writeFile(path.join(f.root, 'b.txt'), 'b\n'); f.rawGit(['add', '.']); f.rawGit(['commit', '-m', 'base']);
    await writeFile(path.join(f.root, 'a.txt'), 'a2\n'); await writeFile(path.join(f.root, 'b.txt'), 'b2\n'); await f.git.stage(f.id, ['b.txt']);
    f.calls.length = 0;
    const status = await f.git.state(f.id); const entry = status.changes.find(change => change.path === 'a.txt' && change.group === 'working')!;
    const prepared = await new DiffService(f.git).prepare(f.id, entry, false, { head: status.oid });
    assert.equal(prepared.left.toString(), 'a\n');
    assert.deepEqual(f.calls.filter(call => call !== 'cat-file'), ['status', 'ls-files'], 'one status run and one index lookup scoped to the file');
    assert.ok(f.calls.filter(call => call === 'cat-file').length <= 2);
    f.calls.length = 0;
    const preview = await f.git.preview(f.id); await f.git.commit(preview, 'commit b', options);
    assert.ok(!f.calls.includes('ls-files') && !f.calls.includes('diff'), `unexpected whole-repository reads: ${f.calls.join(' ')}`);
    assert.deepEqual(settled(f.calls), ['status', 'for-each-ref', 'config', 'status', 'for-each-ref', 'config', 'rev-parse', 'status'], 'review (status, refs), action (status, refs, new HEAD) and one refresh');
  } finally { await f.close(); }
});

test('the staged fingerprint still detects index changes but ignores unrelated working edits', async () => {
  const f = await costFixture();
  try {
    await writeFile(path.join(f.root, 'a.txt'), 'a\n'); await writeFile(path.join(f.root, 'b.txt'), 'b\n'); f.rawGit(['add', '.']); f.rawGit(['commit', '-m', 'base']);
    await writeFile(path.join(f.root, 'a.txt'), 'reviewed\n'); await f.git.stage(f.id, ['a.txt']);
    const unaffected = await f.git.preview(f.id); await writeFile(path.join(f.root, 'b.txt'), 'edited after review\n'); await writeFile(path.join(f.root, 'untracked.txt'), 'x\n');
    const again = await f.git.preview(f.id); assert.equal(again.index, unaffected.index, 'working-tree edits are not index changes');
    await writeFile(path.join(f.root, 'a.txt'), 'swapped\n'); f.rawGit(['add', 'a.txt']);
    const swapped = await f.git.preview(f.id); assert.notEqual(swapped.index, unaffected.index, 'same path, different staged blob');
    await assert.rejects(f.git.commit(unaffected, 'stale', options), /changed/);
    f.rawGit(['mv', 'b.txt', 'renamed.txt']); const renamed = await f.git.preview(f.id); assert.notEqual(renamed.index, swapped.index);
    f.rawGit(['reset', '-q', 'renamed.txt', 'b.txt']); const reverted = await f.git.preview(f.id); assert.equal(reverted.index, swapped.index, 'unstaging the rename restores the earlier staged set');
    const result = await f.git.commit(reverted, 'reviewed content', options); assert.equal(f.rawGit(['show', 'HEAD:a.txt']), 'swapped\n'); assert.equal(f.rawGit(['rev-parse', 'HEAD']).trim(), result.oid);
  } finally { await f.close(); }
});

test('the refs fingerprint still notices moved branches and changed upstream configuration', async () => {
  const f = await costFixture();
  try {
    await writeFile(path.join(f.root, 'a.txt'), 'a\n'); f.rawGit(['add', '.']); f.rawGit(['commit', '-m', 'base']); f.rawGit(['branch', 'topic']);
    const base = await f.git.preview(f.id);
    assert.equal((await f.git.preview(f.id)).refs, base.refs, 'unchanged refs give the same fingerprint');
    f.rawGit(['config', 'branch.topic.remote', 'origin']); f.rawGit(['config', 'branch.topic.merge', 'refs/heads/topic']);
    const configured = await f.git.preview(f.id); assert.notEqual(configured.refs, base.refs, 'an upstream change is a refs change');
    await writeFile(path.join(f.root, 'b.txt'), 'b\n'); f.rawGit(['add', 'b.txt']); f.rawGit(['commit', '-m', 'next']); f.rawGit(['branch', '-f', 'topic', 'HEAD']); f.rawGit(['reset', '-q', '--soft', 'HEAD~1']); f.rawGit(['reset', '-q']);
    assert.notEqual((await f.git.preview(f.id)).refs, configured.refs, 'a moved branch is a refs change');
  } finally { await f.close(); }
});
