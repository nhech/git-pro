import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { loadWithVscode } from './compare-loader';
import { NonUtf8Error } from '../../src/git/history/history-parser';
import { LinkOutsideError } from '../../src/security/paths';
import { MenuRouter } from '../../src/webviews/menu-context';

const oid = (value: number) => value.toString(16).padStart(40, '0');
const LEFT = oid(1), RIGHT = oid(2), BASE = oid(3), MOVED = oid(4);
const commit = (value: number, subject = `Commit ${value}`) => ({ oid: oid(value), parents: [oid(value + 1000)], author: 'Fixture', email: 'fixture@example.invalid', timestamp: 1700000000, subject });
type Message = Record<string, unknown>;
interface Uri { scheme: string; fsPath?: string; path: string; label?: string; content?: string; toString(): string }
const uri = (scheme: string, value: string): Uri => ({ scheme, path: value, ...(scheme === 'file' ? { fsPath: value } : {}), toString: () => `${scheme}:${value}` });

class FakePanel {
  readonly sent: Message[] = []; visible = true; revealed = 0; disposed = false; iconPath: unknown; title: string;
  receive: (value: unknown) => Promise<void> = async () => undefined; private onDispose: () => void = () => undefined;
  readonly webview = { html: '', cspSource: 'owned:', asWebviewUri: (value: Uri) => value, postMessage: async (value: Message) => { this.sent.push(value); return true; },
    onDidReceiveMessage: (listener: (value: unknown) => Promise<void>) => { this.receive = listener; return { dispose: () => undefined }; } };
  constructor(title: string) { this.title = title; }
  get html(): string { return this.webview.html; }
  onDidDispose(listener: () => void) { this.onDispose = listener; return { dispose: () => undefined }; }
  reveal() { this.revealed++; }
  dispose() { if (this.disposed) return; this.disposed = true; this.onDispose(); }
  get session() { return /data-session="([^"]+)"/.exec(this.html)![1]!; }
  send(value: Message) { return this.receive({ session: this.session, ...value }); }
  /** Messages are built in the VM realm; a JSON copy gives plain objects that strict deep equality can compare. */
  last(type: string): Message | undefined { const value = this.sent.slice().reverse().find(item => item.type === type); return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) as Message; }
  get state() { return this.last('state') as Message & { revision: number; files: Message & { items: Message[] }; sides: { leftOnly: Message & { commits: Message[] }; rightOnly: Message & { commits: Message[] } } }; }
}

async function harness(options: { files?: unknown; worktree?: unknown; head?: string; equivalent?: ReadonlySet<string>; skipped?: boolean } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'git-pro-compare-panel-')));
  await mkdir(path.join(root, 'src')); await writeFile(path.join(root, 'src', 'app.ts'), 'working\n'); await writeFile(path.join(root, 'README.md'), 'readme\n');
  const panels: FakePanel[] = [], executed: unknown[][] = [], clipboard: string[] = [], histories: unknown[][] = [], calls: string[] = [];
  const tabs: { label: string; input: unknown }[] = [];
  const settings = { mode: 'fork' as string, beside: true as boolean };
  const vscode = {
    window: { createWebviewPanel: (_type: string, title: string) => { const panel = new FakePanel(title); panels.push(panel); return panel; },
      tabGroups: { get all() { return [{ tabs }]; }, close: async (closing: { label: string }[]) => { for (const tab of closing) tabs.splice(tabs.indexOf(tab as never), 1); return true; } } },
    commands: { executeCommand: async (...args: unknown[]) => { executed.push(args); if (args[0] === 'vscode.changes') tabs.push({ label: String(args[1]), input: { textDiffs: args[2] } }); } },
    workspace: { getConfiguration: () => ({ get: (key: string) => key === 'compare.openDiffsBeside' ? settings.beside : settings.mode }), registerTextDocumentContentProvider: () => ({ dispose: () => undefined }) },
    Uri: { file: (value: string) => uri('file', value), joinPath: (base: Uri, ...parts: string[]) => uri(base.scheme ?? 'file', [base.path, ...parts].join('/')), from: ({ scheme, path: value }: { scheme: string; path: string }) => uri(scheme, value) },
    ViewColumn: { Active: -1, Beside: -2 }, env: { clipboard: { writeText: async (value: string) => { clipboard.push(value); } } }
  };
  const files = (scope: string, from: string | undefined, to: string | undefined, entries: { status: string; path: string; originalPath?: string }[], binary: string[] = []) =>
    ({ scope, from, to, files: entries, stats: entries.map(entry => ({ path: entry.path, ...(entry.originalPath ? { originalPath: entry.originalPath } : {}), added: binary.includes(entry.path) ? null : 1, removed: binary.includes(entry.path) ? null : 0 })), omitted: false });
  const branchFiles = options.files ?? files('fork', BASE, LEFT, [{ status: 'M', path: 'src/app.ts' }, { status: 'A', path: 'logo.png' }, { status: 'R100', originalPath: 'old.md', path: 'README.md' }], ['logo.png']);
  const refs = new Map([['feature', LEFT], ['main', RIGHT], ['HEAD', RIGHT], ['refs/heads/main', RIGHT]]);
  let invalidate: () => void = () => undefined;
  const repo = { id: 'repo', root, gitDir: path.join(root, '.git'), commonDir: path.join(root, '.git') }, open = [repo];
  const history = {
    resolveRef: async (_id: string, ref: string) => { calls.push(`resolve:${ref}`); const value = refs.get(ref) ?? (/^[0-9a-f]{40}$/.test(ref) ? ref : undefined); if (!value) throw new Error('Invalid revision.'); return value; },
    compareRefs: async (_id: string, left: string, right: string, mode: string) => { calls.push(`compare:${left}:${right}:${mode}`);
      return { repositoryId: 'repo', left: { name: left, oid: left }, right: { name: right, oid: right }, fork: { oid: BASE, multiple: false },
        leftOnly: { count: 60, offset: 0, commits: Array.from({ length: 25 }, (_, index) => commit(index + 10, index ? `Commit ${index}` : '<img src=x onerror=alert(1)>')) }, rightOnly: { count: 0, offset: 0, commits: [] }, files: branchFiles, ...(options.equivalent ? { equivalent: options.equivalent } : {}), ...(options.skipped ? { equivalentSkipped: true } : {}) }; },
    comparisonFiles: async (_id: string, left: string, right: string, mode: string) => { calls.push(`files:${left}:${right}:${mode}`); return files(mode === 'tips' ? 'tips' : 'fork', mode === 'tips' ? left : BASE, mode === 'tips' ? right : left, [{ status: 'M', path: 'src/app.ts' }]); },
    comparisonPage: async (_id: string, tip: string, exclude: string, offset: number) => { calls.push(`page:${tip}:${exclude}:${offset}`); return [commit(offset + 100)]; },
    details: async (_id: string, value: string) => { calls.push(`details:${value}`); return { commit: commit(Number.parseInt(value, 16)), parent: oid(999), files: [{ status: 'D', path: 'gone.txt' }], stats: [{ path: 'gone.txt', added: 0, removed: 3 }], message: 'Details' }; },
    worktreeFiles: async (_id: string, value: string) => { calls.push(`worktree:${value}`); return options.worktree ?? files('worktree', value, undefined, [{ status: 'M', path: 'src/app.ts' }, { status: 'D', path: 'only-branch.txt' }, { status: 'R090', originalPath: 'before.txt', path: 'README.md' }]); },
    revision: async (_id: string, value: string | undefined, file: string) => { calls.push(`revision:${value ?? 'none'}:${file}`); return Buffer.from(`${value ?? 'none'}:${file}`); }
  };
  const menus = new MenuRouter();
  const deps = {
    surfaces: { menus },
    registry: { list: () => [...open], store: { get: () => ({ head: options.head ?? 'main' }) }, onDidInvalidate: (listener: () => void) => { invalidate = listener; return { dispose: () => undefined }; }, resolveFile: async () => repo },
    history, policy: { authorizeFile: async (base: string, relative: string) => { if (relative === 'outlink') throw new LinkOutsideError(); return path.join(base, ...relative.split('/')); } },
    revisions: { add: (content: Buffer, label: string) => ({ ...uri('git-pro-revision', `/${label}`), label, content: content.toString() }) },
    historyPanels: { open: (...args: unknown[]) => { histories.push(args); } },
    git: { branchSearchSnapshot: async () => [{ name: 'feature', oid: oid(10), ref: 'refs/heads/feature', remote: false, upstream: '', worktree: '' }] }, tools: { tags: async () => [{ name: 'v1', oid: oid(11), target: oid(11), annotated: false }] }
  };
  const exports = loadWithVscode(path.resolve(__dirname, '../../src/webviews/compare/compare-panel.js'), vscode);
  const blobs = loadWithVscode(path.resolve(__dirname, '../../src/documents/blob-provider.js'), vscode);
  const Panels = exports.ComparePanels as new (context: unknown, deps: unknown, blobs: unknown) => { openRefs(id: string, left: string, right: string): Promise<void>; openWorktree(id: string, ref: string, folder?: string): Promise<void>; getFromBranch: unknown; activePanelCount: number; dispose(): void };
  const Blobs = blobs.BlobProvider as new (history: unknown) => unknown;
  const surface = new Panels({ extensionUri: uri('file', '/extension') }, deps, new Blobs(history));
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  return { root, panels, executed, clipboard, histories, calls, tabs, settings, surface, refs, menus, history: history as Record<string, unknown>, invalidate: () => invalidate(), settle, files,
    /** registry.sync without this repository, and with it again. */
    close: () => { open.length = 0; }, reopen: () => { open.splice(0, open.length, repo); },
    cleanup: async () => { surface.dispose(); await rm(root, { recursive: true, force: true }); } };
}

test('Compare pins refs before the tab opens, reuses the tab for the same pair and replays state on readiness without reading Git', async () => {
  const h = await harness();
  try {
    await h.surface.openRefs('repo', 'feature', 'main');
    assert.equal(h.panels.length, 1); const panel = h.panels[0]!;
    assert.equal(panel.title, 'Compare: feature ↔ main'); assert.match(panel.html, /script-src 'nonce-[0-9a-f]{32}'/); assert.match(panel.html, /default-src 'none'/);
    assert.deepEqual(h.calls.slice(0, 3), ['resolve:feature', 'resolve:main', `compare:${LEFT}:${RIGHT}:fork`], 'Refs are pinned to OIDs, then compared by pin');
    await h.surface.openRefs('repo', 'feature', 'refs/heads/main'); assert.equal(h.panels.length, 1, 'The same (repository, left OID, right OID) reveals the open tab'); assert.equal(panel.revealed, 1);
    await h.surface.openRefs('repo', 'main', 'feature'); assert.equal(h.panels.length, 2, 'The reversed pair is a different comparison');
    const reads = h.calls.length; await panel.send({ type: 'ready' }); await h.settle();
    assert.equal(h.calls.length, reads, 'Readiness replays the captured state');
    const state = panel.state;
    assert.deepEqual(state.left, { name: 'feature', oid: LEFT, current: false }); assert.deepEqual(state.right, { name: 'main', oid: RIGHT, current: true });
    assert.equal(state.sides.leftOnly.count, 60); assert.equal(state.sides.leftOnly.commits.length, 25); assert.equal(state.sides.rightOnly.count, 0);
    assert.equal(state.sides.leftOnly.commits[0]!.subject, '<img src=x onerror=alert(1)>', 'Hostile text stays text for the textContent renderer');
    assert.deepEqual(state.sides.leftOnly.commits[0]!.refs, ['feature'], 'Branch tips are badged once the refs load');
    assert.equal(state.files.scope, 'fork'); assert.equal(state.files.total, 3); assert.equal(state.files.binary, 1);
    assert.deepEqual(state.files.items.map(item => [item.index, item.status, item.path, item.originalPath ?? null]), [[0, 'M', 'src/app.ts', null], [1, 'A', 'logo.png', null], [2, 'R', 'README.md', 'old.md']]);
    assert.equal(state.files.items.some(item => 'presence' in item), false);
    await panel.send({ type: 'ready', session: 'forged' }); assert.match(String(panel.last('error')?.message), /expired/);
    await panel.receive({ type: 'diff', session: panel.session, revision: state.revision, index: -1 }); assert.match(String(panel.last('error')?.message), /Unknown Compare action/);
  } finally { await h.cleanup(); }
});

test('Selecting a loaded commit shows its files and keeps the comparison; All changes returns without a Git read', async () => {
  const h = await harness();
  try {
    await h.surface.openRefs('repo', 'feature', 'main'); const panel = h.panels[0]!;
    await panel.send({ type: 'selectCommit', revision: panel.state.revision, oid: oid(999) }); assert.match(String(panel.last('error')?.message), /loaded lists/, 'Only commits in a loaded page can be selected');
    const before = panel.state.revision; await panel.send({ type: 'selectCommit', revision: before, oid: oid(12) });
    const state = panel.state; assert.equal(state.revision, before + 1);
    assert.equal(state.files.scope, 'commit'); assert.deepEqual(state.files.commit, { oid: oid(12), subject: 'Commit 12' }); assert.equal(state.files.from, oid(999)); assert.equal(state.files.items[0]!.path, 'gone.txt');
    assert.equal(state.sides.leftOnly.commits.length, 25, 'The comparison pages stay');
    await panel.send({ type: 'diff', revision: state.revision, index: 0 });
    const diff = h.executed.at(-1)!; assert.equal(diff[0], 'vscode.diff'); assert.equal((diff[1] as Uri).content, `${oid(999)}:gone.txt`); assert.equal((diff[2] as Uri).content, 'none:gone.txt', 'A deleted file diffs against an empty right side');
    assert.equal(diff[3], `gone.txt (${oid(999).slice(0, 8)} ↔ ${oid(12).slice(0, 8)})`);
    const reads = h.calls.length; await panel.send({ type: 'allChanges', revision: panel.state.revision });
    assert.equal(h.calls.length, reads); assert.equal(panel.state.files.scope, 'fork'); assert.equal(panel.state.files.total, 3);
    await panel.send({ type: 'copyRevision', revision: panel.state.revision, oid: oid(12) }); assert.deepEqual(h.clipboard, [oid(12)]);
    await panel.send({ type: 'showInHistory', revision: panel.state.revision, oid: oid(13) }); assert.deepEqual(h.histories, [['repo', undefined, oid(13), true]]);
    await panel.send({ type: 'copyRevision', revision: panel.state.revision, oid: oid(500) }); assert.deepEqual(h.clipboard, [oid(12)], 'Copy is limited to loaded commits');
  } finally { await h.cleanup(); }
});

test('Commit pages move by exactly 25 from the current page and keep the pinned tips', async () => {
  const h = await harness();
  try {
    await h.surface.openRefs('repo', 'feature', 'main'); const panel = h.panels[0]!;
    for (const offset of [50, 75]) { await panel.send({ type: 'page', revision: panel.state.revision, side: 'left', offset }); assert.match(String(panel.last('error')?.message), /adjacent/); }
    await panel.send({ type: 'page', revision: panel.state.revision, side: 'right', offset: 25 }); assert.match(String(panel.last('error')?.message), /adjacent/, 'An empty side has no next page');
    await panel.send({ type: 'page', revision: panel.state.revision, side: 'left', offset: 25 });
    assert.equal(h.calls.at(-1), `page:${LEFT}:${RIGHT}:25`); assert.equal(panel.state.sides.leftOnly.offset, 25); assert.equal(panel.state.sides.leftOnly.commits[0]!.oid, oid(125));
    const stale = panel.state.revision - 1; await panel.send({ type: 'page', revision: stale, side: 'left', offset: 0 }); assert.match(String(panel.last('error')?.message), /changed/, 'A stale revision is refused');
  } finally { await h.cleanup(); }
});

test('Index-based file actions resolve against the captured list and open native diffs with redacted titles', async () => {
  const h = await harness();
  try {
    await h.surface.openRefs('repo', 'feature', 'main'); const panel = h.panels[0]!, revision = panel.state.revision;
    await panel.send({ type: 'diff', revision, index: 3 }); assert.match(String(panel.last('error')?.message), /current comparison/);
    await panel.send({ type: 'diff', revision, index: 2 });
    let diff = h.executed.at(-1)!; assert.equal((diff[1] as Uri).content, `${BASE}:old.md`); assert.equal((diff[2] as Uri).content, `${LEFT}:README.md`, 'A rename diffs the old path at the fork point against the new path');
    assert.equal(diff[3], `README.md (fork ${BASE.slice(0, 8)} ↔ feature ${LEFT.slice(0, 8)})`);
    await panel.send({ type: 'localDiff', revision, index: 0 });
    diff = h.executed.at(-1)!; assert.equal((diff[1] as Uri).content, `${LEFT}:src/app.ts`); assert.equal((diff[2] as Uri).scheme, 'file', 'Compare with Local opens the real, editable working file'); assert.equal((diff[2] as Uri).fsPath, path.join(h.root, 'src', 'app.ts'));
    const reads = h.calls.length; await panel.send({ type: 'diff', revision, index: 1 }); assert.match(String(panel.last('error')?.message), /logo\.png: binary file — no text diff/); assert.equal(h.calls.length, reads, 'A binary row is refused before any read');
    await panel.send({ type: 'openFile', revision, index: 0 }); assert.equal(h.executed.at(-1)![0], 'vscode.open');
    assert.equal(panel.state.revision, revision, 'Opening diffs changes nothing the tab shows');
  } finally { await h.cleanup(); }
});

test('Swap exchanges the sides, recomputes files from the same pins and re-keys the tab', async () => {
  const h = await harness();
  try {
    await h.surface.openRefs('repo', 'feature', 'main'); const panel = h.panels[0]!;
    await panel.send({ type: 'swap', revision: panel.state.revision });
    const state = panel.state; assert.equal((state.left as Message).name, 'main'); assert.equal((state.right as Message).name, 'feature'); assert.equal(state.sides.rightOnly.count, 60);
    assert.equal(h.calls.at(-1), `files:${RIGHT}:${LEFT}:fork`); assert.equal(panel.title, 'Compare: main ↔ feature');
    const compares = h.calls.filter(call => call.startsWith('compare:')).length;
    await h.surface.openRefs('repo', 'main', 'feature'); assert.equal(h.panels.length, 1, 'The swapped tab now owns the reversed pair'); assert.equal(h.calls.filter(call => call.startsWith('compare:')).length, compares);
    await panel.send({ type: 'filesMode', revision: panel.state.revision, mode: 'tips' });
    assert.equal(h.calls.at(-1), `files:${RIGHT}:${LEFT}:tips`); assert.equal(panel.state.filesMode, 'tips'); assert.equal(panel.state.files.scope, 'tips');
  } finally { await h.cleanup(); }
});

test('Open All Changes opens one multi-diff tab of lazy blob sides, excludes binaries and replaces only its own earlier tab', async () => {
  const many = Array.from({ length: 305 }, (_, index) => ({ status: 'M', path: `dir/file-${index}.txt` }));
  const h = await harness();
  try {
    await h.surface.openRefs('repo', 'feature', 'main'); const panel = h.panels[0]!, title = 'Compare: feature ↔ main · All Changes';
    h.tabs.push({ label: title, input: { viewType: 'gitPro.compare' } });
    await panel.send({ type: 'openAll', revision: panel.state.revision });
    const opened = h.executed.at(-1)!; assert.equal(opened[0], 'vscode.changes'); assert.equal(opened[1], title);
    const resources = opened[2] as [Uri, Uri | undefined, Uri | undefined][];
    assert.equal(resources.length, 2, 'The binary file is left out');
    assert.equal(resources[0]![0].fsPath, path.join(h.root, 'src', 'app.ts')); assert.equal(resources[0]![1]!.scheme, 'git-pro-blob'); assert.equal(resources[0]![2]!.scheme, 'git-pro-blob');
    assert.match(resources[0]![1]!.path, /^\/[0-9a-f-]{36}\/app\.ts$/, 'Sides carry only a token and a basename');
    assert.equal(h.calls.some(call => call.startsWith('revision:')), false, 'Blob sides are read lazily, when VS Code shows them');
    // VS Code 1.141 labels a multi-diff tab with a file count; such a tab with this title is ours too, a webview tab with that label is not.
    h.tabs.push({ label: `${title} (2 files)`, input: { textDiffs: [] } }, { label: `${title} (notes)`, input: { viewType: 'other' } });
    await panel.send({ type: 'openAll', revision: panel.state.revision });
    assert.equal(h.tabs.filter(tab => tab.label === title).length, 2, 'One multi-diff tab plus the unrelated webview tab with the same label');
    assert.equal(h.tabs.filter(tab => tab.label.startsWith(title) && Array.isArray((tab.input as { textDiffs?: unknown }).textDiffs)).length, 1, 'Reopening replaced the earlier multi-diff tabs, with or without a file count');
    assert.ok(h.tabs.some(tab => tab.label === `${title} (notes)`), 'A webview tab whose label merely starts with the title stays open');
  } finally { await h.cleanup(); }
  const capped = await harness({ files: { scope: 'tips', from: LEFT, to: RIGHT, files: many, stats: [], omitted: false } });
  try {
    await capped.surface.openRefs('repo', 'feature', 'main'); const panel = capped.panels[0]!;
    assert.equal(panel.state.files.items.length, 200, 'Files are posted 200 at a time');
    await panel.send({ type: 'filesPage', revision: panel.state.revision, offset: 200 }); assert.equal(panel.state.files.items.length, 105); assert.equal(panel.state.files.items[0]!.index, 200);
    await panel.send({ type: 'filesPage', revision: panel.state.revision, offset: 400 }); assert.match(String(panel.last('error')?.message), /available file page/);
    await panel.send({ type: 'openAll', revision: panel.state.revision });
    assert.equal((capped.executed.at(-1)![2] as unknown[]).length, 300); assert.match(String(panel.last('notice')?.message), /first 300 of 305/);
  } finally { await capped.cleanup(); }
});

test('Working-tree mode diffs the branch snapshot against the real file, swaps sides and delegates Get from Branch with both rename paths', async () => {
  const h = await harness();
  try {
    await h.surface.openWorktree('repo', 'feature'); const panel = h.panels[0]!;
    assert.equal(panel.title, 'Compare: feature ↔ Working Tree'); assert.equal(h.calls.at(-1), `worktree:${LEFT}`);
    let state = panel.state; assert.equal(state.mode, 'worktree'); assert.equal(state.sides, undefined); assert.equal(state.head, 'main');
    assert.deepEqual(state.files.items.map(item => item.presence), ['both', 'branch', 'both']);
    await panel.send({ type: 'diff', revision: state.revision, index: 0 });
    let diff = h.executed.at(-1)!; assert.equal((diff[1] as Uri).content, `${LEFT}:src/app.ts`); assert.equal((diff[2] as Uri).scheme, 'file'); assert.equal(diff[3], `app.ts (feature ${LEFT.slice(0, 8)} ↔ Working Tree)`);
    await panel.send({ type: 'diff', revision: state.revision, index: 1 }); diff = h.executed.at(-1)!; assert.equal((diff[2] as Uri).content, '', 'A file only in the branch diffs against an empty working side');
    await panel.send({ type: 'openFile', revision: state.revision, index: 1 }); assert.match(String(panel.last('error')?.message), /only-branch\.txt does not exist in the working tree/);
    await panel.send({ type: 'swap', revision: state.revision }); state = panel.state; assert.equal(state.swapped, true); assert.equal(panel.title, 'Compare: Working Tree ↔ feature');
    await panel.send({ type: 'diff', revision: state.revision, index: 0 }); diff = h.executed.at(-1)!; assert.equal((diff[1] as Uri).scheme, 'file'); assert.equal(diff[3], `app.ts (Working Tree ↔ feature ${LEFT.slice(0, 8)})`);
    await panel.send({ type: 'getFromBranch', revision: state.revision, indexes: [2] }); assert.match(String(panel.last('error')?.message), /not available/);
    const requests: unknown[] = []; (h.surface as { getFromBranch: unknown }).getFromBranch = async (request: unknown) => { requests.push(request); return true; };
    const reads = h.calls.filter(call => call.startsWith('worktree:')).length;
    await panel.send({ type: 'getFromBranch', revision: state.revision, indexes: [2, 0] });
    assert.deepEqual(JSON.parse(JSON.stringify(requests)), [{ repositoryId: 'repo', root: h.root, ref: { name: 'feature', oid: LEFT }, files: [{ status: 'R090', path: 'README.md', originalPath: 'before.txt' }, { status: 'M', path: 'src/app.ts' }] }]);
    assert.equal(h.calls.filter(call => call.startsWith('worktree:')).length, reads + 1, 'The working-tree list is read again after Get from Branch');
    await panel.send({ type: 'getFromBranch', revision: state.revision, indexes: [0] }); assert.match(String(panel.last('error')?.message), /changed/, 'Indexes from an older list are refused');
    await panel.send({ type: 'openAll', revision: panel.state.revision });
    const resources = h.executed.at(-1)![2] as [Uri, Uri | undefined, Uri | undefined][];
    assert.equal(resources[0]![1]!.scheme, 'file', 'Swapped: the editable working file is on the left'); assert.equal(resources[1]![1], undefined, 'A file only in the branch has no working side'); assert.equal(resources[1]![2]!.scheme, 'git-pro-blob');
  } finally { await h.cleanup(); }
});

test('Working files must be regular files of this repository, never symlinks or Git metadata', async () => {
  const h = await harness({ files: { scope: 'tips', from: LEFT, to: RIGHT, files: [{ status: 'M', path: 'link.txt' }, { status: 'M', path: '.git/config' }], stats: [], omitted: false } });
  try {
    let linked = true; try { await symlink(path.join(h.root, 'README.md'), path.join(h.root, 'link.txt')); } catch { linked = false; }
    await h.surface.openRefs('repo', 'feature', 'main'); const panel = h.panels[0]!, revision = panel.state.revision;
    if (linked) { await panel.send({ type: 'openFile', revision, index: 0 }); assert.match(String(panel.last('error')?.message), /regular files/); }
    await panel.send({ type: 'localDiff', revision, index: 1 }); assert.match(String(panel.last('error')?.message), /Git metadata/);
  } finally { await h.cleanup(); }
});

test('A path that leads into .git through a link (a tracked symlink or junction, or a Windows 8.3 name) is refused as Git metadata', async () => {
  const h = await harness({ files: { scope: 'tips', from: LEFT, to: RIGHT, files: [{ status: 'M', path: 'link/config' }, { status: 'M', path: 'plain/config' }], stats: [], omitted: false } });
  try {
    // The working tree has a link named `link` to .git (the repository root of the harness is already canonical); a ref supplied `link/config`.
    await mkdir(path.join(h.root, '.git'), { recursive: true }); await writeFile(path.join(h.root, '.git', 'config'), '[core]\n');
    await mkdir(path.join(h.root, 'plain')); await writeFile(path.join(h.root, 'plain', 'config'), 'ordinary\n');
    let linked = true; try { await symlink(path.join(h.root, '.git'), path.join(h.root, 'link'), 'junction'); } catch { linked = false; }
    await h.surface.openRefs('repo', 'feature', 'main'); const panel = h.panels[0]!, revision = panel.state.revision;
    if (linked) for (const type of ['localDiff', 'openFile', 'diff'] as const) {
      await panel.send({ type, revision, index: 0 }); assert.match(String(panel.last('error')?.message), /Git metadata/, `${type} must refuse link/config`);
    }
    // The same file outside .git is still an ordinary working file.
    await panel.send({ type: 'openFile', revision, index: 1 });
    assert.ok(h.executed.some(args => args[0] === 'vscode.open' && /plain[\\/]config$/.test(String((args[1] as { fsPath?: string }).fsPath))), 'a regular working file keeps opening');
  } finally { await h.cleanup(); }
});

test('A moved ref is reported without changing the pins, and Refresh re-pins it', async () => {
  const h = await harness();
  try {
    await h.surface.openRefs('repo', 'feature', 'main'); const panel = h.panels[0]!, revision = panel.state.revision;
    h.refs.set('main', MOVED); h.invalidate(); await new Promise(resolve => setTimeout(resolve, 900));
    assert.deepEqual(panel.state.moved, ['main']); assert.equal((panel.state.right as Message).oid, RIGHT); assert.equal(panel.state.revision, revision, 'A moved notice keeps the captured file indexes valid');
    await panel.send({ type: 'refresh' });
    assert.equal((panel.state.right as Message).oid, MOVED); assert.deepEqual(panel.state.moved, []); assert.equal(h.calls.filter(call => call.startsWith('compare:')).at(-1), `compare:${LEFT}:${MOVED}:fork`);
    await h.surface.openRefs('repo', 'feature', 'main'); assert.equal(h.panels.length, 1, 'The refreshed tab owns the new pair');
    h.refs.delete('feature'); await panel.send({ type: 'refresh' }); assert.match(String(panel.last('error')?.message), /no longer resolves/); assert.equal((panel.state.left as Message).oid, LEFT);
  } finally { await h.cleanup(); }
});

test('Load failures show in the tab, busy requests are refused and disposal releases the tab', async () => {
  const h = await harness({ files: { scope: 'fork', from: BASE, to: LEFT, files: [], stats: [], omitted: true, note: 'multipleMergeBases' } });
  try {
    await h.surface.openRefs('repo', 'feature', 'main'); const panel = h.panels[0]!;
    assert.equal(panel.state.files.omitted, true); assert.equal(panel.state.files.note, 'multipleMergeBases');
    await panel.send({ type: 'openAll', revision: panel.state.revision }); assert.match(String(panel.last('error')?.message), /Too many changed files/);
    await assert.rejects(h.surface.openRefs('repo', 'missing', 'main'), /Invalid revision/, 'An unresolvable ref fails before any tab opens'); assert.equal(h.panels.length, 1);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }), page = h.history.comparisonPage as (...args: unknown[]) => Promise<unknown>;
    h.history.comparisonPage = async (...args: unknown[]) => { await gate; return page(...args); };
    const pending = panel.send({ type: 'page', revision: panel.state.revision, side: 'left', offset: 25 });
    await panel.send({ type: 'allChanges', revision: panel.state.revision }); assert.match(String(panel.last('error')?.message), /Wait for the current Compare action/, 'One request at a time per tab');
    release(); await pending; assert.equal(panel.state.sides.leftOnly.offset, 25); assert.equal(panel.last('busy')?.busy, false);
    const original = h.history.compareRefs; h.history.compareRefs = async () => { throw new Error('fatal: bad object <secret> token=abc'); };
    await h.surface.openRefs('repo', 'main', 'feature'); const failed = h.panels.at(-1)!;
    assert.equal(failed.state.loading, false); assert.match(String(failed.state.error), /bad object/, 'A load failure shows in the tab instead of the command toast'); assert.doesNotMatch(String(failed.state.error), /abc/, 'Errors are redacted');
    assert.equal(failed.state.files, undefined); failed.dispose();
    assert.equal(h.surface.activePanelCount, 1); panel.dispose(); assert.equal(h.surface.activePanelCount, 0);
    const count = panel.sent.length; await panel.send({ type: 'ready' }); assert.equal(panel.sent.length, count);
    h.history.compareRefs = original; await h.surface.openRefs('repo', 'feature', 'main'); assert.equal(h.panels.length, 3, 'A closed tab is never revealed again');
  } finally { await h.cleanup(); }
});

test('Open All Changes in working-tree mode leaves out submodules, symlinks and Git metadata, opens the rest and says how many it left out', async () => {
  const entries = [{ status: 'M', path: 'src/app.ts' }, { status: 'M', path: 'sub' }, { status: 'M', path: '.git/config' }, { status: 'M', path: 'README.md' }, { status: 'D', path: 'only-branch.txt' }];
  const h = await harness({ worktree: { scope: 'worktree', from: LEFT, to: undefined, files: entries, stats: entries.map(entry => ({ path: entry.path, added: 1, removed: 1 })), omitted: false } });
  try {
    // A submodule's working side is a folder; `.git/config` is refused by name.
    await mkdir(path.join(h.root, 'sub'));
    await h.surface.openWorktree('repo', 'feature'); const panel = h.panels[0]!;
    await panel.send({ type: 'openAll', revision: panel.state.revision });
    assert.equal(panel.last('error'), undefined, String(panel.last('error')?.message));
    const opened = h.executed.at(-1)!; assert.equal(opened[0], 'vscode.changes');
    const resources = opened[2] as [Uri, Uri | undefined, Uri | undefined][];
    assert.deepEqual(Array.from(resources, resource => path.relative(h.root, resource[0].fsPath!).replace(/\\/g, '/')), ['src/app.ts', 'README.md', 'only-branch.txt']);
    assert.equal(resources[0]![2]!.scheme, 'file'); assert.equal(resources[2]![2], undefined, 'A file only in the branch still opens with no working side');
    assert.equal(panel.last('notice')?.message, 'Left out 2 files that have no regular working file (symlinks, submodules, nested repositories or Git metadata); use native Git for them.');
  } finally { await h.cleanup(); }
  const only = await harness({ worktree: { scope: 'worktree', from: LEFT, to: undefined, files: [{ status: 'M', path: 'sub' }], stats: [{ path: 'sub', added: 1, removed: 1 }], omitted: false } });
  try {
    await mkdir(path.join(only.root, 'sub'));
    await only.surface.openWorktree('repo', 'feature'); const panel = only.panels[0]!;
    await panel.send({ type: 'openAll', revision: panel.state.revision });
    assert.equal(panel.last('error')?.message, 'Left out 1 file that has no regular working file (a symlink, submodule, nested repository or Git metadata); use native Git for it.');
    assert.equal(only.executed.some(args => args[0] === 'vscode.changes'), false, 'Nothing is left to open');
  } finally { await only.cleanup(); }
});

test('A tracked link that leads out of the repository is left out of Open All like any other symlink, not a failure of the whole action', async () => {
  const entries = [{ status: 'M', path: 'README.md' }, { status: 'T', path: 'outlink' }];
  const h = await harness({ worktree: { scope: 'worktree', from: LEFT, to: undefined, files: entries, stats: entries.map(entry => ({ path: entry.path, added: 1, removed: 1 })), omitted: false } });
  try {
    await h.surface.openWorktree('repo', 'feature'); const panel = h.panels[0]!;
    await panel.send({ type: 'openAll', revision: panel.state.revision });
    assert.equal(panel.last('error'), undefined, String(panel.last('error')?.message));
    const resources = h.executed.at(-1)![2] as [Uri, Uri | undefined, Uri | undefined][];
    assert.deepEqual(Array.from(resources, resource => path.relative(h.root, resource[0].fsPath!).replace(/\\/g, '/')), ['README.md']);
    assert.equal(panel.last('notice')?.message, 'Left out 1 file that has no regular working file (a symlink, submodule, nested repository or Git metadata); use native Git for it.');
  } finally { await h.cleanup(); }
});

test('A closed repository marks the tab expired instead of reporting moved refs; a ref that no longer resolves is reported as gone', async () => {
  const h = await harness();
  // The panel re-checks its refs after a debounce; polling a bounded time is steadier than guessing how long that takes on a busy CI machine.
  const until = async (check: () => boolean) => { for (let attempt = 0; attempt < 100 && !check(); attempt++) await new Promise(resolve => setTimeout(resolve, 50)); };
  try {
    await h.surface.openRefs('repo', 'feature', 'main'); const panel = h.panels[0]!, revision = panel.state.revision;
    h.refs.delete('feature'); h.invalidate(); await until(() => (panel.state.gone as unknown[]).length === 1);
    assert.deepEqual(panel.state.moved, [], 'A deleted branch did not move'); assert.deepEqual(panel.state.gone, ['feature']); assert.equal(panel.state.expired, undefined);
    h.refs.set('feature', LEFT); h.invalidate(); await until(() => (panel.state.gone as unknown[]).length === 0); assert.deepEqual(panel.state.gone, []);
    const resolve = h.history.resolveRef; h.history.resolveRef = async () => { throw new Error('Repository is no longer open.'); };
    h.close(); h.invalidate(); await until(() => panel.state.expired === true);
    assert.equal(panel.state.expired, true); assert.deepEqual(panel.state.moved, [], 'Closing the repository moves no ref'); assert.deepEqual(panel.state.gone, []);
    assert.equal(panel.state.revision, revision, 'The captured file indexes stay valid');
    await panel.send({ type: 'refresh' });
    assert.match(String(panel.last('error')?.message), /Repository is no longer open\./); assert.doesNotMatch(String(panel.last('error')?.message), /no longer resolves/, 'Refresh names the closed repository, not a vanished ref');
    h.reopen(); h.history.resolveRef = resolve; h.invalidate(); await until(() => panel.state.expired === undefined);
    assert.equal(panel.state.expired, undefined, 'Reopening the repository brings the tab back'); assert.deepEqual(panel.state.moved, []);
  } finally { await h.cleanup(); }
});

test('Withheld file lists and shallow-clone fork points reach the webview as notes', async () => {
  const h = await harness({ files: { scope: 'fork', from: BASE, to: LEFT, files: [], stats: [], omitted: true, note: 'nonUtf8Path' } });
  try {
    const compareRefs = h.history.compareRefs as (...args: unknown[]) => Promise<Record<string, unknown>>;
    h.history.compareRefs = async (...args: unknown[]) => ({ ...await compareRefs(...args), fork: { oid: null, multiple: false, shallow: true } });
    await h.surface.openRefs('repo', 'feature', 'main'); const panel = h.panels[0]!;
    assert.deepEqual(panel.state.fork, { oid: null, multiple: false, shallow: true }); assert.equal(panel.state.files.note, 'nonUtf8Path'); assert.equal(panel.state.files.omitted, true);
    await panel.send({ type: 'openAll', revision: panel.state.revision });
    assert.equal(panel.last('error')?.message, 'Some changed paths are not valid UTF-8, so Git Pro cannot list or open them here. Use a terminal for this comparison.');
    h.history.details = async (_id: string, value: string) => ({ commit: commit(Number.parseInt(value, 16)), parent: oid(999), files: [], stats: [], message: 'Details', filesOmitted: true, filesNote: 'nonUtf8Path' });
    await panel.send({ type: 'selectCommit', revision: panel.state.revision, oid: oid(12) });
    assert.equal(panel.state.files.scope, 'commit'); assert.equal(panel.state.files.omitted, true); assert.equal(panel.state.files.note, 'nonUtf8Path');
  } finally { await h.cleanup(); }
});

test('Open All Changes shows a blob side that is not UTF-8 as a read-only notice; other failures still fail that side', async () => {
  const vscode = { workspace: { registerTextDocumentContentProvider: () => ({ dispose: () => undefined }) }, Uri: { from: ({ scheme, path: value }: { scheme: string; path: string }) => ({ ...uri(scheme, value), query: '', fragment: '' }) } };
  const exports = loadWithVscode(path.resolve(__dirname, '../../src/webviews/compare/compare-panel.js'), vscode);
  const history = { revision: async (_id: string, _oid: string, file: string) => { if (file.endsWith('legacy.txt')) throw new NonUtf8Error('Text diff is unavailable: this revision is not UTF-8 text. Use native Git for this file.'); if (file === 'big.txt') throw new Error('Revision exceeds the 5 MiB text diff limit.'); return Buffer.from('text\n'); } };
  const surface = (exports.createCompareSurface as (context: unknown, deps: unknown) => { blobs: { add(id: string, oid: string, file: string): unknown; provideTextDocumentContent(uri: unknown): Promise<string> }; dispose(): void })({ extensionUri: uri('file', '/extension') }, { registry: { onDidInvalidate: () => ({ dispose: () => undefined }) }, history });
  try {
    assert.equal(await surface.blobs.provideTextDocumentContent(surface.blobs.add('repo', LEFT, 'docs/legacy.txt')), `This version of legacy.txt (${LEFT.slice(0, 8)}) is not UTF-8 text, so Git Pro cannot show it here. Use native Git to compare it.\n`, 'the commit is named, so two non-UTF-8 versions of one file are not identical notices');
    assert.equal(await surface.blobs.provideTextDocumentContent(surface.blobs.add('repo', LEFT, 'plain.txt')), 'text\n');
    await assert.rejects(surface.blobs.provideTextDocumentContent(surface.blobs.add('repo', LEFT, 'big.txt')), /5 MiB/);
  } finally { surface.dispose(); }
});

test('Native menu commands reach the tab through the router and are checked like its own messages', async () => {
  const h = await harness();
  try {
    await h.surface.openRefs('repo', 'feature', 'main'); const panel = h.panels[0]!, state = panel.state, listed = state.sides.leftOnly.commits[1]!.oid;
    const argument = (section: string, extra: Record<string, unknown> = {}) => ({ webview: 'gitPro.compare', webviewSection: section, preventDefaultContextMenuItems: true, session: panel.session, revision: state.revision, ...extra });
    const errors = () => panel.sent.filter(message => message.type === 'error').length;
    const run = async (name: string, section: string, extra: Record<string, unknown> = {}, given = argument(section, extra)) => { const { panel: target, context } = h.menus.resolve(given, ['gitPro.compare'], section); await target.handle!(name, context); };
    assert.equal(h.menus.commit(argument('commit', { oid: listed }), ['gitPro.history', 'gitPro.compare']).repositoryId, 'repo', 'the commit menu of History works on a commit this tab lists');
    assert.throws(() => h.menus.commit(argument('commit', { oid: oid(77) }), ['gitPro.compare']), /no longer shown/, 'and refuses a commit it never listed');
    assert.throws(() => h.menus.commit(argument('file', { oid: listed }), ['gitPro.compare']), /Git Pro panel menu/, 'a file row is not a commit');
    const revision = state.revision;
    await run('copyPath', 'file', { index: 2, indexes: '2', revision }); assert.deepEqual(h.clipboard, ['README.md']);
    await run('diff', 'file', { index: 0, indexes: '0', revision }); assert.equal(h.executed.at(-1)![0], 'vscode.diff');
    await run('localDiff', 'file', { index: 0, indexes: '0', revision }); assert.equal((h.executed.at(-1)![2] as Uri).scheme, 'file');
    await run('openFile', 'file', { index: 0, indexes: '0', revision }); assert.equal(h.executed.at(-1)![0], 'vscode.open');
    const failures = errors();
    await run('diff', 'file', { index: 0, indexes: '0', revision: revision - 1 }); assert.match(String(panel.last('error')?.message), /changed/, 'a menu opened before the list changed is stale');
    await run('diff', 'file', { index: 9, indexes: '9', revision }); assert.match(String(panel.last('error')?.message), /current comparison/);
    await run('getFromBranch', 'file', { index: 0, indexes: '0,0', revision }); assert.match(String(panel.last('error')?.message), /Unknown Compare action/, 'a repeated index is not a selection');
    await run('getFromBranch', 'file', { index: 0, indexes: '0, 1', revision }); assert.equal(errors(), failures + 4, 'a malformed list never reaches the handler');
    await run('getFromBranch', 'file', { index: 0, indexes: '0', revision }); assert.match(String(panel.last('error')?.message), /comparing a branch with the working tree/, 'Get from Branch belongs to working-tree comparisons');
    await run('showFiles', 'commit', { oid: listed }); await h.settle();
    assert.equal(panel.state.files.scope, 'commit'); assert.equal(h.menus.commit(argument('commit', { oid: listed, revision: panel.state.revision }), ['gitPro.compare']).oid, listed, 'the shown commit stays known');
    await run('showInHistory', 'commit', { oid: listed, revision: panel.state.revision }); assert.deepEqual(h.histories.at(-1)!.slice(2), [listed, true]);
    const before = errors(); await run('showFiles', 'commit', { oid: oid(77), revision: panel.state.revision }); assert.equal(errors(), before + 1); assert.match(String(panel.last('error')?.message), /loaded lists/);
    await assert.rejects(run('diff', 'file', { index: 0, revision }, argument('file', { index: 0, revision, session: 'x'.repeat(65) })), /Git Pro panel menu/);
    assert.throws(() => h.menus.resolve(argument('commit', { index: 0 }), ['gitPro.compare'], 'file'), /Git Pro panel menu/, 'a command for file rows refuses a commit row');
    panel.dispose(); assert.throws(() => h.menus.resolve(argument('file'), ['gitPro.compare']), /closed/, 'a closed tab leaves the router');
  } finally { await h.cleanup(); }
});

test('Get from Branch from a native menu names the selection the row carried', async () => {
  const h = await harness();
  try {
    await h.surface.openWorktree('repo', 'feature'); const panel = h.panels[0]!, revision = panel.state.revision;
    const requests: unknown[] = []; (h.surface as { getFromBranch: unknown }).getFromBranch = async (request: unknown) => { requests.push(request); return true; };
    const { panel: target, context } = h.menus.resolve({ webview: 'gitPro.compare', webviewSection: 'file', session: panel.session, revision, index: 2, indexes: '2,0' }, ['gitPro.compare'], 'file');
    await target.handle!('getFromBranch', context);
    assert.deepEqual((JSON.parse(JSON.stringify(requests)) as { files: { path: string }[] }[])[0]!.files.map(file => file.path), ['README.md', 'src/app.ts']);
  } finally { await h.cleanup(); }
});

test('A folder comparison lists only the files inside the folder, keeps its own tab and refuses paths outside the repository', async () => {
  const h = await harness();
  try {
    await h.surface.openWorktree('repo', 'feature', 'src'); const panel = h.panels[0]!;
    assert.equal(panel.title, 'Compare: feature ↔ Working Tree · src');
    const state = panel.state as unknown as { folder?: string; files: { total: number; items: { path: string }[] } };
    assert.equal(state.folder, 'src'); assert.deepEqual(state.files.items.map(item => item.path), ['src/app.ts']); assert.equal(state.files.total, 1, 'the count is the folder\'s');
    await h.surface.openWorktree('repo', 'feature', 'src'); assert.equal(h.panels.length, 1, 'the same folder reveals its tab');
    await h.surface.openWorktree('repo', 'feature'); assert.equal(h.panels.length, 2, 'the whole working tree is another comparison');
    assert.equal(h.panels[1]!.title, 'Compare: feature ↔ Working Tree'); assert.equal((h.panels[1]!.state.files as unknown as { total: number }).total, 3);
    const requests: { files: { path: string }[] }[] = []; (h.surface as { getFromBranch: unknown }).getFromBranch = async (request: { files: { path: string }[] }) => { requests.push(request); return true; };
    await panel.send({ type: 'getFromBranch', revision: panel.state.revision, indexes: [0] }); assert.deepEqual(JSON.parse(JSON.stringify(requests)).map((request: { files: { path: string }[] }) => request.files.map(file => file.path)), [['src/app.ts']], "Get from Branch acts on the folder's files");
    for (const bad of ['src/', '../outside', '/etc', 'C:/x', 'a\\b', '.git', 'a/.git/hooks', '']) await assert.rejects(h.surface.openWorktree('repo', 'feature', bad), /Invalid history path|Choose a folder/, bad);
    assert.equal(h.panels.length, 2, 'a refused folder opens no tab');
  } finally { await h.cleanup(); }
});

test('Diffs open beside the tab as a preview without taking focus, unless the setting is off', async () => {
  const h = await harness();
  try {
    await h.surface.openRefs('repo', 'feature', 'main'); const panel = h.panels[0]!, revision = panel.state.revision;
    await panel.send({ type: 'diff', revision, index: 0 });
    assert.deepEqual(JSON.parse(JSON.stringify(h.executed.at(-1)!.slice(4))), [{ viewColumn: -2, preview: true, preserveFocus: true }], 'the list stays in view and the next click replaces the diff');
    await panel.send({ type: 'localDiff', revision, index: 0 });
    assert.deepEqual(JSON.parse(JSON.stringify(h.executed.at(-1)!.slice(4))), [{ viewColumn: -2, preview: true, preserveFocus: true }]);
    await panel.send({ type: 'openFile', revision, index: 0 }); assert.deepEqual(h.executed.at(-1), ['vscode.open', h.executed.at(-1)![1]], 'opening the file itself is an explicit move to the editor');
    h.settings.beside = false;
    await panel.send({ type: 'diff', revision, index: 0 }); assert.equal(h.executed.at(-1)![4], undefined, 'off: the diff opens in the tab\'s own group');
  } finally { await h.cleanup(); }
});

test('The file filter narrows the list by name and change type, keeps each file\'s own index, and Open All Changes and paging follow it', async () => {
  const h = await harness();
  try {
    await h.surface.openRefs('repo', 'feature', 'main'); const panel = h.panels[0]!, files = () => panel.state.files as unknown as { total: number; unfiltered?: number; binary: number; items: { index: number; path: string }[] };
    assert.equal(files().total, 3); assert.equal(files().unfiltered, undefined, 'no filter, nothing to compare the total with');
    await panel.send({ type: 'filter', revision: panel.state.revision, text: 'readme', statuses: '' });
    assert.deepEqual(files().items.map(item => [item.index, item.path]), [[2, 'README.md']], 'matched by name, whatever the case; the index is still the file\'s place in the captured list');
    assert.equal(files().total, 1); assert.equal(files().unfiltered, 3); assert.deepEqual((panel.state as unknown as { filter: unknown }).filter, { text: 'readme', statuses: '' });
    await panel.send({ type: 'filter', revision: panel.state.revision, text: 'old', statuses: '' });
    assert.deepEqual(files().items.map(item => item.path), ['README.md'], 'a renamed file also matches by its old path');
    await panel.send({ type: 'filter', revision: panel.state.revision, text: '', statuses: 'A' });
    assert.deepEqual(files().items.map(item => [item.index, item.path]), [[1, 'logo.png']]); assert.equal(files().binary, 1, 'the binary count is the shown files\'');
    await panel.send({ type: 'filter', revision: panel.state.revision, text: '', statuses: 'MR' });
    assert.deepEqual(files().items.map(item => item.path), ['src/app.ts', 'README.md']);
    await panel.send({ type: 'filter', revision: panel.state.revision, text: 'zzz', statuses: '' }); assert.equal(files().total, 0); assert.equal(files().unfiltered, 3);
    // Actions name the captured index, so a file opened from a filtered list is the file that was shown.
    await panel.send({ type: 'filter', revision: panel.state.revision, text: 'readme', statuses: '' });
    await panel.send({ type: 'diff', revision: panel.state.revision, index: 2 }); assert.equal((h.executed.at(-1)![1] as Uri).content, `${BASE}:old.md`);
    await panel.send({ type: 'openAll', revision: panel.state.revision });
    const opened = h.executed.at(-1)!; assert.equal(opened[0], 'vscode.changes'); assert.match(String(opened[1]), /Filtered Changes$/); assert.equal((opened[2] as unknown[]).length, 1, 'only the file that matches');
    await panel.send({ type: 'filter', revision: panel.state.revision, text: 'zzz', statuses: '' });
    await panel.send({ type: 'openAll', revision: panel.state.revision }); assert.match(String(panel.last('error')?.message), /No files match the filter/);
    await panel.send({ type: 'filesPage', revision: panel.state.revision, offset: 200 }); assert.match(String(panel.last('error')?.message), /available file page/, 'paging is over the shown files');
    await panel.send({ type: 'filter', revision: panel.state.revision, text: '', statuses: '' }); assert.equal(files().total, 3); assert.equal(files().unfiltered, undefined);
  } finally { await h.cleanup(); }
});

test('Commits with the same change on the other side are marked in the lists, and the tab says how many there are or that they were not checked', async () => {
  const marked = await harness({ equivalent: new Set([oid(10), oid(12), oid(77)]) });
  try {
    await marked.surface.openRefs('repo', 'feature', 'main'); const state = marked.panels[0]!.state as unknown as { equivalentCommits?: number; equivalentSkipped?: boolean; sides: { leftOnly: { commits: { oid: string; equivalent?: boolean }[] } } };
    assert.deepEqual(state.sides.leftOnly.commits.filter(commit => commit.equivalent).map(commit => commit.oid), [oid(10), oid(12)], 'only the listed commits that have a counterpart carry the mark');
    assert.equal(state.equivalentCommits, 3); assert.equal(state.equivalentSkipped, undefined);
  } finally { await marked.cleanup(); }
  const skipped = await harness({ skipped: true });
  try {
    await skipped.surface.openRefs('repo', 'feature', 'main'); const state = skipped.panels[0]!.state as unknown as { equivalentCommits?: number; equivalentSkipped?: boolean; sides: { leftOnly: { commits: { equivalent?: boolean }[] } } };
    assert.equal(state.equivalentSkipped, true); assert.equal(state.equivalentCommits, undefined); assert.ok(state.sides.leftOnly.commits.every(commit => commit.equivalent === undefined));
  } finally { await skipped.cleanup(); }
  const plain = await harness();
  try { await plain.surface.openRefs('repo', 'feature', 'main'); const state = plain.panels[0]!.state as unknown as Record<string, unknown>; assert.equal('equivalentCommits' in state, false); assert.equal('equivalentSkipped' in state, false); } finally { await plain.cleanup(); }
});
