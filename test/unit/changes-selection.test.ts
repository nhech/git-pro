import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

type Change = { path: string; group: 'staged' | 'working' | 'untracked' | 'conflicts'; status: string };
const changes: Change[] = [{ path: 'a.ts', group: 'working', status: 'M' }, { path: 'src/b.ts', group: 'working', status: 'M' }, { path: 'new.ts', group: 'untracked', status: '?' }, { path: 'c.ts', group: 'staged', status: 'A' }, { path: 'src/d.ts', group: 'staged', status: 'M' },
  // An untracked directory shown with a trailing slash is a repository of its own.
  { path: 'vendor/lib/', group: 'untracked', status: '?' }];

/** The compiled DailyCommands over a stand-in Git service: what the Changes view's rows (files, folders, groups) turn into when Stage or Unstage runs. */
function harness() {
  const commands = new Map<string, (...args: unknown[]) => Promise<void>>(), calls: [string, string[]][] = [], errors: string[] = [], copied: string[] = [];
  const git = { registry: { active: { id: 'owned' }, list: () => [{ id: 'owned', root: '/owned' }], store: { get: () => ({ head: 'main', operation: 'idle', changes }) } }, state: async () => ({ changes }),
    stage: async (_id: string, paths: string[]) => { calls.push(['stage', Array.from(paths)]); }, unstage: async (_id: string, paths: string[]) => { calls.push(['unstage', Array.from(paths)]); } };
  const vscode = { Uri: class { static file(root: string) { return { fsPath: root }; } }, ProgressLocation: { Window: 10 }, env: { clipboard: { writeText: async (text: string) => { copied.push(text); } } }, workspace: { getConfiguration: () => ({ get: () => 'ff-only' }) },
    commands: { registerCommand: (id: string, fn: (...args: unknown[]) => Promise<void>) => { commands.set(id, fn); return { dispose: () => commands.delete(id) }; }, executeCommand: async () => undefined },
    window: { withProgress: (_options: unknown, run: () => Promise<void>) => run(), showErrorMessage: async (text: string) => { errors.push(text); return undefined; }, activeTextEditor: undefined } };
  const source = path.resolve(__dirname, '../../src/commands/daily.commands.js'), load = createRequire(source), exports: Record<string, unknown> = {};
  runInNewContext(readFileSync(source, 'utf8'), { exports, require: (name: string) => name === 'vscode' ? vscode : name === '../git/git.service' ? { DailyError: class extends Error {} } : name === '../git/diff/diff.service' ? { DiffService: class {} } : load(name) });
  const view = { selection: [] as unknown[] };
  const instance = new (exports.DailyCommands as new (...args: unknown[]) => { dispose(): void })(git, {}, {}, view, { error: () => undefined });
  return { run: (id: string, ...args: unknown[]) => commands.get(id)!(...args), calls, errors, copied, view, dispose: () => instance.dispose() };
}
const folder = (prefix: string, name: Change['group']) => ({ kind: 'folder', repositoryId: 'owned', group: name, prefix });
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
    // Several selected rows arrive as the second argument. A header that is selected beside files is only a header that was clicked to open it: it adds nothing.
    await h.run('gitPro.stage', file('a.ts', 'working'), [group('working'), file('a.ts', 'working'), file('new.ts', 'untracked')]);
    assert.deepEqual(h.calls.at(-1), ['stage', ['a.ts', 'new.ts']], 'the files that were selected, not the whole Working Tree');
    await h.run('gitPro.stage', group('working'), [group('working'), group('untracked')]); assert.deepEqual(h.calls.at(-1), ['stage', ['a.ts', 'src/b.ts', 'new.ts']], 'headers on their own stand for their files');
    // Run without a clicked row (a keyboard shortcut), the view's own selection is the target, and a selected header is not.
    h.view.selection = [file('new.ts', 'untracked')]; await h.run('gitPro.stage'); assert.deepEqual(h.calls.at(-1), ['stage', ['new.ts']]);
    h.view.selection = [group('untracked'), file('new.ts', 'untracked')]; await h.run('gitPro.stage'); assert.deepEqual(h.calls.at(-1), ['stage', ['new.ts']]);
    const staged = h.calls.length; h.view.selection = [group('untracked')]; await h.run('gitPro.stage'); assert.equal(h.calls.length, staged); assert.match(h.errors.at(-1)!, /Select changed files in the Changes view/);
    // An operation row or a message is not a change.
    const count = h.calls.length; await h.run('gitPro.stage', { kind: 'operation', repositoryId: 'owned' }); assert.equal(h.calls.length, count); assert.match(h.errors.at(-1)!, /Select changed file or folder entries only/);
  } finally { h.dispose(); }
});

test('a nested repository is left out of a group or folder, and Stage Folder and Copy Relative Path take every selected row', async () => {
  const h = harness();
  try {
    // Stage All on the Untracked group: the untracked repository is not staged as an embedded one, and does not make the whole action fail.
    await h.run('gitPro.stage', group('untracked')); assert.deepEqual(h.calls.at(-1), ['stage', ['new.ts']]);
    await h.run('gitPro.stageFolder', folder('vendor/', 'untracked')); assert.match(h.errors.at(-1)!, /has no changed files in the selected status group \(a nested repository is left out\)/);
    // An explicit row of that repository still gets Git's own refusal, from the service.
    await h.run('gitPro.stage', { kind: 'file', repositoryId: 'owned', change: changes.find(change => change.path === 'vendor/lib/') }); assert.deepEqual(h.calls.at(-1), ['stage', ['vendor/lib/']]);
    // Several folders, or a folder and a file, are one action.
    await h.run('gitPro.stageFolder', folder('src/', 'working'), [folder('src/', 'working'), file('a.ts', 'working')]); assert.deepEqual(h.calls.at(-1), ['stage', ['src/b.ts', 'a.ts']]);
    await h.run('gitPro.unstageFolder', folder('src/', 'staged'), [folder('src/', 'staged'), file('c.ts', 'staged')]); assert.deepEqual(h.calls.at(-1), ['unstage', ['src/d.ts', 'c.ts']]);
    await h.run('gitPro.copyPath', file('a.ts', 'working'), [file('a.ts', 'working'), file('src/b.ts', 'working')]); assert.deepEqual(h.copied.at(-1), 'a.ts\nsrc/b.ts');
  } finally { h.dispose(); }
});
