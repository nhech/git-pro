import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as path from 'node:path';

const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const disposable = { dispose: () => undefined };

test('Changes does not rebuild while hidden, keeps the badge current, drops the invisible selection and renders once when shown', async () => {
  const file = path.resolve(__dirname, '../../src/views/changes/changes-panel.js'), load = createRequire(file), exports: Record<string, unknown> = {};
  type Change = { group: string; path: string; status: string };
  const listeners: (() => void)[] = [];
  const repo = { id: 'repo', root: 'fixture/repo' };
  const change = (name: string): Change => ({ group: 'working', path: name, status: 'M' });
  const registry = { active: repo, store: new Map<string, { version: number; changes: Change[] }>([[repo.id, { version: 1, changes: [change('a.txt')] }]]), errors: new Map<string, string>(),
    onDidChange: (callback: () => void) => { listeners.push(callback); return disposable; } };
  let built = 0;
  const provider = { onDidChangeTreeData: () => disposable,
    getChildren: (node?: unknown) => node ? registry.store.get(repo.id)!.changes.map(item => ({ kind: 'file', repositoryId: repo.id, change: item })) : [{ kind: 'group', group: 'working' }],
    getTreeItem: (node: { kind: string; change?: Change }) => { built++; return { label: node.kind === 'file' ? node.change!.path : 'Working Tree', description: node.kind === 'file' ? 'Modified' : '1' }; } };
  const vscode = { workspace: { getConfiguration: () => ({ get: () => 'status' }), onDidChangeConfiguration: () => disposable },
    Uri: { file: (value: string) => value, joinPath: (_root: unknown, ...parts: string[]) => parts.join('/') }, commands: { executeCommand: async () => undefined } };
  runInNewContext(readFileSync(file, 'utf8'), { exports, Buffer, require: (name: string) => name === 'vscode' ? vscode : load(name) });
  const states: { rows: { kind: string; key: string; label: string }[] }[] = [];
  let receive: (value: unknown) => void = () => undefined, onVisibility: () => void = () => undefined;
  const view = { visible: true, badge: undefined as { value: number } | undefined,
    webview: { html: '', cspSource: 'owned:', asWebviewUri: String, onDidReceiveMessage: (callback: typeof receive) => { receive = callback; return disposable; },
      postMessage: async (value: { type: string; rows: { kind: string; key: string; label: string }[] }) => { if (value.type === 'state') states.push(value); return true; } },
    onDidDispose: () => disposable, onDidChangeVisibility: (callback: () => void) => { onVisibility = callback; return disposable; } };
  type Panel = { resolveWebviewView(view: unknown): void; dispose(): void; readonly selection: unknown[] };
  const Constructor = exports.ChangesPanel as new (context: unknown, registry: unknown, provider: unknown) => Panel;
  const panel = new Constructor({ extensionUri: 'owned' }, registry, provider);
  const fire = () => { for (const callback of listeners) callback(); };
  panel.resolveWebviewView(view); await settle();
  assert.equal(states.length, 1); assert.equal(view.badge?.value, 1);
  const session = /data-session="([^"]+)"/.exec(view.webview.html)![1]!;
  receive({ type: 'select', session, keys: [states[0]!.rows.find(row => row.kind === 'file')!.key] }); await settle();
  assert.equal(panel.selection.length, 1);

  view.visible = false; onVisibility();
  assert.equal(panel.selection.length, 0, 'a hidden renderer cannot show or change a selection');
  const builtBeforeHidden = built;
  registry.store.set(repo.id, { version: 2, changes: [change('a.txt'), change('b.txt')] });
  for (let index = 0; index < 5; index++) { fire(); await settle(); }
  assert.equal(states.length, 1, 'no state is built or posted for a hidden view'); assert.equal(built, builtBeforeHidden, 'no tree items are created either');
  assert.equal(view.badge?.value, 2, 'the activity-bar badge still tracks the change count');

  view.visible = true; onVisibility(); await settle();
  assert.equal(states.length, 2); assert.ok(states[1]!.rows.some(row => row.label === 'b.txt'));
  receive({ type: 'ready', session }); await settle();
  assert.equal(states.length, 3, 'the recreated renderer always receives a forced state');
  panel.dispose();
});

test('Commit composer skips state delivery while hidden and delivers it on ready', async () => {
  const file = path.resolve(__dirname, '../../src/webviews/commit/commit-composer.js'), load = createRequire(file), exports: Record<string, unknown> = {};
  const vscode = { workspace: { onDidChangeConfiguration: () => disposable, getConfiguration: () => ({ get: () => undefined }) },
    Uri: { file: (value: string) => value, joinPath: (_root: unknown, ...parts: string[]) => parts.join('/') } };
  runInNewContext(readFileSync(file, 'utf8'), { exports, require: (name: string) => name === 'vscode' ? vscode : load(name) });
  const context = { extensionUri: 'owned', workspaceState: { get: (_key: string, fallback: unknown) => fallback, update: async () => undefined } };
  const git = { registry: { active: { id: 'repo', root: 'fixture' }, onDidChange: () => disposable, store: new Map([['repo', { changes: [{ group: 'staged' }], operation: 'idle' }]]) }, repository: () => ({ root: 'fixture' }) };
  type Composer = { resolveWebviewView(view: unknown): Promise<void>; update(): Promise<void>; dispose(): void };
  const Constructor = exports.CommitComposer as new (context: unknown, git: unknown, commit: () => Promise<boolean>) => Composer;
  const composer = new Constructor(context, git, async () => true);
  const posted: { type: string }[] = []; let receive: (value: unknown) => Promise<void> = async () => undefined;
  const view = { visible: false, webview: { html: '', asWebviewUri: String, cspSource: 'owned:', onDidReceiveMessage: (callback: typeof receive) => { receive = callback; return disposable; },
    postMessage: async (value: { type: string }) => { posted.push(value); return true; } }, onDidDispose: () => disposable };
  try {
    await composer.resolveWebviewView(view); await composer.update();
    assert.equal(posted.length, 0, 'nothing is posted to a hidden view');
    view.visible = true; const session = /data-session="([^"]+)"/.exec(view.webview.html)![1]!;
    await receive({ type: 'ready', session });
    assert.equal(posted.filter(message => message.type === 'state').length, 1);
  } finally { composer.dispose(); }
});

/** One BlameController over fake editors: which editors are visible and whether blame is on can change while it runs. */
async function blameFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'git-pro-blame-idle-'));
  const target = path.join(root, 'line.txt'); await writeFile(target, 'committed\n');
  const file = path.resolve(__dirname, '../../src/editor/blame-controller.js'), load = createRequire(file), exports: Record<string, unknown> = {};
  const events = new Map<string, () => void>(); let enabled = false, configurationReads = 0, timer: (() => void) | undefined;
  const counts = new Map<string, { clears: number; writes: number }>();
  const editor = (name: string) => {
    counts.set(name, { clears: 0, writes: 0 });
    return { name, document: { uri: { scheme: 'file', fsPath: target }, isDirty: false, lineAt: () => ({ range: {} }) }, selection: { active: { line: 0 } },
      setDecorations: (_type: unknown, items: unknown[]) => { const count = counts.get(name)!; if (items.length) count.writes++; else count.clears++; } };
  };
  const first = editor('first'), second = editor('second');
  let active = first, visible = [first];
  const subscribe = (name: string) => (callback: () => void) => { events.set(name, callback); return { dispose: () => events.delete(name) }; };
  class MarkdownString { isTrusted: unknown; supportHtml = false; appendText(): void {} appendMarkdown(): void {} }
  const vscode = { MarkdownString, ThemeColor: class {},
    window: { get activeTextEditor() { return active; }, get visibleTextEditors() { return visible; }, createTextEditorDecorationType: () => ({ dispose: () => undefined }), onDidChangeTextEditorSelection: subscribe('selection'), onDidChangeActiveTextEditor: subscribe('active') },
    workspace: { getConfiguration: () => ({ get: (key: string, fallback: unknown) => { configurationReads++; return key === 'blame.enabled' ? enabled : fallback; } }),
      onDidChangeTextDocument: subscribe('document'), onDidSaveTextDocument: subscribe('save'), onDidChangeConfiguration: subscribe('configuration') } };
  runInNewContext(readFileSync(file, 'utf8'), { exports, require: (name: string) => name === 'vscode' ? vscode : name === '../security/paths' ? { canonicalFilePath: async (value: string) => value } : load(name),
    setTimeout: (callback: () => void) => { timer = callback; return 1; }, clearTimeout: () => { timer = undefined; }, AbortController });
  const oid = 'a'.repeat(40);
  const history = { blame: async () => ({ oid, author: 'Author', timestamp: 1791072000, summary: 'summary', uncommitted: false }) };
  const registry = { resolveFile: async () => ({ id: 'owned', root }), store: { get: () => ({ oid }) }, onDidChange: subscribe('registry') };
  const Controller = exports.BlameController as new (history: unknown, registry: unknown) => { dispose(): void };
  const controller = new Controller(history, registry);
  const configure = (value: boolean) => { enabled = value; (events.get('configuration') as unknown as (event: { affectsConfiguration: () => boolean }) => void)({ affectsConfiguration: () => true }); };
  const rendered = async (name: string, writes: number) => { for (let attempt = 0; attempt < 300 && counts.get(name)!.writes < writes; attempt++) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(counts.get(name)!.writes, writes, `${name} annotation rendered`); };
  return { events, counts, first, second, controller, configure, runTimer: () => timer!(), rendered, reads: () => configurationReads,
    show: (...editors: (typeof first)[]) => { visible = editors; active = editors[0]!; },
    close: async () => { controller.dispose(); await rm(root, { recursive: true, force: true }); } };
}

test('Blame stays idle while disabled and removes its annotation exactly once when turned off', async () => {
  const b = await blameFixture();
  try {
    for (let index = 0; index < 50; index++) { b.events.get('document')!(); b.events.get('selection')!(); b.events.get('registry')!(); }
    assert.equal(b.counts.get('first')!.clears, 0, 'typing, cursor movement and status events do not touch editors while blame is off'); assert.ok(b.reads() >= 150);
    b.configure(true); assert.equal(b.counts.get('first')!.clears, 1, 'an enabled controller clears the stale annotation before recomputing');
    b.runTimer(); await b.rendered('first', 1);
    b.configure(false); assert.equal(b.counts.get('first')!.clears, 2, 'turning blame off removes the visible annotation');
    for (let index = 0; index < 20; index++) b.events.get('document')!();
    assert.equal(b.counts.get('first')!.clears, 2, 'and then goes quiet again');
  } finally { await b.close(); }
});

test('Blame clears an annotation left on an editor that was hidden when blame was turned off', async () => {
  const b = await blameFixture();
  try {
    b.configure(true); b.runTimer(); await b.rendered('first', 1);
    b.show(b.second); b.configure(false); // the annotated editor is no longer visible
    assert.equal(b.counts.get('second')!.clears, 0, 'an editor that never carried an annotation is left alone');
    assert.equal(b.counts.get('first')!.clears, 1, 'only the clear made before it was hidden');
    b.show(b.first); b.events.get('active')!();
    assert.equal(b.counts.get('first')!.clears, 2, 'the stale annotation is removed as soon as that editor is visible again');
    b.events.get('active')!(); assert.equal(b.counts.get('first')!.clears, 2);
  } finally { await b.close(); }
});
