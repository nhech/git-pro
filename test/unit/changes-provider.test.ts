import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as path from 'node:path';

type Change = { path: string; group: 'staged' | 'working' | 'untracked' | 'conflicts'; status: string; originalPath?: string };
type Node = { kind: 'group'; repositoryId: string; group: Change['group'] } | { kind: 'operation'; repositoryId: string; banner: { text: string; actions: { id: string; disabled?: string }[] } } | { kind: 'folder'; repositoryId: string; group: Change['group']; prefix: string } | { kind: 'file'; repositoryId: string; change: Change } | { kind: 'message'; message: string };
const disposable = { dispose: () => undefined };

function harness(initial: Change[], mode = 'folder', operation = 'idle', surfaces?: unknown) {
  const file = path.resolve(__dirname, '../../src/views/changes/changes.provider.js'), load = createRequire(file), exports: Record<string, unknown> = {};
  let reads = 0, current = mode; const configListeners: ((event: { affectsConfiguration: (key: string) => boolean }) => void)[] = [];
  class TreeItem { id?: string; description?: string; contextValue?: string; tooltip?: string; iconPath?: unknown; command?: unknown; constructor(readonly label: string, readonly collapsibleState?: number) {} }
  class ThemeIcon { static readonly File = new ThemeIcon('file'); constructor(readonly id: string, readonly color?: unknown) {} }
  class ThemeColor { constructor(readonly id: string) {} }
  class EventEmitter { private readonly listeners = new Set<() => void>(); event = (listener: () => void) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; fire(): void { for (const listener of this.listeners) listener(); } dispose(): void { this.listeners.clear(); } }
  const vscode = { TreeItem, ThemeIcon, ThemeColor, EventEmitter, TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 }, Uri: { file: (value: string) => value, from: (parts: { scheme: string; path: string; query: string }) => parts },
    workspace: { getConfiguration: () => { reads++; return { get: (_key: string, fallback: string) => current ?? fallback }; }, onDidChangeConfiguration: (callback: (typeof configListeners)[number]) => { configListeners.push(callback); return disposable; } } };
  runInNewContext(readFileSync(file, 'utf8'), { exports, require: (name: string) => name === 'vscode' ? vscode : load(name) });
  const repo = { id: 'repo', root: 'fixture/repo' };
  let changes: readonly Change[] = Object.freeze(initial.map(change => Object.freeze(change)));
  // A snapshot is one immutable object until the status changes, as in the real store.
  let snapshot = { changes, operation };
  const registry = { active: repo, errors: new Map<string, string>(), store: { get: (id?: string) => id === undefined || id === repo.id ? snapshot : undefined }, list: () => [repo], onDidChange: () => disposable };
  type Provider = { onDidChangeTreeData(listener: () => void): { dispose(): void }; currentBanner(repositoryId: string): { actions: { id: string; disabled?: string }[] } | undefined; getChildren(node?: Node): Node[]; getTreeItem(node: Node): { label: string; description?: string; iconPath?: unknown; tooltip?: string; resourceUri?: { scheme: string; path: string; query: string }; contextValue?: string }; dispose(): void };
  const provider = new (exports.ChangesProvider as new (registry: unknown, surfaces?: unknown) => Provider)(registry, surfaces);
  // The operation row (an idle repository with conflicts earns one) is tested on its own; the tree below it is what the oracle describes.
  const children = (node?: Node) => provider.getChildren(node).filter(child => child.kind !== 'operation');
  return { provider, children, repo, get reads() { return reads; }, setMode: (value: string) => { current = value; for (const listener of configListeners) listener({ affectsConfiguration: key => key === 'gitPro.changes.groupBy' }); },
    setChanges: (next: Change[]) => { changes = Object.freeze(next.map(change => Object.freeze(change))); snapshot = { changes, operation }; } };
}

/** The tree builder before indexing, kept verbatim as the oracle. */
function reference(changes: readonly Change[], mode: string, repositoryId: string, node?: Node): Node[] {
  if (node && (node.kind === 'file' || node.kind === 'message')) return [];
  if (!node) return changes.length ? (['conflicts', 'staged', 'working', 'untracked'] as const).filter(group => changes.some(change => change.group === group)).map(group => ({ kind: 'group' as const, repositoryId, group })) : [{ kind: 'message', message: 'Working tree clean' }];
  if (node.kind !== 'group' && node.kind !== 'folder') return [];
  const prefix = node.kind === 'folder' ? node.prefix : '';
  const selected = changes.filter(change => change.group === node.group && change.path.startsWith(prefix));
  if (mode !== 'folder') return selected.map(change => ({ kind: 'file' as const, repositoryId, change }));
  const folders = new Set<string>(), children: Node[] = [];
  for (const change of selected) { const suffix = change.path.slice(prefix.length), slash = suffix.indexOf('/'); if (slash < 0) children.push({ kind: 'file', repositoryId, change }); else folders.add(prefix + suffix.slice(0, slash + 1)); }
  return [...[...folders].sort().map(folder => ({ kind: 'folder' as const, repositoryId, group: node.group, prefix: folder })), ...children];
}
const describe = (node: Node): string => node.kind === 'file' ? `file:${node.change.group}:${node.change.path}:${node.change.originalPath ?? ''}` : node.kind === 'folder' ? `folder:${node.group}:${node.prefix}` : node.kind === 'group' ? `group:${node.group}` : node.kind === 'operation' ? `operation:${node.banner.text}` : `message:${node.message}`;
function walk(children: (node?: Node) => Node[], node?: Node, depth = 0): string[] {
  const result: string[] = [];
  for (const child of children(node)) { result.push(`${' '.repeat(depth)}${describe(child)}`, ...walk(children, child, depth + 1)); }
  return result;
}
const change = (name: string, group: Change['group'] = 'working', status = 'M'): Change => ({ path: name, group, status });
const handmade = [change('README.md'), change('src/a.ts'), change('src/b.ts', 'staged', 'A'), change('src/deep/er/c.ts'), change('src/deep/d.ts', 'untracked', '?'), change('src/deep/d.ts', 'staged'), change('docs/guide.md', 'conflicts', 'UU'),
  change('with space/日本語 file.txt'), change('trailing/'), change('src/a.ts'), { path: 'new/name.ts', group: 'staged' as const, status: 'R', originalPath: 'old/name.ts' }];

test('indexed folder tree is identical to the original filter-per-folder builder', () => {
  const h = harness(handmade);
  assert.deepEqual(walk(node => h.children(node)), walk(node => reference(handmade, 'folder', h.repo.id, node)));
  let seed = 0x51ed27; const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
  const vocabulary = ['src', 'lib', 'test', 'a', 'b', 'util', 'x y', 'ü', 'node_modules'], groups: Change['group'][] = ['staged', 'working', 'untracked', 'conflicts'];
  const generated: Change[] = [];
  for (let index = 0; index < 600; index++) {
    const depth = next() % 6; const parts: string[] = [];
    for (let level = 0; level < depth; level++) parts.push(vocabulary[next() % vocabulary.length]!);
    parts.push(`file${next() % 40}.ts`); generated.push(change(parts.join('/'), groups[next() % 4]!));
  }
  const g = harness(generated);
  assert.deepEqual(walk(node => g.children(node)), walk(node => reference(generated, 'folder', g.repo.id, node)));
  g.setMode('status');
  assert.deepEqual(walk(node => g.children(node)), walk(node => reference(generated, 'status', g.repo.id, node)));
});

test('building the whole tree reads the grouping setting once, not once per folder', () => {
  const files: Change[] = []; for (let index = 0; index < 3000; index++) files.push(change(`packages/pkg${index % 150}/src/dir${index % 20}/file${index}.ts`));
  const h = harness(files);
  const size = walk(node => h.children(node)).length;
  assert.ok(size > 3000 + 150, 'folders and files were produced'); assert.ok(h.reads <= 1, `expected one configuration read, saw ${h.reads}`);
  walk(node => h.children(node)); assert.ok(h.reads <= 1, 'the setting stays cached until it changes');
  h.setMode('status'); walk(node => h.children(node)); assert.equal(h.reads, 2, 'a configuration change re-reads exactly once');
});

test('a new status snapshot never serves a stale folder index', () => {
  const h = harness([change('a/one.ts'), change('b/two.ts')]);
  assert.deepEqual(walk(node => h.children(node)), walk(node => reference([change('a/one.ts'), change('b/two.ts')], 'folder', h.repo.id, node)));
  const next = [change('a/one.ts'), change('c/three.ts'), change('c/four.ts', 'staged', 'A')]; h.setChanges(next);
  assert.deepEqual(walk(node => h.children(node)), walk(node => reference(next, 'folder', h.repo.id, node)));
  h.setChanges([]); assert.deepEqual(Array.from(h.provider.getChildren(), describe), ['message:Working tree clean']);
});

test('tree items share icons, redact once per row and keep their contract', () => {
  const h = harness([change('src/a.ts'), change('src/b.ts'), change('src/token=abc.ts')], 'status');
  const [group] = h.provider.getChildren(); const [first, second, third] = h.provider.getChildren(group);
  const item = h.provider.getTreeItem(first!), other = h.provider.getTreeItem(second!);
  // The name leads and the directory follows it; the status is the letter the row's URI draws at the far edge, with its words in the tooltip.
  assert.equal(item.label, 'a.ts'); assert.equal(item.description, 'src'); assert.equal(item.tooltip, 'src/a.ts\nModified'); assert.equal(item.contextValue, 'gitPro.change.working');
  assert.deepEqual({ ...item.resourceUri }, { scheme: 'git-pro-change', path: '/src/a.ts', query: 'g=working&s=M' });
  assert.equal(item.iconPath, other.iconPath, 'equal visuals share one immutable icon object');
  assert.equal(h.provider.getTreeItem(third!).label, 'token=[redacted]', 'secret-looking text is still redacted');
  assert.equal(h.provider.getTreeItem(group!).description, '3');
});

test('conflict rows describe their kind from the repository operation and never run Diff', () => {
  const conflicts = [change('both.ts', 'conflicts', 'UU'), change('gone.ts', 'conflicts', 'DU'), change('kept.ts', 'conflicts', 'UD')];
  const describeRows = (operation: string) => { const h = harness(conflicts, 'status', operation); const [group] = h.children(); return h.children(group).map(node => h.provider.getTreeItem(node)); };
  assert.deepEqual(describeRows('merging').map(item => item.description), ['Both modified', 'Deleted by us', 'Deleted by them']);
  assert.deepEqual(describeRows('rebasing').map(item => item.description), ['Both modified', 'Deleted by them', 'Deleted by us'], 'a rebase swaps Yours and Theirs (D3)');
  const item = describeRows('merging')[0] as { command?: { command: string } };
  assert.equal(item.command?.command, 'gitPro.resolveConflict', 'a conflicted file has no diff to open');
  const working = harness([change('a.ts')], 'status'); const [group] = working.provider.getChildren();
  assert.equal((working.provider.getTreeItem(working.provider.getChildren(group)[0]!) as { command?: { command: string } }).command?.command, 'gitPro.diff');
});

test('an operation in progress is the first row, offers its buttons as words of its context value, and is worded again when the summary arrives', async () => {
  let release!: (summary: unknown) => void;
  const summary = { operation: 'merging', title: 'Merging feature into main', canContinue: false, canSkip: false, canAbort: true, editStop: false, nativeOnly: false, yours: {}, theirs: {} };
  const h = harness([change('a.ts', 'conflicts', 'UU'), change('b.ts', 'conflicts', 'UU')], 'status', 'merging', { operation: { summary: () => new Promise(resolve => { release = resolve; }) } });
  let redrawn = 0; h.provider.onDidChangeTreeData(() => { redrawn++; });
  const [operation, group] = h.provider.getChildren(); assert.equal(operation!.kind, 'operation'); assert.equal(group!.kind, 'group');
  let item = h.provider.getTreeItem(operation!) as unknown as { label: string; contextValue: string; command: { command: string }; tooltip: string };
  assert.match(item.label, /Merge in progress · 2 conflicts/); assert.equal(item.command.command, 'gitPro.operation.menu', 'a click opens the same choices as a list, with the reason for each one that is unavailable');
  const words = item.contextValue.split(' '); assert.deepEqual(Array.from(words), ['gitPro.operation', 'resolve', 'abort'], 'Continue waits for the conflicts, so the row does not offer it');
  assert.match(item.tooltip, /Continue Merge…: Resolve and stage all conflicts first/);
  h.provider.getChildren(); assert.equal(redrawn, 0, 'the summary is requested once per snapshot, and nothing is redrawn before it arrives');
  release(summary); await new Promise(resolve => setImmediate(resolve)); assert.equal(redrawn, 1, 'the row is drawn again with the summary\'s words');
  item = h.provider.getTreeItem(h.provider.getChildren()[0]!) as unknown as typeof item; assert.match(item.label, /Merging feature into main · 2 conflicts/);
  // Everything resolved: the row stays, now offering Continue, and the tree below it is empty rather than "clean".
  const finished = harness([], 'status', 'merging'); const rows = finished.provider.getChildren();
  assert.deepEqual(Array.from(rows, row => row.kind), ['operation']); assert.deepEqual(Array.from((finished.provider.getTreeItem(rows[0]!) as unknown as { contextValue: string }).contextValue.split(' ')), ['gitPro.operation', 'continue', 'abort']);
  assert.deepEqual(Array.from(harness([change('a.ts')], 'status').provider.getChildren(), row => row.kind), ['group'], 'no operation, no row');
  assert.equal(finished.provider.currentBanner('repo')?.actions.some(action => action.id === 'continue'), true); assert.equal(finished.provider.currentBanner('other'), undefined);
});

test('group rows carry their repository and a context value per status group', () => {
  const h = harness([change('a.ts'), change('b.ts', 'staged', 'A'), change('c.ts', 'untracked', '?')], 'status');
  const groups = h.provider.getChildren(); assert.deepEqual(Array.from(groups, node => (node as { repositoryId?: string }).repositoryId), ['repo', 'repo', 'repo']);
  assert.deepEqual(Array.from(groups, node => h.provider.getTreeItem(node).contextValue), ['gitPro.group.staged', 'gitPro.group.working', 'gitPro.group.untracked']);
  assert.deepEqual(Array.from(h.provider.getChildren(groups[1]), node => (h.provider.getTreeItem(node) as { description?: string }).description), [undefined], 'a file at the root has no directory to show');
});

test('a row carries words after its kind for the menus: no file to open when it is deleted, and Merge… only for a conflict both sides changed or added', () => {
  const rows = [change('kept.ts'), change('gone.ts', 'working', 'D'), change('removed.ts', 'staged', 'D'), change('new.ts', 'untracked', '?'), change('both.ts', 'conflicts', 'UU'), change('added.ts', 'conflicts', 'AA'), change('mine.ts', 'conflicts', 'DU'), change('theirs.ts', 'conflicts', 'UD'), change('neither.ts', 'conflicts', 'DD')];
  const h = harness(rows, 'status');
  // Every file row, whatever changed in it, has the icon of its file in the user's file icon theme; the status is the colour and the letter of the row.
  const icons = new Set(h.children().flatMap(group => h.children(group)).map(node => h.provider.getTreeItem(node).iconPath as { id: string; color?: unknown }));
  assert.equal(icons.size, 1, 'one shared object'); assert.equal([...icons][0]!.id, 'file'); assert.equal([...icons][0]!.color, undefined);
  const values = Object.fromEntries(h.children().flatMap(group => h.children(group)).map(node => { const item = h.provider.getTreeItem(node); return [item.label, item.contextValue]; }));
  assert.deepEqual(values, { 'kept.ts': 'gitPro.change.working', 'gone.ts': 'gitPro.change.working nofile', 'removed.ts': 'gitPro.change.staged nofile', 'new.ts': 'gitPro.change.untracked',
    'both.ts': 'gitPro.change.conflicts merge', 'added.ts': 'gitPro.change.conflicts merge', 'mine.ts': 'gitPro.change.conflicts', 'theirs.ts': 'gitPro.change.conflicts', 'neither.ts': 'gitPro.change.conflicts nofile' });
});
