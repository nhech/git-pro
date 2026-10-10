import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { GitService, DailyError } from '../../src/git/git.service';
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
import { changedPathsInFolder } from '../../src/views/changes/folder-selection';

async function dailyFixture() {
  const f = await fixture(); const event = new Emitter<void>();
  const policy = new PathPolicy(() => [f.parent], () => true);
  const executor = new GitExecutor(gitExecutable, policy, silentLogger, undefined, f.env);
  const store = new RepositoryStore(); const registry = new RepositoryRegistry(policy, executor, store, silentLogger, 60_000);
  const coordinator = new OperationCoordinator(() => policy.checkTrust());
  const backend: DailyBackend = {
    stage: async (root, files) => { f.git(['--literal-pathspecs', 'add', '--', ...files], root); },
    commit: async (root, message, opts) => { f.git(['commit', '-m', message, ...(opts.amend ? ['--amend'] : []), ...(opts.signoff ? ['--signoff'] : []), ...(opts.noVerify ? ['--no-verify'] : [])], root); },
    fetch: async (root, remote) => { f.git(['fetch', remote ?? 'origin'], root); },
    push: async (root, remote, branch, upstream) => { f.git(['push', ...(upstream ? ['--set-upstream'] : []), remote, branch], root); },
    createBranch: async (root, name, checkout, base) => { f.git(checkout ? ['checkout', '-b', name, ...(base ? [base] : [])] : ['branch', name, ...(base ? [base] : [])], root); },
    checkout: async (root, name) => { f.git(['checkout', name], root); },
    deleteBranch: async (root, name, force) => { f.git(['branch', force ? '-D' : '-d', name], root); },
    setUpstream: async (root, name, upstream) => { f.git(['branch', `--set-upstream-to=${upstream}`, name], root); },
    remotes: async root => f.git(['remote'], root).trim().split(/\r?\n/).filter(Boolean).map(name => ({ name, fetchUrl: f.git(['remote', 'get-url', name], root).trim() }))
  };
  await registry.sync([{ root: f.root, onDidChange: event.event }]);
  const git = new GitService(registry, executor, policy, coordinator, backend); const id = registry.active!.id;
  const close = async () => { coordinator.dispose(); registry.dispose(); executor.dispose(); store.dispose(); event.dispose(); await f.cleanup(); };
  return { ...f, rawGit: f.git, git, id, backend, close };
}
const options = { amend: false, signoff: false, noVerify: false };

test('warm branch displays follow create, checkout, rename and delete across linked worktrees', async () => {
  const f = await dailyFixture();
  try {
    await writeFile(path.join(f.root, 'base.txt'), 'base\n');
    await f.git.stage(f.id, ['base.txt']); await f.git.commit(await f.git.preview(f.id), 'base', options);
    const linked = path.join(f.parent, 'linked'); f.rawGit(['worktree', 'add', '-b', 'linked', linked]);
    const event = () => ({ dispose() {} });
    await f.git.registry.sync([{ root: f.root, onDidChange: event }, { root: linked, onDidChange: event }]);
    const linkedId = f.git.registry.list().find(repo => repo.root === linked)!.id;
    const before = await f.git.branchSearchSnapshot(f.id), siblingBefore = await f.git.branchSearchSnapshot(linkedId);
    assert.strictEqual(await f.git.branchSearchSnapshot(f.id), before);
    await f.git.createBranch(f.id, 'created', true);
    const created = await f.git.branchSearchSnapshot(f.id), siblingCreated = await f.git.branchSearchSnapshot(linkedId);
    assert.ok(created.some(branch => branch.name === 'created' && branch.worktree));
    assert.ok(siblingCreated.some(branch => branch.name === 'created' && branch.worktree));
    assert.ok(!before.some(branch => branch.name === 'created')); assert.ok(!siblingBefore.some(branch => branch.name === 'created'));
    await f.git.checkout(f.id, 'main');
    assert.equal((await f.git.branchSearchSnapshot(linkedId)).find(branch => branch.name === 'created')!.worktree, '');
    await f.git.branchAction(await f.git.preview(f.id), 'created', 'rename', 'renamed');
    for (const id of [f.id, linkedId]) {
      const list = await f.git.branchSearchSnapshot(id); assert.ok(list.some(branch => branch.name === 'renamed')); assert.ok(!list.some(branch => branch.name === 'created'));
    }
    await f.git.branchAction(await f.git.preview(f.id), 'renamed', 'delete');
    for (const id of [f.id, linkedId]) assert.ok(!(await f.git.branchSearchSnapshot(id)).some(branch => branch.name === 'renamed'));
    assert.equal(f.rawGit(['symbolic-ref', '--short', 'HEAD']).trim(), 'main');
    assert.equal(f.rawGit(['status', '--porcelain']), ''); assert.equal(await readFile(path.join(f.root, 'base.txt'), 'utf8'), 'base\n');
  } finally { await f.close(); }
});

test('partially failing mutation evicts display reads populated during its action', async () => {
  const f = await dailyFixture();
  try {
    await writeFile(path.join(f.root, 'base.txt'), 'base\n');
    await f.git.stage(f.id, ['base.txt']); await f.git.commit(await f.git.preview(f.id), 'base', options);
    const before = await f.git.branchSearchSnapshot(f.id);
    f.backend.createBranch = async () => {
      assert.ok(!(await f.git.branchSearchSnapshot(f.id)).some(branch => branch.name === 'partial'));
      f.rawGit(['branch', 'partial']); throw new Error('fixture failure after actual ref creation');
    };
    await assert.rejects(f.git.createBranch(f.id, 'partial', false), /fixture failure after actual ref creation/);
    assert.ok((await f.git.branchSearchSnapshot(f.id)).some(branch => branch.name === 'partial'));
    assert.ok(!before.some(branch => branch.name === 'partial'));
    assert.equal(f.rawGit(['symbolic-ref', '--short', 'HEAD']).trim(), 'main'); assert.equal(f.rawGit(['status', '--porcelain']), '');
  } finally { await f.close(); }
});

test('unborn unstage preserves working files and unrelated staged entries', async () => {
  const f = await dailyFixture();
  try {
    await writeFile(path.join(f.root, 'first.txt'), 'first'); await writeFile(path.join(f.root, '日本語 file.txt'), 'second');
    await f.git.stage(f.id, ['first.txt', '日本語 file.txt']); await f.git.unstage(f.id, ['first.txt']);
    assert.equal(await readFile(path.join(f.root, 'first.txt'), 'utf8'), 'first');
    const staged = (await f.git.preview(f.id)).status.changes.filter(c => c.group === 'staged');
    assert.deepEqual(staged.map(c => c.path), ['日本語 file.txt']);
  } finally { await f.close(); }
});

test('staged-only commit and diff preserve partial staging; discard restores index', async () => {
  const f = await dailyFixture();
  try {
    const file = path.join(f.root, 'mixed.txt'); await writeFile(file, 'base\n');
    await f.git.stage(f.id, ['mixed.txt']); await f.git.commit(await f.git.preview(f.id), 'base', options);
    await writeFile(file, 'base\nstaged\n'); await f.git.stage(f.id, ['mixed.txt']); await writeFile(file, 'base\nstaged\nunstaged\n');
    const snapshot = await f.git.preview(f.id); const diffs = new DiffService(f.git);
    const staged = await diffs.prepare(f.id, snapshot.status.changes.find(c => c.group === 'staged')!);
    assert.equal(staged.left.toString(), 'base\n'); assert.equal(staged.right?.toString(), 'base\nstaged\n');
    const working = await diffs.prepare(f.id, snapshot.status.changes.find(c => c.group === 'working')!);
    assert.equal(working.left.toString(), 'base\nstaged\n'); assert.equal(working.workingPath, file);
    await f.git.commit(snapshot, 'staged only\n\nBody', { ...options, signoff: true });
    assert.equal(f.rawGit(['show', 'HEAD:mixed.txt']), 'base\nstaged\n');
    assert.match(f.rawGit(['log', '-1', '--format=%B']), /Signed-off-by: Fixture/);
    assert.equal(await readFile(file, 'utf8'), 'base\nstaged\nunstaged\n');
    assert.equal((await f.git.preview(f.id)).status.changes[0]?.group, 'working');
    await f.git.discard(await f.git.preview(f.id, ['mixed.txt']));
    assert.equal(await readFile(file, 'utf8'), 'base\nstaged\n');
    await assert.rejects(f.git.commit(await f.git.preview(f.id), 'empty', options), /Stage changes/);
  } finally { await f.close(); }
});

test('stale discard, branch refs and in-progress operations block mutation', async () => {
  const f = await dailyFixture();
  try {
    const file = path.join(f.root, 'base.txt'); await writeFile(file, 'base'); await f.git.stage(f.id, ['base.txt']); await f.git.commit(await f.git.preview(f.id), 'base', options);
    await writeFile(file, 'reviewed'); const reviewed = await f.git.preview(f.id, ['base.txt']); await writeFile(file, 'changed again');
    await assert.rejects(f.git.discard(reviewed), /changed/); assert.equal(await readFile(file, 'utf8'), 'changed again');
    await f.git.discard(await f.git.preview(f.id, ['base.txt'])); await f.git.createBranch(f.id, 'old', false);
    const branchPreview = await f.git.preview(f.id); await f.git.createBranch(f.id, 'new', false);
    await assert.rejects(f.git.branchAction(branchPreview, 'old', 'delete'), /changed/);
    await writeFile(path.join(f.root, '.git', 'MERGE_HEAD'), branchPreview.head!);
    await assert.rejects(f.git.stage(f.id, ['base.txt']), /operation is in progress/);
  } finally { await f.close(); }
});

test('rename unstage expands original path; born additions and deletions diff correctly', async () => {
  const f = await dailyFixture();
  try {
    await writeFile(path.join(f.root, 'before.txt'), 'base'); await f.git.stage(f.id, ['before.txt']); await f.git.commit(await f.git.preview(f.id), 'base', options);
    // Use the fixture backend to perform an external rename without extension UI.
    const { rename, unlink } = await import('node:fs/promises'); await rename(path.join(f.root, 'before.txt'), path.join(f.root, 'after.txt'));
    await f.git.stage(f.id, ['before.txt', 'after.txt']);
    const changes = (await f.git.preview(f.id)).status.changes; const diff = await new DiffService(f.git).prepare(f.id, changes[0]!);
    assert.equal(diff.left.toString(), 'base'); assert.equal(diff.right?.toString(), 'base');
    await f.git.unstage(f.id, ['after.txt']); assert.equal((await f.git.preview(f.id)).status.changes.some(c => c.group === 'staged'), false);
    await unlink(path.join(f.root, 'after.txt')); const deleted = (await f.git.preview(f.id)).status.changes.find(c => c.path === 'before.txt')!;
    const removed = await new DiffService(f.git).prepare(f.id, deleted); assert.equal(removed.left.toString(), 'base'); assert.equal(removed.right?.length, 0);
  } finally { await f.close(); }
});

test('nested repository and directory staging are rejected', async () => {
  const f = await dailyFixture();
  try {
    await mkdir(path.join(f.root, 'folder')); await writeFile(path.join(f.root, 'folder', 'file'), 'nested');
    assert.ok((await f.git.preview(f.id)).status.changes.some(c => c.path === 'folder/file'));
    await assert.rejects(f.git.stage(f.id, ['folder']), /individual/);
    f.rawGit(['init', '-b', 'main'], path.join(f.root, 'folder'));
    await f.git.registry.sync([f.root, path.join(f.root, 'folder')].map(root => ({ root, onDidChange: () => ({ dispose() {} }) })));
    await assert.rejects(f.git.stage(f.id, ['folder/file']), /nested repositories/);
    await assert.rejects(f.git.stage(f.id, ['../outside']), /path|outside/i);
  } finally { await f.close(); }
});

test('status-scoped folder stage, unstage and discard preserve unrelated entries',async()=>{
  const f=await dailyFixture();
  try{
    await mkdir(path.join(f.root,'src','one'),{recursive:true});await mkdir(path.join(f.root,'src','one-more'),{recursive:true});
    for(const name of ['working.txt','tracked[1].txt','staged.txt','discard.txt'])await writeFile(path.join(f.root,'src/one',name),'base');
    await writeFile(path.join(f.root,'src/one-more/other.txt'),'base');
    await f.git.stage(f.id,['src/one/working.txt','src/one/tracked[1].txt','src/one/staged.txt','src/one/discard.txt','src/one-more/other.txt']);
    await f.git.commit(await f.git.preview(f.id),'folder fixture',options);
    await writeFile(path.join(f.root,'src/one/working.txt'),'changed');
    await writeFile(path.join(f.root,'src/one/staged.txt'),'staged change');await f.git.stage(f.id,['src/one/staged.txt']);
    await writeFile(path.join(f.root,'src/one/discard.txt'),'discard this');
    await writeFile(path.join(f.root,'src/one-more/other.txt'),'outside folder');
    await writeFile(path.join(f.root,'src/one/new.txt'),'untracked');
    await writeFile(path.join(f.root,'src/one/untracked[1].txt'),'untracked');
    const snapshot=await f.git.preview(f.id),folder=(group:'working'|'staged'|'untracked')=>changedPathsInFolder(snapshot.status.changes,group,'src/one/');
    const stagePaths=[...folder('working'),...folder('untracked')];assert.deepEqual(stagePaths,['src/one/discard.txt','src/one/working.txt','src/one/new.txt','src/one/untracked[1].txt']);
    await f.git.stage(f.id,stagePaths);
    const staged=(await f.git.preview(f.id)).status.changes.filter(change=>change.group==='staged').map(change=>change.path);
    assert.ok(staged.includes('src/one/staged.txt'));assert.ok(staged.includes('src/one/untracked[1].txt'));assert.ok(!staged.includes('src/one-more/other.txt'));
    assert.ok((await f.git.preview(f.id)).status.changes.some(change=>change.group==='working'&&change.path==='src/one-more/other.txt'));
    const unstagePaths=changedPathsInFolder((await f.git.preview(f.id)).status.changes,'staged','src/one/');await f.git.unstage(f.id,unstagePaths);
    assert.ok((await f.git.preview(f.id)).status.changes.some(change=>change.group==='working'&&change.path==='src/one-more/other.txt'));
    const discardSnapshot=await f.git.preview(f.id),discardPaths=changedPathsInFolder(discardSnapshot.status.changes,'working','src/one/');
    await f.git.discard(await f.git.preview(f.id,discardPaths));
    assert.equal(await readFile(path.join(f.root,'src/one/discard.txt'),'utf8'),'base');
    assert.equal((await f.git.preview(f.id)).status.changes.some(change=>change.path==='src/one-more/other.txt'&&change.group==='working'),true);
  }finally{await f.close();}
});

test('literal filenames stage singly; checked-out worktree and dirty checkout are protected', async () => {
  const f = await dailyFixture();
  try {
    await writeFile(path.join(f.root, 'a[1].txt'), 'literal'); await writeFile(path.join(f.root, 'a1.txt'), 'unrelated');
    await f.git.stage(f.id, ['a[1].txt']);
    assert.deepEqual((await f.git.preview(f.id)).status.changes.filter(c => c.group === 'staged').map(c => c.path), ['a[1].txt']);
    await f.git.commit(await f.git.preview(f.id), 'literal', options);
    await f.git.createBranch(f.id, 'side', false); await assert.rejects(f.git.checkout(f.id, 'side'), /local changes/);
    f.rawGit(['worktree', 'add', path.join(f.parent, 'linked'), 'side']);
    await assert.rejects(f.git.branchAction(await f.git.preview(f.id), 'side', 'force-delete'), /worktree/);
  } finally { await f.close(); }
});

test('branch rename/delete/upstream and divergent rebase preserve expected refs and files', async () => {
  const f = await dailyFixture();
  try {
    await writeFile(path.join(f.root, 'base'), 'base'); await f.git.stage(f.id, ['base']); await f.git.commit(await f.git.preview(f.id), 'base', options);
    await f.git.createBranch(f.id, 'old', false); await f.git.branchAction(await f.git.preview(f.id), 'old', 'rename', 'renamed');
    assert.ok((await f.git.branches(f.id)).some(b => b.name === 'renamed')); await f.git.branchAction(await f.git.preview(f.id), 'renamed', 'delete');
    assert.equal((await f.git.branches(f.id)).some(b => b.name === 'renamed'), false);
    const bare = path.join(f.parent, 'remote.git'); await mkdir(bare); f.rawGit(['init', '--bare', '--initial-branch=main'], bare); f.rawGit(['remote', 'add', 'origin', bare]);
    await f.git.push(f.id, { remote: 'origin', branch: 'main' });
    await f.git.branchAction(await f.git.preview(f.id), 'main', 'unset-upstream'); assert.equal((await f.git.preview(f.id)).status.upstream, undefined);
    await f.git.setUpstream(f.id, 'main', 'origin/main');
    const other = path.join(f.parent, 'other'); f.rawGit(['clone', bare, other], f.parent); f.rawGit(['config', 'commit.gpgsign', 'false'], other);
    await writeFile(path.join(other, 'remote'), 'remote'); f.rawGit(['add', '.'], other); f.rawGit(['commit', '-m', 'remote'], other); f.rawGit(['push'], other);
    await writeFile(path.join(f.root, 'local'), 'local'); await f.git.stage(f.id, ['local']); const before = await f.git.commit(await f.git.preview(f.id), 'local', options);
    f.rawGit(['config', 'rebase.autostash', 'true']); await f.git.pull(f.id, 'rebase');
    assert.notEqual((await f.git.preview(f.id)).head, before.oid); assert.equal(await readFile(path.join(f.root, 'remote'), 'utf8'), 'remote'); assert.equal(await readFile(path.join(f.root, 'local'), 'utf8'), 'local');
    assert.equal(f.rawGit(['rev-list', '--count', 'HEAD']).trim(), '3');
  } finally { await f.close(); }
});

test('hooks reject by default; opt-in skip and amend work; stale index blocks commit', async () => {
  const f = await dailyFixture();
  try {
    const file = path.join(f.root, 'hooked'); await writeFile(file, 'base'); await f.git.stage(f.id, ['hooked']);
    await writeFile(path.join(f.root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await assert.rejects(f.git.commit(await f.git.preview(f.id), 'blocked', options));
    await f.git.commit(await f.git.preview(f.id), 'allowed', { ...options, noVerify: true });
    const count = f.rawGit(['rev-list', '--count', 'HEAD']);
    await writeFile(file, 'amended'); await f.git.stage(f.id, ['hooked']);
    await f.git.commit(await f.git.preview(f.id), 'amended', { ...options, amend: true, noVerify: true });
    assert.equal(f.rawGit(['rev-list', '--count', 'HEAD']), count); assert.equal(f.rawGit(['show', 'HEAD:hooked']), 'amended');
    await writeFile(file, 'reviewed'); await f.git.stage(f.id, ['hooked']); const preview = await f.git.preview(f.id);
    await writeFile(file, 'external'); f.rawGit(['add', 'hooked']);
    await assert.rejects(f.git.commit(preview, 'stale', { ...options, noVerify: true }), /changed/);
  } finally { await f.close(); }
});

test('local bare remote: publish, fetch, FF pull, divergence, merge and push failure', async () => {
  const f = await dailyFixture();
  try {
    const bare = path.join(f.parent, 'remote.git'); await mkdir(bare); f.rawGit(['init', '--bare', '--initial-branch=main'], bare);
    f.rawGit(['remote', 'add', 'origin', bare]); await writeFile(path.join(f.root, 'base'), 'base'); await f.git.stage(f.id, ['base']); await f.git.commit(await f.git.preview(f.id), 'base', options);
    await assert.rejects(f.git.push(f.id), /upstream/); await f.git.push(f.id, { remote: 'origin', branch: 'main' });
    assert.equal(f.rawGit(['rev-parse', 'refs/heads/main'], bare), f.rawGit(['rev-parse', 'HEAD']));
    const other = path.join(f.parent, 'other'); f.rawGit(['clone', bare, other], f.parent); f.rawGit(['config', 'commit.gpgsign', 'false'], other);
    await writeFile(path.join(other, 'remote-file'), 'remote'); f.rawGit(['add', '.'], other); f.rawGit(['commit', '-m', 'remote'], other); f.rawGit(['push'], other);
    await f.git.fetch(f.id, 'origin'); await f.git.pull(f.id, 'ff-only'); assert.equal(await readFile(path.join(f.root, 'remote-file'), 'utf8'), 'remote');
    await writeFile(path.join(f.root, 'local'), 'local'); await f.git.stage(f.id, ['local']); await f.git.commit(await f.git.preview(f.id), 'local', options);
    await writeFile(path.join(other, 'remote-file'), 'remote2'); f.rawGit(['add', '.'], other); f.rawGit(['commit', '-m', 'remote2'], other); f.rawGit(['push'], other);
    await f.git.fetch(f.id, 'origin');
    const beforePullHead = f.rawGit(['rev-parse', 'HEAD']), beforePullIndex = f.rawGit(['ls-files', '--stage']);
    await writeFile(path.join(f.root, 'local'), 'saved local changes');
    await assert.rejects(f.git.pull(f.id, 'ff-only'), error => error instanceof DailyError && error.code === 'dirty');
    assert.equal(await readFile(path.join(f.root, 'local'), 'utf8'), 'saved local changes');
    assert.equal(f.rawGit(['rev-parse', 'HEAD']), beforePullHead); assert.equal(f.rawGit(['ls-files', '--stage']), beforePullIndex);
    await writeFile(path.join(f.root, 'local'), 'local');
    await assert.rejects(f.git.pull(f.id, 'ff-only'), error => error instanceof DailyError && error.code === 'diverged');
    assert.equal(f.rawGit(['rev-parse', 'HEAD']), beforePullHead); assert.equal(f.rawGit(['ls-files', '--stage']), beforePullIndex);
    await f.git.pull(f.id, 'merge'); assert.equal(f.rawGit(['rev-list', '--parents', '-1', 'HEAD']).trim().split(' ').length, 3);
    f.rawGit(['remote', 'set-url', '--push', 'origin', path.join(f.parent, 'missing.git')]);
    await writeFile(path.join(f.root, 'local'), 'commit-before-failed-push'); await f.git.stage(f.id, ['local']);
    const result = await f.git.commit(await f.git.preview(f.id), 'committed once', options, true);
    assert.ok(result.pushError); assert.equal(f.rawGit(['rev-parse', 'HEAD']).trim(), result.oid); assert.equal((await f.git.preview(f.id)).status.changes.length, 0);
    // Built-in Git errors may carry an auth code without useful toString text.
    let pushes=0;f.backend.push=async()=>{pushes++;throw Object.assign(new Error('Git failed'),{gitErrorCode:'AuthenticationFailed',stderr:'password=PRIVATE_SENTINEL'});};
    const count=Number(f.rawGit(['rev-list','--count','HEAD'])),remoteRefs=f.rawGit(['for-each-ref','--format=%(refname) %(objectname)'],bare);
    await writeFile(path.join(f.root,'auth-boundary.txt'),'commit remains successful\n');await f.git.stage(f.id,['auth-boundary.txt']);
    const authenticatedFailure=await f.git.commit(await f.git.preview(f.id),'committed once before auth failure',options,true);
    assert.equal(authenticatedFailure.pushed,false);assert.equal(pushes,1);assert.match(authenticatedFailure.pushError!,/credential helper/);assert.equal(authenticatedFailure.pushError!.includes('PRIVATE_SENTINEL'),false);
    assert.equal((authenticatedFailure.pushError!.match(/Check repository access/g)||[]).length,1);assert.equal(Number(f.rawGit(['rev-list','--count','HEAD'])),count+1);assert.equal(f.rawGit(['rev-parse','HEAD']).trim(),authenticatedFailure.oid);assert.equal(f.rawGit(['for-each-ref','--format=%(refname) %(objectname)'],bare),remoteRefs);
  } finally { await f.close(); }
});
