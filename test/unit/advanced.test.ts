import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAdvancedMutation, type AdvancedMutation } from '../../src/git/advanced/advanced-builders';
import { editorCommand } from '../../src/git/advanced/owned-editor';
import * as path from 'node:path';
import { acceptBothText, hasConflictMarkers } from '../../src/git/conflicts/text-conflicts';
import { parseIndex } from '../../src/git/conflicts/index-parser';
import { validateRemoteUrl } from '../../src/security/remotes';
import { buildMutationCommand } from '../../src/git/command-builders';
import { validateRebasePlan } from '../../src/git/rebase/rebase-plan';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { loadWithVscode } from './compare-loader';
test('advanced recipes reject arbitrary modes, commands, merge-parent batches and option OIDs',()=>{
  const oid='a'.repeat(40);
  assert.throws(()=>buildAdvancedMutation({kind:'reset',mode:'--hard;echo bad',oid} as unknown as AdvancedMutation));
  assert.throws(()=>buildAdvancedMutation({kind:'merge',strategy:'ff',oid:'--all'}));
  assert.throws(()=>buildAdvancedMutation({kind:'cherryPick',oids:[oid,'b'.repeat(40)],parent:1}));
  assert.throws(()=>buildAdvancedMutation({kind:'operationControl',operation:'merging',action:'skip'}));
  assert.throws(()=>buildAdvancedMutation({kind:'operationControl',operation:'rebasing',action:'continue',message:'not for a rebase'}),/only to continuing a merge/);
  assert.deepEqual(buildAdvancedMutation({kind:'operationControl',operation:'merging',action:'continue',message:'Reviewed'}).slice(-3),['commit','-m','Reviewed']);
  assert.deepEqual(buildAdvancedMutation({kind:'operationControl',operation:'rebasing',action:'continue'}).slice(-2),['rebase','--continue']);
  assert.deepEqual(buildAdvancedMutation({kind:'revert',oids:[oid]}).slice(-3),['revert','--no-edit',oid]);
  const result=editorCommand({node:process.execPath,helper:path.resolve("editor's helper.cjs")});assert.ok(result.includes("'\\''"));assert.throws(()=>editorCommand({node:'node',helper:'helper'}));
});
test('interactive plan rejects execution actions, duplicate OIDs, empty reword and first squash',()=>{
  const oid='a'.repeat(40),commits=[{oid,parent:'b'.repeat(40),subject:'Commit'}];
  assert.throws(()=>validateRebasePlan(commits,[{oid,action:'exec' as 'pick'}]));assert.throws(()=>validateRebasePlan(commits,[{oid,action:'reword',message:''}]));assert.throws(()=>validateRebasePlan(commits,[{oid,action:'squash'}]));
  assert.doesNotThrow(()=>validateRebasePlan(commits,[{oid,action:'drop'}]));
});
test('force lease cannot become an unconditional force, option target or unsupported helper transport',()=>{
  const oid='a'.repeat(40),url='https://example.invalid/repo.git';
  const args=buildMutationCommand({kind:'pushLease',url,branch:'main',source:oid,expected:'b'.repeat(40)});
  assert.ok(args.includes(`--force-with-lease=refs/heads/main:${'b'.repeat(40)}`));assert.equal(args.includes('--force'),false);assert.equal(args.at(-1),`${oid}:refs/heads/main`);
  for(const value of ['ext::command','--upload-pack=x','ftp://example.invalid/x','https://example.invalid/x\nsecret'])assert.throws(()=>validateRemoteUrl(value));
});
test('text conflicts preserve surrounding lines, diff3 base and CRLF; malformed markers are blocked',()=>{
  const text='before\r\n<<<<<<< ours\r\nours\r\n||||||| base\r\nbase\r\n=======\r\ntheirs\r\n>>>>>>> theirs\r\nafter\r\n';
  assert.equal(acceptBothText(text),'before\r\nours\r\ntheirs\r\nafter\r\n');assert.equal(hasConflictMarkers(text),true);assert.equal(hasConflictMarkers('plain text'),false);
  assert.throws(()=>acceptBothText('<<<<<<< a\nours\n=======\ntheirs\n'),/complete/);
  const index=parseIndex(Buffer.from(`100644 ${'a'.repeat(40)} 2\tname\twith\nnewline\0`));assert.equal(index[0]?.path,'name\twith\nnewline');assert.throws(()=>parseIndex(Buffer.from('truncated')));
});

type OperationChoice = { label: string; description: string; action: string; iconPath: { id?: string; path?: string } };
function operationHarness(operation: string, editStop: boolean, conflicts: number, choice?: string, confirm = false, theme = 2) {
  const picks: { items: OperationChoice[]; options: { title: string; placeHolder: string } }[] = [];
  const warnings: { text: string; button: string }[] = [], mutations: string[] = [];
  const snapshot = { operation, status: { changes: Array.from({ length: conflicts }, () => ({ group: 'conflicts', path: 'file.txt' })) } };
  const vscode = {
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    ThemeIcon: class { constructor(readonly id: string) {} },
    Uri: { joinPath: (root: { path: string }, ...parts: string[]) => ({ path: [root.path, ...parts].join('/') }) },
    window: {
      activeColorTheme: { kind: theme },
      showQuickPick: async (items: OperationChoice[], options: { title: string; placeHolder: string }) => { picks.push({ items, options }); return items.find(item => item.action === choice); },
      showWarningMessage: async (text: string, _options: unknown, button: string) => { warnings.push({ text, button }); return confirm ? button : undefined; },
      showInformationMessage: async () => undefined
    }
  };
  const source = path.resolve(__dirname, '../../src/commands/advanced.commands.js'), load = createRequire(source), exports: Record<string, unknown> = {};
  runInNewContext(readFileSync(source, 'utf8'), { exports, require: (name: string) => name === 'vscode' ? vscode : name === './message-editor' ? {} : name === '../git/conflicts/conflicts.service' ? { ConflictsService: class {} } : name === '../git/advanced/lease.service' ? { LeaseService: class {} } : name === '../editor/open-files' ? { refuseUnsaved: async () => undefined } : load(name) });
  const Constructor = exports.AdvancedCommands as new (...args: unknown[]) => { actions(): Promise<void> };
  const instance = new Constructor({ git: { registry: { active: { id: 'owned' } } }, snapshot: async () => snapshot, isEditStop: async () => editStop, control: async (reviewed: unknown, action: string) => { assert.equal(reviewed, snapshot); mutations.push(action); } }, {}, {}, {}, { path: '/owned-extension' });
  return { run: () => instance.actions(), picks, warnings, mutations };
}

test('operation picker uses plain labels and consequence descriptions; cancellation cannot mutate', async () => {
  for (const operation of ['merging', 'rebasing', 'cherry-picking', 'reverting']) for (const theme of [1, 2, 3, 4]) {
    const h = operationHarness(operation, operation === 'rebasing', 0, undefined, false, theme); await h.run();
    const pick = h.picks[0]!;
    const labels = Array.from(pick.items, item => item.label);
    assert.equal(labels[0], 'Continue'); assert.equal(labels.at(-1), 'Abort');
    assert.equal(labels.includes('Skip current commit'), operation !== 'merging');
    assert.equal(labels.includes('Stage edited files'), operation === 'rebasing');
    assert.equal(labels.includes('Amend stopped commit'), operation === 'rebasing');
    for (const item of pick.items) {
      assert.ok(item.description.length > 20); assert.doesNotMatch(item.label, /\$\(/);
      if (theme >= 3) { assert.ok(item.iconPath.id); assert.equal(item.iconPath.path, undefined); }
      else { assert.match(item.iconPath.path!, /^\/owned-extension\/media\/operation-icons\/[a-z-]+\.svg$/); assert.equal(item.iconPath.id, undefined); assert.ok(readFileSync(path.resolve(item.iconPath.path!.slice('/owned-extension/'.length)), 'utf8').startsWith('<svg ')); }
    }
    assert.deepEqual(h.warnings, []); assert.deepEqual(h.mutations, []);
  }
});

test('operation guidance distinguishes one/multiple conflicts, edit stop and clean pause', async () => {
  for (const [count, edit, expected] of [[1, true, '1 conflicted file'], [2, false, '2 conflicted files'], [0, true, 'Paused to edit a commit'], [0, false, 'No conflicted files']] as const) {
    const h = operationHarness('rebasing', edit, count); await h.run();
    assert.ok(h.picks[0]!.options.placeHolder.startsWith(expected));
    assert.match(h.picks[0]!.options.placeHolder, /then Continue/);
    assert.equal(h.picks[0]!.options.title, 'Git Pro: Rebase paused');
    if (count) assert.match(h.picks[0]!.items[0]!.description, /resolving and staging/);
  }
});

/** Objects built inside the vm have that context's prototypes; compare their data. */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
type Control = (advanced: unknown, snapshot: unknown, action: string, options?: { mergeMessage?: string }) => Promise<boolean>;
/** advanced.commands.js in a vm with recorded modals, a scripted owned message editor and a recording AdvancedService. */
function controlHarness(operation: string, answers: (string | undefined)[], edited?: string, gitDir = '/missing') {
  const warnings: { text: string; buttons: string[]; detail: string }[] = [], calls: unknown[][] = [], edits: { initial: string; title: string }[] = [];
  const snapshot = { repositoryId: 'owned', operation, status: { changes: [] } };
  const vscode = { window: { showWarningMessage: async (text: string, options: { detail: string }, ...buttons: string[]) => { warnings.push({ text, buttons, detail: options.detail }); return answers.shift(); } } };
  const source = path.resolve(__dirname, '../../src/commands/advanced.commands.js'), load = createRequire(source), exports: Record<string, unknown> = {};
  const editMessage = async (initial: string, title: string) => { edits.push({ initial, title }); return edited; };
  runInNewContext(readFileSync(source, 'utf8'), { exports, require: (name: string) => name === 'vscode' ? vscode : name === './message-editor' ? { editMessage } : name === '../git/conflicts/conflicts.service' ? { ConflictsService: class {} } : name === '../git/advanced/lease.service' ? { LeaseService: class {} } : name === '../editor/open-files' ? { refuseUnsaved: async () => undefined } : load(name) });
  const advanced = { git: { repository: (id: string) => { assert.equal(id, 'owned'); return { gitDir }; } }, control: async (...args: unknown[]) => { assert.equal(args[0], snapshot); calls.push(args.slice(1)); } };
  return { run: (action: string, options?: { mergeMessage?: string }) => (exports.confirmAndControl as Control)(advanced, snapshot, action, options), warnings, calls, edits };
}

test('merge Continue offers Commit Merge or Edit Message…, prefilled from MERGE_MSG without its comment lines', async () => {
  const commit = controlHarness('merging', ['Commit Merge']);
  assert.equal(await commit.run('continue'), true);
  assert.deepEqual(commit.warnings.map(item => [item.text, item.buttons]), [['Continue merging?', ['Commit Merge', 'Edit Message…']]]);
  assert.match(commit.warnings[0]!.detail, /Hooks will still run/); assert.deepEqual(commit.calls, [['continue']], 'Git\'s prepared message: commit --no-edit');
  const dir = mkdtempSync(path.join(tmpdir(), 'git-pro-merge-msg-'));
  try {
    writeFileSync(path.join(dir, 'MERGE_MSG'), "Merge branch 'feature'\n\n# Conflicts:\n#\tsrc/app.ts\n");
    const edit = controlHarness('merging', ['Edit Message…'], "Merge branch 'feature'\n\n#123 fix the login form\n", dir);
    assert.equal(await edit.run('continue'), true);
    assert.deepEqual(edit.edits, [{ initial: "Merge branch 'feature'\n", title: 'Merge commit message' }]);
    assert.deepEqual(plain(edit.calls), [['continue', { mergeMessage: "Merge branch 'feature'\n\n#123 fix the login form\n" }]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const abandoned = controlHarness('merging', ['Edit Message…'], undefined);
  assert.equal(await abandoned.run('continue'), false); assert.equal(abandoned.edits[0]!.initial, '', 'no MERGE_MSG: an empty prefill'); assert.deepEqual(abandoned.calls, []);
  const cancelled = controlHarness('merging', [undefined]);
  assert.equal(await cancelled.run('continue'), false); assert.deepEqual(cancelled.calls, []);
  const given = controlHarness('merging', ['Commit Merge']);
  assert.equal(await given.run('continue', { mergeMessage: 'Collected elsewhere' }), true);
  assert.deepEqual(given.warnings.map(item => item.buttons), [['Commit Merge']]); assert.deepEqual(plain(given.calls), [['continue', { mergeMessage: 'Collected elsewhere' }]]);
});

test('confirmAndControl refuses what Git Pro cannot control before asking anything', async () => {
  for (const [operation, action, error] of [['merging', 'skip', /Merge cannot skip/], ['bisecting', 'abort', /native Git/], ['idle', 'continue', /No supported operation/], ['rebasing', 'reset', /Unknown operation action/]] as const) {
    const h = controlHarness(operation, ['Continue']);
    await assert.rejects(h.run(action), error); assert.deepEqual(h.warnings, []); assert.deepEqual(h.calls, []);
  }
  for (const operation of ['rebasing', 'cherry-picking', 'reverting']) for (const [action, label] of [['continue', 'Continue'], ['skip', 'Skip current commit'], ['abort', 'Abort']] as const) {
    const h = controlHarness(operation, [label]);
    assert.equal(await h.run(action), true); assert.deepEqual(h.warnings.map(item => [item.text, item.buttons]), [[`${label} ${operation}?`, [label]]]); assert.deepEqual(h.calls, [[action]]);
  }
});

test('a squash merge that stops on conflicts records its source for the Conflicts tab; other failures record nothing', async () => {
  const { GitFailure } = await import('../../src/git/git-error-parser');
  for (const [failure, recorded] of [[new GitFailure('conflict', 'Git stopped with 1 conflict.', 1), true], [new GitFailure('unknown', 'fatal', 128), false]] as const) {
    const target = 'b'.repeat(40), picks = ['Merge', 'squash'];
    const vscode = {
      ProgressLocation: { Window: 10 },
      window: {
        showQuickPick: async (items: (string | { value?: string })[]) => { const want = picks.shift(); return items.find(item => typeof item === 'string' ? item === want : item.value === want); },
        showInputBox: async () => 'feature', showWarningMessage: async (_text: string, _options: unknown, button: string) => button,
        withProgress: async (_options: unknown, task: () => Promise<unknown>) => task(), showInformationMessage: async () => undefined
      }
    };
    const source = path.resolve(__dirname, '../../src/commands/advanced.commands.js'), load = createRequire(source), exports: Record<string, unknown> = {};
    runInNewContext(readFileSync(source, 'utf8'), { exports, require: (name: string) => name === 'vscode' ? vscode : name === './message-editor' ? {} : name === '../git/conflicts/conflicts.service' ? { ConflictsService: class {} } : name === '../git/advanced/lease.service' ? { LeaseService: class {} } : name === '../editor/open-files' ? { refuseUnsaved: async () => undefined } : load(name) });
    const { createSurfaces } = await import('../../src/conflicts/surfaces'), surfaces = createSurfaces();
    const snapshot = { operation: 'idle', head: 'c'.repeat(40), status: { changes: [] } };
    const advanced = { git: { registry: { active: { id: 'owned' } }, repository: () => ({ root: '/repo' }) }, snapshot: async () => snapshot, resolve: async () => target,
      preview: async (_id: string, command: unknown) => ({ snapshot, command, files: [] }), execute: async () => { throw failure; } };
    const Constructor = exports.AdvancedCommands as new (...args: unknown[]) => { actions(): Promise<void> };
    await assert.rejects(new Constructor(advanced, {}, {}, {}, { path: '/owned-extension' }, surfaces).actions(), (error: unknown) => error === failure);
    assert.deepEqual(plain([...surfaces.conflictSources]), recorded ? [['owned', { kind: 'squash', oid: target }]] : []);
  }
});

test('Continue, Skip and Abort retain exact confirmation and action dispatch; Cancel preserves operation', async () => {
  for (const [action, label] of [['continue', 'Continue'], ['skip', 'Skip current commit'], ['abort', 'Abort']]) {
    for (const confirm of [false, true]) {
      const h = operationHarness('rebasing', true, 0, action, confirm); await h.run();
      assert.deepEqual(h.warnings, [{ text: `${label} rebasing?`, button: label }]);
      assert.deepEqual(h.mutations, confirm ? [action] : []);
    }
  }
});

test('the per-file Resolve Conflict quick pick refuses Accept, Accept Both and Mark Resolved under an unsaved or merge editor of the file, before and after its modal (N12)', async () => {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'git-pro-quick-pick-'))), file = path.join(root, 'app.ts'); writeFileSync(file, '<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs\n');
  class Uri { constructor(readonly scheme: string, readonly fsPath: string) {} static file(value: string) { return new Uri('file', value); } }
  const documents: { uri: Uri; isDirty: boolean }[] = [], tabs: { input: unknown }[] = [], resolved: unknown[][] = [], warnings: string[] = [];
  let choice = 'yours', during: () => void = () => undefined;
  const vscode = { Uri, workspace: { get textDocuments() { return documents; } },
    window: { tabGroups: { get all() { return [{ tabs }]; } }, showQuickPick: async (items: { action: string }[]) => items.find(item => item.action === choice),
      showWarningMessage: async (text: string, _options: unknown, button: string) => { warnings.push(text); during(); return button; }, showInformationMessage: async () => undefined },
    commands: { executeCommand: async () => undefined } };
  const preview = { snapshot: { operation: 'merging' }, path: 'app.ts', entries: [{ stage: 1 }, { stage: 2 }, { stage: 3 }], text: 'x', markers: true };
  class ConflictsService { preview = async () => preview; resolve = async (...args: unknown[]) => { resolved.push(args.slice(1)); }; }
  const source = path.resolve(__dirname, '../../src/commands/advanced.commands.js'), load = createRequire(source), exports: Record<string, unknown> = {};
  const openFiles = loadWithVscode(path.resolve(__dirname, '../../src/editor/open-files.js'), vscode);
  runInNewContext(readFileSync(source, 'utf8'), { exports, require: (name: string) => name === 'vscode' ? vscode : name === './message-editor' ? {} : name === '../git/conflicts/conflicts.service' ? { ConflictsService } : name === '../git/advanced/lease.service' ? { LeaseService: class {} } : name === '../editor/open-files' ? openFiles : load(name) });
  const advanced = { git: { registry: { active: { id: 'owned' } }, repository: () => ({ root }), authorizePath: async (_id: string, relative: string) => path.join(root, relative) } };
  const instance = new (exports.AdvancedCommands as new (...args: unknown[]) => { conflict(arg: unknown): Promise<void> })(advanced, {}, {}, {}, { path: '/owned-extension' });
  const run = () => instance.conflict({ repositoryId: 'owned', change: { path: 'app.ts' } });
  try {
    // The editor shows no markers while the disk copy still has them: the marker modal must not be what the user answers.
    documents.push({ uri: Uri.file(file), isDirty: true });
    for (const action of ['yours', 'both', 'mark']) { choice = action; await assert.rejects(run(), /Save or revert app\.ts first/, action); }
    assert.deepEqual(warnings, [], 'refused before any modal'); documents.length = 0;
    tabs.push({ input: { base: Uri.file('b'), input1: Uri.file('1'), input2: Uri.file('2'), result: Uri.file(file) } });
    await assert.rejects(run(), /Close the merge editor for app\.ts first/); tabs.length = 0;
    choice = 'theirs'; during = () => { documents.push({ uri: Uri.file(file), isDirty: true }); };
    await assert.rejects(run(), /Save or revert app\.ts first/, 'an editor that became dirty while the modal was open'); assert.deepEqual(resolved, []);
    documents.length = 0; during = () => undefined;
    await run(); assert.deepEqual(resolved, [['incoming', false]], 'Theirs in a merge is Git --theirs');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
