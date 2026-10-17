import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { NativeDiffError } from '../../src/git/diff/native-diff-error';

type Change = { path: string; group: 'staged' | 'working' | 'untracked' | 'conflicts'; status: string };
const changes: Change[] = [{ path: 'img/logo.png', group: 'working', status: 'M' }, { path: 'notes.md', group: 'working', status: 'M' }];

/** The compiled DailyCommands over stand-ins: what opening a change's diff does when Git Pro's own text diff cannot show the file. */
function harness(options: { prepare: () => Promise<unknown>; nativeOpens?: boolean; nativeThrows?: boolean }) {
  const commands = new Map<string, (...args: unknown[]) => Promise<void>>(), executed: [string, unknown[]][] = [], errors: string[] = [], tabs: { label: string }[] = [];
  const git = { registry: { active: { id: 'owned' }, list: () => [{ id: 'owned', root: '/owned' }], store: { get: () => ({ head: 'main', operation: 'idle', changes }) } },
    state: async () => ({ changes, oid: 'abc' }), authorizePath: async (_id: string, file: string) => `/owned/${file}` };
  const vscode = { Uri: class { static file(fsPath: string) { return { scheme: 'file', fsPath }; } }, ProgressLocation: { Window: 10 }, workspace: { getConfiguration: () => ({ get: () => 'ff-only' }) },
    commands: { registerCommand: (id: string, fn: (...args: unknown[]) => Promise<void>) => { commands.set(id, fn); return { dispose: () => commands.delete(id) }; },
      executeCommand: async (id: string, ...args: unknown[]) => {
        executed.push([id, args]);
        if (id === 'git.openChange') { if (options.nativeThrows) throw new Error("command 'git.openChange' not found"); if (options.nativeOpens !== false) tabs.push({ label: `${path.basename((args[0] as { fsPath: string }).fsPath)} (Working Tree)` }); }
      } },
    window: { withProgress: (_options: unknown, run: () => Promise<void>) => run(), showErrorMessage: async (text: string) => { errors.push(text); return undefined; }, activeTextEditor: undefined, tabGroups: { all: [{ tabs }] } } };
  const source = path.resolve(__dirname, '../../src/commands/daily.commands.js'), load = createRequire(source), exports: Record<string, unknown> = {};
  runInNewContext(readFileSync(source, 'utf8'), { exports, require: (name: string) => name === 'vscode' ? vscode : name === '../git/git.service' ? { DailyError: class extends Error {} } : name === '../git/diff/diff.service' ? { DiffService: class {} } : name === '../git/diff/native-diff-error' ? { NativeDiffError } : load(name) });
  const view = { selection: [] as unknown[] }, revisions = { add: (_content: unknown, name: string) => ({ scheme: 'git-pro-revision', name }) };
  const instance = new (exports.DailyCommands as new (...args: unknown[]) => { dispose(): void; diffs: unknown })(git, revisions, {}, view, { error: () => undefined });
  instance.diffs = { prepare: options.prepare };
  const row = (file: string) => ({ kind: 'file', repositoryId: 'owned', change: changes.find(change => change.path === file) });
  return { run: (id: string, ...args: unknown[]) => commands.get(id)!(...args), executed, errors, row, dispose: () => instance.dispose() };
}
const binary = () => Promise.reject(new NativeDiffError('Binary revision: open the file through native Source Control.'));

test('a change that the text diff cannot show opens in the built-in Source Control, and the row never shows an error for it', async () => {
  const h = harness({ prepare: binary });
  try {
    for (const command of ['gitPro.diff', 'gitPro.diffHead']) {
      const before = h.executed.length; await h.run(command, h.row('img/logo.png'));
      const opened = h.executed.slice(before); assert.deepEqual(opened.map(([id]) => id), ['git.openChange'], `${command} asks the built-in Git extension for the diff`);
      assert.equal((opened[0]![1][0] as { fsPath: string }).fsPath, '/owned/img/logo.png');
    }
    assert.deepEqual(h.errors, []); assert.ok(!h.executed.some(([id]) => id === 'vscode.diff'), 'no text diff was opened');
  } finally { h.dispose(); }
});

test('when the built-in Source Control cannot show the file either, the reason is the error, and other failures are never turned into a native diff', async () => {
  // The Git extension is off: the command does not exist.
  const off = harness({ prepare: binary, nativeThrows: true });
  try { await off.run('gitPro.diff', off.row('img/logo.png')); assert.match(off.errors.at(-1)!, /Binary revision: open the file through native Source Control/); } finally { off.dispose(); }
  // The command did nothing (it does not know the file): no diff of it is open, so the user is told.
  const unknown = harness({ prepare: binary, nativeOpens: false });
  try { await unknown.run('gitPro.diff', unknown.row('img/logo.png')); assert.equal(unknown.executed.filter(([id]) => id === 'git.openChange').length, 1); assert.match(unknown.errors.at(-1)!, /Binary revision/); } finally { unknown.dispose(); }
  // A conflict is Git Pro's own to explain, and any other failure is still a failure.
  for (const error of [new Error('This file has merge conflicts. Use Git Pro: Resolve Conflicts… to compare its sides or merge it.'), new Error('Git failed')]) {
    const h = harness({ prepare: () => Promise.reject(error) });
    try { await h.run('gitPro.diff', h.row('notes.md')); assert.ok(!h.executed.some(([id]) => id === 'git.openChange')); assert.equal(h.errors.at(-1), `Git Pro: ${error.message}`); } finally { h.dispose(); }
  }
});

test('a text file still opens in Git Pro\'s own diff', async () => {
  const h = harness({ prepare: async () => ({ left: Buffer.from('a\n'), right: undefined, workingPath: '/owned/notes.md', title: 'notes.md (Index ↔ Working Tree)' }) });
  try {
    await h.run('gitPro.diff', h.row('notes.md'));
    assert.deepEqual(h.executed.map(([id]) => id), ['vscode.diff']); assert.deepEqual(h.errors, []);
  } finally { h.dispose(); }
});
