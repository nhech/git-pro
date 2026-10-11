import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import * as path from 'node:path';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

class Uri {
  constructor(readonly scheme: string, readonly fsPath: string, readonly path: string) {}
  static file(fsPath: string): Uri { return new Uri('file', fsPath, fsPath); }
  static from(parts: { scheme: string; path: string }): Uri { return new Uri(parts.scheme, parts.path, parts.path); }
  toString(): string { return `${this.scheme}:${this.path}`; }
}
interface FakeTab { input: unknown; group: Group; isActive: boolean; label: string }
interface Group { isActive: boolean; viewColumn: number; tabs: FakeTab[]; readonly activeTab: FakeTab | undefined }
type TabEvent = { opened: FakeTab[]; closed: FakeTab[]; changed: FakeTab[] };
const host = {
  commands: [] as { id: string; args: unknown[] }[], filters: [] as unknown[], available: new Set<string>(), handlers: new Map<string, (...args: unknown[]) => unknown>(),
  infos: [] as string[], warnings: [] as { message: string; detail?: string | undefined }[], errors: [] as string[], answers: { info: undefined as string | undefined, warning: undefined as string | undefined },
  documents: [] as { uri: Uri; isDirty: boolean }[], groups: [] as Group[], listeners: new Set<(event: TabEvent) => void>()
};
const group = (viewColumn: number, isActive: boolean): Group => ({ isActive, viewColumn, tabs: [], get activeTab() { return this.tabs.find(tab => tab.isActive); } });
const fire = (event: Partial<TabEvent>) => { for (const listener of [...host.listeners]) listener({ opened: [], closed: [], changed: [], ...event }); };
const vscode = {
  __esModule: true, Uri,
  window: {
    tabGroups: { get all() { return host.groups; }, get activeTabGroup() { return host.groups.find(item => item.isActive) ?? host.groups[0]; },
      onDidChangeTabs: (listener: (event: TabEvent) => void) => { host.listeners.add(listener); return { dispose: () => host.listeners.delete(listener) }; },
      close: async (tab: FakeTab) => { closeTab(tab); return true; } },
    showInformationMessage: async (message: string) => { host.infos.push(message); return host.answers.info; },
    showWarningMessage: async (message: string, options?: { detail?: string }) => { host.warnings.push({ message, detail: options?.detail }); return host.answers.warning; },
    showErrorMessage: async (message: string) => { host.errors.push(message); return undefined; }
  },
  workspace: { get textDocuments() { return host.documents; } },
  commands: {
    getCommands: async (filter?: boolean) => { host.filters.push(filter); return [...host.available].filter(id => !filter || !id.startsWith('_')); },
    executeCommand: async (id: string, ...args: unknown[]) => { host.commands.push({ id, args }); return host.handlers.get(id)?.(...args); }
  }
};
const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown }, original = loader._load;
loader._load = function (request: string, ...rest: unknown[]) { return request === 'vscode' ? vscode : original.call(this, request, ...rest); };
/* eslint-disable @typescript-eslint/no-require-imports */
const { MergeEditorBridge } = require('../../src/editor/merge-editor-bridge') as typeof import('../../src/editor/merge-editor-bridge');
const { ConflictSnapshots } = require('../../src/documents/conflict-snapshots') as typeof import('../../src/documents/conflict-snapshots');
const { ConflictActions } = require('../../src/webviews/conflicts/conflict-actions') as typeof import('../../src/webviews/conflicts/conflict-actions');
/* eslint-enable @typescript-eslint/no-require-imports */
loader._load = original;

function openTab(result: string, input: Record<string, unknown> = {}, target = host.groups.find(item => item.isActive)!): FakeTab {
  for (const tab of target.tabs) tab.isActive = false;
  const tab: FakeTab = { input: { base: Uri.from({ scheme: 'git-pro-conflict', path: '/b/x' }), input1: Uri.from({ scheme: 'git-pro-conflict', path: '/1/x' }), input2: Uri.from({ scheme: 'git-pro-conflict', path: '/2/x' }), ...input, result: Uri.file(result) }, group: target, isActive: true, label: path.basename(result) };
  target.tabs.push(tab); fire({ opened: [tab] }); return tab;
}
function closeTab(tab: FakeTab): void { tab.group.tabs.splice(tab.group.tabs.indexOf(tab), 1); if (tab.isActive && tab.group.tabs[0]) tab.group.tabs[0].isActive = true; fire({ closed: [tab] }); }
const settle = async (rounds = 6) => { for (let index = 0; index < rounds; index++) await new Promise(resolve => setImmediate(resolve)); };
const root = path.resolve('conflict-fixture');
const merging = { yours: { stage: 2, flag: 'ours' }, theirs: { stage: 3, flag: 'theirs' } } as const, rebasing = { yours: { stage: 3, flag: 'theirs' }, theirs: { stage: 2, flag: 'ours' } } as const;
type Row = { path: string; kind: string; mergeable: boolean; binary: boolean; workingFile: boolean; markers: { present: boolean; blocks: number | null } | null; unsupported?: string; yours: string; theirs: string };
const row = (file: string, extra: Partial<Row> = {}): Row => ({ path: file, kind: 'bothModified', mergeable: true, binary: false, workingFile: true, markers: { present: true, blocks: 1 }, yours: 'modified', theirs: 'modified', ...extra });

function harness(operation: 'merging' | 'rebasing' = 'merging', base = root) {
  host.commands.length = 0; host.filters.length = 0; host.infos.length = 0; host.warnings.length = 0; host.errors.length = 0; host.documents.length = 0; host.listeners.clear(); host.handlers.clear();
  host.answers.info = undefined; host.answers.warning = undefined; host.groups = [group(1, true)];
  host.available = new Set(['_open.mergeEditor', 'git.openMergeEditor', 'mergeEditor.acceptMerge', 'vscode.open']);
  // `_open.mergeEditor` resolves before its tab exists, as in VS Code.
  host.handlers.set('_open.mergeEditor', (args: unknown) => {
    const value = args as { base: Uri; input1: { uri: Uri }; input2: { uri: Uri }; output: Uri };
    setImmediate(() => openTab(value.output.fsPath, { base: value.base, input1: value.input1.uri, input2: value.input2.uri }));
  });
  const sides = operation === 'merging' ? merging : rebasing, rows = new Map<string, Row>([['src/app.ts', row('src/app.ts')], ['src/b.ts', row('src/b.ts')]]);
  const staged: string[][] = [], withMarkers: string[] = [], opened: { id: string; options: unknown }[] = [], batches: unknown[] = [];
  const api = {
    previewBatch: async (_id: string, paths: readonly string[]) => { const batch = { snapshot: { operation }, sides, rows: paths.map(file => { const found = rows.get(file); if (!found) throw new Error('Select current conflicted files. Conflicts changed; review again.'); return found; }) }; batches.push(batch); return batch; },
    stageBlobs: async (_id: string, file: string) => ({ path: file, operation, sides, base: Buffer.from('base\n'), ours: Buffer.from('git ours\n'), theirs: Buffer.from('git theirs\n') }),
    markResolved: async (batch: { rows: Row[] }) => { staged.push(batch.rows.map(item => item.path)); for (const item of batch.rows) rows.delete(item.path); },
    list: async () => ({ rows: [...rows.values()] })
  };
  const summary = operation === 'merging'
    ? { yours: { label: 'Yours', ref: 'main', oid: '1a2b3c4d'.padEnd(40, '0'), detail: 'main' }, theirs: { label: 'Theirs', ref: 'feature', oid: '9f8e7d6c'.padEnd(40, '0'), detail: 'feature' }, title: 'Merging feature into main', operation, sides, source: undefined }
    : { yours: { label: 'Yours', ref: 'feature', oid: '9f8e7d6c'.padEnd(40, '0'), detail: 'Rebasing 9f8e7d6 from feature' }, theirs: { label: 'Theirs', ref: 'main', oid: '1a2b3c4d'.padEnd(40, '0'), detail: 'Already rebased commits and commits from main' }, title: 'Rebasing feature onto main', operation, sides, source: undefined };
  const snapshots = new ConflictSnapshots();
  const bridge = new MergeEditorBridge({ api: api as never, snapshots, logger: { info: () => undefined, error: () => undefined }, checkTrust: () => undefined, timeoutMs: 40,
    stageWithMarkers: async (_id, file) => { withMarkers.push(file); rows.delete(file); }, authorize: async (_id, file) => path.join(base, ...file.split('/')),
    locate: async file => file.startsWith(base) ? { id: 'repo', file: path.relative(base, file).replace(/\\/g, '/') } : undefined, active: () => 'repo',
    summary: async () => summary as never, conflicts: async (id, options) => { opened.push({ id, options }); } });
  const executed = () => host.commands.map(item => item.id);
  return { bridge, snapshots, rows, staged, withMarkers, opened, batches, summary, executed, api };
}
const mergeArgs = () => host.commands.filter(item => item.id === '_open.mergeEditor').map(item => item.args[0] as { base: Uri; input1: { uri: Uri; title: string; description: string; detail: string }; input2: { uri: Uri; title: string; description: string; detail: string }; output: Uri });

test('Merge… opens _open.mergeEditor through getCommands(false) with Yours on the left and Theirs on the right, then focuses the new tab', async () => {
  const h = harness('merging');
  assert.equal(await h.bridge.open('repo', 'src/app.ts'), true);
  assert.equal(host.filters[0], false, 'underscore commands are only listed by getCommands(false)');
  const [args] = mergeArgs();
  assert.ok(args);
  assert.deepEqual([args.input1.title, args.input1.description, args.input1.detail], ['Yours', '$(git-commit) 1a2b3c4', 'main']);
  assert.deepEqual([args.input2.title, args.input2.description, args.input2.detail], ['Theirs', '$(git-commit) 9f8e7d6', 'feature']);
  assert.equal(h.snapshots.provideTextDocumentContent(args.input1.uri as never), 'git ours\n', 'merge: Yours is Git --ours (stage 2)');
  assert.equal(h.snapshots.provideTextDocumentContent(args.input2.uri as never), 'git theirs\n');
  assert.equal(h.snapshots.provideTextDocumentContent(args.base as never), 'base\n');
  for (const uri of [args.base, args.input1.uri, args.input2.uri]) { assert.equal(uri.scheme, 'git-pro-conflict'); assert.match(uri.path, /^\/[0-9a-f-]{36}\/app\.ts$/); }
  assert.equal(args.output.fsPath, path.join(root, 'src', 'app.ts'), 'the Result is the real file');
  assert.deepEqual(h.executed().slice(-1), ['workbench.action.focusActiveEditorGroup'], '_open.mergeEditor opens with preserveFocus, so the bridge focuses it');
  assert.equal(await h.bridge.isOpen(path.join(root, 'src', 'app.ts').toUpperCase()), process.platform === 'win32', 'Windows paths compare case-insensitively');
  assert.equal(await h.bridge.isOpen(path.join(root, 'src', 'app.ts')), true);

  host.commands.length = 0;
  assert.equal(await h.bridge.open('repo', 'src/app.ts'), true);
  assert.deepEqual(h.executed(), ['workbench.action.focusActiveEditorGroup'], 'an open merge tab is revealed, never opened twice');
  const other = group(2, false); host.groups.push(other);
  const tab = host.groups[0]!.tabs[0]!; host.groups[0]!.tabs = []; tab.group = other; other.tabs.push({ input: {}, group: other, isActive: true, label: 'x' }, tab); tab.isActive = false;
  host.commands.length = 0; await h.bridge.open('repo', 'src/app.ts');
  assert.deepEqual(host.commands.map(item => [item.id, ...item.args]), [['workbench.action.focusSecondEditorGroup'], ['workbench.action.openEditorAtIndex', 1], ['workbench.action.focusActiveEditorGroup']]);
  h.bridge.dispose();
});

test('during a rebase the left pane is still Yours: the replayed commit, Git --theirs, with the WebStorm rebase wording', async () => {
  const h = harness('rebasing');
  await h.bridge.open('repo', 'src/app.ts');
  const [args] = mergeArgs();
  assert.ok(args);
  assert.equal(h.snapshots.provideTextDocumentContent(args.input1.uri as never), 'git theirs\n');
  assert.equal(h.snapshots.provideTextDocumentContent(args.input2.uri as never), 'git ours\n');
  assert.deepEqual([args.input1.title, args.input1.detail, args.input2.title, args.input2.detail], ['Yours', 'Rebasing 9f8e7d6 from feature', 'Theirs', 'Already rebased commits and commits from main']);
  h.bridge.dispose();
});

test('fallbacks run only when a command is missing or rejects; a slow tab is never answered with a second merge editor', async () => {
  let h = harness();
  host.handlers.set('_open.mergeEditor', () => { throw new TypeError('invalid argument'); });
  host.handlers.set('git.openMergeEditor', (uri: unknown) => { setImmediate(() => openTab((uri as Uri).fsPath)); });
  assert.equal(await h.bridge.open('repo', 'src/app.ts'), true);
  assert.deepEqual(h.executed().filter(id => id.includes('MergeEditor') || id.includes('mergeEditor')), ['_open.mergeEditor', 'git.openMergeEditor']);
  h.bridge.dispose();

  h = harness(); host.handlers.set('_open.mergeEditor', () => undefined);
  assert.equal(await h.bridge.open('repo', 'src/app.ts'), false);
  assert.equal(h.executed().includes('git.openMergeEditor'), false, 'a timeout does not fall back');
  assert.equal(h.executed().includes('vscode.open'), false);
  assert.match(host.infos.at(-1)!, /still opening/);
  h.bridge.dispose();

  h = harness(); host.available = new Set();
  assert.equal(await h.bridge.open('repo', 'src/app.ts'), true);
  assert.deepEqual(h.executed(), ['vscode.open']);
  assert.match(host.infos.at(-1)!, /Merge editor unavailable/);
  h.bridge.dispose();

  h = harness(); h.rows.set('src/gone.ts', row('src/gone.ts', { kind: 'deletedByThem', mergeable: false, theirs: 'deleted' }));
  await assert.rejects(h.bridge.open('repo', 'src/gone.ts'), /Deleted by them — choose Accept Yours or Accept Theirs/);
  assert.equal(h.executed().length, 0);
  h.bridge.dispose();
});

test('a merge tab restored with expired snapshot inputs is reopened instead of revealed', async () => {
  const h = harness();
  const stale = openTab(path.join(root, 'src', 'app.ts'));
  assert.equal(await h.bridge.open('repo', 'src/app.ts'), true);
  assert.equal(host.groups[0]!.tabs.includes(stale), false);
  assert.equal(mergeArgs().length, 1);
  h.bridge.dispose();
});

test('Apply & Next refuses any editor but the matching merge editor, stages only after a successful Complete Merge and opens the next file', async () => {
  const h = harness(), file = path.join(root, 'src', 'app.ts');
  await assert.rejects(h.bridge.apply(), /Focus the merge editor first/);
  await h.bridge.open('repo', 'src/app.ts');
  await assert.rejects(h.bridge.apply(Uri.file(path.join(root, 'src', 'b.ts'))), /Focus the merge editor first/, 'the button belongs to another merge editor');
  host.handlers.set('mergeEditor.acceptMerge', () => ({ successful: false }));
  await h.bridge.apply(Uri.file(file));
  assert.deepEqual(h.staged, [], 'nothing is staged when the user cancels Complete Merge');

  h.rows.set('src/app.ts', row('src/app.ts', { markers: { present: false, blocks: 0 } }));
  host.handlers.set('mergeEditor.acceptMerge', () => { closeTab(host.groups[0]!.activeTab!); return { successful: true }; });
  host.commands.length = 0;
  await h.bridge.apply(Uri.file(file)); await settle();
  assert.deepEqual(h.staged, [['src/app.ts']]);
  assert.deepEqual(h.executed().slice(0, 2), ['mergeEditor.acceptMerge', '_open.mergeEditor']);
  assert.equal(mergeArgs().at(-1)!.output.fsPath, path.join(root, 'src', 'b.ts'), 'the next unresolved file opens');
  assert.ok(host.infos.some(text => /Staged src\/app\.ts/.test(text)));
  assert.equal(host.infos.some(text => /merged\./.test(text)), false, 'Apply & Next does not also show the native-completion prompt');

  h.rows.set('src/b.ts', row('src/b.ts', { markers: { present: true, blocks: 1 } }));
  host.answers.warning = undefined;
  await h.bridge.apply(Uri.file(path.join(root, 'src', 'b.ts')));
  assert.match(host.warnings.at(-1)!.message, /Conflict markers remain in src\/b\.ts/);
  assert.deepEqual(h.withMarkers, [], 'declining the marker modal stages nothing');
  await h.bridge.open('repo', 'src/b.ts'); host.answers.warning = 'Stage with markers';
  await h.bridge.apply(Uri.file(path.join(root, 'src', 'b.ts'))); await settle();
  assert.deepEqual(h.withMarkers, ['src/b.ts']);
  assert.deepEqual(h.opened.at(-1), { id: 'repo', options: { select: ['src/b.ts'] } }, 'with nothing left to merge, the Conflicts tab is revealed');
  host.available.delete('mergeEditor.acceptMerge'); h.rows.set('src/c.ts', row('src/c.ts'));
  await h.bridge.open('repo', 'src/c.ts');
  await assert.rejects(h.bridge.apply(), /Use Complete Merge, then Mark Resolved/);
  h.bridge.dispose();
});

test('Merge… on several rows walks the selection first, and Next Conflicted File and Back follow the active merge editor', async () => {
  const h = harness();
  for (const file of ['src/c.ts', 'src/d.ts']) h.rows.set(file, row(file, { markers: { present: false, blocks: 0 } }));
  await h.bridge.openSequence('repo', ['src/d.ts', 'src/b.ts']);
  host.handlers.set('mergeEditor.acceptMerge', () => { closeTab(host.groups[0]!.activeTab!); return { successful: true }; });
  h.rows.set('src/d.ts', row('src/d.ts', { markers: { present: false, blocks: 0 } }));
  await h.bridge.apply(); await settle();
  assert.deepEqual(mergeArgs().map(args => path.basename(args.output.fsPath)), ['d.ts', 'b.ts'], 'the queued selection comes before path order');
  await h.bridge.nextFile(); await settle();
  assert.equal(path.basename(mergeArgs().at(-1)!.output.fsPath), 'c.ts', 'next in path order after b.ts');
  await h.bridge.back();
  assert.deepEqual(h.opened.at(-1), { id: 'repo', options: { select: ['src/c.ts'] } });
  h.bridge.dispose();
});

test('native Complete Merge is detected once: a merged tab that closes without Apply offers Mark Resolved, never stages by itself', async () => {
  const h = harness();
  await h.bridge.open('repo', 'src/app.ts');
  h.rows.set('src/app.ts', row('src/app.ts', { markers: { present: false, blocks: 0 } }));
  host.answers.info = undefined;
  closeTab(host.groups[0]!.activeTab!); await settle();
  assert.equal(host.infos.filter(text => /app\.ts merged/.test(text)).length, 1);
  assert.deepEqual(h.staged, [], 'dismissing the prompt stages nothing');
  await h.bridge.open('repo', 'src/app.ts');
  host.answers.info = 'Mark Resolved';
  closeTab(host.groups[0]!.activeTab!); await settle();
  assert.deepEqual(h.staged, [['src/app.ts']]);
  h.rows.set('src/b.ts', row('src/b.ts', { markers: { present: true, blocks: 2 } }));
  await h.bridge.open('repo', 'src/b.ts'); const before = host.infos.length;
  closeTab(host.groups[0]!.activeTab!); await settle();
  assert.equal(host.infos.length, before, 'markers remain: no prompt');
  h.bridge.dispose();
});

function actions(operation: 'merging' | 'rebasing' = 'merging', base = root) {
  const h = harness(operation, base), accepted: { side: string; rows: string[] }[] = [], prompts: { message: string; detail: string; action: string }[] = [];
  let answer = true, fresh: () => Promise<unknown> = async () => h.summary, during: () => void = () => undefined;
  const api = { ...h.api, acceptSide: async (batch: { rows: Row[] }, side: string) => { accepted.push({ side, rows: batch.rows.map(item => item.path) }); } };
  const instance = new ConflictActions({ api: api as never, revisions: { add: () => Uri.file('rev') as never }, tools: {} as never, summary: async () => await fresh() as never, checkTrust: () => undefined,
    authorize: async (_id, file) => path.join(base, ...file.split('/')), root: () => base, confirm: async (message, detail, action) => { prompts.push({ message, detail, action }); during(); return answer; } });
  return { ...h, instance, accepted, prompts, setAnswer: (value: boolean) => { answer = value; }, setSummary: (read: () => Promise<unknown>) => { fresh = read; }, whileModal: (run: () => void) => { during = run; } };
}

test('Accept Yours / Theirs shows one modal naming the side, its Git flag, the files and the deletions, and refuses dirty or merge-open files (N2, N12)', async () => {
  const a = actions();
  a.rows.set('src/old.ts', row('src/old.ts', { kind: 'deletedByThem', mergeable: false, theirs: 'deleted' }));
  assert.equal(await a.instance.accept('repo', ['src/app.ts', 'src/old.ts'], 'theirs'), true);
  const prompt = a.prompts.at(-1)!;
  assert.equal(prompt.message, 'Accept Theirs for 2 files?'); assert.equal(prompt.action, 'Accept Theirs');
  const lines = prompt.detail.split('\n');
  assert.equal(lines[0], root); assert.equal(lines[1], 'Merging feature into main');
  assert.equal(lines[2], 'Theirs = feature · 9f8e7d6 (the branch being merged) → git --theirs');
  assert.ok(lines.includes('src/app.ts') && lines.indexOf('src/app.ts') < lines.findIndex(line => line.startsWith('Deletes')), 'kept files first');
  assert.match(prompt.detail, /including any edits you made/);
  assert.equal(lines.at(-1), 'src/old.ts', 'the deletion is listed apart');
  assert.deepEqual(a.accepted, [{ side: 'theirs', rows: ['src/app.ts', 'src/old.ts'] }]);
  a.setAnswer(false);
  assert.equal(await a.instance.accept('repo', ['src/app.ts'], 'yours'), false);
  assert.equal(a.accepted.length, 1, 'cancelling the modal changes nothing');
  a.setAnswer(true);
  host.documents.push({ uri: Uri.file(path.join(root, 'src', 'app.ts')), isDirty: true });
  await assert.rejects(a.instance.accept('repo', ['src/app.ts'], 'yours'), /Save or revert src\/app\.ts first/);
  host.documents.length = 0;
  await a.bridge.open('repo', 'src/app.ts');
  await assert.rejects(a.instance.accept('repo', ['src/app.ts'], 'yours'), /Close the merge editor for src\/app\.ts first/);
  await assert.rejects(a.instance.markResolved('repo', ['src/b.ts']), /Conflict markers remain in src\/b\.ts/);
  assert.equal(a.accepted.length, 1);
  a.bridge.dispose();

  const r = actions('rebasing');
  await r.instance.accept('repo', ['src/app.ts'], 'yours');
  assert.equal(r.prompts.at(-1)!.detail.split('\n')[2], 'Yours = feature · 9f8e7d6 (the commit being rebased) → git --theirs', 'a rebase names the swap');
  assert.equal(r.prompts.at(-1)!.message, 'Accept Yours for 1 file?');
  r.rows.set('src/bin.png', row('src/bin.png', { binary: true, markers: null, mergeable: false }));
  await assert.rejects(r.instance.markResolved('repo', ['src/bin.png']), /binary\. Choose Accept Yours or Accept Theirs/, 'N13');
  r.bridge.dispose();
});

test('N12 and Merge… compare canonical paths: an editor opened through a junction or symlink of the workspace is found, and its Uri is reused', async () => {
  const real = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'git-pro-n12-'))), alias = `${real}-alias`;
  mkdirSync(path.join(real, 'src')); writeFileSync(path.join(real, 'src', 'app.ts'), 'x\n'); symlinkSync(real, alias, 'junction');
  try {
    const a = actions('merging', real), aliased = Uri.file(path.join(alias, 'src', 'app.ts'));
    host.documents.push({ uri: aliased, isDirty: true });
    await assert.rejects(a.instance.accept('repo', ['src/app.ts'], 'theirs'), /Save or revert src\/app\.ts first/, 'the authorized path is canonical, the editor keeps the alias');
    assert.equal(a.prompts.length, 0);
    host.documents[0]!.isDirty = false;
    assert.equal(await a.bridge.open('repo', 'src/app.ts'), true);
    assert.equal(mergeArgs().at(-1)!.output.fsPath, aliased.fsPath, 'the merge editor opens on the Uri the document already has: one model per file');
    assert.equal(await a.bridge.isOpen(path.join(real, 'src', 'app.ts')), true);
    host.commands.length = 0; assert.equal(await a.bridge.open('repo', 'src/app.ts'), true);
    assert.deepEqual(a.executed(), ['workbench.action.focusActiveEditorGroup'], 'revealed, never a second merge editor on one Result');
    await assert.rejects(a.instance.accept('repo', ['src/app.ts'], 'theirs'), /Close the merge editor for src\/app\.ts first/);
    assert.ok((await a.bridge.openResults()).has(process.platform === 'win32' ? path.join(real, 'src', 'app.ts').toLowerCase() : path.join(real, 'src', 'app.ts')), 'the mergeOpen column compares canonical keys');
    assert.deepEqual(a.accepted, []);
    a.bridge.dispose();
  } finally { unlinkSync(alias); rmSync(real, { recursive: true, force: true }); }
});

test('Accept names the sides only from a summary of the reviewed state, re-checks editors after the modal, and Mark Resolved needs both sides', async () => {
  const a = actions(), stale = { ...a.summary, operation: 'rebasing', title: 'Rebasing feature onto main', yours: { label: 'Yours', ref: 'feature', oid: '9f8e7d6c'.padEnd(40, '0'), detail: 'x' } };
  await a.instance.accept('repo', ['src/app.ts'], 'yours', stale as never);
  let lines = a.prompts.at(-1)!.detail.split('\n');
  assert.deepEqual(lines.slice(1, 3), ['Merging feature into main', 'Yours = main · 1a2b3c4 (the checked-out branch) → git --ours'], 'the tab\'s older summary does not name the new mapping');
  a.setSummary(async () => { throw new Error('read failed'); });
  await a.instance.accept('repo', ['src/app.ts'], 'yours', stale as never);
  lines = a.prompts.at(-1)!.detail.split('\n');
  assert.deepEqual(lines.slice(1, 3), ['Unresolved conflicts', 'Yours = your version (the checked-out branch) → git --ours'], 'without a matching summary the sides keep generic names');
  a.setSummary(async () => a.summary);
  const accepted = a.accepted.length;
  a.whileModal(() => { host.documents.push({ uri: Uri.file(path.join(root, 'src', 'app.ts')), isDirty: true }); });
  await assert.rejects(a.instance.accept('repo', ['src/app.ts'], 'theirs'), /Save or revert src\/app\.ts first/, 'an editor that became dirty while the modal was open');
  assert.equal(a.accepted.length, accepted); host.documents.length = 0; a.whileModal(() => undefined);
  a.rows.set('src/old.ts', row('src/old.ts', { kind: 'deletedByThem', mergeable: false, theirs: 'deleted', markers: { present: false, blocks: 0 } }));
  await assert.rejects(a.instance.markResolved('repo', ['src/old.ts']), /src\/old\.ts is deleted by them: Mark Resolved would keep only the version Git left in the working tree\. Choose Accept Yours or Accept Theirs\./);
  assert.deepEqual(a.staged, []);
  a.bridge.dispose();
});

test('Use Column Layout runs merge.columnLayout once, on the next merge editor the bridge shows, and never without the request', async () => {
  const h = harness(); host.available.add('merge.columnLayout');
  await h.bridge.open('repo', 'src/app.ts'); assert.equal(h.executed().includes('merge.columnLayout'), false);
  h.bridge.preferColumnLayout(); host.commands.length = 0;
  await h.bridge.open('repo', 'src/app.ts');
  assert.deepEqual(h.executed(), ['workbench.action.focusActiveEditorGroup', 'merge.columnLayout'], 'it acts on the active merge editor, so it runs once that one has focus');
  await h.bridge.open('repo', 'src/b.ts'); assert.equal(h.executed().filter(id => id === 'merge.columnLayout').length, 1, 'VS Code keeps the layout for later merge editors');
  h.bridge.dispose();
});
