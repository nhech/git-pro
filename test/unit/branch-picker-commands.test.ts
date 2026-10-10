import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import type { BranchInfo } from '../../src/git/git.service';

function event<T>() {
  const listeners = new Set<(value: T) => void>();
  return { listeners, listen: (fn: (value: T) => void) => { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
    fire: (value: T) => { for (const fn of [...listeners]) fn(value); } };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const branch = (name: string, remote = false): BranchInfo => ({ name, remote, ref: `refs/${remote ? 'remotes' : 'heads'}/${name}`, oid: 'a'.repeat(40), upstream: '', worktree: '' });
type Item = { label: string; description?: string; kind?: number; alwaysShow?: boolean; iconPath?: { id: string; color?: { id: string } }; node?: { repositoryId: string; branch: BranchInfo }; create?: boolean; action?: string };

function harness(failure?: 'read' | 'show') {
  const changed = event<string>(), accepted = event<void>(), hidden = event<void>(), registryChanged = event<void>();
  let disposed = false, writes = 0, shown = 0, disposedCount = 0, items: readonly Item[] = [], busy = false, placeholder = '';
  const picker = {
    value: '', selectedItems: [] as readonly Item[], title: '',
    get items() { return items; }, set items(value: readonly Item[]) { assert.equal(disposed, false); writes++; items = value; },
    get busy() { return busy; }, set busy(value: boolean) { assert.equal(disposed, false); writes++; busy = value; },
    get placeholder() { return placeholder; }, set placeholder(value: string) { assert.equal(disposed, false); writes++; placeholder = value; },
    onDidChangeValue: changed.listen, onDidAccept: accepted.listen, onDidHide: hidden.listen,
    show: () => { shown++; if (failure === 'show') throw new Error('owned show failure'); }, hide: () => { picker.selectedItems = []; hidden.fire(); }, dispose: () => { disposed = true; disposedCount++; },
  };
  const original = { id: 'owned', root: '/owned' }, other = { id: 'other', root: '/other' };
  const registry = { active: original as typeof original | undefined, list: () => repositories, onDidChange: registryChanged.listen, store: { get: () => ({ head: 'main' }) } };
  let repositories = [original], readCount = 0, inputCount = 0;
  const read = deferred<readonly BranchInfo[]>(), commands = new Map<string, (...args: unknown[]) => Promise<void>>(), errors: string[] = [], copied: string[] = [], actionTitles: string[] = [];
  const actionItems: readonly Item[][] = [], operations: unknown[][] = [], warnings: { text: string; choices: string[] }[] = [];
  let actionChoice: string | undefined = 'Copy Name', confirmation: string | undefined;
  let refs = [branch('feature/ux')];
  const git = { registry, repository: (id: string) => { assert.equal(id, original.id); return original; },
    preview: async (id: string) => { assert.equal(id, original.id); return { repositoryId: id }; }, branches: async () => refs,
    checkout: async (...args: unknown[]) => { operations.push(['checkout', ...args]); },
    branchAction: async (...args: unknown[]) => { operations.push(['branchAction', ...args]); },
    branchSearchSnapshot: () => { assert.equal(shown, 1, 'picker must open before the metadata read starts'); readCount++; if (failure === 'read') throw new Error('owned synchronous read failure'); return read.promise; } };
  const vscode = { ProgressLocation: { Window: 10 }, QuickPickItemKind: { Separator: -1 },
    ThemeIcon: class { constructor(readonly id: string, readonly color?: { id: string }) {} }, ThemeColor: class { constructor(readonly id: string) {} }, commands: {
    registerCommand: (id: string, fn: (...args: unknown[]) => Promise<void>) => { commands.set(id, fn); return { dispose: () => commands.delete(id) }; }, executeCommand: async () => undefined,
  }, window: { createQuickPick: () => picker, withProgress: (_options: unknown, run: () => Promise<void>) => run(),
    showErrorMessage: async (text: string) => { errors.push(text); return undefined; },
    showQuickPick: async (offered: readonly Item[], options: { title: string }) => { actionTitles.push(options.title); (actionItems as Item[][]).push([...offered]); return offered.find(item => (typeof item === 'string' ? item : item.label) === actionChoice); },
    showWarningMessage: async (text: string, _options: unknown, ...choices: string[]) => { warnings.push({ text, choices }); return confirmation; },
    showInputBox: async () => { inputCount++; return undefined; },
  }, env: { clipboard: { writeText: async (text: string) => { copied.push(text); } } } };
  const source = path.resolve(__dirname, '../../src/commands/daily.commands.js'), load = createRequire(source), exports: Record<string, unknown> = {};
  runInNewContext(readFileSync(source, 'utf8'), { exports, require: (name: string) => name === 'vscode' ? vscode : name === '../git/git.service' ? { DailyError: class extends Error {} } : name === '../git/diff/diff.service' ? { DiffService: class {} } : load(name) });
  const Constructor = exports.DailyCommands as new (...args: unknown[]) => { dispose(): void };
  const instance = new Constructor(git, {}, {}, { selection: [] }, { error: () => undefined });
  const start = () => commands.get('gitPro.branches')!();
  const type = (value: string) => { picker.value = value; changed.fire(value); };
  const choose = (item: Item) => { picker.selectedItems = [item]; accepted.fire(); };
  const assertClosed = () => { assert.equal(disposedCount, 1); for (const stream of [changed, accepted, hidden, registryChanged]) assert.equal(stream.listeners.size, 0); };
  return { picker, read, registry, registryChanged, original, other, instance, errors, copied, actionTitles, actionItems, operations, warnings, start, type, choose, assertClosed,
    action: (selected: BranchInfo, choice?: string, confirm?: string, fresh = true) => { actionChoice = choice; confirmation = confirm; refs = fresh ? [selected] : []; return commands.get('gitPro.branchActions')!({ kind: 'branch', repositoryId: original.id, branch: selected }); },
    stats: () => ({ readCount, inputCount, shown, writes }), replace: () => { repositories = [{ ...original }]; registry.active = repositories[0]; },
    remove: () => { repositories = []; }, accept: () => accepted.fire() };
}

test('branch picker opens busy before deferred read, retains typed query, caps matches and captures selection before hide', async () => {
  const h = harness(), pending = h.start();
  assert.equal(h.stats().shown, 1); assert.equal(h.picker.busy, true); assert.equal(h.picker.items.length, 0);
  assert.match(h.picker.placeholder, /Loading/); h.type('FeAtUrE'); h.accept(); assert.equal(h.stats().inputCount, 0);
  const branches = [branch('main'), ...Array.from({ length: 250 }, (_, i) => branch(`feature/${i}`, i === 0))];
  h.read.resolve(branches); await tick();
  assert.equal(h.picker.busy, false); assert.equal(h.picker.value, 'FeAtUrE'); assert.equal(h.picker.items.filter(item => item.node).length, 200);
  assert.equal(h.picker.items[0]!.node!.branch, branches[1]);
  assert.equal(h.picker.items[0]!.description, 'Remote'); assert.equal(h.picker.items[0]!.iconPath?.id, 'cloud');
  const staleItem = h.picker.items[0]!; h.type('main'); h.choose(staleItem); assert.equal(h.copied.length, 0);
  h.type('feature/0'); h.choose(h.picker.items[0]!); h.accept(); await pending;
  assert.deepEqual(h.copied, ['feature/0']); assert.deepEqual(h.actionTitles, ['feature/0']); h.assertClosed(); h.instance.dispose();
});

test('local branch actions describe scope, keep deletion last, and cancel or separator cannot mutate', async () => {
  const h = harness(), selected = branch('feature/ux');
  await h.action(selected); const items = h.actionItems[0]!;
  assert.equal(items[0]!.label, 'Checkout'); assert.ok(items[0]!.iconPath);
  const divider = items.findIndex(item => item.kind === -1);
  assert.ok(divider > items.findIndex(item => item.label === 'Copy Name'));
  assert.deepEqual(Array.from(items.slice(divider + 1), item => item.action), ['Delete', 'Force Delete']);
  assert.ok(items.filter(item => item.kind !== -1).every(item => item.description && item.iconPath && item.action));
  await h.action(selected, 'Delete branch'); assert.deepEqual(h.operations, []); assert.deepEqual(h.warnings, []); assert.deepEqual(h.copied, []);
  await h.action(selected, 'Checkout'); assert.deepEqual(h.operations, [['checkout', 'owned', 'feature/ux']]); h.instance.dispose();
});

test('remote branch actions offer only tracking checkout and copy; copy preserves the full raw name', async () => {
  const h = harness(), selected = branch('origin/feature/ux', true);
  await h.action(selected, 'Copy Name');
  assert.deepEqual(Array.from(h.actionItems[0]!, item => item.action), ['Checkout Tracking Branch', 'Copy Name']);
  assert.ok(h.actionItems[0]!.every(item => item.description && item.iconPath));
  assert.deepEqual(h.copied, ['origin/feature/ux']); assert.deepEqual(h.operations, []); assert.deepEqual(h.warnings, []);
  await h.action(selected); assert.equal(h.copied.length, 1); assert.equal(h.stats().inputCount, 0); h.instance.dispose();
});

test('branch deletion keeps plain modal identities, fresh-ref guard and explicit force selection', async () => {
  const h = harness(), selected = branch('feature/ux');
  await h.action(selected, 'Delete'); assert.deepEqual(h.warnings[0]!.choices, ['Delete']); assert.deepEqual(h.operations, []);
  await h.action(selected, 'Delete', 'Delete'); assert.equal(h.operations[0]![3], 'delete');
  await h.action(selected, 'Force Delete', 'Delete'); assert.equal(h.operations.length, 1);
  assert.deepEqual(h.warnings.at(-1)!.choices, ['Force Delete']); assert.match(h.warnings.at(-1)!.text, /Unmerged commits may become unreachable/);
  await h.action(selected, 'Force Delete', 'Force Delete'); assert.equal(h.operations[1]![3], 'force-delete');
  const warningCount = h.warnings.length;
  await h.action(selected, 'Delete', 'Delete', false); assert.equal(h.operations.length, 2); assert.equal(h.warnings.length, warningCount);
  assert.equal(h.errors.length, 1); h.instance.dispose();
});

test('closing branch picker settles without waiting for read; late success/rejection never changes disposed UI', async () => {
  for (const reject of [false, true]) {
    const h = harness(); let settled = false;
    const pending = h.start().then(() => { settled = true; });
    h.picker.hide(); await tick(); assert.equal(settled, true); h.assertClosed();
    const writes = h.stats().writes;
    if (reject) h.read.reject(new Error('late failure')); else h.read.resolve([branch('main')]);
    await pending; await tick(); assert.equal(h.stats().writes, writes); assert.deepEqual(h.errors, []); h.instance.dispose();
  }
});

test('repository switch/removal/replacement closes loading picker and ignores late metadata', async () => {
  for (const change of ['switch', 'remove', 'replace']) {
    const h = harness(), pending = h.start();
    if (change === 'switch') h.registry.active = h.other;
    else if (change === 'remove') h.remove(); else h.replace();
    h.registryChanged.fire(); await pending; h.assertClosed();
    h.read.reject(new Error('obsolete repository')); await tick(); assert.deepEqual(h.errors, []); h.instance.dispose();
  }
});

test('repository status refresh keeps picker open; changed repository at accept cannot open branch actions', async () => {
  const h = harness(), pending = h.start(); h.registryChanged.fire();
  h.read.resolve([branch('main')]); await tick(); assert.equal(h.picker.busy, false);
  h.registry.active = h.other; h.choose(h.picker.items[0]!); await pending;
  assert.deepEqual(h.actionTitles, []); h.assertClosed(); h.instance.dispose();
});

test('live load failure closes picker, uses existing error UI once, and next invocation can retry', async () => {
  const h = harness(), pending = h.start(); h.read.reject(new Error('owned read failure')); await pending;
  h.assertClosed(); assert.equal(h.errors.length, 1); h.instance.dispose();
  const retry = harness(), again = retry.start(); retry.read.resolve([]); await tick();
  assert.equal(retry.picker.items.length, 1); retry.choose(retry.picker.items[0]!); await again;
  assert.equal(retry.stats().inputCount, 1); retry.assertClosed(); retry.instance.dispose();
});

test('extension disposal dismisses pending picker and disposes all event registrations', async () => {
  const h = harness(), pending = h.start(); h.instance.dispose(); await pending; h.assertClosed();
  h.read.resolve([branch('main')]); await tick(); assert.deepEqual(h.errors, []);
});

test('synchronous loading/show failure closes picker and reports through established recovery', async () => {
  for (const failure of ['read', 'show'] as const) {
    const h = harness(failure); await h.start(); h.assertClosed(); assert.equal(h.errors.length, 1);
    assert.equal(h.stats().readCount, failure === 'read' ? 1 : 0); h.instance.dispose();
  }
});

test('late metadata after a missed repository event cannot populate obsolete branches', async () => {
  const h = harness(), pending = h.start(), writes = h.stats().writes;
  h.replace(); h.read.resolve([branch('main')]); await pending;
  h.assertClosed(); assert.equal(h.stats().writes, writes); assert.deepEqual(h.actionTitles, []); h.instance.dispose();
});

test('branch data precedes create, current is explicit, separator is inert, and no-match create is cancelable', async () => {
  const h = harness(), pending = h.start(); h.read.resolve([branch('main'), branch('origin/main', true)]); await tick();
  const current = h.picker.items[0]!; assert.equal(current.node!.branch.name, 'main'); assert.equal(current.description, 'Current · Local');
  assert.equal(current.iconPath?.id, 'git-branch'); assert.equal(current.iconPath?.color?.id, 'charts.green');
  const separator = h.picker.items.find(item => item.kind === -1)!; assert.ok(separator); h.choose(separator); await tick();
  assert.equal(h.stats().inputCount, 0); assert.equal(h.picker.busy, false); assert.deepEqual(h.actionTitles, []);
  assert.equal(h.picker.items.at(-1)!.create, true); h.type('missing-branch'); assert.equal(h.picker.items.length, 1);
  assert.equal(h.picker.items[0]!.create, true); assert.equal(h.picker.items[0]!.alwaysShow, true); h.choose(h.picker.items[0]!); await pending;
  assert.equal(h.stats().inputCount, 1); assert.deepEqual(h.actionTitles, []); assert.deepEqual(h.errors, []); h.assertClosed(); h.instance.dispose();
});
