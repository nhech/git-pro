import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

type Change = { path: string; group: 'staged' | 'working' | 'untracked' | 'conflicts'; status: string };
const changes: Change[] = [{ path: 'a.ts', group: 'working', status: 'M' }, { path: 'src/b.ts', group: 'working', status: 'M' }, { path: 'new.ts', group: 'untracked', status: '?' }, { path: 'c.ts', group: 'staged', status: 'A' }, { path: 'src/d.ts', group: 'staged', status: 'M' }];

/** The compiled DailyCommands over a stand-in Git service: what the Changes view's rows (files, folders, groups) turn into when Stage or Unstage runs. */
function harness() {
  const commands = new Map<string, (...args: unknown[]) => Promise<void>>(), calls: [string, string[]][] = [], errors: string[] = [];
  const git = { registry: { active: { id: 'owned' }, list: () => [{ id: 'owned', root: '/owned' }], store: { get: () => ({ head: 'main', operation: 'idle', changes }) } }, state: async () => ({ changes }),
    stage: async (_id: string, paths: string[]) => { calls.push(['stage', Array.from(paths)]); }, unstage: async (_id: string, paths: string[]) => { calls.push(['unstage', Array.from(paths)]); } };
  const vscode = { Uri: class { static file(root: string) { return { fsPath: root }; } }, ProgressLocation: { Window: 10 }, workspace: { getConfiguration: () => ({ get: () => 'ff-only' }) },
    commands: { registerCommand: (id: string, fn: (...args: unknown[]) => Promise<void>) => { commands.set(id, fn); return { dispose: () => commands.delete(id) }; }, executeCommand: async () => undefined },
    window: { withProgress: (_options: unknown, run: () => Promise<void>) => run(), showErrorMessage: async (text: string) => { errors.push(text); return undefined; }, activeTextEditor: undefined } };
  const source = path.resolve(__dirname, '../../src/commands/daily.commands.js'), load = createRequire(source), exports: Record<string, unknown> = {};
  runInNewContext(readFileSync(source, 'utf8'), { exports, require: (name: string) => name === 'vscode' ? vscode : name === '../git/git.service' ? { DailyError: class extends Error {} } : name === '../git/diff/diff.service' ? { DiffService: class {} } : load(name) });
  const view = { selection: [] as unknown[] };
  const instance = new (exports.DailyCommands as new (...args: unknown[]) => { dispose(): void })(git, {}, {}, view, { error: () => undefined });
  return { run: (id: string, ...args: unknown[]) => commands.get(id)!(...args), calls, errors, view, dispose: () => instance.dispose() };
}
const file = (path: string, group: Change['group']) => ({ kind: 'file', repositoryId: 'owned', change: changes.find(change => change.path === path && change.group === group) });
const group = (name: Change['group']) => ({ kind: 'group', repositoryId: 'owned', group: name });

test('a group row of the Changes view stands for every file in it, and each action keeps its own rules about which groups it takes', async () => {
  const h = harness();
  try {
    await h.run('gitPro.stage', group('working')); assert.deepEqual(h.calls.at(-1), ['stage', ['a.ts', 'src/b.ts']]);
    await h.run('gitPro.stage', group('untracked')); assert.deepEqual(h.calls.at(-1), ['stage', ['new.ts']]);
    await h.run('gitPro.unstage', group('staged')); assert.deepEqual(h.calls.at(-1), ['unstage', ['c.ts', 'src/d.ts']]);
    // A group and a file of another group together are checked by the same rules.
    const before = h.calls.length; await h.run('gitPro.stage', group('staged')); assert.equal(h.calls.length, before); assert.match(h.errors.at(-1)!, /Stage only Working Tree or Untracked entries/);
    await h.run('gitPro.unstage', group('working')); assert.equal(h.calls.length, before); assert.match(h.errors.at(-1)!, /Unstage only Staged entries/);
    // Several selected rows arrive as the second argument: a group and a file in it count once.
    await h.run('gitPro.stage', group('working'), [group('working'), file('a.ts', 'working'), file('new.ts', 'untracked')]);
    assert.deepEqual(h.calls.at(-1), ['stage', ['a.ts', 'src/b.ts', 'new.ts']]);
    // Run without a clicked row (a keyboard shortcut), the view's own selection is the target.
    h.view.selection = [group('untracked')]; await h.run('gitPro.stage'); assert.deepEqual(h.calls.at(-1), ['stage', ['new.ts']]);
    // An operation row or a message is not a change.
    const count = h.calls.length; await h.run('gitPro.stage', { kind: 'operation', repositoryId: 'owned' }); assert.equal(h.calls.length, count); assert.match(h.errors.at(-1)!, /Select changed file or folder entries only/);
  } finally { h.dispose(); }
});
