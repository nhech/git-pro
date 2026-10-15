import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fixture, gitExecutable } from '../fixtures/repository-fixture';
import { NonUtf8Error } from '../../src/git/history/history-parser';
import { PathPolicy } from '../../src/security/paths';
import { GitExecutor } from '../../src/git/git-executor';
import { RepositoryRegistry } from '../../src/repositories/repository-registry';
import { RepositoryStore } from '../../src/state/repository-store';
import { Emitter } from '../../src/utils/events';
import { silentLogger } from '../../src/utils/logging';
import { HistoryService } from '../../src/git/history/history.service';
import { loadWithVscode } from '../unit/compare-loader';

async function compareFixture() {
  const f = await fixture(); const policy = new PathPolicy(() => [f.parent], () => true);
  const executor = new GitExecutor(gitExecutable, policy, silentLogger, undefined, f.env), store = new RepositoryStore(), registry = new RepositoryRegistry(policy, executor, store, silentLogger, 60_000);
  const event = new Emitter<void>(); await registry.sync([{ root: f.root, onDidChange: event.event }]);
  const service = new HistoryService(registry, executor, policy), id = registry.active!.id;
  const commit = async (files: Record<string, string | Buffer | null>, message: string) => {
    for (const [name, content] of Object.entries(files)) {
      if (content === null) { f.git(['rm', '-q', '--', name]); continue; }
      await mkdir(path.dirname(path.join(f.root, name)), { recursive: true }); await writeFile(path.join(f.root, name), content); f.git(['add', '--', name]);
    }
    f.git(['commit', '-q', '-m', message]); return f.git(['rev-parse', 'HEAD']).trim();
  };
  const close = async () => { service.dispose(); registry.dispose(); executor.dispose(); event.dispose(); store.dispose(); await f.cleanup(); };
  return { ...f, policy, registry, service, id, commit, close, event };
}
type Posted = Record<string, unknown>;
/** The real Compare surface (createCompareSurface, with its blob provider) over real Git, behind a stand-in webview. */
function realSurface(f: Awaited<ReturnType<typeof compareFixture>>) {
  const uri = (scheme: string, value: string) => ({ scheme, path: value, query: '', fragment: '', fsPath: value, toString: () => `${scheme}:${value}` });
  const executed: unknown[][] = [], posted: Posted[] = [];
  let receive: (value: unknown) => Promise<void> = async () => undefined, html = '';
  const panel = { webview: { cspSource: 'owned:', asWebviewUri: (value: unknown) => value, postMessage: async (value: Posted) => { posted.push(JSON.parse(JSON.stringify(value)) as Posted); return true; }, onDidReceiveMessage: (listener: typeof receive) => { receive = listener; return { dispose: () => undefined }; }, get html() { return html; }, set html(value: string) { html = value; } },
    visible: true, title: '', iconPath: undefined as unknown, reveal: () => undefined, onDidDispose: () => ({ dispose: () => undefined }), dispose: () => undefined };
  const vscode = { window: { createWebviewPanel: () => panel, tabGroups: { all: [], close: async () => true } }, commands: { executeCommand: async (...args: unknown[]) => { executed.push(args); } },
    workspace: { getConfiguration: () => ({ get: () => 'fork' }), registerTextDocumentContentProvider: () => ({ dispose: () => undefined }) },
    Uri: { file: (value: string) => uri('file', value), joinPath: (base: { path: string }, ...parts: string[]) => uri('file', [base.path, ...parts].join('/')), from: ({ scheme, path: value }: { scheme: string; path: string }) => uri(scheme, value) },
    ViewColumn: { Active: -1 }, env: { clipboard: { writeText: async () => undefined } } };
  const compare = loadWithVscode(path.resolve(__dirname, '../../src/webviews/compare/compare-panel.js'), vscode);
  const deps = { registry: f.registry, history: f.service, policy: f.policy, revisions: { add: () => uri('git-pro-revision', '/x') }, historyPanels: { open: () => undefined }, git: { branchSearchSnapshot: async () => [] }, tools: { tags: async () => [] } };
  const surface = (compare.createCompareSurface as (context: unknown, deps: unknown) => { openRefs(id: string, left: string, right: string): Promise<void>; blobs: { provideTextDocumentContent(uri: unknown): Promise<string> }; dispose(): void })({ extensionUri: uri('file', '/extension') }, deps);
  const state = () => posted.filter(item => item.type === 'state').at(-1) as { revision: number; files: { items: { index: number; path: string }[] } };
  const send = (message: Posted) => receive({ session: /data-session="([^"]+)"/.exec(html)![1]!, ...message });
  return { surface, executed, posted, state, send };
}
const summary = (files: { status: string; path: string; originalPath?: string }[]) => files.map(file => `${file.status.charAt(0)} ${file.originalPath ? `${file.originalPath} -> ` : ''}${file.path}`).sort();

test('Since fork lists only what the left branch changed after the fork; Tip to tip lists every difference between the tips', async () => {
  const f = await compareFixture();
  try {
    const base = await f.commit({ 'shared.txt': 'one\ntwo\nthree\n', 'moved.txt': 'a stable file that is long enough\nto be detected as a rename\nby git diff -M\n' }, 'base');
    f.git(['checkout', '-q', '-b', 'feature']);
    f.git(['mv', 'moved.txt', 'renamed.txt']);
    const feature = await f.commit({ 'feature.txt': 'feature\n', 'shared.txt': 'one\ntwo\nthree\nfour\n' }, 'feature work');
    f.git(['checkout', '-q', 'main']); const main = await f.commit({ 'main.txt': 'main\n' }, 'main work');
    const fork = await f.service.compareRefs(f.id, 'feature', 'main', 'fork');
    assert.deepEqual(fork.left, { name: 'feature', oid: feature }); assert.deepEqual(fork.right, { name: 'main', oid: main }); assert.deepEqual(fork.fork, { oid: base, multiple: false });
    assert.equal(fork.files.scope, 'fork'); assert.equal(fork.files.from, base); assert.equal(fork.files.to, feature); assert.equal(fork.files.note, undefined);
    assert.deepEqual(summary([...fork.files.files]), ['A feature.txt', 'M shared.txt', 'R moved.txt -> renamed.txt'], "main's own change is not part of what feature brings");
    assert.equal(fork.leftOnly.count, 1); assert.deepEqual(fork.leftOnly.commits.map(item => item.oid), [feature]); assert.equal(fork.rightOnly.count, 1); assert.deepEqual(fork.rightOnly.commits.map(item => item.oid), [main]);
    const tips = await f.service.comparisonFiles(f.id, feature, main, 'tips');
    assert.equal(tips.scope, 'tips'); assert.equal(tips.from, feature); assert.equal(tips.to, main);
    assert.deepEqual(summary([...tips.files]), ['D feature.txt', 'A main.txt', 'M shared.txt', 'R renamed.txt -> moved.txt'].sort());
    assert.deepEqual(await f.service.mergeBase(f.id, feature, main), { oid: base, multiple: false });
    const same = await f.service.compareRefs(f.id, 'main', main, 'fork');
    assert.equal(same.leftOnly.count + same.rightOnly.count, 0); assert.deepEqual(same.files.files, []); assert.equal(same.fork.oid, main);
  } finally { await f.close(); }
});

test('Criss-cross merges report several merge bases and use the first; unrelated histories fall back to tip to tip', async () => {
  const f = await compareFixture();
  try {
    await f.commit({ 'base.txt': 'base\n' }, 'base');
    f.git(['checkout', '-q', '-b', 'x']); const x1 = await f.commit({ 'x.txt': 'x\n' }, 'x1');
    f.git(['checkout', '-q', '-b', 'y', 'main']); const y1 = await f.commit({ 'y.txt': 'y\n' }, 'y1');
    f.git(['checkout', '-q', 'x']); f.git(['merge', '-q', '--no-ff', '--no-edit', y1]); await f.commit({ 'x.txt': 'x2\n' }, 'x2');
    f.git(['checkout', '-q', 'y']); f.git(['merge', '-q', '--no-ff', '--no-edit', x1]); await f.commit({ 'y.txt': 'y2\n' }, 'y2');
    const crossed = await f.service.compareRefs(f.id, 'x', 'y', 'fork');
    assert.equal(crossed.fork.multiple, true); assert.ok([x1, y1].includes(crossed.fork.oid!));
    assert.equal(crossed.files.note, 'multipleMergeBases'); assert.equal(crossed.files.scope, 'fork'); assert.equal(crossed.files.from, crossed.fork.oid);
    f.git(['checkout', '-q', '--orphan', 'other']); f.git(['rm', '-q', '-rf', '--', '.']); const other = await f.commit({ 'other.txt': 'other\n' }, 'unrelated root');
    const unrelated = await f.service.compareRefs(f.id, 'other', 'main', 'fork');
    assert.deepEqual(unrelated.fork, { oid: null, multiple: false }, 'merge-base exits 1 with no output, which is an answer, not a failure');
    assert.equal(unrelated.files.scope, 'tips'); assert.equal(unrelated.files.note, 'noCommonAncestor'); assert.equal(unrelated.files.from, other);
    assert.deepEqual(summary([...unrelated.files.files]), ['A base.txt', 'D other.txt']); assert.equal(unrelated.leftOnly.count, 1); assert.equal(unrelated.rightOnly.count, 1);
  } finally { await f.close(); }
});

test('Working-tree files cover staged and unstaged edits, additions and deletions of tracked files, never untracked ones', async () => {
  const f = await compareFixture();
  try {
    const head = await f.commit({ 'staged.txt': 'staged\n', 'unstaged.txt': 'unstaged\n', 'deleted.txt': 'deleted\n', 'both.txt': 'both\n', 'image.bin': Buffer.from([0, 1, 2, 3]) }, 'base');
    await writeFile(path.join(f.root, 'staged.txt'), 'staged change\n'); f.git(['add', '--', 'staged.txt']);
    await writeFile(path.join(f.root, 'unstaged.txt'), 'unstaged change\n');
    await writeFile(path.join(f.root, 'both.txt'), 'both staged\n'); f.git(['add', '--', 'both.txt']); await writeFile(path.join(f.root, 'both.txt'), 'both staged and unstaged\n');
    await rm(path.join(f.root, 'deleted.txt'));
    await writeFile(path.join(f.root, 'added.txt'), 'added\n'); f.git(['add', '--', 'added.txt']);
    await writeFile(path.join(f.root, 'untracked.txt'), 'untracked\n');
    await writeFile(path.join(f.root, 'image.bin'), Buffer.from([0, 9, 9, 9, 9]));
    const files = await f.service.worktreeFiles(f.id, head);
    assert.equal(files.scope, 'worktree'); assert.equal(files.from, head); assert.equal(files.to, undefined); assert.equal(files.omitted, false);
    assert.deepEqual(summary([...files.files]), ['A added.txt', 'D deleted.txt', 'M both.txt', 'M image.bin', 'M staged.txt', 'M unstaged.txt']);
    assert.equal(files.stats.find(stat => stat.path === 'image.bin')?.added, null, 'Binary changes have no line counts');
    assert.equal(files.stats.find(stat => stat.path === 'both.txt')?.added, 1, 'The working copy, not the index, is the right side');
    assert.equal(f.git(['status', '--porcelain=v1', '--', 'staged.txt']).trim(), 'M  staged.txt', 'Reading the comparison leaves the index alone');
  } finally { await f.close(); }
});

test('The Compare tab on real Git keeps binaries out of Open All Changes and serves its lazy sides through the bounded revision reader', async () => {
  const f = await compareFixture();
  try {
    await f.commit({ 'app.ts': 'export const value = 1;\n', 'logo.png': Buffer.from([137, 80, 78, 71, 0, 1]) }, 'base');
    f.git(['checkout', '-q', '-b', 'feature']); await f.commit({ 'app.ts': 'export const value = 2;\n', 'logo.png': Buffer.from([137, 80, 78, 71, 0, 2]), 'docs/new.md': '# New\n' }, 'feature');
    f.git(['checkout', '-q', 'main']);
    const uri = (scheme: string, value: string) => ({ scheme, path: value, query: '', fragment: '', fsPath: value, toString: () => `${scheme}:${value}` });
    const executed: unknown[][] = [], posted: Record<string, unknown>[] = [];
    let receive: (value: unknown) => Promise<void> = async () => undefined, html = '';
    const panel = { webview: { cspSource: 'owned:', asWebviewUri: (value: unknown) => value, postMessage: async (value: Record<string, unknown>) => { posted.push(JSON.parse(JSON.stringify(value)) as Record<string, unknown>); return true; }, onDidReceiveMessage: (listener: typeof receive) => { receive = listener; return { dispose: () => undefined }; }, get html() { return html; }, set html(value: string) { html = value; } },
      visible: true, title: '', iconPath: undefined as unknown, reveal: () => undefined, onDidDispose: () => ({ dispose: () => undefined }), dispose: () => undefined };
    const vscode = { window: { createWebviewPanel: () => panel, tabGroups: { all: [], close: async () => true } }, commands: { executeCommand: async (...args: unknown[]) => { executed.push(args); } },
      workspace: { getConfiguration: () => ({ get: () => 'fork' }), registerTextDocumentContentProvider: () => ({ dispose: () => undefined }) },
      Uri: { file: (value: string) => uri('file', value), joinPath: (base: { path: string }, ...parts: string[]) => uri('file', [base.path, ...parts].join('/')), from: ({ scheme, path: value }: { scheme: string; path: string }) => uri(scheme, value) },
      ViewColumn: { Active: -1 }, env: { clipboard: { writeText: async () => undefined } } };
    const modules = new Map<string, Record<string, unknown>>();
    const compare = loadWithVscode(path.resolve(__dirname, '../../src/webviews/compare/compare-panel.js'), vscode, modules), blobs = loadWithVscode(path.resolve(__dirname, '../../src/documents/blob-provider.js'), vscode, modules);
    const provider = new (blobs.BlobProvider as new (history: unknown) => { provideTextDocumentContent(uri: unknown): Promise<string> })(f.service);
    const deps = { registry: f.registry, history: f.service, policy: f.policy, revisions: { add: () => uri('git-pro-revision', '/x') }, historyPanels: { open: () => undefined }, git: { branchSearchSnapshot: async () => [] }, tools: { tags: async () => [] } };
    const surface = new (compare.ComparePanels as new (context: unknown, deps: unknown, blobs: unknown) => { openRefs(id: string, left: string, right: string): Promise<void>; dispose(): void })({ extensionUri: uri('file', '/extension') }, deps, provider);
    try {
      await surface.openRefs(f.id, 'feature', 'main');
      const session = /data-session="([^"]+)"/.exec(html)![1]!, state = posted.filter(item => item.type === 'state').at(-1) as { revision: number; files: { total: number; binary: number } };
      assert.equal(state.files.total, 3); assert.equal(state.files.binary, 1);
      await receive({ type: 'openAll', session, revision: state.revision });
      assert.equal(posted.some(item => item.type === 'error'), false, JSON.stringify(posted.filter(item => item.type === 'error')));
      const [command, title, resources] = executed.at(-1) as [string, string, [{ fsPath: string }, { path: string } | undefined, { path: string } | undefined][]];
      assert.equal(command, 'vscode.changes'); assert.equal(title, 'Compare: feature ↔ main · All Changes');
      // Array.from builds the list in this realm; the panel's own arrays come from the VM.
      assert.deepEqual(Array.from(resources, resource => path.relative(f.root, resource[0].fsPath).replace(/\\/g, '/')).sort(), ['app.ts', 'docs/new.md'], 'The binary logo is left out');
      const app = resources.find(resource => resource[0].fsPath.endsWith('app.ts'))!, added = resources.find(resource => resource[0].fsPath.endsWith('new.md'))!;
      assert.equal(await provider.provideTextDocumentContent(app[1]), 'export const value = 1;\n', 'The left side is the merge base'); assert.equal(await provider.provideTextDocumentContent(app[2]), 'export const value = 2;\n');
      assert.equal(added[1], undefined, 'An added file has no left side');
    } finally { surface.dispose(); }
  } finally { await f.close(); }
});

test('A changed path that is not UTF-8 withholds the file list with a note, while the comparison and its commit lists still load', async () => {
  const f = await compareFixture();
  try {
    const base = await f.commit({ 'a.txt': 'a\n' }, 'base');
    const run = (args: string[], input?: Buffer | string) => { const result = spawnSync(gitExecutable, args, { cwd: f.root, env: f.env, input, windowsHide: true }); if (result.status) throw new Error(`${args[0]} ${result.stderr}`); return result.stdout.toString('utf8').trim(); };
    // `caf\xe9.txt` (Latin-1) cannot be written on every file system, so the commit is built from a tree.
    const blob = run(['hash-object', '-w', '--stdin'], 'x\n'), kept = run(['rev-parse', 'HEAD:a.txt']);
    const tree = run(['mktree', '-z'], Buffer.concat([Buffer.from(`100644 blob ${kept}\ta.txt\x00100644 blob ${blob}\tcaf`), Buffer.from([0xe9]), Buffer.from('.txt\0')]));
    const latin = run(['commit-tree', tree, '-p', base, '-m', 'latin1 name']); f.git(['branch', 'latin', latin]);
    const result = await f.service.compareRefs(f.id, 'latin', 'main', 'fork');
    assert.deepEqual(result.leftOnly.commits.map(item => item.oid), [latin]); assert.equal(result.leftOnly.count, 1); assert.equal(result.rightOnly.count, 0);
    assert.equal(result.files.scope, 'fork'); assert.equal(result.files.omitted, true); assert.equal(result.files.note, 'nonUtf8Path'); assert.deepEqual(result.files.files, []); assert.deepEqual(result.files.stats, []);
    const tips = await f.service.comparisonFiles(f.id, latin, base, 'tips');
    assert.equal(tips.omitted, true); assert.equal(tips.note, 'nonUtf8Path');
    // The History panel's own two-ref compare takes the same route instead of failing on the path.
    const history = await f.service.compare(f.id, 'latin', 'main');
    assert.equal(history.filesNote, 'nonUtf8Path'); assert.deepEqual(history.files, []); assert.deepEqual(history.stats, []); assert.equal(history.leftCount, 1);
    const details = await f.service.details(f.id, latin);
    assert.equal(details.commit.oid, latin); assert.equal(details.filesOmitted, true); assert.equal(details.filesNote, 'nonUtf8Path'); assert.deepEqual(details.files, []);
    const ordinary = await f.service.compareRefs(f.id, 'main', 'latin', 'fork');
    assert.equal(ordinary.files.omitted, false, 'main brings nothing since the fork, so nothing is withheld'); assert.equal(ordinary.files.note, undefined);
  } finally { await f.close(); }
});

test('A revision that is not UTF-8 is refused in words, and Open All Changes shows that side as a read-only notice', async () => {
  const f = await compareFixture();
  try {
    await f.commit({ 'legacy.txt': Buffer.from('caf\xe9\r\n', 'latin1'), 'plain.txt': 'one\n' }, 'base');
    f.git(['checkout', '-q', '-b', 'feature']); const feature = await f.commit({ 'legacy.txt': Buffer.from('caf\xe9 au lait\r\n', 'latin1'), 'plain.txt': 'two\n' }, 'feature'); f.git(['checkout', '-q', 'main']);
    await assert.rejects(f.service.revision(f.id, feature, 'legacy.txt'), (error: unknown) => error instanceof NonUtf8Error && /^Text diff is unavailable: this revision is not UTF-8 text\./.test(error.message));
    await assert.rejects(f.service.workingRevision(f.id, 'legacy.txt'), /the working file is not UTF-8 text/);
    assert.equal((await f.service.revision(f.id, feature, 'plain.txt')).toString('utf8'), 'two\n');
    const h = realSurface(f);
    try {
      await h.surface.openRefs(f.id, 'feature', 'main');
      const state = h.state(), legacy = state.files.items.find(item => item.path === 'legacy.txt')!;
      await h.send({ type: 'diff', revision: state.revision, index: legacy.index });
      const error = h.posted.filter(item => item.type === 'error').at(-1);
      assert.match(String(error?.message), /Text diff is unavailable: this revision is not UTF-8 text/); assert.doesNotMatch(String(error?.message), /TypeError|encoded data/);
      await h.send({ type: 'openAll', revision: state.revision });
      const resources = h.executed.at(-1)![2] as [{ fsPath: string }, unknown, unknown][];
      const side = resources.find(resource => resource[0].fsPath.endsWith('legacy.txt'))!, plain = resources.find(resource => resource[0].fsPath.endsWith('plain.txt'))!;
      assert.match(await h.surface.blobs.provideTextDocumentContent(side[1]), /^This version of legacy\.txt \([0-9a-f]{8}\) is not UTF-8 text, so Git Pro cannot show it here\./);
      assert.equal(await h.surface.blobs.provideTextDocumentContent(plain[2]), 'two\n', 'UTF-8 sides are unchanged');
    } finally { h.surface.dispose(); }
  } finally { await f.close(); }
});

test('A shallow clone that cut off the fork point says so instead of reporting unrelated histories', async () => {
  const f = await compareFixture();
  try {
    await f.commit({ 'a.txt': 'a\n' }, 'base');
    f.git(['checkout', '-q', '-b', 'feature']); for (const n of [1, 2, 3]) await f.commit({ [`f${n}.txt`]: `${n}\n` }, `f${n}`);
    f.git(['checkout', '-q', 'main']); for (const n of [1, 2, 3]) await f.commit({ [`m${n}.txt`]: `${n}\n` }, `m${n}`);
    const full = await f.service.compareRefs(f.id, 'feature', 'main', 'fork');
    assert.ok(full.fork.oid); assert.equal('shallow' in full.fork, false); assert.equal(full.leftOnly.count, 3);
    const dest = path.join(f.parent, 'shallow');
    f.git(['config', '--global', '--add', 'safe.directory', dest.replace(/\\/g, '/')]);
    f.git(['clone', '-q', '--depth', '2', '--no-single-branch', pathToFileURL(f.root).href, dest], f.parent);
    await f.registry.sync([{ root: f.root, onDidChange: f.event.event }, { root: dest, onDidChange: f.event.event }]);
    const clone = f.registry.list().find(repo => repo.id !== f.id)!;
    const result = await f.service.compareRefs(clone.id, 'refs/remotes/origin/feature', 'main', 'fork');
    assert.deepEqual(result.fork, { oid: null, multiple: false, shallow: true }, 'merge-base finds nothing above the shallow boundary');
    assert.equal(result.files.scope, 'tips'); assert.equal(result.files.note, 'shallowHistory');
    assert.equal(result.leftOnly.count, 2, 'only the downloaded commits are counted, which the note explains');
    assert.equal((await f.service.comparisonFiles(clone.id, result.left.oid, result.right.oid, 'tips', undefined, result.fork)).note, 'shallowHistory');
    f.git(['checkout', '-q', '--orphan', 'other']); f.git(['rm', '-q', '-rf', '--', '.']); await f.commit({ 'other.txt': 'other\n' }, 'unrelated root');
    assert.deepEqual((await f.service.compareRefs(f.id, 'other', 'main', 'fork')).fork, { oid: null, multiple: false }, 'a complete repository still reports unrelated histories as such');
  } finally { await f.close(); }
});
