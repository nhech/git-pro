import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import type { BranchInfo } from '../../src/git/git.service';
import type { ChangedFile } from '../../src/git/history/history-parser';
import { loadWithVscode } from './compare-loader';

type Exports = Record<string, unknown>;
/** Runs a compiled command module against a stand-in `vscode`; every other import is the real compiled module unless stubbed. */
function load(file: string, vscode: unknown, stubs: Record<string, unknown> = {}): Exports {
  const source = path.resolve(__dirname, '../../src/commands', file), requireFrom = createRequire(source), exports: Exports = {};
  runInNewContext(readFileSync(source, 'utf8'), { exports, process, require: (name: string) => name === 'vscode' ? vscode : name in stubs ? stubs[name] : requireFrom(name) });
  return exports;
}
const oid = (digit: string) => digit.repeat(40);
/** Values built inside the vm context carry its prototypes; compare their data. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const branch = (name: string, remote = false, value = oid('a')): BranchInfo => ({ name, remote, ref: `refs/${remote ? 'remotes' : 'heads'}/${name}`, oid: value, upstream: '', worktree: '' });
const node = (info: BranchInfo, repositoryId = 'owned') => ({ kind: 'branch', repositoryId, branch: info });
class Uri { constructor(readonly scheme: string, readonly fsPath: string) {} static file(file: string) { return new Uri('file', file); } }
class ThemeIcon { constructor(readonly id: string, readonly color?: { id: string }) {} }
class ThemeColor { constructor(readonly id: string) {} }
type Pick = { label: string; description?: string; iconPath?: ThemeIcon; choice?: { ref: string; name: string } };

function compareHarness(head = 'main') {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'git-pro-compare-commands-')));
  writeFileSync(path.join(root, 'app.ts'), 'working\n'); mkdirSync(path.join(root, 'src'));
  const repo = { id: 'owned', root }, store = { head, changes: [] as { group: string; path: string }[] };
  const picks: { items: Pick[]; title: string }[] = [], warnings: { text: string; detail: string; choices: string[] }[] = [], infos: string[] = [], executed: unknown[][] = [], previews: unknown[] = [], executions: unknown[] = [];
  const state = { pick: ((): Pick | undefined => undefined) as (items: Pick[]) => Pick | undefined, confirm: undefined as string | undefined, resolved: new Map<string, string>(), trees: new Map<string, string>(), activeEditor: undefined as { document: { uri: Uri } } | undefined };
  const vscode = { Uri, ThemeIcon, ThemeColor, ProgressLocation: { Window: 10 },
    window: { get activeTextEditor() { return state.activeEditor; },
      showQuickPick: async (items: Pick[], options: { title: string }) => { picks.push({ items, title: options.title }); return state.pick(items); },
      showWarningMessage: async (text: string, options: { detail: string }, ...choices: string[]) => { warnings.push({ text, detail: options.detail, choices }); return state.confirm; },
      showInformationMessage: async (text: string) => { infos.push(text); return undefined; }, withProgress: (_options: unknown, run: () => Promise<unknown>) => run() },
    commands: { executeCommand: async (...args: unknown[]) => { executed.push(args); } } };
  const registry = { active: repo as typeof repo | undefined, list: () => [repo], store: { get: (id: string) => id === repo.id ? store : undefined },
    resolveFile: async (file: string) => file.startsWith(root) ? repo : undefined };
  const preview = { snapshot: { repositoryId: repo.id, head: oid('c'), status: { head, changes: [] } }, files: [{ path: 'src/a.ts', status: 'M' }], mergeContext: { headOnly: 1, targetOnly: 2 } };
  const deps = { registry, policy: { authorizeFile: async (base: string, relative: string) => path.join(base, relative) },
    executor: { read: async (_root: string, command: { kind: string; path: string }) => ({ stdout: Buffer.from(state.trees.get(command.path) ?? '') }) },
    git: { repository: () => repo, branchSearchSnapshot: async () => [branch('main'), branch('feature'), branch('origin/main', true)] },
    tools: { tags: async () => [{ name: 'v1.0', oid: oid('9'), target: oid('8'), annotated: true }] },
    advanced: { resolve: async (_id: string, ref: string) => { const value = state.resolved.get(ref); if (!value) throw new Error(`unresolved ${ref}`); return value; },
      preview: async (_id: string, command: unknown) => { previews.push(command); return preview; }, execute: async (value: unknown) => { executions.push(value); } },
    history: { revision: async (_id: string, at: string, file: string) => Buffer.from(`${file}@${at}`) },
    revisions: { add: (content: Buffer, label: string) => ({ snapshot: content.toString(), label }) },
    surfaces: { conflictSources: new Map() } as { conflictSources: Map<string, unknown>; compare?: unknown } };
  const surface = { refs: [] as string[][], worktrees: [] as string[][], disposed: 0, getFromBranch: undefined as ((request: unknown) => Promise<boolean>) | undefined,
    openRefs: async (...args: string[]) => { surface.refs.push(args); }, openWorktree: async (...args: string[]) => { surface.worktrees.push(args); }, dispose: () => { surface.disposed++; } };
  const restores: unknown[][] = [];
  const module = load('compare.commands.js', vscode, { '../webviews/compare/compare-panel': { createCompareSurface: (_context: unknown, given: unknown) => { assert.equal(given, deps); return surface; } },
    './get-from-branch': { getFromBranch: async (...args: unknown[]) => { restores.push(args); return true; } } });
  const commands = new Map<string, (...args: unknown[]) => Promise<unknown>>(), context = { subscriptions: [] as { dispose(): void }[] };
  (module.registerCompare as (...args: unknown[]) => void)(context, deps, (id: string, action: (...args: unknown[]) => Promise<unknown>) => { commands.set(id, action); });
  const run = (id: string, ...args: unknown[]) => commands.get(id)!(...args);
  return { root, repo, store, registry, deps, surface, context, commands, run, picks, warnings, infos, executed, previews, executions, preview, state, restores, module, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('registerCompare publishes the Compare tab through the trusted wrapper and withdraws it on disposal', () => {
  const h = compareHarness();
  try {
    assert.deepEqual([...h.commands.keys()].sort(), ['gitPro.compareBranches', 'gitPro.compareWithBranch', 'gitPro.compareWithCurrent', 'gitPro.compareWithRef', 'gitPro.diffWithWorkingTree', 'gitPro.mergeIntoCurrent', 'gitPro.rebaseCurrentOnto']);
    assert.equal(h.deps.surfaces.compare, h.surface);
    for (const disposable of h.context.subscriptions) disposable.dispose();
    assert.equal(h.surface.disposed, 1); assert.equal(h.deps.surfaces.compare, undefined);
  } finally { h.cleanup(); }
});

test('the Compare tab hands Get from Branch rows over with the pinned OID and a display name, and a changed repository root is refused', async () => {
  const h = compareHarness();
  try {
    const files = [{ status: 'R100', originalPath: 'old.txt', path: 'new.txt' }];
    assert.equal(await h.surface.getFromBranch!({ repositoryId: 'owned', root: h.root, ref: { name: 'refs/remotes/origin/feature', oid: oid('b') }, files }), true);
    assert.equal(h.restores.length, 1); assert.equal(h.restores[0]![0], h.deps);
    assert.deepEqual(plain(h.restores[0]![1]), { repositoryId: 'owned', oid: oid('b'), name: 'origin/feature', files });
    await assert.rejects(h.surface.getFromBranch!({ repositoryId: 'owned', root: path.join(h.root, 'moved'), ref: { name: 'HEAD', oid: oid('b') }, files }), /Repository changed/);
    assert.equal(h.restores.length, 1);
    const label = h.module.refLabel as (ref: string) => string;
    assert.deepEqual(['refs/heads/a/b', 'refs/tags/v1', 'HEAD', oid('c')].map(label), ['a/b', 'v1', 'HEAD', oid('c').slice(0, 8)]);
  } finally { h.cleanup(); }
});

test('Compare with Current and Show Diff with Working Tree open the tab with full refs, refuse the current branch and pick from the palette', async () => {
  const h = compareHarness();
  try {
    await h.run('gitPro.compareWithCurrent', node(branch('feature')));
    await h.run('gitPro.compareWithCurrent', node(branch('origin/main', true)));
    assert.deepEqual(h.surface.refs, [['owned', 'refs/heads/feature', 'refs/heads/main'], ['owned', 'refs/remotes/origin/main', 'refs/heads/main']]);
    await assert.rejects(h.run('gitPro.compareWithCurrent', node(branch('main'))), /main is the current branch/);
    await h.run('gitPro.diffWithWorkingTree', node(branch('feature')));
    assert.deepEqual(h.surface.worktrees, [['owned', 'refs/heads/feature']]);
    await assert.rejects(h.run('gitPro.compareWithCurrent', node(branch('feature'), 'closed')), /no longer open/);
    // A node whose ref does not match its name is not trusted; the palette path asks instead.
    h.state.pick = items => items.find(item => item.label === 'v1.0');
    await h.run('gitPro.compareWithCurrent', node({ ...branch('feature'), ref: 'refs/heads/other' }));
    const offered = h.picks.at(-1)!;
    assert.match(offered.title, /Compare with Current \(main\)/);
    assert.deepEqual(plain(offered.items.map(item => [item.label, item.description, item.iconPath?.id])), [['feature', 'Local branch', 'git-branch'], ['origin/main', 'Remote branch', 'cloud'], ['v1.0', 'Tag', 'tag']]);
    assert.deepEqual(h.surface.refs.at(-1), ['owned', 'refs/tags/v1.0', 'refs/heads/main']);
    h.state.pick = () => undefined; const before = h.surface.worktrees.length;
    await h.run('gitPro.diffWithWorkingTree'); assert.equal(h.surface.worktrees.length, before);
    h.store.head = '(detached)'; h.state.pick = items => items[0];
    await h.run('gitPro.compareWithCurrent', node(branch('main')));
    assert.deepEqual(h.surface.refs.at(-1), ['owned', 'refs/heads/main', 'HEAD']);
    h.registry.active = undefined; await assert.rejects(h.run('gitPro.compareWithCurrent'), /Select a repository/);
  } finally { h.cleanup(); }
});

test('Compare Branches needs exactly two branches of one repository and keeps the current one on the right', async () => {
  const h = compareHarness();
  try {
    const main = node(branch('main')), feature = node(branch('feature')), remote = node(branch('origin/main', true));
    await h.run('gitPro.compareBranches', main, [main, feature]);
    await h.run('gitPro.compareBranches', remote, [remote, feature]);
    assert.deepEqual(h.surface.refs, [['owned', 'refs/heads/feature', 'refs/heads/main'], ['owned', 'refs/remotes/origin/main', 'refs/heads/feature']]);
    for (const selected of [[main], [main, feature, remote], [main, { kind: 'group', remote: false }]]) await assert.rejects(h.run('gitPro.compareBranches', main, selected), /exactly two branches/);
    await assert.rejects(h.run('gitPro.compareBranches', main), /exactly two branches/);
    await assert.rejects(h.run('gitPro.compareBranches', main, [main, main]), /two different branches/);
    h.registry.list = () => [h.repo, { ...h.repo, id: 'second' }];
    await assert.rejects(h.run('gitPro.compareBranches', main, [main, node(branch('feature'), 'second')]), /one repository/);
    assert.equal(h.surface.refs.length, 2);
  } finally { h.cleanup(); }
});

test('Compare with Another Branch works from any branch, lists the others with the checked-out one first, and keeps the checked-out branch on the right', async () => {
  const h = compareHarness();
  try {
    const labelsOf = (items: Pick[]) => plain(items.map(item => item.label));
    // A local branch: the choice list leaves out the branch itself and offers the current branch, remote branches and tags.
    h.state.pick = items => items.find(item => item.label === 'origin/main');
    await h.run('gitPro.compareWithBranch', node(branch('feature')));
    assert.deepEqual(labelsOf(h.picks.at(-1)!.items), ['main', 'origin/main', 'v1.0']);
    assert.equal(h.picks.at(-1)!.title, 'Compare feature with…');
    assert.equal(h.picks.at(-1)!.items[0]!.description, 'Current branch');
    // Choosing the checked-out branch puts it on the right.
    h.state.pick = items => items.find(item => item.label === 'main');
    await h.run('gitPro.compareWithBranch', node(branch('feature')));
    // The checked-out branch itself: the other branch goes on the left. A remote branch and a tag work as well.
    h.state.pick = items => items.find(item => item.label === 'feature');
    await h.run('gitPro.compareWithBranch', node(branch('main')));
    assert.deepEqual(labelsOf(h.picks.at(-1)!.items), ['feature', 'origin/main', 'v1.0']);
    h.state.pick = items => items.find(item => item.label === 'main');
    await h.run('gitPro.compareWithBranch', node(branch('origin/main', true)));
    h.state.pick = items => items.find(item => item.label === 'v1.0');
    await h.run('gitPro.compareWithBranch', node(branch('feature')));
    assert.deepEqual(h.surface.refs, [
      ['owned', 'refs/heads/feature', 'refs/remotes/origin/main'], ['owned', 'refs/heads/feature', 'refs/heads/main'], ['owned', 'refs/heads/feature', 'refs/heads/main'],
      ['owned', 'refs/remotes/origin/main', 'refs/heads/main'], ['owned', 'refs/heads/feature', 'refs/tags/v1.0']]);
    // Dismissing the list opens nothing; a branch of a repository that closed is refused.
    h.state.pick = () => undefined; const before = h.surface.refs.length;
    await h.run('gitPro.compareWithBranch', node(branch('feature')));
    assert.equal(h.surface.refs.length, before);
    await assert.rejects(h.run('gitPro.compareWithBranch', node(branch('feature'), 'closed')), /no longer open/);
    // From the palette no branch is given, so both sides are picked, the second list without the first choice.
    const picked: string[] = [];
    h.state.pick = items => { const choice = items.find(item => item.label === (picked.length === 0 ? 'origin/main' : 'main')); picked.push(choice!.label); return choice; };
    await h.run('gitPro.compareWithBranch');
    assert.deepEqual(picked, ['origin/main', 'main']);
    assert.deepEqual(labelsOf(h.picks.at(-1)!.items), ['main', 'feature', 'v1.0']);
    assert.deepEqual(h.surface.refs.at(-1), ['owned', 'refs/remotes/origin/main', 'refs/heads/main']);
    // A node whose ref does not match its name is not trusted: the palette path asks for both sides instead.
    h.surface.refs.length = 0; picked.length = 0;
    await h.run('gitPro.compareWithBranch', node({ ...branch('feature'), ref: 'refs/heads/other' }));
    assert.deepEqual(picked, ['origin/main', 'main']);
  } finally { h.cleanup(); }
});

test('Compare with Branch or Tag shows the ref blob against the editable file, current first, and explains a file missing in the ref', async () => {
  const h = compareHarness();
  try {
    const file = Uri.file(path.join(h.root, 'app.ts'));
    h.state.resolved.set('refs/heads/feature', oid('b')).set('refs/heads/main', oid('c'));
    h.state.trees.set('app.ts', `100644 blob ${oid('d')}\tapp.ts`);
    h.state.pick = items => items.find(item => item.label === 'feature');
    await h.run('gitPro.compareWithRef', file);
    assert.deepEqual(plain(h.picks[0]!.items.map(item => item.description)), ['Current branch', 'Local branch', 'Remote branch', 'Tag']);
    assert.match(h.picks[0]!.title, /Compare app\.ts with Branch or Tag/);
    const diff = h.executed[0]!;
    assert.equal(diff[0], 'vscode.diff'); assert.deepEqual(diff[1], { snapshot: `app.ts@${oid('b')}`, label: 'app.ts' }); assert.equal(diff[2], file);
    assert.equal(diff[3], `app.ts (feature ${oid('b').slice(0, 8)}) ↔ Working Tree`);
    h.state.trees.clear(); await h.run('gitPro.compareWithRef', file);
    assert.deepEqual(h.infos, ['app.ts does not exist in feature.']); assert.equal(h.executed.length, 1);
    h.state.activeEditor = { document: { uri: file } }; h.state.pick = () => undefined; await h.run('gitPro.compareWithRef'); assert.equal(h.picks.length, 3);
    await assert.rejects(h.run('gitPro.compareWithRef', Uri.file(path.join(h.root, 'src'))), /Choose a file/);
    await assert.rejects(h.run('gitPro.compareWithRef', new Uri('git-pro-revision', '/x/app.ts')), /Open a file/);
    await assert.rejects(h.run('gitPro.compareWithRef', Uri.file(path.join(tmpdir(), 'elsewhere.ts'))), /outside an open repository/);
  } finally { h.cleanup(); }
});

test('Merge into Current and Rebase Current onto This pin the branch OID, reuse the Advanced preview and modal detail, and run only after the modal', async () => {
  const h = compareHarness();
  try {
    const feature = node(branch('feature', false, oid('b')));
    h.state.resolved.set('refs/heads/feature', oid('b'));
    await h.run('gitPro.mergeIntoCurrent', feature);
    assert.deepEqual(plain(h.previews), [{ kind: 'merge', oid: oid('b'), strategy: 'ff', source: 'refs/heads/feature' }], 'the OID is pinned and the branch is named so the message reads "Merge branch \'feature\'"');
    const merge = h.warnings[0]!;
    assert.equal(merge.text, 'Merge feature into main?'); assert.deepEqual(merge.choices, ['Merge']);
    assert.match(merge.detail, new RegExp(`^${h.root.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}\\nHEAD: ${oid('c')}\\nTarget: feature \\(${oid('b')}\\)\\n1 changed files between HEAD and target\\nsrc/a\\.ts\\nLocal changes: 0`));
    assert.match(merge.detail, /Topology: 1 HEAD-only \/ 2 target-only commits/);
    assert.deepEqual(h.executions, [], 'Cancelling the modal runs nothing');
    h.state.confirm = 'Rebase'; await h.run('gitPro.rebaseCurrentOnto', feature);
    assert.deepEqual(plain(h.previews.at(-1)), { kind: 'rebase', oid: oid('b') }); assert.equal(h.warnings.at(-1)!.text, 'Rebase main onto feature?');
    assert.deepEqual(h.executions, [h.preview]);
    h.state.resolved.set('refs/heads/feature', oid('e'));
    await assert.rejects(h.run('gitPro.mergeIntoCurrent', feature), /Branch changed/);
    await assert.rejects(h.run('gitPro.mergeIntoCurrent', node(branch('main'))), /current branch/);
    await assert.rejects(h.run('gitPro.rebaseCurrentOnto', { kind: 'group', remote: false }), /Choose a branch/);
    assert.equal(h.previews.length, 2); assert.equal(h.executions.length, 1);
  } finally { h.cleanup(); }
});

function getFromBranchHarness() {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'git-pro-get-from-branch-')));
  for (const file of ['keep.txt', 'new.txt', 'added.txt']) writeFileSync(path.join(root, file), 'local\n');
  mkdirSync(path.join(root, 'module'));
  const repo = { id: 'owned', root }, blob = (file: string) => `100644 blob ${oid('1')}\t${file}`;
  const trees = new Map([['keep.txt', blob('keep.txt')], ['old.txt', blob('old.txt')], ['link', `120000 blob ${oid('2')}\tlink`], ['sub', `160000 commit ${oid('3')}\tsub`], ['dir', `040000 tree ${oid('4')}\tdir`]]);
  const documents: { uri: { scheme: string; fsPath: string }; isDirty: boolean }[] = [], warnings: { text: string; detail: string; choices: string[] }[] = [];
  const state = { confirm: 'Get from Branch' as string | undefined, onModal: undefined as (() => void) | undefined, previewError: undefined as Error | undefined, restoreError: undefined as Error | undefined,
    conflicts: false, changes: [] as { group: string; status: string; path: string; originalPath?: string }[], merging: new Set<string>(), tracked: new Set(['keep.txt', 'new.txt', 'added.txt']), previews: [] as { paths: string[] }[], restores: [] as unknown[][] };
  // Merge editors are tabs whose input has base, input1, input2 and result (TabInputTextMerge, duck-typed).
  const uri = (fsPath: string) => ({ scheme: 'file', fsPath }), tabGroups = { get all() { return [{ tabs: [...state.merging].map(file => ({ input: { base: uri('b'), input1: uri('1'), input2: uri('2'), result: uri(file) } })) }]; } };
  const git = { repository: () => repo, authorizePath: async (_id: string, file: string) => path.join(root, file),
    preview: async (repositoryId: string, paths: readonly string[]) => {
      if (state.previewError) throw state.previewError;
      const preview = { repositoryId, paths: [...paths], status: { changes: state.conflicts ? [{ group: 'conflicts', path: 'x.txt' }] : state.changes } }; state.previews.push(preview); return preview;
    },
    restoreFromSource: async (preview: unknown, at: string) => { if (state.restoreError) throw state.restoreError; state.restores.push([preview, at]); } };
  const vscode = { workspace: { textDocuments: documents }, window: { tabGroups, showWarningMessage: async (text: string, options: { detail: string }, ...choices: string[]) => { warnings.push({ text, detail: options.detail, choices }); state.onModal?.(); return state.confirm; } } };
  const module = load('get-from-branch.js', vscode, { '../editor/open-files': loadWithVscode(path.resolve(__dirname, '../../src/editor/open-files.js'), vscode) });
  const read = async (_root: string, command: { kind: string; path: string; paths: string[] }) => {
    if (command.kind === 'index') return { stdout: Buffer.from(command.paths.filter(file => state.tracked.has(file)).map(file => `100644 ${oid('1')} 0\t${file}\0`).join('')) };
    assert.equal(command.kind, 'tree'); return { stdout: Buffer.from(trees.get(command.path) ?? '') };
  };
  const deps = { git, executor: { read } };
  const run = (files: readonly ChangedFile[], at = oid('b')) => (module.getFromBranch as (...args: unknown[]) => Promise<boolean>)(deps, { repositoryId: 'owned', oid: at, name: 'feature', files });
  return { root, documents, warnings, state, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const rows: ChangedFile[] = [{ status: 'M', path: 'keep.txt' }, { status: 'R100', originalPath: 'old.txt', path: 'new.txt' }, { status: 'A', path: 'added.txt' }];

test('Get from Branch lists replaced and deleted files with both paths of a rename, then restores exactly the reviewed preview', async () => {
  const h = getFromBranchHarness();
  try {
    h.state.confirm = undefined;
    assert.equal(await h.run(rows), false);
    assert.deepEqual(h.state.previews.map(preview => preview.paths), [['keep.txt', 'old.txt', 'new.txt', 'added.txt']]); assert.deepEqual(h.state.restores, []);
    const modal = h.warnings[0]!;
    assert.equal(modal.text, 'Get 4 files from feature?'); assert.deepEqual(modal.choices, ['Get from Branch']);
    assert.equal(modal.detail, `Repository: ${h.root}\nFrom: feature · ${oid('b').slice(0, 12)}\nLocal edits to these files are replaced. The index is not changed.\n\nReplaced with the feature version (2):\nkeep.txt\nold.txt\n\nDeleted, because feature does not have them (2):\nnew.txt\nadded.txt`);
    h.state.confirm = 'Get from Branch';
    assert.equal(await h.run(rows), true);
    assert.deepEqual(h.state.restores, [[h.state.previews[1], oid('b')]], 'The restore receives the preview taken before the modal, so a changed fingerprint is refused');
    assert.equal(await h.run([{ status: 'D', path: 'old.txt' }]), true); assert.equal(h.warnings.at(-1)!.text, 'Get old.txt from feature?');
    h.state.restoreError = new Error('HEAD, index or reviewed content changed. Review the action again.');
    await assert.rejects(h.run(rows), /reviewed content changed/);
  } finally { h.cleanup(); }
});

test('Get from Branch refuses symlinks, submodules and folders on either side, operations, conflicts and the row bound before any modal', async () => {
  const h = getFromBranchHarness();
  try {
    for (const file of ['link', 'sub', 'dir']) await assert.rejects(h.run([{ status: 'D', path: file }]), new RegExp(`Use native Git for ${file}: it is a symlink, submodule or folder in feature`));
    await assert.rejects(h.run([{ status: 'A', path: 'module' }]), /Use native Git for module: it is a symlink, submodule or folder in the working tree/);
    assert.deepEqual(h.state.previews, []);
    h.state.previewError = new Error('A Git operation is in progress.'); await assert.rejects(h.run(rows), /operation is in progress/); h.state.previewError = undefined;
    h.state.conflicts = true; await assert.rejects(h.run(rows), /Resolve the current conflicts/); h.state.conflicts = false;
    await assert.rejects(h.run([]), /between 1 and 100/);
    await assert.rejects(h.run(Array.from({ length: 101 }, (_, index) => ({ status: 'M', path: `f${index}.txt` }))), /between 1 and 100/);
    await assert.rejects(h.run(rows, 'feature'), /full object ID/);
    assert.deepEqual(h.warnings, []); assert.deepEqual(h.state.restores, []);
  } finally { h.cleanup(); }
});

test('Get from Branch refuses a path the index does not track but the disk has: untracked or ignored content Git could not give back', async () => {
  const h = getFromBranchHarness();
  try {
    // `git diff feature` shows `D old.txt` (only in the branch), while an untracked old.txt holds work Git has no copy of.
    writeFileSync(path.join(h.root, 'old.txt'), 'PRECIOUS untracked\n');
    await assert.rejects(h.run([{ status: 'D', path: 'old.txt' }]), /old\.txt is not tracked by Git\. Get from Branch would overwrite it, and Git keeps no copy to restore it from\. Move or delete it first\./);
    await assert.rejects(h.run(rows), /old\.txt is not tracked by Git/, 'the branch-side path of a rename is checked too');
    assert.deepEqual(h.warnings, [], 'no modal offers it'); assert.deepEqual(h.state.restores, []);
    h.state.tracked.add('old.txt'); assert.equal(await h.run([{ status: 'M', path: 'old.txt' }]), true, 'a tracked file is replaced as reviewed');
  } finally { h.cleanup(); }
});

test('Get from Branch refuses an intent-to-add file before the modal: the index lists it, but holds none of its content', async () => {
  const h = getFromBranchHarness();
  try {
    // `git add -N added.txt`: ls-files lists it (so it counts as tracked), and status reports it as added in the working tree.
    h.state.changes = [{ group: 'working', status: 'A', path: 'added.txt' }, { group: 'working', status: 'M', path: 'keep.txt' }];
    await assert.rejects(h.run(rows), /added\.txt is only marked for adding \(git add -N\)\. Get from Branch would overwrite or delete it, and Git keeps no copy to restore it from\. Stage it, or move it first\./);
    // Paired with a deleted file, status shows it as the target of a working-tree rename instead.
    h.state.changes = [{ group: 'working', status: 'R', path: 'new.txt', originalPath: 'old.txt' }];
    await assert.rejects(h.run(rows), /new\.txt is only marked for adding/);
    assert.deepEqual(h.warnings, [], 'no modal offers it'); assert.deepEqual(h.state.restores, []);
    h.state.changes = [{ group: 'staged', status: 'A', path: 'added.txt' }, { group: 'working', status: 'M', path: 'added.txt' }];
    assert.equal(await h.run(rows), true, 'a staged addition holds its content in the index and is replaced as reviewed');
  } finally { h.cleanup(); }
});

test('Get from Branch refuses unsaved editors and open merge editors on any target, before the modal and again before Git writes', async () => {
  const h = getFromBranchHarness();
  try {
    const keep = path.join(h.root, 'keep.txt');
    h.documents.push({ uri: { scheme: 'file', fsPath: path.join(h.root, 'other.txt') }, isDirty: true }, { uri: { scheme: 'file', fsPath: keep }, isDirty: false }, { uri: { scheme: 'untitled', fsPath: keep }, isDirty: true });
    assert.equal(await h.run(rows), true, 'Saved or unrelated documents do not block');
    h.documents.push({ uri: { scheme: 'file', fsPath: process.platform === 'win32' ? keep.toUpperCase() : keep }, isDirty: true });
    await assert.rejects(h.run(rows), /Save or revert keep\.txt first\./);
    h.documents.pop(); h.state.merging.add(path.join(h.root, 'new.txt'));
    await assert.rejects(h.run(rows), /Close the merge editor for new\.txt first/);
    h.state.merging.clear(); const modals = h.warnings.length;
    h.state.onModal = () => { h.documents.push({ uri: { scheme: 'file', fsPath: path.join(h.root, 'added.txt') }, isDirty: true }); };
    await assert.rejects(h.run(rows), /Save or revert added\.txt first/);
    assert.equal(h.warnings.length, modals + 1); assert.equal(h.state.restores.length, 1);
  } finally { h.cleanup(); }
});
