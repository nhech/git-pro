import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { MenuRouter } from '../../src/webviews/menu-context';

class Element {
  children: Element[] = []; dataset: Record<string, string> = {}; attributes = new Map<string, string>(); listeners = new Map<string, (event: Record<string, unknown>) => void>();
  value = ''; draggable = false; id = ''; className = ''; isConnected = true; disabled = false; private text = '';
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.text = value; this.children = []; }
  append(...nodes: Element[]) { this.children.push(...nodes); } prepend(node: Element) { this.children.unshift(node); }
  replaceChildren() { for (const child of this.children) child.isConnected = false; this.children = []; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); } getAttribute(key: string) { return this.attributes.get(key); }
  addEventListener(type: string, callback: (event: Record<string, unknown>) => void) { this.listeners.set(type, callback); }
  focus() { /* focus is not observed here */ } scrollIntoView() { /* nor scrolling */ }
}

test('planner rows name themselves for the native right-click menu and select before it opens', () => {
  const ids = ['commits', 'action', 'up', 'down', 'message', 'review', 'status', 'cancel', 'native', 'range', 'selected-title', 'subject', 'message-preview', 'action-help'];
  const elements = new Map(ids.map(id => [id, new Element()])), sent: Record<string, unknown>[] = [];
  const body = { dataset: { session: 's' }, attributes: new Map<string, string>(), setAttribute(key: string, value: string) { this.attributes.set(key, value); } };
  let receive: ((event: { data: unknown }) => void) | undefined;
  runInNewContext(readFileSync('media/rebase.js', 'utf8'), { document: { body, getElementById: (id: string) => elements.get(id), createElement: () => new Element(), createElementNS: () => new Element() },
    window: { addEventListener: (_type: string, callback: typeof receive) => { receive = callback; } }, acquireVsCodeApi: () => ({ postMessage: (value: Record<string, unknown>) => sent.push(value) }) });
  const steps = [{ oid: 'a'.repeat(40), action: 'pick', subject: 'First' }, { oid: 'b'.repeat(40), action: 'reword', subject: 'Second', message: 'Second' }, { oid: 'c'.repeat(40), action: 'pick', subject: 'Third' }];
  receive!({ data: { type: 'state', session: 's', revision: 4, range: 'Captured', steps } }); receive!({ data: { type: 'busy', session: 's', busy: false } });
  const rows = elements.get('commits')!.children, context = (index: number) => JSON.parse(rows[index]!.getAttribute('data-vscode-context')!) as Record<string, unknown>;
  assert.deepEqual(JSON.parse(body.attributes.get('data-vscode-context')!), { preventDefaultContextMenuItems: true }, 'outside a row nothing offers Cut, Copy and Paste');
  assert.deepEqual(context(0), { preventDefaultContextMenuItems: true, session: 's', revision: 4, webviewSection: 'step', oid: steps[0]!.oid, stepAction: 'pick', stepFirst: true, stepLast: false });
  assert.deepEqual([context(1).stepAction, context(1).stepFirst, context(1).stepLast], ['reword', false, false]); assert.equal(context(2).stepLast, true);
  const before = sent.length;
  rows[2]!.listeners.get('contextmenu')!({});
  assert.equal(elements.get('selected-title')!.textContent, `Selected: ${'c'.repeat(10)}`, 'the row under the pointer is selected first');
  assert.equal(sent.length, before, 'selecting asks the host for nothing');
});

test('native right-click commands reach the planner through the router as its own requests', async () => {
  const file = path.resolve(__dirname, '../../src/webviews/rebase/rebase-planner.js'), load = createRequire(file), exports: Record<string, unknown> = {};
  let receive: (raw: unknown) => Promise<void> = async () => undefined, closed: () => void = () => undefined; const sent: Record<string, unknown>[] = [];
  const panel = { webview: { html: '', cspSource: 'vscode-resource:', asWebviewUri: (uri: unknown) => String(uri), postMessage: async (value: Record<string, unknown>) => { sent.push(value); return true; },
    onDidReceiveMessage: (callback: typeof receive) => { receive = callback; return { dispose: () => undefined }; } }, onDidDispose: (callback: () => void) => { closed = callback; return { dispose: () => undefined }; }, dispose: () => closed() };
  const vscode = { window: { createWebviewPanel: () => panel }, ViewColumn: { Active: 1 }, Uri: { joinPath: (_uri: unknown, ...parts: string[]) => parts.join('/') } };
  runInNewContext(readFileSync(file, 'utf8'), { exports, require: (name: string) => name === 'vscode' ? vscode : load(name) });
  type Steps = readonly { oid: string; action: string; message?: string }[];
  type Planner = { choose(preview: unknown, root: string, edit: (oid: string, initial?: string) => Promise<string | undefined>, confirm?: (steps: Steps) => Promise<boolean>): Promise<Steps | { native: Steps } | undefined>; dispose(): void };
  const menus = new MenuRouter(), Constructor = exports.RebasePlanner as new (context: unknown, menus: MenuRouter) => Planner, planner = new Constructor({ extensionUri: 'owned' }, menus);
  const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40), commits = [a, b, c].map(oid => ({ oid, parent: 'd'.repeat(40), subject: 'Fixture' }));
  const result = planner.choose({ commits, base: 'd'.repeat(40), snapshot: { head: c } }, 'fixture', async () => 'Reworded', async () => true);
  const session = /data-session="([^"]+)"/.exec(panel.webview.html)![1]!; await receive({ type: 'ready', session, revision: 0 });
  const state = () => sent.slice().reverse().find(item => item.type === 'state') as unknown as { revision: number; steps: { oid: string; action: string; message?: string }[] };
  const argument = (extra: Record<string, unknown>) => ({ webview: 'gitPro.rebasePlanner', webviewSection: 'step', preventDefaultContextMenuItems: true, session, revision: state().revision, oid: b, ...extra });
  const run = async (action: string, extra: Record<string, unknown> = {}) => { const { panel: target, context } = menus.resolve(argument(extra), ['gitPro.rebasePlanner'], 'step'); await target.handle!(action, context); };
  const errors = () => sent.filter(item => item.type === 'error').length;
  await run('fixup'); assert.deepEqual(state().steps.map(step => step.action), ['pick', 'fixup', 'pick']);
  await run('moveUp'); assert.deepEqual(state().steps.map(step => step.oid), [b, a, c], 'Move Up is the Move Up button');
  await run('moveDown', { oid: c }); assert.deepEqual(state().steps.map(step => step.oid), [b, a, c], 'the last row cannot move down');
  await run('reword'); assert.deepEqual(JSON.parse(JSON.stringify(state().steps.find(step => step.oid === b))), { oid: b, action: 'reword', message: 'Reworded', subject: 'Fixture' }, 'Reword… asks for the message exactly as the Action list does');
  const before = errors();
  await run('editMessage'); assert.equal(errors(), before, 'Edit Message… is offered for a reworded commit');
  await run('pick', { revision: 0 }); assert.match(String(sent.at(-1)?.message), /Plan changed/, 'a menu drawn for an older plan is refused');
  await run('pick', { oid: 'e'.repeat(40) }); assert.match(String(sent.at(-1)?.message), /outside/, 'a commit outside the captured range');
  assert.equal(errors(), before + 2);
  await assert.rejects(run('exec'), /Unknown planner menu action/);
  assert.throws(() => menus.commit(argument({ oid: a }), ['gitPro.rebasePlanner']), /Git Pro panel menu/, 'the planner has no repository commits to offer');
  planner.dispose(); assert.equal(await result, undefined);
  assert.throws(() => menus.resolve(argument({}), ['gitPro.rebasePlanner']), /closed/, 'a closed planner leaves the router');
});
