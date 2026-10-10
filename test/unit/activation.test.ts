import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import Module from 'node:module';

type Listener = (value?: unknown) => void;
class EventEmitter { readonly listeners = new Set<Listener>(); readonly event = (listener: Listener) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; fire(value?: unknown): void { for (const listener of [...this.listeners]) listener(value); } dispose(): void { this.listeners.clear(); } }

test('with Git disabled at startup every contributed command explains why, and enabling Git starts Git Pro without a reload', async () => {
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
