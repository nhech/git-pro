import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as path from 'node:path';
import { buildUndoMutation } from '../../src/git/undo/undo-builders';
import { buildMutationCommand } from '../../src/git/command-builders';
import { describeAge } from '../../src/utils/age';
import { UndoService, UndoUnavailable, parseUndoEntries, undoLimit, undoMaxAge, type UndoBackend, type UndoEntry, type UndoMemento } from '../../src/git/undo/undo.service';

const oid = (digit: string) => digit.repeat(40);
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

class Memory implements UndoMemento {
  readonly values = new Map<string, unknown>();
  get<T>(key: string, fallback: T): T { return (this.values.has(key) ? this.values.get(key) : fallback) as T; }
  async update(key: string, value: unknown): Promise<void> { this.values.set(key, JSON.parse(JSON.stringify(value))); }
}
function fakeBackend(options: { snapshot?: string | null; snapshotError?: boolean; keepError?: boolean; missing?: string[] } = {}) {
  const refs = new Map<string, string>(), calls: string[] = [];
  const backend: UndoBackend = {
    snapshot: async root => { calls.push(`snapshot ${root}`); if (options.snapshotError) throw new Error('needs merge'); return options.snapshot === null ? undefined : options.snapshot ?? oid('1'); },
    keep: async (_root, name, value) => { calls.push(`keep ${name}`); if (options.keepError) throw new Error('cannot lock ref'); refs.set(name, value); },
    drop: async (_root, name) => { calls.push(`drop ${name}`); refs.delete(name); },
    exists: async (_root, value) => !options.missing?.includes(value),
  };
  return { backend, refs, calls };
}
const discard = { kind: 'discard' as const, label: 'Discarded 2 files', paths: ['a.ts', 'b.ts'] };

test('the commands behind a safety copy name only refs of Git Pro\'s own and full object IDs', () => {
  const prefix = ['--literal-pathspecs', '--no-pager', '-c', 'color.ui=false'];
  assert.deepEqual(buildUndoMutation({ kind: 'undoSnapshot' }), [...prefix, 'stash', 'create', 'Git Pro safety copy']);
  assert.deepEqual(buildUndoMutation({ kind: 'undoKeep', name: '1760000000000-discard', oid: oid('a') }), [...prefix, 'update-ref', '-m', 'Git Pro safety copy', 'refs/gitpro/undo/1760000000000-discard', oid('a')]);
  assert.deepEqual(buildUndoMutation({ kind: 'undoDrop', name: '1760000000000-push-2' }), [...prefix, 'update-ref', '-d', 'refs/gitpro/undo/1760000000000-push-2']);
  assert.deepEqual(buildMutationCommand({ kind: 'undoDrop', name: '1760000000000-reset' }).slice(-3), ['update-ref', '-d', 'refs/gitpro/undo/1760000000000-reset'], 'the executor builds them too');
  for (const name of ['', 'main', '../heads/main', '1760000000000-other', '1760000000000-discard/../x', '1760000000000-discard-x', '12-discard', '1760000000000-discard ', 'refs/heads/main', '-1760000000000-discard']) {
    assert.throws(() => buildUndoMutation({ kind: 'undoKeep', name, oid: oid('a') }), /Invalid safety copy name/, name);
    assert.throws(() => buildUndoMutation({ kind: 'undoDrop', name }), /Invalid safety copy name/, name);
  }
  for (const value of ['', 'HEAD', '--all', 'abc', oid('g')]) assert.throws(() => buildUndoMutation({ kind: 'undoKeep', name: '1760000000000-discard', oid: value }), /Invalid full object ID/, value);
});

test('the records in the workspace state are read as data: whatever is not exactly an entry is left out', () => {
  const good: unknown[] = [
    { id: '1760000000002-discard', kind: 'discard', time: 1760000000002, label: 'Discarded a.ts', snapshot: oid('a'), paths: ['a.ts'] },
    { id: '1760000000003-reset', kind: 'reset', time: 1760000000003, label: 'Hard reset', head: oid('b'), snapshot: oid('c'), branch: 'main' },
    { id: '1760000000001-push', kind: 'push', time: 1760000000001, label: 'Force pushed', remote: 'origin', url: 'https://example.test/o/r.git', branch: 'main', oldTip: oid('d'), newTip: oid('e') },
  ];
  assert.deepEqual(parseUndoEntries(good).map(entry => entry.id), ['1760000000003-reset', '1760000000002-discard', '1760000000001-push'], 'newest first');
  const bad: unknown[] = [null, 5, 'text', [], {}, { ...(good[0] as object), id: 'main' }, { ...(good[0] as object), id: '1760000000002-push' }, { ...(good[0] as object), kind: 'other' }, { ...(good[0] as object), time: 'now' },
    { ...(good[0] as object), time: Number.NaN }, { ...(good[0] as object), label: '' }, { ...(good[0] as object), label: 'x'.repeat(301) }, { ...(good[0] as object), snapshot: 'HEAD' }, { ...(good[0] as object), paths: [] },
    { ...(good[0] as object), paths: [5] }, { ...(good[0] as object), paths: ['a\0b'] }, { ...(good[1] as object), head: 'nope' }, { ...(good[1] as object), snapshot: 7 }, { ...(good[1] as object), branch: '' },
    { ...(good[2] as object), oldTip: 'x' }, { ...(good[2] as object), url: '' }, { ...(good[2] as object), remote: 4 }];
  assert.deepEqual(parseUndoEntries([...bad, ...good]).length, 3, 'every malformed record is dropped, the three good ones stay');
  assert.deepEqual(parseUndoEntries('not a list'), []); assert.deepEqual(parseUndoEntries(undefined), []);
  assert.deepEqual(plain(parseUndoEntries([{ id: '1760000000001-reset', kind: 'reset', time: 1760000000001, label: 'Hard reset', head: oid('b'), extra: 'ignored' }])), [{ id: '1760000000001-reset', kind: 'reset', time: 1760000000001, label: 'Hard reset', head: oid('b') }], 'unknown fields are not carried');
});

test('a copy is kept in a ref before the action, recorded per repository, and a discard that cannot be copied does not run', async () => {
  const f = fakeBackend(), state = new Memory(); const now = 1_760_000_000_000;
  const service = new UndoService(f.backend, state, () => now);
  const entry = await service.save('repo', '/work/repo', discard);
  assert.deepEqual(plain(entry), { id: '1760000000000-discard', time: now, label: 'Discarded 2 files', kind: 'discard', snapshot: oid('1'), paths: ['a.ts', 'b.ts'] });
  assert.equal(f.refs.get('1760000000000-discard'), oid('1'), 'the ref keeps the copy alive');
  assert.deepEqual(plain(service.list('repo')), [plain(entry)]); assert.deepEqual(service.list('other'), [], 'per repository'); assert.equal(service.find('repo', entry.id)?.id, entry.id);
  // Nothing to copy, or a ref that cannot be made: the discard is not to go on.
  const clean = new UndoService(fakeBackend({ snapshot: null }).backend, new Memory(), () => now);
  await assert.rejects(clean.save('repo', '/work/repo', discard), UndoUnavailable); assert.deepEqual(clean.list('repo'), []);
  const locked = new UndoService(fakeBackend({ keepError: true }).backend, new Memory(), () => now);
  await assert.rejects(locked.save('repo', '/work/repo', discard), /cannot lock ref/); assert.deepEqual(locked.list('repo'), []);
  // A hard reset keeps HEAD even when the changes cannot be copied; with a copy, the ref keeps the copy (whose first parent is HEAD).
  const needsMerge = fakeBackend({ snapshotError: true }), unmerged = new UndoService(needsMerge.backend, new Memory(), () => now);
  const bare = await unmerged.save('repo', '/work/repo', { kind: 'reset', label: 'Hard reset', head: oid('b'), branch: 'main' });
  assert.deepEqual(plain(bare), { id: '1760000000000-reset', time: now, label: 'Hard reset', kind: 'reset', head: oid('b'), branch: 'main' }); assert.equal(needsMerge.refs.get('1760000000000-reset'), oid('b'));
  const withChanges = fakeBackend({ snapshot: oid('c') }), saved = await new UndoService(withChanges.backend, new Memory(), () => now).save('repo', '/work/repo', { kind: 'reset', label: 'Hard reset', head: oid('b') });
  assert.equal((saved as { snapshot?: string }).snapshot, oid('c')); assert.equal(withChanges.refs.get('1760000000000-reset'), oid('c'));
  // A force push needs the commit it replaces to be here.
  const gone = fakeBackend({ missing: [oid('d')] }), push = { kind: 'push' as const, label: 'Force pushed main to origin', remote: 'origin', url: 'https://example.test/o/r.git', branch: 'main', oldTip: oid('d'), newTip: oid('e') };
  await assert.rejects(new UndoService(gone.backend, new Memory(), () => now).save('repo', '/work/repo', push), UndoUnavailable); assert.equal(gone.refs.size, 0);
  const here = fakeBackend(), kept = await new UndoService(here.backend, new Memory(), () => now).save('repo', '/work/repo', push);
  assert.equal(here.refs.get(kept.id), oid('d'), 'the old tip is what is kept'); assert.equal(await new UndoService(here.backend, new Memory()).holds('/work/repo', oid('d')), true); assert.equal(await new UndoService(gone.backend, new Memory()).holds('/work/repo', oid('d')), false);
  // The label is bounded, and two copies in one millisecond get two names.
  const twice = new UndoService(fakeBackend().backend, new Memory(), () => now), first = await twice.save('repo', '/r', { ...discard, label: 'x'.repeat(500) }), second = await twice.save('repo', '/r', discard);
  assert.equal(first.label.length, 300); assert.equal(first.id, '1760000000000-discard'); assert.equal(second.id, '1760000000000-discard-1'); assert.equal(twice.list('repo').length, 2);
});

test('at most twenty copies are kept for thirty days; the rest are let go with their refs, and saves made together are all recorded', async () => {
  const f = fakeBackend(), state = new Memory(); let now = 1_760_000_000_000;
  const service = new UndoService(f.backend, state, () => now);
  for (let n = 0; n < 25; n++) { now += 1000; await service.save('repo', '/r', discard); }
  assert.equal(service.list('repo').length, undoLimit); assert.equal(f.refs.size, undoLimit, 'the five oldest refs are gone');
  assert.equal(service.list('repo')[0]!.time, now); assert.equal(service.list('repo').at(-1)!.time, 1_760_000_000_000 + 6000);
  // Past thirty days a copy no longer shows, and the next save lets it go.
  now += undoMaxAge - 15_000; assert.equal(service.list('repo').length, undoLimit - 4, 'the four oldest have passed their age');
  const before = f.refs.size; await service.save('repo', '/r', discard); assert.ok(f.refs.size < before, 'old refs were dropped by the save');
  assert.ok(service.list('repo').every(entry => entry.time >= now - undoMaxAge));
  // Saves started together are each recorded, not the last one only.
  const together = new UndoService(fakeBackend().backend, new Memory(), () => now);
  await Promise.all([1, 2, 3, 4, 5].map(() => together.save('repo', '/r', discard))); assert.equal(together.list('repo').length, 5); assert.equal(new Set(together.list('repo').map(entry => entry.id)).size, 5);
  // Removing one lets go of its record and its ref.
  const [one] = together.list('repo'); await together.remove('repo', '/r', one!.id); assert.equal(together.list('repo').length, 4); assert.equal(together.find('repo', one!.id), undefined);
  // A failing backend never keeps a copy from being forgotten.
  const failing = fakeBackend(); const unlucky = new UndoService({ ...failing.backend, drop: async () => { throw new Error('locked'); } }, new Memory(), () => now);
  const kept = await unlucky.save('repo', '/r', discard); await unlucky.remove('repo', '/r', kept.id); assert.equal(unlucky.list('repo').length, 0);
});

test('how long ago a copy was made is said in the largest unit that fits', () => {
  const now = 1_760_000_000_000, ago = (milliseconds: number) => describeAge(now - milliseconds, now);
  assert.equal(ago(0), 'just now'); assert.equal(ago(59_000), 'just now'); assert.equal(ago(60_000), '1 minute ago'); assert.equal(ago(5 * 60_000), '5 minutes ago');
  assert.equal(ago(60 * 60_000), '1 hour ago'); assert.equal(ago(23 * 60 * 60_000), '23 hours ago'); assert.equal(ago(24 * 60 * 60_000), '1 day ago'); assert.equal(ago(10 * 24 * 60 * 60_000), '10 days ago');
  assert.equal(describeAge(now + 5000, now), 'just now', 'a clock that moved back is not a negative age');
});

// ---- The commands, against a stand-in vscode ----

type Quick = { label: string; description: string; detail: string; entry: UndoEntry };
function commandsHarness(initial: UndoEntry[] = []) {
  const f = fakeBackend(), state = new Memory(), now = 1_760_000_100_000;
  const service = new UndoService(f.backend, state, () => now);
  const infos: string[] = [], warnings: { text: string; detail: string; button: string }[] = [], picks: { items: Quick[]; title: string }[] = [], bar: string[] = [], calls: unknown[][] = [];
  const control = { pick: ((items: Quick[]) => items[0]) as (items: Quick[]) => Quick | undefined, confirm: 'Restore' as string | undefined, review: true, applyError: undefined as Error | undefined, restore: true, held: true };
  const status = { changes: [{ path: 'a.ts', group: 'working' }, { path: 'c.ts', group: 'staged' }] };
  const vscode = { ProgressLocation: { Window: 10 }, window: {
    showInformationMessage: async (text: string) => { infos.push(text); return undefined; },
    showWarningMessage: async (text: string, options: { detail: string }, button: string) => { warnings.push({ text, detail: options.detail, button }); return control.confirm; },
    showQuickPick: async (items: Quick[], options: { title: string }) => { picks.push({ items, title: options.title }); return control.pick(items); },
    withProgress: (_options: unknown, run: () => Promise<unknown>) => run(), setStatusBarMessage: (text: string) => { bar.push(text); } } };
  const source = path.resolve(__dirname, '../../src/commands/undo.commands.js'), load = createRequire(source), exports: Record<string, unknown> = {};
  runInNewContext(readFileSync(source, 'utf8'), { exports, require: (name: string) => name === 'vscode' ? vscode : load(name) });
  const repo = { id: 'repo', root: '/work/repo' };
  const git = { repository: () => repo, state: async () => status, preview: async (id: string, paths: string[]) => ({ repositoryId: id, paths }),
    restoreFromSource: async (preview: unknown, snapshot: string) => { calls.push(['restore', preview, snapshot]); }, applySafetyCopy: async (id: string, snapshot: string) => { if (control.applyError) throw control.applyError; calls.push(['apply', id, snapshot]); } };
  const advanced = { review: async (...args: unknown[]) => { calls.push(['review', ...args]); return control.review; }, restorePush: async (...args: unknown[]) => { calls.push(['restorePush', ...args]); return control.restore; } };
  const deps = { registry: { active: repo as typeof repo | undefined, list: () => [repo] }, git, undo: Object.assign(service, { holds: async () => control.held }) };
  const Constructor = exports.UndoCommands as new (...args: unknown[]) => { undo(argument: unknown): Promise<void> };
  const commands = new Constructor(deps, advanced, () => now);
  return { commands, service, state, f, infos, warnings, picks, bar, calls, control, deps, status, seed: async () => { for (const entry of initial) state.values.set('gitPro.undo:repo', [entry, ...(state.values.get('gitPro.undo:repo') as UndoEntry[] ?? [])]); } };
}
const discardEntry: UndoEntry = { id: '1760000000000-discard', kind: 'discard', time: 1_760_000_000_000, label: 'Discarded 2 files', snapshot: oid('a'), paths: ['a.ts', 'b.ts'] };
const resetEntry: UndoEntry = { id: '1760000050000-reset', kind: 'reset', time: 1_760_000_050_000, label: 'Hard reset of main from abc', head: oid('b'), snapshot: oid('c'), branch: 'main' };
const pushEntry: UndoEntry = { id: '1760000090000-push', kind: 'push', time: 1_760_000_090_000, label: 'Force pushed main to origin', remote: 'origin', url: 'https://example.test/o/r.git', branch: 'main', oldTip: oid('d'), newTip: oid('e') };

test('Undo… lists the copies newest first, and says when there are none', async () => {
  const empty = commandsHarness(); await empty.commands.undo(undefined);
  assert.match(empty.infos[0]!, /Nothing to undo/); assert.equal(empty.picks.length, 0);
  const h = commandsHarness([discardEntry, resetEntry, pushEntry]); await h.seed();
  h.control.pick = () => undefined; await h.commands.undo(undefined);
  assert.equal(h.picks[0]!.title, 'Git Pro: Undo…');
  assert.deepEqual(plain(h.picks[0]!.items.map(item => [item.label, item.description, item.detail])), [
    ['Force pushed main to origin', 'just now', 'origin/main was ' + oid('d').slice(0, 10) + ', now ' + oid('e').slice(0, 10)],
    ['Hard reset of main from abc', 'just now', `HEAD was ${oid('b').slice(0, 10)} · uncommitted changes saved`],
    ['Discarded 2 files', '1 minute ago', 'a.ts, b.ts']]);
  assert.deepEqual(h.calls, [], 'cancelling the list restores nothing');
});

test('restoring a discard names what changed since, restores only the saved paths from the copy, and lets the copy go', async () => {
  const h = commandsHarness([discardEntry]); await h.seed();
  h.control.pick = items => items[0];
  await h.commands.undo(undefined);
  assert.match(h.warnings[0]!.text, /^Restore 2 files as they were/); assert.match(h.warnings[0]!.detail, /\/work\/repo\na\.ts\nb\.ts/);
  assert.match(h.warnings[0]!.detail, /These have changed since and will be replaced:\na\.ts/, 'a.ts has unstaged edits again, b.ts and the staged c.ts do not');
  assert.doesNotMatch(h.warnings[0]!.detail, /replaced:[\s\S]*b\.ts/);
  assert.deepEqual(plain(h.calls), [['restore', { repositoryId: 'repo', paths: ['a.ts', 'b.ts'] }, oid('a')]]);
  assert.deepEqual(h.service.list('repo'), [], 'the copy is let go once it is restored'); assert.match(h.bar[0]!, /restored 2 files/);
  // Declining restores nothing and keeps the copy; a copy Git no longer has is said.
  const declined = commandsHarness([discardEntry]); await declined.seed(); declined.control.confirm = undefined; await declined.commands.undo(undefined);
  assert.deepEqual(declined.calls, []); assert.equal(declined.service.list('repo').length, 1);
  const lost = commandsHarness([discardEntry]); await lost.seed(); lost.control.held = false; await assert.rejects(lost.commands.undo(undefined), /no longer has the saved copy/); assert.equal(lost.warnings.length, 0);
});

test('restoring a hard reset goes through the reviewed reset, then applies the saved changes; a failure keeps the copy and says how to apply it', async () => {
  const h = commandsHarness([resetEntry]); await h.seed();
  await h.commands.undo(undefined);
  assert.deepEqual(plain(h.calls[0]), ['review', 'repo', { kind: 'reset', oid: oid('b'), mode: 'hard' }, 'Reset', { note: 'Undo: Hard reset of main from abc. The changes to tracked files that were saved before it are applied again afterwards.', quiet: true }]);
  assert.deepEqual(plain(h.calls[1]), ['apply', 'repo', oid('c')]); assert.deepEqual(h.service.list('repo'), []); assert.match(h.bar[0]!, /HEAD is back at/);
  // The reset was not confirmed: nothing is applied and the copy stays.
  const cancelled = commandsHarness([resetEntry]); await cancelled.seed(); cancelled.control.review = false; await cancelled.commands.undo(undefined);
  assert.equal(cancelled.calls.length, 1); assert.equal(cancelled.service.list('repo').length, 1);
  // The changes cannot be applied: HEAD is back, the copy stays, and the error carries the command that applies it.
  const failed = commandsHarness([resetEntry]); await failed.seed(); failed.control.applyError = new Error('would be overwritten');
  await assert.rejects(failed.commands.undo(undefined), new RegExp(`HEAD is back at ${oid('b').slice(0, 10)}.*git stash apply ${oid('c')}`)); assert.equal(failed.service.list('repo').length, 1);
  // Nothing was saved with it: only HEAD moves.
  const headOnly = commandsHarness([{ ...resetEntry, snapshot: undefined } as unknown as UndoEntry]); await headOnly.seed(); await headOnly.commands.undo(undefined);
  assert.deepEqual(headOnly.calls.map(call => call[0]), ['review']); assert.doesNotMatch(String((headOnly.calls[0]![4] as { note: string }).note), /applied again/);
});

test('restoring a force push is the reviewed lease push, and a toast or message names its copy exactly', async () => {
  const h = commandsHarness([pushEntry]); await h.seed();
  await h.commands.undo(undefined); assert.deepEqual(plain(h.calls), [['restorePush', 'repo', plain(pushEntry)]]); assert.deepEqual(h.service.list('repo'), []); assert.match(h.bar[0]!, /main on origin is back at/);
  const declined = commandsHarness([pushEntry]); await declined.seed(); declined.control.restore = false; await declined.commands.undo(undefined); assert.equal(declined.service.list('repo').length, 1);
  // A request from a toast names the repository and the copy, and skips the list.
  const named = commandsHarness([discardEntry, resetEntry]); await named.seed();
  named.control.pick = () => { throw new Error('the list must not open'); };
  await named.commands.undo({ repositoryId: 'repo', id: resetEntry.id }); assert.equal(named.calls[0]![0], 'review');
  await assert.rejects(named.commands.undo({ repositoryId: 'repo', id: '1760000000999-reset' }), /no longer keeps that copy/);
  await assert.rejects(named.commands.undo({ repositoryId: 'elsewhere', id: resetEntry.id }), /no longer open/);
  // Anything else is not a request: the list opens for the active repository.
  const lists = commandsHarness([discardEntry]); await lists.seed(); lists.control.pick = () => undefined;
  for (const argument of [undefined, 'text', 5, {}, { repositoryId: 5, id: 'x' }, { repositoryId: 'repo' }]) await lists.commands.undo(argument);
  assert.equal(lists.picks.length, 6);
  const none = commandsHarness([discardEntry]); await none.seed(); none.deps.registry.active = undefined; await assert.rejects(none.commands.undo(undefined), /Select a repository first/);
});

// ---- The actions that throw something away keep a copy first ----

/** DailyCommands over stand-ins: what Discard does about a copy. */
function discardHarness(options: { save?: 'ok' | 'fail'; confirm?: string | undefined } = {}) {
  const commands = new Map<string, (...args: unknown[]) => Promise<void>>(), order: string[] = [], bar: string[] = [], errors: string[] = [];
  const saved: unknown[] = [];
  const status = { head: 'main', upstream: 'origin/main', changes: [{ path: 'a.ts', group: 'working', status: 'M' }, { path: 'b.ts', group: 'working', status: 'M' }], omitted: [] };
  const git = {
    registry: { active: { id: 'owned' }, list: () => [{ id: 'owned', root: '/owned' }], store: { get: () => status } }, repository: () => ({ root: '/owned' }), state: async () => status,
    discardable: async (_id: string, paths: string[]) => ({ targets: paths, skipped: [] }), preview: async () => ({ repositoryId: 'owned', paths: ['a.ts', 'b.ts'] }),
    discard: async () => { order.push('discard'); } };
  const undo = { save: async (...args: unknown[]) => { order.push('save'); saved.push(args); if (options.save === 'fail') throw new Error('Git has no copy of the changes to keep.'); return { id: '1760000000000-discard', label: String((args[2] as { label: string }).label) }; } };
  const vscode = { Uri: class { static file(fsPath: string) { return { fsPath }; } }, ProgressLocation: { Window: 10, Notification: 15 },
    workspace: { getConfiguration: () => ({ get: () => undefined }) },
    commands: { registerCommand: (id: string, fn: (...args: unknown[]) => Promise<void>) => { commands.set(id, fn); return { dispose: () => commands.delete(id) }; }, executeCommand: async () => undefined },
    window: { withProgress: (_options: unknown, run: () => Promise<void>) => run(), showErrorMessage: async (text: string) => { errors.push(text); }, setStatusBarMessage: (text: string) => { bar.push(text); },
      showWarningMessage: async (_text: string, _options: unknown, button: string) => { order.push('confirm'); return 'confirm' in options ? options.confirm : button; }, showInformationMessage: async () => undefined, activeTextEditor: undefined } };
  const source = path.resolve(__dirname, '../../src/commands/daily.commands.js'), load = createRequire(source), exports: Record<string, unknown> = {};
  runInNewContext(readFileSync(source, 'utf8'), { exports, require: (name: string) => name === 'vscode' ? vscode : name === '../git/git.service' ? { DailyError: class extends Error {} } : name === '../git/diff/diff.service' ? { DiffService: class {} } : load(name) });
  const instance = new (exports.DailyCommands as new (...args: unknown[]) => { dispose(): void })(git, {}, {}, { selection: [] }, { error: () => undefined }, undefined, undo);
  const nodes = ['a.ts', 'b.ts'].map(file => ({ kind: 'file', repositoryId: 'owned', change: { path: file, group: 'working', status: 'M' } }));
  return { order, bar, errors, saved, run: () => commands.get('gitPro.discard')!(nodes[0], nodes), dispose: () => instance.dispose() };
}

test('Discard keeps a copy after the confirmation and before it discards, and does not discard when no copy can be kept', async () => {
  const h = discardHarness();
  try {
    await h.run();
    assert.deepEqual(h.order, ['confirm', 'save', 'discard'], 'the copy is made after the user agreed and before the files change');
    assert.deepEqual(plain(h.saved[0]), ['owned', '/owned', { kind: 'discard', label: 'Discarded 2 files', paths: ['a.ts', 'b.ts'] }]);
    assert.match(h.bar[0]!, /Discarded 2 files\. Run Git Pro: Undo… to bring them back\./);
  } finally { h.dispose(); }
  const cancelled = discardHarness({ confirm: undefined });
  try { await cancelled.run(); assert.deepEqual(cancelled.order, ['confirm'], 'declining keeps no copy and discards nothing'); assert.deepEqual(cancelled.bar, []); } finally { cancelled.dispose(); }
  const failing = discardHarness({ save: 'fail' });
  try {
    await failing.run();
    assert.deepEqual(failing.order, ['confirm', 'save'], 'no copy, no discard'); assert.match(failing.errors[0]!, /could not keep a copy of these changes first, so nothing was discarded/); assert.deepEqual(failing.bar, []);
  } finally { failing.dispose(); }
});

/** AdvancedCommands over stand-ins: a hard reset, a force push, and the restore of a force push. */
function advancedHarness(options: { confirm?: (text: string) => string | undefined; protect?: boolean; holds?: boolean; saveError?: boolean; head?: string | undefined } = {}) {
  const order: string[] = [], warnings: { text: string; detail: string }[] = [], toasts: { text: string; button: string }[] = [], saved: unknown[] = [], executed: unknown[][] = [], pushes: unknown[] = [], previews: unknown[][] = [];
  let toastChoice: string | undefined;
  const snapshot = { operation: 'idle', head: options.head === undefined && 'head' in options ? undefined : options.head ?? oid('1'), status: { head: 'main', changes: [{ group: 'working', path: 'a.ts' }] } };
  const advanced = {
    git: { registry: { active: { id: 'owned' }, store: { get: () => ({ head: 'main' }) } }, repository: () => ({ root: '/owned' }), remotes: async () => [{ name: 'origin' }] },
    preview: async (_id: string, command: unknown) => { order.push('preview'); return { snapshot, files: [], command }; }, execute: async () => { order.push('execute'); }, snapshot: async () => snapshot };
  class LeaseService {
    constructor(readonly owner: unknown) {}
    preview = async (...args: unknown[]) => { previews.push(args.slice(1)); return { snapshot, remote: 'origin', url: 'https://example.test/o/r.git', branch: 'main', source: String(args[3] ?? oid('1')), expected: oid('2') }; };
    push = async (preview: unknown) => { order.push('push'); pushes.push(preview); };
  }
  const undo = { holds: async () => options.holds !== false, save: async (...args: unknown[]) => { order.push('save'); saved.push(args); if (options.saveError) throw new Error('cannot lock ref'); return { id: `1760000000000-${(args[2] as { kind: string }).kind}`, label: String((args[2] as { label: string }).label) }; } };
  const vscode = { ProgressLocation: { Window: 10 }, Uri: { file: (fsPath: string) => ({ fsPath }) }, workspace: { getConfiguration: () => ({ get: () => options.protect ? ['main'] : [] }) },
    commands: { executeCommand: async (...args: unknown[]) => { executed.push(args); } },
    window: { withProgress: (_options: unknown, run: () => Promise<unknown>) => run(), showQuickPick: async (items: { name?: string }[]) => items[0], showInputBox: async () => 'main',
      showWarningMessage: async (text: string, options2: { detail: string }, button: string) => { warnings.push({ text, detail: options2.detail }); order.push('confirm'); return options.confirm ? options.confirm(text) : button; },
      showInformationMessage: async (text: string, button: string) => { toasts.push({ text, button }); return toastChoice; } } };
  const source = path.resolve(__dirname, '../../src/commands/advanced.commands.js'), load = createRequire(source), exports: Record<string, unknown> = {};
  runInNewContext(readFileSync(source, 'utf8'), { exports, require: (name: string) => name === 'vscode' ? vscode : name === './message-editor' ? {} : name === '../git/conflicts/conflicts.service' ? { ConflictsService: class {} } : name === '../git/advanced/lease.service' ? { LeaseService } : name === '../editor/open-files' ? { refuseUnsaved: async () => undefined } : load(name) });
  type Commands = { review(id: string, command: unknown, action: string, options?: unknown): Promise<boolean>; forcePush(): Promise<void>; restorePush(id: string, entry: unknown): Promise<boolean> };
  const instance = new (exports.AdvancedCommands as new (...args: unknown[]) => Commands)(advanced, {}, {}, {}, { path: '/ext' }, undefined, undo);
  return { instance, order, warnings, toasts, saved, executed, pushes, previews, choose: (button: string | undefined) => { toastChoice = button; } };
}
const hardReset = { kind: 'reset', oid: oid('9'), mode: 'hard' };
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('a hard reset keeps HEAD and the tracked changes after the confirmation, offers Undo in a toast, and the other modes keep nothing', async () => {
  const h = advancedHarness(); h.choose('Undo');
  assert.equal(await h.instance.review('owned', hardReset, 'Reset'), true);
  assert.deepEqual(h.order, ['preview', 'confirm', 'save', 'execute'], 'kept after the user agreed, before HEAD moves');
  assert.deepEqual(plain(h.saved[0]), ['owned', '/owned', { kind: 'reset', label: `Hard reset of main from ${oid('1').slice(0, 10)}`, head: oid('1'), branch: 'main' }]);
  await settle(); assert.deepEqual(plain(h.toasts), [{ text: `Hard reset of main from ${oid('1').slice(0, 10)}.`, button: 'Undo' }]);
  assert.deepEqual(plain(h.executed), [['gitPro.undo', { repositoryId: 'owned', id: '1760000000000-reset' }]], 'the Undo button asks for exactly that copy');
  // A copy that cannot be made does not stop a reset the user confirmed; a quiet review (an undo) shows no toast; a cancelled one does nothing.
  const unprotected = advancedHarness({ saveError: true }); assert.equal(await unprotected.instance.review('owned', hardReset, 'Reset'), true); await settle(); assert.deepEqual(unprotected.order, ['preview', 'confirm', 'save', 'execute']); assert.deepEqual(unprotected.toasts, []);
  const quiet = advancedHarness(); await quiet.instance.review('owned', hardReset, 'Reset', { quiet: true, note: 'Undo: something' }); await settle();
  assert.deepEqual(quiet.toasts, []); assert.equal(quiet.saved.length, 1, 'an undo keeps a copy too'); assert.match(quiet.warnings[0]!.detail, /\nUndo: something$/);
  const cancelled = advancedHarness({ confirm: () => undefined }); assert.equal(await cancelled.instance.review('owned', hardReset, 'Reset'), false); assert.deepEqual(cancelled.order, ['preview', 'confirm']);
  for (const command of [{ kind: 'reset', oid: oid('9'), mode: 'soft' }, { kind: 'reset', oid: oid('9'), mode: 'mixed' }, { kind: 'reset', oid: oid('9'), mode: 'keep' }, { kind: 'revert', oids: [oid('9')] }]) {
    const other = advancedHarness(); await other.instance.review('owned', command, 'Reset'); assert.deepEqual(other.saved, [], JSON.stringify(command));
  }
  const unborn = advancedHarness({ head: undefined }); await unborn.instance.review('owned', hardReset, 'Reset'); assert.deepEqual(unborn.saved, [], 'no HEAD, nothing to keep');
});

test('a force push keeps the remote branch\'s current commit when this repository has it, and says so in the review; the lease push is the same either way', async () => {
  const h = advancedHarness();
  await h.instance.forcePush();
  assert.deepEqual(h.order, ['confirm', 'save', 'push'], 'the lease review, then the copy, then the push');
  assert.match(h.warnings[0]!.detail, /Git Pro keeps the remote branch's current commit, so Undo… can put it back\.$/);
  assert.deepEqual(plain(h.saved[0]), ['owned', '/owned', { kind: 'push', label: 'Force pushed main to origin', remote: 'origin', url: 'https://example.test/o/r.git', branch: 'main', oldTip: oid('2'), newTip: oid('1') }]);
  await settle(); assert.equal(h.toasts[0]!.text, 'Force pushed main to origin.');
  const absent = advancedHarness({ holds: false }); await absent.instance.forcePush();
  assert.deepEqual(absent.order, ['confirm', 'push'], 'no copy of what is not here, and the push still goes on'); assert.match(absent.warnings[0]!.detail, /That commit is not in this repository, so Undo… cannot put it back\.$/);
  const broken = advancedHarness({ saveError: true }); await broken.instance.forcePush(); assert.deepEqual(broken.order, ['confirm', 'save', 'push']);
  const declined = advancedHarness({ confirm: () => undefined }); await declined.instance.forcePush(); assert.deepEqual(declined.order, ['confirm']); assert.deepEqual(declined.saved, []);
});

test('undoing a force push is the lease review with the old commit as the replacement, and refuses a remote whose address changed', async () => {
  const entry = { id: '1760000000000-push', kind: 'push', time: 1_760_000_000_000, label: 'Force pushed main to origin', remote: 'origin', url: 'https://example.test/o/r.git', branch: 'main', oldTip: oid('d'), newTip: oid('2') };
  const h = advancedHarness();
  assert.equal(await h.instance.restorePush('owned', entry), true);
  assert.deepEqual(plain(h.previews), [['origin', 'main', oid('d')]]); assert.deepEqual(h.order, ['confirm', 'push']);
  assert.equal(h.warnings[0]!.text, `Put main on origin back to ${oid('d').slice(0, 10)}?`); assert.match(h.warnings[0]!.detail, new RegExp(`Expected remote: ${oid('2')}\\nReplacement: ${oid('d')}\\nThe push will fail`));
  // The remote has moved since the force push: the review says what putting the old commit back replaces.
  const moved = advancedHarness(); await moved.instance.restorePush('owned', { ...entry, newTip: oid('3') });
  assert.match(moved.warnings[0]!.detail, new RegExp(`The remote branch has changed since your force push \\(Git Pro pushed ${oid('3')}\\)`));
  const declined = advancedHarness({ confirm: () => undefined }); assert.equal(await declined.instance.restorePush('owned', entry), false); assert.deepEqual(declined.pushes, []);
  const changed = advancedHarness(); await assert.rejects(changed.instance.restorePush('owned', { ...entry, url: 'https://elsewhere.test/o/r.git' }), /address of this remote has changed/); assert.deepEqual(changed.order, []);
  // A protected branch asks first, as for any rewrite of its history.
  const guarded = advancedHarness({ protect: true, confirm: text => text.startsWith('Rewrite') ? undefined : 'Push with lease' }); assert.equal(await guarded.instance.restorePush('owned', entry), false); assert.deepEqual(guarded.pushes, []);
});
