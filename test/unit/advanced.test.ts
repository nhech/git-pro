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
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
test('advanced recipes reject arbitrary modes, commands, merge-parent batches and option OIDs',()=>{
  const oid='a'.repeat(40);
  assert.throws(()=>buildAdvancedMutation({kind:'reset',mode:'--hard;echo bad',oid} as unknown as AdvancedMutation));
  assert.throws(()=>buildAdvancedMutation({kind:'merge',strategy:'ff',oid:'--all'}));
  assert.throws(()=>buildAdvancedMutation({kind:'cherryPick',oids:[oid,'b'.repeat(40)],parent:1}));
  assert.throws(()=>buildAdvancedMutation({kind:'operationControl',operation:'merging',action:'skip'}));
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
  runInNewContext(readFileSync(source, 'utf8'), { exports, require: (name: string) => name === 'vscode' ? vscode : name === './message-editor' ? {} : name === '../git/conflicts/conflicts.service' ? { ConflictsService: class {} } : name === '../git/advanced/lease.service' ? { LeaseService: class {} } : load(name) });
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

test('Continue, Skip and Abort retain exact confirmation and action dispatch; Cancel preserves operation', async () => {
  for (const [action, label] of [['continue', 'Continue'], ['skip', 'Skip current commit'], ['abort', 'Abort']]) {
    for (const confirm of [false, true]) {
      const h = operationHarness('rebasing', true, 0, action, confirm); await h.run();
      assert.deepEqual(h.warnings, [{ text: `${label} rebasing?`, button: label }]);
      assert.deepEqual(h.mutations, confirm ? [action] : []);
    }
  }
});
