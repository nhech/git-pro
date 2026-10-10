import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { BranchInfo } from '../../src/git/git.service';
import type { ExtensionDiagnostics } from '../../src/extension';
import { Emitter } from '../../src/utils/events';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) { assert.ok(Date.now() < deadline, message); await delay(20); }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const branch = (name: string): BranchInfo => ({ name, ref: `refs/heads/${name}`, oid: 'a'.repeat(40), remote: false, upstream: '', worktree: '' });
type Item = vscode.QuickPickItem & { node?: { branch: BranchInfo }; create?: boolean };

function fixture() {
  let native!: vscode.QuickPick<Item>, shows = 0, disposals = 0, eventRegistrations = 0, registryRegistrations = 0, readCalls = 0, hiddenEvents = 0;
  const commands = new Map<string, () => Promise<void>>(), errors: string[] = [], actions: string[] = [], read = deferred<readonly BranchInfo[]>();
  const changed = new Emitter<void>(), original = { id: 'fixture', root: '/fixture' }, other = { id: 'other', root: '/other' };
  let repositories = [original];
  const registry = { active: original as typeof original | undefined, list: () => repositories, store: { get: () => ({ head: 'main' }) }, onDidChange: (listener: () => void) => {
    registryRegistrations++; const registration = changed.event(listener); let disposed = false;
    return { dispose: () => { if (!disposed) { disposed = true; registryRegistrations--; registration.dispose(); } } };
  } };
  const observers: vscode.Disposable[] = [];
  const facade = { ProgressLocation: vscode.ProgressLocation, Uri: vscode.Uri, QuickPickItemKind: vscode.QuickPickItemKind, ThemeIcon: vscode.ThemeIcon, ThemeColor: vscode.ThemeColor, commands: {
    executeCommand: vscode.commands.executeCommand,
    registerCommand: (id: string, callback: () => Promise<void>) => { commands.set(id, callback); return { dispose: () => commands.delete(id) }; },
  }, window: { withProgress: vscode.window.withProgress,
    createQuickPick: () => {
      native = vscode.window.createQuickPick<Item>();
      observers.push(native.onDidHide(() => { hiddenEvents++; }));
      return new Proxy(native, { get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== 'function') return value;
        if (property === 'show') return () => { shows++; target.show(); };
        if (property === 'dispose') return () => { disposals++; target.dispose(); };
        if (['onDidChangeValue', 'onDidHide', 'onDidAccept'].includes(String(property))) {
          return (...args: unknown[]) => {
            eventRegistrations++;
            const registration = (value as (...args: unknown[]) => vscode.Disposable).apply(target, args);
            let disposed = false;
            return { dispose: () => { if (!disposed) { disposed = true; eventRegistrations--; registration.dispose(); } } };
          };
        }
        return (...args: unknown[]) => (value as (...args: unknown[]) => unknown).apply(target, args);
      }, set(target, property, value) { return Reflect.set(target, property, value, target); } });
    },
    showQuickPick: async (_items: unknown, options: { title: string }) => { actions.push(options.title); return undefined; },
    showInputBox: async () => { throw new Error('Fixture must not create or mutate a branch.'); },
    showWarningMessage: async () => { throw new Error('Fixture must not approve a mutation.'); },
    showErrorMessage: async (message: string) => { errors.push(message); return undefined; },
  }, env: { clipboard: { writeText: async () => { throw new Error('Fixture must not write the clipboard.'); } } } };
  const git = { registry, repository: () => original,
    branchSearchSnapshot: () => { assert.equal(shows, 1, 'Native picker show precedes deferred branch read'); readCalls++; return read.promise; } };
  const source = path.resolve(__dirname, '../../src/commands/daily.commands.js'), load = createRequire(source), exports: Record<string, unknown> = {};
  runInNewContext(readFileSync(source, 'utf8'), { exports, require: (name: string) => name === 'vscode' ? facade : load(name) });
  const Constructor = exports.DailyCommands as new (...args: unknown[]) => { dispose(): void };
  const controller = new Constructor(git, {}, {}, { selection: [] }, { error: () => undefined });
  let settled = false;
  const pending = commands.get('gitPro.branches')!().then(() => { settled = true; });
  return { read, registry, original, other, changed, errors, actions, controller, pending,
    picker: () => native, state: () => ({ shows, disposals, eventRegistrations, registryRegistrations, readCalls, hiddenEvents, settled }),
    replace: () => { repositories = [{ ...original }]; registry.active = repositories[0]; },
    cleanup: () => { controller.dispose(); for (const observer of observers) observer.dispose(); changed.dispose(); },
  };
}

async function snapshot(root: string) {
  const git = (args: string[], allowUnborn = false) => {
    const result = spawnSync('git', args, { cwd: root, env: process.env, windowsHide: true, shell: false });
    assert.ok(result.status === 0 || (allowUnborn && result.status === 1), result.stderr.toString());
    return { exit: result.status, bytes: result.stdout.toString('base64') };
  };
  const files: Record<string, string> = {};
  const walk = async (directory: string) => { for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const file = path.join(directory, entry.name); assert.equal(entry.isSymbolicLink(), false);
    if (entry.isDirectory()) await walk(file); else files[path.relative(root, file)] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
  } };
  await walk(root);
  const index = await fs.readFile(path.join(root, '.git/index')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  return { head: git(['rev-parse', '--verify', '--quiet', 'HEAD'], true), refs: git(['for-each-ref', '--format=%(refname) %(objectname)']),
    status: git(['status', '--porcelain=v2', '-z']), staged: git(['ls-files', '--stage', '-z']), workingDiff: git(['diff', '--binary']), indexDiff: git(['diff', '--cached', '--binary']),
    index: index ? createHash('sha256').update(index).digest('hex') : null, files };
}

export async function run(): Promise<void> {
  const output = process.env.GIT_PRO_BRANCH_PICKER_OUTPUT; assert.ok(output);
  const reports: unknown[] = [];
  for (const scenario of ['close-success', 'close-failure', 'loaded-accept', 'switch', 'replace', 'dispose', 'live-failure']) {
    const f = fixture();
    try {
      await until(() => f.state().readCalls === 1, 'Fixture read never starts');
      assert.equal(f.state().shows, 1); assert.equal(f.picker().busy, true); assert.equal(f.picker().items.length, 0);
      assert.equal(f.state().settled, false);
      f.picker().value = 'FeAtUrE'; await delay(250);
      if (scenario.startsWith('close')) {
        await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
        await until(() => f.state().settled, 'Closing native QuickPick must not wait for metadata');
        assert.ok(f.state().hiddenEvents >= 1 && f.state().hiddenEvents <= 2, 'Native hide notifications stay bounded; controller cleanup must still happen exactly once');
        if (scenario === 'close-failure') f.read.reject(new Error('late fixture failure')); else f.read.resolve([branch('feature/late')]);
      } else if (scenario === 'loaded-accept') {
        f.read.resolve([branch('main'), ...Array.from({ length: 250 }, (_, i) => branch(`feature/${i}`))]);
        await until(() => !f.picker().busy, 'Native picker never becomes ready');
        assert.equal(f.picker().value, 'FeAtUrE'); assert.equal(f.picker().items.filter(item => item.node).length, 200);
        const selected = f.picker().items[0]!; assert.equal(selected.node!.branch.name, 'feature/0');
        f.picker().activeItems = [selected]; await delay(250);
        await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
        await until(() => f.state().settled, 'Native acceptance must settle');
        assert.deepEqual(f.actions, ['feature/0']);
      } else if (scenario === 'live-failure') {
        f.read.reject(new Error('live owned fixture failure'));
        await until(() => f.state().settled, 'Live load failure must settle'); assert.equal(f.errors.length, 1);
      } else {
        if (scenario === 'switch') { f.registry.active = f.other; f.changed.fire(); }
        else if (scenario === 'replace') { f.replace(); f.changed.fire(); }
        else f.controller.dispose();
        await until(() => f.state().settled, 'Repository/disposal closure must not wait for metadata');
        f.read.reject(new Error('obsolete fixture failure'));
      }
      await f.pending; await delay(100);
      assert.equal(f.state().disposals, 1); assert.equal(f.state().eventRegistrations, 0);
      assert.equal(f.state().registryRegistrations, 0);
      if (scenario !== 'live-failure') assert.deepEqual(f.errors, []);
      if (scenario !== 'loaded-accept') assert.deepEqual(f.actions, []);
      reports.push({ scenario, ...f.state(), actionRequests: f.actions, errorCount: f.errors.length, passed: true });
    } catch (error) {
      reports.push({ scenario, ...f.state(), actionRequests: f.actions, errorCount: f.errors.length, passed: false, error: String(error) });
      await fs.writeFile(output, JSON.stringify({ version: vscode.version, passed: false, controllerFixture: reports, originalInstalledCommandStarted: false, error: String(error) }, null, 2) + '\n', { flag: 'wx' });
      throw error;
    } finally { f.cleanup(); }
  }

  const extension = vscode.extensions.getExtension<ExtensionDiagnostics>('nhech.git-pro'); assert.ok(extension);
  const api = await extension.activate(); assert.ok(api.activeRepository());
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; assert.ok(root); assert.ok(root.includes('git-pro-host-'));
  const before = await snapshot(root), original: unknown[] = [];
  try {
  for (let invocation = 0; invocation < 3; invocation++) {
    let settled = false; const started = Date.now(), pending = vscode.commands.executeCommand('gitPro.branches').then(() => { settled = true; });
    await delay(250); assert.equal(settled, false, 'Original installed picker stays open until explicitly dismissed');
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    await until(() => settled, 'Original installed branch command must settle after closeQuickOpen'); await pending;
    assert.deepEqual(await snapshot(root), before, 'Read-only original branch picker preserves repository exactly');
    original.push({ invocation, elapsedMs: Date.now() - started, settledAfterClose: true, repositoryPreserved: true });
  }
  } catch (error) {
    await fs.writeFile(output, JSON.stringify({ version: vscode.version, passed: false, controllerFixture: reports, originalInstalledCommand: original, error: String(error) }, null, 2) + '\n', { flag: 'wx' });
    throw error;
  }
  const result = { version: vscode.version, controllerFixture: reports, originalInstalledCommand: original,
    productionCommandReplacements: 0, gitMutations: 0, clipboardWrites: 0, physicalInput: false, nativeWindowsTouched: false,
    note: 'Compiled production controller with genuine native public QuickPick and deferred fixture metadata; separate original installed command opens/dismisses three times with exact repository preservation. Programmatic value/activeItems and public workbench commands do not certify physical keyboard, pixels or speech.' };
  await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(result));
}
