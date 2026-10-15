import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import Module from 'node:module';

type Listener = (value?: unknown) => void;
class EventEmitter { readonly listeners = new Set<Listener>(); readonly event = (listener: Listener) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; fire(value?: unknown): void { for (const listener of [...this.listeners]) listener(value); } dispose(): void { this.listeners.clear(); } }
/** Each test loads the extension against its own vscode stand-in, so the compiled sources must not come from an earlier test's module cache. */
const unloadSources = () => { const root = path.resolve(__dirname, '../../src') + path.sep; for (const key of Object.keys(require.cache)) if (key.startsWith(root)) delete require.cache[key]; };

test('with Git disabled at startup every contributed command explains why, and enabling Git starts Git Pro without a reload', async () => {
  unloadSources();
  const manifest = JSON.parse(readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')) as { contributes: { commands: { command: string }[] } };
  const commands = new Map<string, (...args: unknown[]) => unknown>(), logs: string[] = [], errors: string[] = [];
  let enablement: Listener | undefined;
  const exported = { enabled: false, onDidChangeEnablement: (listener: Listener) => { enablement = listener; return { dispose: () => undefined }; },
    // The real start reads the Git path first; failing there keeps this test away from the rest of activation.
    getAPI: () => ({ get git(): never { throw new Error('GIT_PATH_SENTINEL'); }, repositories: [], onDidOpenRepository: () => ({ dispose: () => undefined }), onDidCloseRepository: () => ({ dispose: () => undefined }) }) };
  const vscode = new Proxy({
    EventEmitter, Disposable: { from: (...items: { dispose(): unknown }[]) => ({ dispose: () => items.forEach(item => item.dispose()) }) },
    window: { createOutputChannel: () => ({ appendLine: (line: string) => logs.push(line), show: () => undefined, dispose: () => undefined }), state: { focused: true },
      showErrorMessage: async (message: string) => { errors.push(message); return undefined; } },
    workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: process.cwd() } }], getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
    commands: { registerCommand: (id: string, callback: (...args: unknown[]) => unknown) => { assert.equal(commands.has(id), false, `${id} registered twice`); commands.set(id, callback); return { dispose: () => commands.delete(id) }; }, executeCommand: async () => undefined },
    extensions: { getExtension: (id: string) => id === 'vscode.git' ? { activate: async () => exported } : undefined }
  }, { get: (target: Record<string, unknown>, key: string) => key in target ? target[key] : class {} });
  const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown }, original = loader._load;
  loader._load = function (request: string, ...rest: unknown[]) { return request === 'vscode' ? vscode : original.call(this, request, ...rest); };
  try {
    const { activate } = await import(path.resolve(__dirname, '../../src/extension.js')) as { activate(context: unknown): Promise<unknown> };
    const context = { subscriptions: [] as { dispose(): unknown }[], extensionUri: { fsPath: process.cwd() }, extension: { packageJSON: manifest } };
    assert.equal(await activate(context), undefined);
    const contributed = manifest.contributes.commands.map(item => item.command);
    assert.deepEqual(contributed.filter(id => !commands.has(id)), [], 'no contributed command is left unregistered');
    await commands.get('gitPro.refresh')!(); assert.match(errors.at(-1)!, /Enable the built-in Git extension/);

    exported.enabled = true; enablement!(true); await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(logs.some(line => line.includes('GIT_PATH_SENTINEL')), 'enabling Git ran the deferred start');
    assert.deepEqual(contributed.filter(id => !commands.has(id)), [], 'a failed start still answers every command');
    await commands.get('gitPro.refresh')!(); assert.match(errors.at(-1)!, /Git could not be started/);
    for (const disposable of context.subscriptions) disposable?.dispose();
  } finally { loader._load = original; }
});

test('a full start registers every contributed command, including the conflict, operation and compare features, and disposing the subscriptions removes them all', async () => {
  unloadSources();
  const manifest = JSON.parse(readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')) as { contributes: { commands: { command: string }[] } };
  const commands = new Map<string, (...args: unknown[]) => unknown>(), trees = new Map<string, Record<string, unknown>>(), logs: string[] = [];
  // Everything the test does not model is inert: callable, constructible and disposable, but never thenable, so no await waits on it.
  const inert: unknown = new Proxy(function inert() { /* no-op */ }, {
    get: (_target, key) => key === 'then' ? undefined : key === Symbol.toPrimitive ? () => '' : key === Symbol.iterator ? function* () { /* empty */ } : key === 'dispose' ? () => undefined : inert,
    set: () => true, apply: () => inert, construct: () => inert as object });
  const modelled = <T extends object>(members: T): T => new Proxy(members, { get: (target, key) => key in target ? (target as Record<string | symbol, unknown>)[key] : key === 'then' || typeof key === 'symbol' ? undefined : inert });
  const disposable = { dispose: () => undefined }, event = () => disposable;
  const exported = modelled({ enabled: true, onDidChangeEnablement: event,
    // An absolute native executable passes resolveGitExecutable; with no repositories open nothing runs it.
    getAPI: () => modelled({ git: { path: process.execPath }, repositories: [], onDidOpenRepository: event, onDidCloseRepository: event, openRepository: async () => null }) });
  const vscode = modelled({
    EventEmitter, Disposable: class { static from(...items: { dispose(): unknown }[]) { return { dispose: () => items.forEach(item => item.dispose()) }; } constructor(readonly dispose: () => unknown) {} },
    Uri: modelled({ joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts) }), file: (fsPath: string) => ({ scheme: 'file', fsPath }) }),
    window: modelled({ createOutputChannel: () => modelled({ appendLine: (line: string) => logs.push(line) }), state: { focused: true }, activeTextEditor: undefined, visibleTextEditors: [],
      createTreeView: (id: string, options: Record<string, unknown>) => { trees.set(id, options); return { dispose: disposable.dispose, selection: [], onDidChangeSelection: event }; } }),
    workspace: modelled({ isTrusted: true, workspaceFolders: [], textDocuments: [], getConfiguration: () => modelled({ get: (_key: string, fallback: unknown) => fallback }) }),
    commands: modelled({ registerCommand: (id: string, callback: (...args: unknown[]) => unknown) => { assert.equal(commands.has(id), false, `${id} registered twice`); commands.set(id, callback); return { dispose: () => commands.delete(id) }; },
      executeCommand: async () => undefined }),
    extensions: modelled({ getExtension: (id: string) => id === 'vscode.git' ? { activate: async () => exported } : undefined })
  });
  const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown }, original = loader._load;
  loader._load = function (request: string, ...rest: unknown[]) { return request === 'vscode' ? vscode : original.call(this, request, ...rest); };
  try {
    const { activate } = await import(path.resolve(__dirname, '../../src/extension.js')) as { activate(context: unknown): Promise<unknown> };
    const storage = { fsPath: path.join(tmpdir(), 'git-pro-activation-storage') }, state = modelled({ get: (_key: string, fallback?: unknown) => fallback, update: async () => undefined, keys: () => [] });
    const context = { subscriptions: [] as { dispose(): unknown }[], extensionUri: { fsPath: process.cwd() }, globalStorageUri: storage, workspaceState: state, globalState: state, extension: { packageJSON: manifest } };
    const api = await activate(context);
    assert.ok(api, `started; log: ${logs.join(' | ')}`);
    assert.ok(!logs.some(line => /error/i.test(line)), logs.join('\n'));
    const contributed = manifest.contributes.commands.map(item => item.command);
    assert.deepEqual(contributed.filter(id => !commands.has(id)), [], 'every contributed command is registered by the started extension');
    for (const id of ['gitPro.conflicts.open', 'gitPro.mergeEditor.apply', 'gitPro.operation.abort', 'gitPro.compareWithCurrent', 'gitPro.mergeIntoCurrent']) assert.ok(commands.has(id), id);
    assert.equal(trees.get('gitPro.branchesView')?.canSelectMany, true, 'Branches allows selecting two branches to compare');
    for (const disposable of context.subscriptions) disposable?.dispose();
    assert.deepEqual([...commands.keys()], [], 'deactivation removes every registration, the new feature commands included');
  } finally { loader._load = original; }
});
