import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

class DailyError extends Error { constructor(readonly code: string, message: string) { super(message); } }
type Snapshot = { oid: string; head: string; upstream: string; ahead: number; behind: number; changes: readonly unknown[] };
const clean = (): Snapshot => ({ oid: 'a'.repeat(40), head: 'main', upstream: 'origin/main', ahead: 1, behind: 1, changes: [] });
function harness(error: Error, choice?: string, reviewed = clean()) {
  const commands = new Map<string, () => Promise<void>>(), errors: string[] = [], warnings: string[] = [], strategies: string[] = [], executed: string[] = [];
  let reads = 0;
  const git = { registry: { active: { id: 'owned' }, refresh: async () => undefined, store: { get: () => ({ ...clean(), operation: 'idle' }) } },
    repository: () => ({ root: '/owned' }), preview: async () => { reads++; return { repositoryId: 'owned', head: reads === 1 ? clean().oid : reviewed.oid, status: reads === 1 ? clean() : reviewed }; },
    pull: async (_id: string, strategy: string) => { strategies.push(strategy); if (strategies.length === 1) throw error; } };
  const vscode = { Uri: { file: (root: string) => ({ fsPath: root }) }, ProgressLocation: { Window: 10 }, workspace: { getConfiguration: () => ({ get: () => 'ff-only' }) },
    commands: { registerCommand: (id: string, fn: () => Promise<void>) => { commands.set(id, fn); return { dispose: () => commands.delete(id) }; }, executeCommand: async (id: string) => { executed.push(id); } },
    window: { withProgress: (_options: unknown, run: () => Promise<void>) => run(), showWarningMessage: async (text: string) => { warnings.push(text); return choice; }, showErrorMessage: async (text: string) => { errors.push(text); return undefined; } } };
  const source = path.resolve(__dirname, '../../src/commands/daily.commands.js'), load = createRequire(source), exports: Record<string, unknown> = {};
  runInNewContext(readFileSync(source, 'utf8'), { exports, require: (name: string) => name === 'vscode' ? vscode : name === '../git/git.service' ? { DailyError } : name === '../git/diff/diff.service' ? { DiffService: class {} } : load(name) });
  const Constructor = exports.DailyCommands as new (...args: unknown[]) => { dispose(): void };
  const instance = new Constructor(git, {}, {}, { selection: [] }, { error: () => undefined });
  return { run: async () => { try { await commands.get('gitPro.pull')!(); } finally { instance.dispose(); } }, errors, warnings, strategies, executed };
}
test('diverged branch does not turn dirty, stale, authentication or fetch failures into strategy selection', async () => {
  for (const failure of [new DailyError('dirty', 'Commit or stash local changes before pulling.'), new DailyError('stale', 'Local branch changed during fetch.'), Object.assign(new Error('Authentication failed'), { gitErrorCode: 'AuthenticationFailed' }), new Error('Fetch transport unavailable')]) {
    const h = harness(failure, 'Merge'); await h.run();
    assert.equal(h.warnings.length, 0, failure.message); assert.equal(h.errors.length, 1); assert.deepEqual(h.strategies, ['ff-only']); assert.deepEqual(h.executed, []);
  }
});
test('verified FF divergence preserves Cancel and explicit Rebase or Merge selection', async () => {
  for (const choice of [undefined, 'Rebase', 'Merge', 'Review Branches']) {
    const h = harness(new DailyError('diverged', 'Branches diverged.'), choice); await h.run();
    assert.equal(h.errors.length, 0); assert.equal(h.warnings.length, 1); assert.match(h.warnings[0]!, /Local \+1, remote \+1/);
    assert.deepEqual(h.strategies, choice === 'Rebase' || choice === 'Merge' ? ['ff-only', choice.toLowerCase()] : ['ff-only']);
    assert.deepEqual(h.executed, choice === 'Review Branches' ? ['gitPro.branches'] : []);
  }
});
test('fresh dirty, changed HEAD or no longer diverged snapshot prevents strategy dialog after FF divergence', async () => {
  for (const reviewed of [{ ...clean(), changes: [{ path: 'saved.txt' }] }, { ...clean(), oid: 'b'.repeat(40) }, { ...clean(), head: 'other' }, { ...clean(), upstream: 'backup/main' }, { ...clean(), ahead: 0 }]) {
    const h = harness(new DailyError('diverged', 'Branches diverged.'), 'Merge', reviewed); await h.run();
    assert.equal(h.warnings.length, 0); assert.equal(h.errors.length, 1); assert.deepEqual(h.strategies, ['ff-only']);
  }
});
