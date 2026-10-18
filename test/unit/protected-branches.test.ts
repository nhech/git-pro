import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { isProtectedBranch, protectedBranchPatterns } from '../../src/security/protected-branches';

test('protected branch patterns are globs over a branch name, and anything that is not text is ignored', () => {
  const patterns = ['main', 'release/*', 'hotfix/**', 'v?.x'];
  for (const branch of ['main', 'release/1.1', 'hotfix/a', 'hotfix/a/b', 'v1.x', 'refs/heads/main']) assert.ok(isProtectedBranch(branch, patterns), branch);
  for (const branch of ['main2', 'domain', 'release/1/2', 'release', 'v10.x', 'feature/main', undefined, '', '(detached)']) assert.ok(!isProtectedBranch(branch, patterns), String(branch));
  // The characters of a branch name that a regular expression would treat as syntax are text.
  assert.ok(isProtectedBranch('a+b(c)', ['a+b(c)'])); assert.ok(!isProtectedBranch('aab', ['a+b'])); assert.ok(!isProtectedBranch('main', ['ma.n']));
  assert.deepEqual(protectedBranchPatterns([' main ', '', 5, null, 'refs/heads/dev', 'x'.repeat(201), { a: 1 }]), ['main', 'dev']);
  assert.deepEqual(protectedBranchPatterns('main'), []); assert.deepEqual(protectedBranchPatterns(undefined), []);
  assert.equal(protectedBranchPatterns(Array.from({ length: 150 }, (_, index) => `b${index}`)).length, 100, 'at most 100 patterns');
  assert.ok(!isProtectedBranch('main', []) && !isProtectedBranch('main', undefined), 'nothing is protected by default');
});

/** The compiled DailyCommands over stand-ins: what a commit or a push on a branch does when it is, or is not, protected. */
function harness(options: { head: string; protectedBranches?: unknown; confirmBeforeCommit?: boolean; confirmBeforePush?: boolean; answer?: string | undefined }) {
  const commands = new Map<string, (...args: unknown[]) => Promise<void>>(), modals: { type: string; message: string; detail?: string }[] = [], calls: string[] = [];
  const settings: Record<string, unknown> = { protectedBranches: options.protectedBranches ?? [], 'commit.confirmBeforeCommit': options.confirmBeforeCommit ?? false, confirmBeforePush: options.confirmBeforePush ?? false };
  const status = { head: options.head, upstream: 'origin/main', changes: [{ path: 'a.ts', group: 'staged', status: 'M' }, { path: 'b.ts', group: 'staged', status: 'A' }, { path: 'c.ts', group: 'working', status: 'M' }], omitted: [] };
  const preview = { head: 'abc', status }, git = {
    registry: { active: { id: 'owned' }, list: () => [{ id: 'owned', root: '/owned' }], store: { get: () => status } }, repository: () => ({ root: '/owned' }),
    preview: async () => preview, commit: async () => { calls.push('commit'); return { oid: 'abcdef1234567', pushed: false }; }, push: async () => { calls.push('push'); } };
  // Only the modal questions are recorded: the toast that says a commit was created is not one.
  const ask = (type: string) => async (message: string, ...rest: unknown[]) => { const given = rest[0] as { modal?: boolean; detail?: string } | undefined; if (given?.modal) modals.push({ type, message, ...(given.detail === undefined ? {} : { detail: given.detail }) }); return 'answer' in options && given?.modal ? options.answer : rest.find(item => typeof item === 'string'); };
  const vscode = { Uri: class { static file(fsPath: string) { return { fsPath }; } }, ProgressLocation: { Window: 10, Notification: 15 },
    workspace: { getConfiguration: () => ({ get: (key: string, fallback?: unknown) => settings[key] ?? fallback }) },
    commands: { registerCommand: (id: string, fn: (...args: unknown[]) => Promise<void>) => { commands.set(id, fn); return { dispose: () => commands.delete(id) }; }, executeCommand: async () => undefined },
    window: { withProgress: (_options: unknown, run: () => Promise<void>) => run(), showErrorMessage: async () => undefined, showWarningMessage: ask('warning'), showInformationMessage: ask('information'), activeTextEditor: undefined } };
  const source = path.resolve(__dirname, '../../src/commands/daily.commands.js'), load = createRequire(source), exports: Record<string, unknown> = {};
  runInNewContext(readFileSync(source, 'utf8'), { exports, require: (name: string) => name === 'vscode' ? vscode : name === '../git/git.service' ? { DailyError: class extends Error {} } : name === '../git/diff/diff.service' ? { DiffService: class {} } : load(name) });
  const instance = new (exports.DailyCommands as new (...args: unknown[]) => { dispose(): void; commit(id: string, message: string, options: unknown, push: boolean): Promise<boolean> })(git, {}, {}, { selection: [] }, { error: () => undefined });
  return { instance, modals, calls, push: () => commands.get('gitPro.push')!(), dispose: () => instance.dispose() };
}
const request = { amend: false, signoff: false, noVerify: false };

test('a commit on a protected branch asks once, in its own words; others keep the plain setting', async () => {
  const guarded = harness({ head: 'main', protectedBranches: ['main'], confirmBeforeCommit: true });
  try {
    assert.equal(await guarded.instance.commit('owned', 'message', request, false), true);
    assert.equal(guarded.modals.length, 1, 'one question, not the plain confirmation as well'); assert.equal(guarded.modals[0]!.type, 'warning');
    assert.match(guarded.modals[0]!.message, /Commit 2 staged files on protected branch main\?/); assert.match(guarded.modals[0]!.detail!, /gitPro\.protectedBranches/); assert.deepEqual(guarded.calls, ['commit']);
    await guarded.instance.commit('owned', 'message', request, true); assert.match(guarded.modals.at(-1)!.message, /and push on protected branch main/);
  } finally { guarded.dispose(); }
  const refused = harness({ head: 'release/1.1', protectedBranches: ['release/*'], answer: undefined });
  try { assert.equal(await refused.instance.commit('owned', 'message', request, false), false); assert.deepEqual(refused.calls, [], 'a refused question commits nothing'); } finally { refused.dispose(); }
  const plain = harness({ head: 'feature', protectedBranches: ['main'] });
  try { assert.equal(await plain.instance.commit('owned', 'message', request, false), true); assert.equal(plain.modals.length, 0, 'an unprotected branch is not asked'); } finally { plain.dispose(); }
  const confirmed = harness({ head: 'feature', protectedBranches: ['main'], confirmBeforeCommit: true });
  try { await confirmed.instance.commit('owned', 'message', request, false); assert.deepEqual(confirmed.modals.map(item => [item.type, item.message]), [['information', 'Commit 2 staged files?']], 'the plain setting still works'); } finally { confirmed.dispose(); }
});

test('a push of a protected branch asks first, and a refusal pushes nothing', async () => {
  const guarded = harness({ head: 'main', protectedBranches: ['main'] });
  try { await guarded.push(); assert.deepEqual(guarded.modals.map(item => [item.type, item.message]), [['warning', 'Push protected branch main?']]); assert.deepEqual(guarded.calls, ['push']); } finally { guarded.dispose(); }
  const refused = harness({ head: 'main', protectedBranches: ['main'], answer: undefined });
  try { await refused.push(); assert.deepEqual(refused.calls, []); } finally { refused.dispose(); }
  const plain = harness({ head: 'feature', protectedBranches: ['main'] });
  try { await plain.push(); assert.equal(plain.modals.length, 0); assert.deepEqual(plain.calls, ['push']); } finally { plain.dispose(); }
});
