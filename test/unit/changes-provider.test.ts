import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as path from 'node:path';

type Change = { path: string; group: 'staged' | 'working' | 'untracked' | 'conflicts'; status: string; originalPath?: string };
type Node = { kind: 'group'; group: Change['group'] } | { kind: 'folder'; repositoryId: string; group: Change['group']; prefix: string } | { kind: 'file'; repositoryId: string; change: Change } | { kind: 'message'; message: string };
const disposable = { dispose: () => undefined };

function harness(initial: Change[], mode = 'folder') {
  const file = path.resolve(__dirname, '../../src/views/changes/changes.provider.js'), load = createRequire(file), exports: Record<string, unknown> = {};
  let reads = 0, current = mode; const configListeners: ((event: { affectsConfiguration: (key: string) => boolean }) => void)[] = [];
  class TreeItem { id?: string; description?: string; contextValue?: string; tooltip?: string; iconPath?: unknown; command?: unknown; constructor(readonly label: string, readonly collapsibleState?: number) {} }
  class ThemeIcon { constructor(readonly id: string, readonly color?: unknown) {} }
  class ThemeColor { constructor(readonly id: string) {} }
  class EventEmitter { private readonly listeners = new Set<() => void>(); event = (listener: () => void) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; fire(): void { for (const listener of this.listeners) listener(); } dispose(): void { this.listeners.clear(); } }
  const vscode = { TreeItem, ThemeIcon, ThemeColor, EventEmitter, TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 }, Uri: { file: (value: string) => value },
    workspace: { getConfiguration: () => { reads++; return { get: (_key: string, fallback: string) => current ?? fallback }; }, onDidChangeConfiguration: (callback: (typeof configListeners)[number]) => { configListeners.push(callback); return disposable; } } };
  runInNewContext(readFileSync(file, 'utf8'), { exports, require: (name: string) => name === 'vscode' ? vscode : load(name) });
  const repo = { id: 'repo', root: 'fixture/repo' };
  let changes: readonly Change[] = Object.freeze(initial.map(change => Object.freeze(change)));
  const registry = { active: repo, errors: new Map<string, string>(), store: { get: () => ({ changes }) }, onDidChange: () => disposable };
  type Provider = { getChildren(node?: Node): Node[]; getTreeItem(node: Node): { label: string; description?: string; iconPath?: unknown; tooltip?: string }; dispose(): void };
  const provider = new (exports.ChangesProvider as new (registry: unknown) => Provider)(registry);
  return { provider, repo, get reads() { return reads; }, setMode: (value: string) => { current = value; for (const listener of configListeners) listener({ affectsConfiguration: key => key === 'gitPro.changes.groupBy' }); },
    setChanges: (next: Change[]) => { changes = Object.freeze(next.map(change => Object.freeze(change))); } };
}

/** The tree builder before indexing, kept verbatim as the oracle. */
function reference(changes: readonly Change[], mode: string, repositoryId: string, node?: Node): Node[] {
  if (node && (node.kind === 'file' || node.kind === 'message')) return [];
  if (!node) return changes.length ? (['conflicts', 'staged', 'working', 'untracked'] as const).filter(group => changes.some(change => change.group === group)).map(group => ({ kind: 'group' as const, group })) : [{ kind: 'message', message: 'Working tree clean' }];
  if (node.kind !== 'group' && node.kind !== 'folder') return [];
  const prefix = node.kind === 'folder' ? node.prefix : '';
  const selected = changes.filter(change => change.group === node.group && change.path.startsWith(prefix));
  if (mode !== 'folder') return selected.map(change => ({ kind: 'file' as const, repositoryId, change }));
  const folders = new Set<string>(), children: Node[] = [];
  for (const change of selected) { const suffix = change.path.slice(prefix.length), slash = suffix.indexOf('/'); if (slash < 0) children.push({ kind: 'file', repositoryId, change }); else folders.add(prefix + suffix.slice(0, slash + 1)); }
  return [...[...folders].sort().map(folder => ({ kind: 'folder' as const, repositoryId, group: node.group, prefix: folder })), ...children];
}
const describe = (node: Node): string => node.kind === 'file' ? `file:${node.change.group}:${node.change.path}:${node.change.originalPath ?? ''}` : node.kind === 'folder' ? `folder:${node.group}:${node.prefix}` : node.kind === 'group' ? `group:${node.group}` : `message:${node.message}`;
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
  assert.deepEqual(walk(node => h.provider.getChildren(node)), walk(node => reference(handmade, 'folder', h.repo.id, node)));
  let seed = 0x51ed27; const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
  const vocabulary = ['src', 'lib', 'test', 'a', 'b', 'util', 'x y', 'ü', 'node_modules'], groups: Change['group'][] = ['staged', 'working', 'untracked', 'conflicts'];
  const generated: Change[] = [];
  for (let index = 0; index < 600; index++) {
    const depth = next() % 6; const parts: string[] = [];
    for (let level = 0; level < depth; level++) parts.push(vocabulary[next() % vocabulary.length]!);
    parts.push(`file${next() % 40}.ts`); generated.push(change(parts.join('/'), groups[next() % 4]!));
  }
  const g = harness(generated);
  assert.deepEqual(walk(node => g.provider.getChildren(node)), walk(node => reference(generated, 'folder', g.repo.id, node)));
  g.setMode('status');
  assert.deepEqual(walk(node => g.provider.getChildren(node)), walk(node => reference(generated, 'status', g.repo.id, node)));
});

test('building the whole tree reads the grouping setting once, not once per folder', () => {
  const files: Change[] = []; for (let index = 0; index < 3000; index++) files.push(change(`packages/pkg${index % 150}/src/dir${index % 20}/file${index}.ts`));
  const h = harness(files);
  const size = walk(node => h.provider.getChildren(node)).length;
  assert.ok(size > 3000 + 150, 'folders and files were produced'); assert.ok(h.reads <= 1, `expected one configuration read, saw ${h.reads}`);
  walk(node => h.provider.getChildren(node)); assert.ok(h.reads <= 1, 'the setting stays cached until it changes');
  h.setMode('status'); walk(node => h.provider.getChildren(node)); assert.equal(h.reads, 2, 'a configuration change re-reads exactly once');
});

test('a new status snapshot never serves a stale folder index', () => {
  const h = harness([change('a/one.ts'), change('b/two.ts')]);
  assert.deepEqual(walk(node => h.provider.getChildren(node)), walk(node => reference([change('a/one.ts'), change('b/two.ts')], 'folder', h.repo.id, node)));
  const next = [change('a/one.ts'), change('c/three.ts'), change('c/four.ts', 'staged', 'A')]; h.setChanges(next);
  assert.deepEqual(walk(node => h.provider.getChildren(node)), walk(node => reference(next, 'folder', h.repo.id, node)));
  h.setChanges([]); assert.deepEqual(Array.from(h.provider.getChildren(), describe), ['message:Working tree clean']);
});

test('tree items share icons, redact once per row and keep their contract', () => {
  const h = harness([change('src/a.ts'), change('src/b.ts'), change('src/token=abc.ts')], 'status');
  const [group] = h.provider.getChildren(); const [first, second, third] = h.provider.getChildren(group);
  const item = h.provider.getTreeItem(first!), other = h.provider.getTreeItem(second!);
  assert.equal(item.label, 'src/a.ts'); assert.equal(item.tooltip, 'src/a.ts'); assert.equal(item.description, 'Modified');
  assert.equal(item.iconPath, other.iconPath, 'equal visuals share one immutable icon object');
  assert.equal(h.provider.getTreeItem(third!).label, 'src/token=[redacted]', 'secret-looking text is still redacted');
  assert.equal(h.provider.getTreeItem(group!).description, '3');
});
