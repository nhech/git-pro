import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module from 'node:module';
import * as path from 'node:path';

type Message = Record<string, unknown>;
class FakePanel {
  readonly sent: Message[] = []; readonly reveals: unknown[] = []; private readonly disposers: (() => void)[] = []; receive: (value: unknown) => void = () => undefined;
  visible = true; iconPath: unknown; disposed = false;
  readonly webview = { html: '', cspSource: 'vscode-resource:', asWebviewUri: (uri: { path: string }) => ({ toString: () => `webview:${uri.path}` }),
    postMessage: async (value: Message) => { this.sent.push(value); return true; }, onDidReceiveMessage: (callback: (value: unknown) => void) => { this.receive = callback; return { dispose: () => undefined }; } };
  constructor(readonly viewType: string, readonly title: string, readonly show: unknown, readonly options: { retainContextWhenHidden?: boolean; localResourceRoots?: { path: string }[] }) {}
  reveal(_column: unknown, preserveFocus: boolean): void { this.reveals.push(preserveFocus); }
  onDidDispose(callback: () => void) { this.disposers.push(callback); return { dispose: () => undefined }; }
  dispose(): void { if (this.disposed) return; this.disposed = true; for (const callback of this.disposers) callback(); }
  last(type: string): Message | undefined { return this.sent.slice().reverse().find(value => value.type === type); }
}
const host = { panels: [] as FakePanel[], commands: [] as { id: string; args: unknown[] }[], groupByDirectory: false, inspect: {} as Record<string, unknown>, updates: [] as unknown[][], available: [] as string[] };
const vscode = {
  __esModule: true,
  window: { createWebviewPanel: (viewType: string, title: string, show: unknown, options: FakePanel['options']) => { const panel = new FakePanel(viewType, title, show, options); host.panels.push(panel); return panel; } },
  workspace: { getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'conflicts.groupByDirectory' ? host.groupByDirectory : fallback, inspect: () => host.inspect, update: async (...args: unknown[]) => { host.updates.push(args); } }),
    onDidChangeConfiguration: () => ({ dispose: () => undefined }) },
  Uri: { file: (fsPath: string) => ({ scheme: 'file', fsPath, path: fsPath }), joinPath: (base: { path: string }, ...parts: string[]) => ({ path: [base.path, ...parts].join('/') }) },
  ViewColumn: { Active: -1 }, ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  commands: { executeCommand: async (id: string, ...args: unknown[]) => { host.commands.push({ id, args }); }, getCommands: async () => host.available }
};
const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown }, original = loader._load;
loader._load = function (request: string, ...rest: unknown[]) { return request === 'vscode' ? vscode : original.call(this, request, ...rest); };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ConflictsPanels } = require('../../src/webviews/conflicts/conflicts-panel') as typeof import('../../src/webviews/conflicts/conflicts-panel');
loader._load = original;
import { MenuRouter } from '../../src/webviews/menu-context';

const root = path.resolve('conflict-fixture'), settle = async (rounds = 8) => { for (let index = 0; index < rounds; index++) await new Promise(resolve => setImmediate(resolve)); };
const summary = (extra: Record<string, unknown> = {}) => ({ repositoryId: 'repo', operation: 'merging', title: 'Merging feature into main', yours: { label: 'Yours', ref: 'main', oid: '1'.repeat(40), detail: 'main' },
  theirs: { label: 'Theirs', ref: 'feature', oid: '2'.repeat(40), detail: 'feature', subject: 'Add login' }, sides: { yours: { stage: 2, flag: 'ours' }, theirs: { stage: 3, flag: 'theirs' } },
  conflicts: 2, editStop: false, canContinue: false, canSkip: false, canAbort: true, nativeOnly: false, ...extra });
const row = (file: string, extra: Record<string, unknown> = {}) => ({ path: file, code: 'UU', kind: 'bothModified', yours: 'modified', theirs: 'modified', stages: { base: true, ours: true, theirs: true }, markers: { present: true, blocks: 1 }, binary: false, mergeable: true, workingFile: true, ...extra });
const list = (rows: ReturnType<typeof row>[], extra: Record<string, unknown> = {}) => ({ snapshot: {}, summary: summary({ conflicts: rows.length, ...extra }), rows, truncated: false });

function harness() {
  host.panels.length = 0; host.commands.length = 0; host.updates.length = 0; host.groupByDirectory = false; host.inspect = {};
  const listeners = new Set<() => void>(), selected: string[] = [], reads: unknown[] = [], calls: { name: string; args: unknown[] }[] = [];
  let next: unknown = list([row('src/a.ts'), row('src/b.ts')]), answer: Promise<boolean> | boolean = true;
  const registry = { repos: [{ id: 'repo', root }], active: { id: 'other', root: 'elsewhere' } as { id: string; root: string } | undefined, store: new Map<string, unknown>([['repo', { version: 1 }]]),
    list() { return this.repos; }, onDidChange: (listener: () => void) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; }, select: (id: string) => { selected.push(id); } };
  const api = { list: async (id: string, signal?: AbortSignal) => { reads.push({ id, signal }); return await next as never; } };
  const record = (name: string, result: unknown = undefined) => async (...args: unknown[]) => { calls.push({ name, args }); return typeof result === 'function' ? (result as () => unknown)() : result; };
  const bridge = { isOpen: async () => false, openResults: async () => new Set<string>(), open: async () => true, openSequence: record('openSequence', true), preferColumnLayout: () => { calls.push({ name: 'preferColumnLayout', args: [] }); },
    onDidChange: () => ({ dispose: () => undefined }) };
  const actions = { accept: record('accept', () => answer), markResolved: record('markResolved'), compare: record('compare'), openFile: record('openFile'), dropStash: record('dropStash', true) };
  const menus = new MenuRouter();
  const panels = new ConflictsPanels({ extensionUri: { path: '/extension' } } as never, { registry: registry as never, api: api as never, bridge: bridge as never, actions: actions as never, checkTrust: () => undefined, logger: { info: () => undefined, error: () => undefined }, menus });
  return { panels, menus, registry, reads, calls, selected, fireRegistry: () => { for (const listener of listeners) listener(); },
    setList: (value: unknown) => { next = value; }, setAnswer: (value: typeof answer) => { answer = value; } };
}
const panel = () => host.panels[0]!;
const session = () => /data-session="([^"]+)"/.exec(panel().webview.html)![1]!;
const send = async (value: Message) => { panel().receive({ session: session(), ...value }); await settle(); };
const state = () => panel().last('state') as { revision: number; rows: { key: string; path: string; group: string; markers: string; mergeOpen: boolean }[]; operation: Record<string, unknown> | null; message: string };
const keyOf = (file: string, group = 'unresolved') => state().rows.find(item => item.path === file && item.group === group)!.key;

test('open resolves once the tab is revealed, before its rows load, and keeps one native-looking tab per repository', async () => {
  const h = harness();
  let release!: () => void; h.setList(new Promise(resolve => { release = () => resolve(list([row('src/a.ts'), row('src/b.ts')])); }));
  await h.panels.open('repo');
  assert.equal(host.panels.length, 1); assert.equal(h.panels.openCount, 1);
  const created = panel();
  assert.equal(created.viewType, 'gitPro.conflicts'); assert.equal(created.title, `Conflicts — ${path.basename(root)}`);
  assert.equal(created.options.retainContextWhenHidden, false); assert.deepEqual(created.options.localResourceRoots?.map(item => item.path), ['/extension/media']);
  assert.deepEqual(created.iconPath, { light: { path: '/extension/media/operation-icons/git-merge-light.svg' }, dark: { path: '/extension/media/operation-icons/git-merge-dark.svg' } });
  for (const name of ['git-merge-light.svg', 'git-merge-dark.svg']) assert.match(readFileSync(path.join('media', 'operation-icons', name), 'utf8'), /^<svg [^>]*viewBox="0 0 16 16"[^>]*fill="#[0-9A-F]{6}"/, `${name} ships as a themed codicon`);
  const html = created.webview.html;
  assert.match(html, /default-src 'none'; style-src vscode-resource:; font-src vscode-resource:; script-src 'nonce-[0-9a-f]{32}'/);
  assert.doesNotMatch(html, /unsafe-inline|unsafe-eval/);
  assert.match(html, /role="treegrid" aria-multiselectable="true"/); assert.match(html, /webview:\/extension\/media\/codicons\/codicon\.css/);
  assert.equal(created.sent.length, 0, 'rows are still loading');
  await h.panels.open('repo', { preserveFocus: true, select: ['src/b.ts'] });
  assert.equal(host.panels.length, 1); assert.deepEqual(created.reveals, [true]);
  release(); await settle();
  const posted = state();
  assert.equal(posted.revision, 1); assert.deepEqual(posted.rows.map(item => [item.path, item.group, item.markers]), [['src/a.ts', 'unresolved', 'present'], ['src/b.ts', 'unresolved', 'present']]);
  assert.ok(posted.rows.every(item => /^[A-Za-z0-9_-]{43}$/.test(item.key)), 'opaque fixed-length keys');
  assert.equal((posted.operation as { title: string }).title, 'Merging feature into main');
  assert.deepEqual((posted.operation as { yours: unknown }).yours, { label: 'Yours', ref: 'main', oid: '1'.repeat(40), flag: 'ours' });
  assert.deepEqual(created.last('select')?.keys, [keyOf('src/b.ts')], 'the requested path is selected once rows exist');
  await assert.rejects(h.panels.open('missing'), /no longer open/);
  h.panels.dispose(); assert.equal(created.disposed, true); assert.equal(h.panels.openCount, 0);
});

test('requests act only on captured keys of the current revision, one at a time, and the rows are read again afterwards', async () => {
  const h = harness(); await h.panels.open('repo'); await settle();
  const revision = state().revision, a = keyOf('src/a.ts');
  await send({ type: 'resolve', revision, action: 'acceptTheirs', keys: [a] });
  assert.equal(h.calls.at(-1)!.name, 'accept'); assert.deepEqual(h.calls.at(-1)!.args.slice(0, 3), ['repo', ['src/a.ts'], 'theirs']);
  assert.equal((h.calls.at(-1)!.args[3] as { title: string }).title, 'Merging feature into main', 'the modal gets the captured operation summary');
  assert.match(String(panel().last('notice')?.message), /Accepted Theirs for 1 file and staged it/);
  assert.ok(h.reads.length >= 2, 'rows are read again after a resolve');
  const before = h.calls.length;
  await send({ type: 'resolve', revision: revision + 5, action: 'acceptYours', keys: [a] });
  assert.match(String(panel().last('error')?.message), /Conflicts changed\. Review again/); assert.equal(h.calls.length, before);
  await send({ type: 'resolve', revision, action: 'acceptYours', keys: ['Z'.repeat(43)] });
  assert.match(String(panel().last('error')?.message), /Conflicts changed/); assert.equal(h.calls.length, before);
  await send({ type: 'resolve', revision, action: 'acceptYours', keys: [a], session: '00000000-0000-4000-8000-000000000000' });
  assert.match(String(panel().last('error')?.message), /session expired/);
  let finish!: (value: boolean) => void; h.setAnswer(new Promise<boolean>(resolve => { finish = resolve; }));
  panel().receive({ session: session(), type: 'resolve', revision, action: 'acceptYours', keys: [a] }); await settle();
  assert.equal(panel().last('busy')?.busy, true);
  await send({ type: 'resolve', revision, action: 'acceptTheirs', keys: [keyOf('src/b.ts')] });
  assert.match(String(panel().last('error')?.message), /Wait for the current Conflicts action/);
  finish(false); await settle();
  assert.equal(panel().last('busy')?.busy, false);
  assert.equal(h.calls.filter(call => call.name === 'accept').length, 2, 'the busy request never ran');
  await send({ type: 'resolve', revision, action: 'markResolved', keys: [a, keyOf('src/b.ts')] });
  assert.deepEqual(h.calls.at(-1), { name: 'markResolved', args: ['repo', ['src/a.ts', 'src/b.ts']] });
  h.panels.dispose();
});

test('a recreated renderer gets the captured rows replayed; changed status reads them again and fills the Resolved group for this operation only', async () => {
  const h = harness(); await h.panels.open('repo'); await settle();
  const reads = h.reads.length, first = state();
  await send({ type: 'select', keys: [keyOf('src/b.ts')] });
  await send({ type: 'ready' });
  assert.equal(h.reads.length, reads, 'ready replays without reading again');
  assert.equal(state().revision, first.revision); assert.deepEqual(panel().last('select'), { type: 'select', session: session(), keys: [keyOf('src/b.ts')], restore: true });
  h.setList(list([row('src/b.ts')])); h.registry.store.set('repo', { version: 2 }); h.fireRegistry();
  await new Promise(resolve => setTimeout(resolve, 80)); await settle();
  const after = state();
  assert.ok(after.revision > first.revision, 'different rows, new revision');
  assert.deepEqual(after.rows.map(item => [item.path, item.group]), [['src/b.ts', 'unresolved'], ['src/a.ts', 'resolved']]);
  assert.equal((after.operation as { conflicts: number }).conflicts, 1);
  await send({ type: 'resolve', revision: after.revision, action: 'acceptYours', keys: [keyOf('src/a.ts', 'resolved')] });
  assert.match(String(panel().last('error')?.message), /Select unresolved files only/);
  // A hidden tab only marks its rows stale; the next `ready` reads them.
  panel().visible = false; h.setList(list([row('src/b.ts')], { theirs: { label: 'Theirs', ref: 'other', oid: '3'.repeat(40), detail: 'other' } })); h.registry.store.set('repo', { version: 3 }); h.fireRegistry();
  await new Promise(resolve => setTimeout(resolve, 80));
  const hidden = h.reads.length; panel().visible = true; await send({ type: 'ready' });
  assert.equal(h.reads.length, hidden + 1);
  assert.deepEqual(state().rows.map(item => item.group), ['unresolved'], 'another operation clears Resolved');
  h.registry.repos = []; h.fireRegistry(); await settle();
  assert.equal(state().message, 'Repository is no longer open.'); assert.deepEqual(state().rows, []);
  h.panels.dispose();
});

test('the operation is part of the revision: a request reviewed for another operation on the same paths is refused', async () => {
  const h = harness(); await h.panels.open('repo'); await settle();
  const before = state(), a = keyOf('src/a.ts');
  // A merge was aborted and a rebase stopped on the same files: same row keys, other sides.
  h.setList(list([row('src/a.ts'), row('src/b.ts')], { operation: 'rebasing', title: 'Rebasing feature onto main', sides: { yours: { stage: 3, flag: 'theirs' }, theirs: { stage: 2, flag: 'ours' } } }));
  await send({ type: 'refresh' });
  assert.equal(keyOf('src/a.ts'), a, 'the row keys stay'); assert.ok(state().revision > before.revision, 'a new operation is a new revision');
  const calls = h.calls.length;
  await send({ type: 'resolve', revision: before.revision, action: 'acceptYours', keys: [a] });
  assert.match(String(panel().last('error')?.message), /Conflicts changed\. Review again/); assert.equal(h.calls.length, calls, 'nothing ran against the new mapping');
  await send({ type: 'resolve', revision: state().revision, action: 'acceptYours', keys: [a] }); assert.equal(h.calls.at(-1)!.name, 'accept');
  h.panels.dispose();
});

test('Use Column Layout is offered only when the command exists and only records the request with the bridge', async () => {
  const absent = harness(); await absent.panels.open('repo'); await settle();
  assert.equal((state() as { columnLayout?: boolean }).columnLayout, false);
  await send({ type: 'columnLayout' }); assert.match(String(panel().last('error')?.message), /no column layout/); assert.equal(absent.calls.some(call => call.name === 'preferColumnLayout'), false);
  absent.panels.dispose();
  host.available = ['merge.columnLayout'];
  try {
    const h = harness(); await h.panels.open('repo'); await settle();
    assert.equal((state() as { columnLayout?: boolean }).columnLayout, true);
    await send({ type: 'columnLayout' });
    assert.deepEqual(h.calls.at(-1), { name: 'preferColumnLayout', args: [] }); assert.match(String(panel().last('notice')?.message), /next merge editor opens in the column layout: Yours \| Result \| Theirs/);
    assert.equal(host.commands.some(item => item.id === 'merge.columnLayout'), false, 'the tab never changes the layout preference itself');
    h.panels.dispose();
  } finally { host.available = []; }
});

test('Merge…, compares, operation buttons, Drop Stash and the directory setting go through their owners', async () => {
  const h = harness();
  h.setList(list([row('src/a.ts'), row('src/b.ts'), row('src/gone.ts', { code: 'UD', kind: 'deletedByThem', theirs: 'deleted', mergeable: false })]));
  await h.panels.open('repo'); await settle();
  const revision = state().revision;
  await send({ type: 'open', revision, action: 'merge', key: keyOf('src/b.ts'), keys: [keyOf('src/b.ts'), keyOf('src/a.ts')] });
  assert.deepEqual(h.calls.at(-1), { name: 'openSequence', args: ['repo', ['src/b.ts', 'src/a.ts']] });
  await send({ type: 'open', revision, action: 'merge', key: keyOf('src/gone.ts') });
  assert.match(String(panel().last('error')?.message), /src\/gone\.ts: Deleted by them — choose Accept Yours or Accept Theirs/);
  await send({ type: 'open', revision, action: 'compareBaseTheirs', key: keyOf('src/a.ts') });
  assert.deepEqual(h.calls.at(-1)!.args.slice(0, 3), ['repo', 'src/a.ts', 'compareBaseTheirs']);
  await send({ type: 'open', revision, action: 'file', key: keyOf('src/a.ts') });
  assert.deepEqual(h.calls.at(-1), { name: 'openFile', args: ['repo', 'src/a.ts'] });
  await send({ type: 'operation', revision, action: 'continue' });
  assert.deepEqual(h.selected, ['repo'], 'the operation commands act on the active repository, which becomes this tab\'s');
  assert.deepEqual(host.commands.at(-1), { id: 'gitPro.operation.continue', args: ['repo'] });
  await send({ type: 'operation', revision, action: 'dropStash' });
  assert.match(String(panel().last('error')?.message), /Drop Stash is offered after a Git Pro stash pop/);
  await send({ type: 'setting', groupByDirectory: true });
  assert.deepEqual(host.updates.at(-1), ['conflicts.groupByDirectory', true, 1], 'user setting unless a workspace value shadows it');
  host.inspect = { workspaceValue: false }; await send({ type: 'setting', groupByDirectory: true });
  assert.deepEqual(host.updates.at(-1), ['conflicts.groupByDirectory', true, 2]);
  await send({ type: 'operation', revision: state().revision, action: 'close' });
  assert.equal(panel().disposed, true); assert.equal(h.panels.openCount, 0);
  h.panels.dispose();

  const stash = harness(), source = { kind: 'stashPop', oid: '4'.repeat(40), selector: 'stash@{0}' };
  stash.setList(list([row('a.txt')], { operation: 'idle', title: 'Conflicts from applying stash@{0} (stash kept)', source, canAbort: false }));
  await stash.panels.open('repo'); await settle();
  stash.setList(list([], { operation: 'idle', title: 'No merge conflicts', canAbort: false })); await send({ type: 'refresh' });
  assert.deepEqual((state().operation as { stash: unknown }).stash, { selector: 'stash@{0}', drop: true }, 'the pop is remembered after the summary drops its source');
  await send({ type: 'operation', revision: state().revision, action: 'dropStash' });
  assert.deepEqual(stash.calls.at(-1), { name: 'dropStash', args: ['repo', { selector: 'stash@{0}', oid: '4'.repeat(40) }] });
  assert.equal((state().operation as { stash?: unknown }).stash, undefined);
  stash.panels.dispose();
});

test('native right-click commands reach the tab through the router and are checked like its own requests', async () => {
  const h = harness(); await h.panels.open('repo'); await settle();
  const revision = state().revision, a = keyOf('src/a.ts'), b = keyOf('src/b.ts');
  const argument = (extra: Record<string, unknown> = {}) => ({ webview: 'gitPro.conflicts', webviewSection: 'conflict', preventDefaultContextMenuItems: true, session: session(), revision, key: a, ...extra });
  const run = async (action: string, given: Record<string, unknown> = argument()) => { const { panel: target, context } = h.menus.resolve(given, ['gitPro.conflicts'], 'conflict'); await target.handle!(action, context); await settle(); };
  assert.equal(h.menus.resolve(argument(), ['gitPro.conflicts']).panel.repositoryId, 'repo');
  await run('acceptTheirs'); assert.deepEqual(h.calls.at(-1)!.args.slice(0, 3), ['repo', ['src/a.ts'], 'theirs'], 'one row names itself');
  await run('merge'); assert.deepEqual(h.calls.at(-1)!.args, ['repo', ['src/a.ts']]); assert.equal(h.calls.at(-1)!.name, 'openSequence');
  // The selection the tab tracks is the target when the clicked row belongs to it.
  await send({ type: 'select', keys: [a, b] });
  await run('acceptYours'); assert.deepEqual(h.calls.at(-1)!.args.slice(0, 3), ['repo', ['src/a.ts', 'src/b.ts'], 'yours'], 'a row of the selection acts for the whole selection');
  await run('merge', argument({ key: b })); assert.deepEqual(h.calls.at(-1)!.args, ['repo', ['src/a.ts', 'src/b.ts']], 'Merge… opens them in sequence');
  await send({ type: 'select', keys: [b] });
  await run('markResolved'); assert.deepEqual(h.calls.at(-1)!.args, ['repo', ['src/a.ts']], 'a row outside the selection acts alone');
  await run('openFile'); assert.equal(h.calls.at(-1)!.name, 'openFile'); assert.deepEqual(h.calls.at(-1)!.args, ['repo', 'src/a.ts']);
  await run('compareYoursTheirs'); assert.equal(h.calls.at(-1)!.name, 'compare'); assert.deepEqual(h.calls.at(-1)!.args.slice(0, 3), ['repo', 'src/a.ts', 'compareYoursTheirs']);
  const before = h.calls.length, errors = () => panel().sent.filter(message => message.type === 'error').length, failures = errors();
  await run('acceptYours', argument({ revision: revision - 1 })); assert.match(String(panel().last('error')?.message), /Conflicts changed/, 'a menu drawn for older rows is stale');
  await run('acceptYours', argument({ key: 'Z'.repeat(43) })); assert.match(String(panel().last('error')?.message), /Conflicts changed/, 'a key the tab never listed');
  await run('acceptYours', argument({ key: 12 })); assert.equal(errors(), failures + 3); assert.equal(h.calls.length, before, 'none of them reached an action');
  await assert.rejects(run('deleteEverything'), /Unknown Conflicts menu action/);
  assert.throws(() => h.menus.resolve(argument({ webviewSection: 'commit' }), ['gitPro.conflicts'], 'conflict'), /Git Pro panel menu/);
  panel().dispose(); assert.throws(() => h.menus.resolve(argument(), ['gitPro.conflicts']), /closed/, 'a closed tab leaves the router');
});
