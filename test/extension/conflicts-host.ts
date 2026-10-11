import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { ExtensionDiagnostics } from '../../src/extension';
import { fileKey, mergeInput } from '../../src/editor/merge-editor-bridge';
import { ConflictActions } from '../../src/webviews/conflicts/conflict-actions';
import { conflictsHtml } from '../../src/webviews/conflicts/conflicts-html';
import { ConflictsService } from '../../src/git/conflicts/conflicts.service';
import { advancedFixture } from '../fixtures/advanced-fixture';
import { canonicalFilePath, containsPath } from '../../src/security/paths';
import { recordHostMetric } from './host-metrics';

const tabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs);
const mergeTabs = (file: string) => tabs().filter(tab => { const input = mergeInput(tab); return input?.result.scheme === 'file' && fileKey(input.result.fsPath) === fileKey(file); });
const text = (value: string) => value.replace(/\r\n/g, '\n');
async function waitFor<T>(probe: () => T | undefined | false, what: string, timeout = 10_000): Promise<T> {
  for (const start = Date.now(); ;) {
    const value = probe(); if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}; tabs: ${tabs().map(tab => tab.label).join(', ')}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
const resultText = (file: string) => vscode.workspace.textDocuments.find(document => document.uri.scheme === 'file' && fileKey(document.uri.fsPath) === fileKey(file))?.getText();
/**
 * Accepts the left input (Yours) in the active merge editor. Its tab exists before its models load, and a Result that starts with Git markers is then reset to base
 * plus the auto-merged hunks; an accept sent before that reset is lost. So this waits for the reset, then repeats the idempotent accept until the Result shows it.
 */
async function acceptAllYours(file: string, expected: string): Promise<void> {
  for (const start = Date.now(); Date.now() - start < 5000 && (resultText(file) ?? '<<<<<<<').includes('<<<<<<<');) await new Promise(resolve => setTimeout(resolve, 50));
  for (const start = Date.now(); text(resultText(file) ?? '') !== expected;) {
    if (Date.now() - start > 10_000) throw new Error(`merge.acceptAllInput1 never reached the Result of ${path.basename(file)}: ${JSON.stringify(resultText(file))}`);
    await vscode.commands.executeCommand('merge.acceptAllInput1');
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}
/** Best effort after a failed step: a dirty merge editor would otherwise ask to save on close, which the test host refuses. */
async function revertAndClose(owned: readonly vscode.Tab[]): Promise<void> {
  for (const tab of owned) {
    try {
      if (!mergeInput(tab)) { await vscode.window.tabGroups.close(tab); continue; }
      const group = ['First', 'Second', 'Third', 'Fourth'][tab.group.viewColumn - 1];
      if (group) await vscode.commands.executeCommand(`workbench.action.focus${group}EditorGroup`);
      await vscode.commands.executeCommand('workbench.action.openEditorAtIndex', tab.group.tabs.indexOf(tab));
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    } catch (error) { console.log(`Conflicts host cleanup: ${String(error)}`); }
  }
}

/**
 * WP2 host checks (design §4 WP2), on VS Code 1.100.0 and 1.141.0. `root` is the harness-owned repository on `external-host-test` with working changes:
 * the conflict lives on two temporary branches and new files only, and every branch, file and tab is restored before returning.
 */
export async function verifyConflictsHost(extension: vscode.Extension<ExtensionDiagnostics>, api: ExtensionDiagnostics, root: string): Promise<void> {
  assert.ok(extension.isActive && api.activeRepository() && root.includes('git-pro-host-'), 'Conflicts host checks run in the owned fixture');
  await mergeEditorFlow(api, root);
  const autoOpened = await autoOpenAfterMerge(extension, api, root);
  await acceptInFixture(extension);
  await rendererChecks(extension);
  await recordHostMetric({ hostSuiteStage: 'conflicts-host', conflictsTabOpened: true, mergeIntoCurrentAutoOpened: autoOpened, mergeEditorYoursLeft: true, applyAndNextStaged: true, acceptTheirsStaged: true, dirtyBufferRefused: true, altMnemonicsStopped: true });
}

/**
 * §3.5 through the trusted wrapper in extension.ts: Merge into Current (Branch Actions) runs a real Git Pro merge that stops on conflicts, and the Conflicts tab
 * opens by itself. The command's modal and its failure toast are answered by replacing them on the vscode API object, which this suite shares with the extension
 * only when it runs from inside the extension folder; an installed VSIX gets its own, so the step is skipped there rather than left waiting on a native modal.
 */
async function autoOpenAfterMerge(extension: vscode.Extension<ExtensionDiagnostics>, api: ExtensionDiagnostics, root: string): Promise<boolean> {
  if (!containsPath(await canonicalFilePath(extension.extensionPath), await canonicalFilePath(__filename))) { console.log('Conflicts auto-open host step skipped: the suite does not share the installed extension\'s vscode API object.'); return false; }
  const window = vscode.window as unknown as Record<'showWarningMessage' | 'showErrorMessage', (message: string, ...rest: unknown[]) => Thenable<unknown>>;
  const original = { warning: window.showWarningMessage, error: window.showErrorMessage }, asked: string[] = [], errors: string[] = [];
  const git = (args: string[], allowFailure = false) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    if (!allowFailure) assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result;
  };
  const file = path.join(root, 'auto-open.txt'), branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim(), head = git(['rev-parse', 'HEAD']).stdout.trim(), status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all']).stdout;
  const conflictTab = () => tabs().filter(tab => tab.input instanceof vscode.TabInputWebview && tab.label === `Conflicts — ${path.basename(root)}`);
  assert.equal(conflictTab().length, 0); assert.equal(existsSync(file), false);
  // Git Pro runs Git without the harness's GIT_CONFIG_GLOBAL, and `git merge` checks the committer identity before it starts: the step lends the repository one.
  const identity = git(['config', '--local', '--get', 'user.email'], true).status !== 0;
  let stashed = false;
  try {
    if (identity) { git(['config', '--local', 'user.name', 'Git Pro Host']); git(['config', '--local', 'user.email', 'host@example.invalid']); }
    // Merge into Current needs a clean repository (Advanced preview): the fixture's own changes wait in a stash.
    git(['stash', 'push', '--include-untracked', '-m', 'git-pro host auto-open']); stashed = true;
    git(['switch', '-c', 'gp-auto-ours']); await writeFile(file, 'base\n'); git(['add', '--', 'auto-open.txt']); git(['commit', '-m', 'auto-open base', '--', 'auto-open.txt']);
    git(['switch', '-c', 'gp-auto-theirs']); await writeFile(file, 'theirs\n'); git(['commit', '-m', 'auto-open theirs', '--', 'auto-open.txt']);
    git(['switch', 'gp-auto-ours']); await writeFile(file, 'ours\n'); git(['commit', '-m', 'auto-open ours', '--', 'auto-open.txt']);
    await vscode.commands.executeCommand('gitPro.refresh');
    window.showWarningMessage = async (message: string) => { asked.push(message); return message === 'Merge gp-auto-theirs into gp-auto-ours?' ? 'Merge' : undefined; };
    window.showErrorMessage = async (message: string) => { errors.push(message); return undefined; };
    if (vscode.window.showWarningMessage !== window.showWarningMessage) { console.log('Conflicts auto-open host step skipped: the vscode API object cannot be answered in this host.'); return false; }
    const node = { kind: 'branch', repositoryId: api.activeRepository(), branch: { name: 'gp-auto-theirs', ref: 'refs/heads/gp-auto-theirs', oid: git(['rev-parse', 'gp-auto-theirs']).stdout.trim(), remote: false, upstream: '', worktree: '' } };
    await vscode.commands.executeCommand('gitPro.mergeIntoCurrent', node);
    assert.deepEqual(asked, ['Merge gp-auto-theirs into gp-auto-ours?'], `only the reviewed modal was asked; toasts: ${JSON.stringify(errors)}`);
    assert.equal(git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], true).status, 0, `Git Pro ran the merge, and Git stopped on the conflict; toasts: ${JSON.stringify(errors)}`);
    assert.equal(errors.length, 1, 'the failure toast still appears');
    await waitFor(() => conflictTab().length === 1, `the Conflicts tab the failure opened (toast: ${errors[0] ?? 'none'})`);
    assert.equal(api.activeSnapshot()?.changes.filter(change => change.group === 'conflicts').length, 1);
    console.log('Git Pro Conflicts auto-open passed: Merge into Current stopped on a conflict and the trusted wrapper opened the Conflicts tab.');
    return true;
  } finally {
    window.showWarningMessage = original.warning; window.showErrorMessage = original.error;
    await revertAndClose(conflictTab());
    git(['merge', '--abort'], true); git(['switch', branch], true); git(['branch', '-D', 'gp-auto-ours', 'gp-auto-theirs'], true);
    if (stashed) assert.equal(git(['stash', 'pop', '--index'], true).status, 0, 'the fixture changes come back, staged ones staged');
    if (identity) { git(['config', '--local', '--unset', 'user.name'], true); git(['config', '--local', '--unset', 'user.email'], true); }
    await vscode.commands.executeCommand('gitPro.refresh');
    assert.equal(git(['rev-parse', 'HEAD']).stdout.trim(), head); assert.equal(git(['status', '--porcelain=v1', '-z', '--untracked-files=all']).stdout, status, 'the fixture working tree is as it was');
  }
}

/** Steps 1–4: a real merge conflict, the Conflicts tab, Merge… through `_open.mergeEditor`, then Apply & Next. */
async function mergeEditorFlow(api: ExtensionDiagnostics, root: string): Promise<void> {
  const git = (args: string[], allowFailure = false) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    if (!allowFailure) assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result;
  };
  const files = ['conflict-a.txt', 'conflict-b.txt'], [fileA, fileB] = files.map(file => path.join(root, file)) as [string, string];
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim(), head = git(['rev-parse', 'HEAD']).stdout.trim(), status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all']).stdout;
  for (const file of [fileA, fileB]) assert.equal(existsSync(file), false, 'the conflict files are new to the fixture');
  const conflictTab = () => tabs().filter(tab => tab.input instanceof vscode.TabInputWebview && tab.label === `Conflicts — ${path.basename(root)}`);
  try {
    // Only new files take part, so the fixture's unrelated working changes ride along untouched.
    git(['switch', '-c', 'gp-conflicts-ours']);
    for (const file of [fileA, fileB]) await writeFile(file, 'base\n');
    git(['add', '--', ...files]); git(['commit', '-m', 'conflicts base', '--', ...files]);
    git(['switch', '-c', 'gp-conflicts-theirs']);
    for (const file of files) await writeFile(path.join(root, file), `theirs ${file}\n`);
    git(['commit', '-m', 'conflicts theirs', '--', ...files]);
    git(['switch', 'gp-conflicts-ours']);
    for (const file of files) await writeFile(path.join(root, file), `ours ${file}\n`);
    git(['commit', '-m', 'conflicts ours', '--', ...files]);
    assert.equal(git(['merge', '--no-edit', 'gp-conflicts-theirs'], true).status, 1, 'the merge stops on conflicts');
    await vscode.commands.executeCommand('gitPro.refresh');
    assert.deepEqual(api.activeSnapshot()?.changes.filter(change => change.group === 'conflicts').map(change => change.path).sort(), files);

    await vscode.commands.executeCommand('gitPro.conflicts.open');
    await waitFor(() => conflictTab().length === 1, 'the Conflicts tab');
    await vscode.commands.executeCommand('gitPro.conflicts.open');
    assert.equal(conflictTab().length, 1, 'one Conflicts tab per repository');

    await vscode.commands.executeCommand('gitPro.conflicts.merge', vscode.Uri.file(fileA));
    const tab = await waitFor(() => mergeTabs(fileA)[0], 'the merge editor for conflict-a.txt');
    const input = mergeInput(tab)!;
    assert.deepEqual([input.base, input.input1, input.input2].map(uri => uri.scheme), ['git-pro-conflict', 'git-pro-conflict', 'git-pro-conflict'], 'bounded snapshots, never git: URIs');
    assert.equal(text((await vscode.workspace.openTextDocument(input.input1)).getText()), 'ours conflict-a.txt\n', 'the left input is Yours (owner decision Q1)');
    assert.equal(text((await vscode.workspace.openTextDocument(input.input2)).getText()), 'theirs conflict-a.txt\n');
    assert.ok(mergeInput(vscode.window.tabGroups.activeTabGroup.activeTab), 'the bridge focuses the merge editor it opened');
    await vscode.commands.executeCommand('gitPro.conflicts.merge', vscode.Uri.file(fileA));
    assert.equal(mergeTabs(fileA).length, 1, 'Merge… on an open file reveals its merge editor');

    // Every conflict handled, so Complete Merge asks nothing; Apply & Next then stages the saved Result and opens the next file.
    await acceptAllYours(fileA, 'ours conflict-a.txt\n');
    await vscode.commands.executeCommand('gitPro.mergeEditor.apply');
    await waitFor(() => mergeTabs(fileB)[0], 'the next conflicted file');
    assert.match(git(['ls-files', '--stage', '--', 'conflict-a.txt']).stdout.trim(), /^100644 [0-9a-f]{40} 0\tconflict-a\.txt$/, 'Apply & Next staged the file');
    assert.equal(text(await readFile(fileA, 'utf8')), 'ours conflict-a.txt\n');
    assert.equal(mergeTabs(fileA).length, 0);
    // Native Complete Merge on the next file saves without staging; the bridge only offers Mark Resolved (a non-modal prompt), and nothing asks before closing.
    assert.ok(mergeInput(vscode.window.tabGroups.activeTabGroup.activeTab), 'the next merge editor has focus');
    await acceptAllYours(fileB, 'ours conflict-b.txt\n');
    await vscode.commands.executeCommand('mergeEditor.acceptMerge');
    await waitFor(() => !mergeTabs(fileB).length, 'Complete Merge to close the editor');
    assert.equal(text(await readFile(fileB, 'utf8')), 'ours conflict-b.txt\n');
    assert.match(git(['ls-files', '--stage', '--', 'conflict-b.txt']).stdout, / [123]\tconflict-b\.txt/, 'native Complete Merge does not stage');
    console.log('Git Pro Conflicts host passed: real merge conflict, one Conflicts tab, Yours | Result | Theirs merge editor on snapshots, Apply & Next staged and opened the next file, native Complete Merge left staging to the user.');
  } finally {
    await revertAndClose([...mergeTabs(fileA), ...mergeTabs(fileB), ...conflictTab()]);
    git(['merge', '--abort'], true); git(['switch', branch], true); git(['branch', '-D', 'gp-conflicts-ours', 'gp-conflicts-theirs'], true);
    await vscode.commands.executeCommand('gitPro.refresh');
  }
  assert.equal(git(['rev-parse', 'HEAD']).stdout.trim(), head); assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim(), branch);
  assert.equal(git(['status', '--porcelain=v1', '-z', '--untracked-files=all']).stdout, status, 'the fixture working tree is as it was');
  for (const file of [fileA, fileB]) assert.equal(existsSync(file), false);
}

/**
 * Step 2's Accept Theirs and the N12 refusal, in an owned fixture: the N2 modal cannot be answered in the host, so the shared Conflicts action runs with a
 * recording confirmation, against WP1's ConflictsService and real VS Code documents.
 */
async function acceptInFixture(extension: vscode.Extension<ExtensionDiagnostics>): Promise<void> {
  const f = await advancedFixture(path.join(extension.extensionPath, 'media', 'helpers', 'preserve-editor.cjs'));
  try {
    await f.commit('both.txt', 'base\n', 'base'); f.git(['switch', '-c', 'side']); await f.commit('both.txt', 'side\n', 'side'); f.git(['switch', 'main']); await f.commit('both.txt', 'main\n', 'main');
    assert.equal(spawnSync('git', ['merge', '--no-edit', 'side'], { cwd: f.root, env: f.env, encoding: 'utf8', windowsHide: true }).status, 1);
    await f.registry.refresh(f.id);
    const service = new ConflictsService(f.advanced), prompts: { message: string; detail: string }[] = [];
    const actions = new ConflictActions({ api: service, revisions: { add: () => { throw new Error('No compare in this check.'); } }, tools: {} as never,
      summary: id => service.context.summary(id), checkTrust: () => f.policy.checkTrust(), authorize: (id, file) => f.gitService.authorizePath(id, file), root: () => f.root,
      confirm: async (message, detail) => { prompts.push({ message, detail }); return true; } });
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(f.root, 'both.txt')));
    const editor = await vscode.window.showTextDocument(document);
    await editor.edit(builder => builder.insert(new vscode.Position(0, 0), 'unsaved '));
    assert.equal(document.isDirty, true);
    await assert.rejects(actions.accept(f.id, ['both.txt'], 'theirs'), /Save or revert both\.txt first/, 'N12: never under unsaved edits');
    assert.equal(prompts.length, 0);
    await vscode.commands.executeCommand('workbench.action.files.revert'); assert.equal(document.isDirty, false);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    assert.equal(await actions.accept(f.id, ['both.txt'], 'theirs'), true);
    assert.equal(prompts[0]?.message, 'Accept Theirs for 1 file?');
    assert.match(prompts[0]!.detail, /Theirs = side · [0-9a-f]{7} \(the branch being merged\) → git --theirs/);
    assert.match(f.git(['ls-files', '--stage', '--', 'both.txt']).trim(), /^100644 [0-9a-f]{40} 0\tboth\.txt$/, 'one step: restored and staged');
    assert.equal(text(await readFile(path.join(f.root, 'both.txt'), 'utf8')), 'side\n');
  } finally { await f.close(); }
}

const themes = [['Default Dark Modern', 'vscode-dark'], ['Default Light Modern', 'vscode-light'], ['Default High Contrast', 'vscode-high-contrast'], ['Default High Contrast Light', 'vscode-high-contrast-light']] as const;
const key = (index: number) => `${String(index).padStart(3, '0')}${'K'.repeat(40)}`;
const hostilePath = 'src/<img src=x onerror=alert(1)>.ts';
const probeRows = [
  { key: key(1), group: 'unresolved', path: 'src/app.ts', kind: 'bothModified', yours: 'modified', theirs: 'modified', markers: 'present', blocks: 2, binary: false, mergeable: true, mergeOpen: false, workingFile: true },
  { key: key(2), group: 'unresolved', path: hostilePath, kind: 'deletedByThem', yours: 'modified', theirs: 'deleted', markers: 'unknown', blocks: null, binary: false, mergeable: false, mergeOpen: false, workingFile: true },
  { key: key(3), group: 'resolved', path: 'README.md', kind: 'bothModified', yours: 'modified', theirs: 'modified', markers: 'none', blocks: 0, binary: false, mergeable: true, mergeOpen: false, workingFile: true }
];
const probeOperation = { kind: 'merging', title: 'Merging feature into main', yours: { label: 'Yours', ref: 'main', oid: '1'.repeat(40), flag: 'ours' }, theirs: { label: 'Theirs', ref: 'feature', oid: '9'.repeat(40), flag: 'theirs' },
  conflicts: 2, canContinue: false, canSkip: false, canAbort: true, nativeOnly: false, editStop: false };
// Runs before the production script in a test-owned panel; it relays the production messages and reports DOM checks. Synthetic events stand in for the keyboard.
const driver = `(() => {
  const bridge=acquireVsCodeApi(),session=document.body.dataset.session,captured=[],forwarded=[];let running=false;
  window.acquireVsCodeApi=()=>({getState:()=>bridge.getState(),setState:value=>bridge.setState(value),postMessage:value=>{if(captured.length<200)captured.push(value);bridge.postMessage(value);}});
  // Stands in for the webview host's window-level listeners, which forward every keydown and keyup to the workbench.
  window.addEventListener('keydown',event=>forwarded.push('down:'+event.key));window.addEventListener('keyup',event=>forwarded.push('up:'+event.key));
  const settle=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))),byId=id=>document.getElementById(id),row=key=>document.querySelector('[data-key="'+key+'"]');
  const key=(node,type,init)=>{const event=new KeyboardEvent(type,{bubbles:true,cancelable:true,...init});node.dispatchEvent(event);return event;};
  window.addEventListener('message',async event=>{
    const data=event.data;if(data?.type!=='conflictsProbe'||data.session!==session||running)return;running=true;
    const checks=[],failures=[];const check=(name,ok)=>{checks.push({name,passed:Boolean(ok)});if(!ok)failures.push(name);};
    try{
      await document.fonts.ready;for(let i=0;i<150&&!document.body.classList.contains(data.themeClass);i++)await settle();await settle();
      check('actual-host-theme',document.body.classList.contains(data.themeClass));
      check('treegrid',byId('table').getAttribute('role')==='treegrid'&&byId('table').getAttribute('aria-multiselectable')==='true');
      check('column-headers',[...document.querySelectorAll('[role=columnheader]')].map(node=>node.textContent).join('|')==='Name|Kind|Yours (main)|Theirs (feature)|State');
      check('banner-region',byId('banner').getAttribute('role')==='region'&&byId('banner').getAttribute('aria-label')==='Merge in progress');
      check('literal-hostile-path',!document.querySelector('img')&&row(data.hostile).getAttribute('aria-label').startsWith(data.hostilePath));
      for(const node of document.querySelectorAll('#rows [role=row]'))check('row-height:'+node.dataset.key,Math.round(node.getBoundingClientRect().height)===22);
      check('no-horizontal-page-scroll',document.documentElement.scrollWidth<=innerWidth+1);
      check('continue-disabled-reason',byId('operation-actions').firstElementChild?.getAttribute('aria-disabled')==='true');
      row(data.first).click();await settle();
      check('accept-enabled',byId('accept-yours').getAttribute('aria-disabled')==='false'&&byId('accept-theirs').getAttribute('aria-disabled')==='false');
      const alt=key(row(data.first),'keydown',{key:'t',code:'KeyT',altKey:true});await settle();
      check('alt-t-prevented',alt.defaultPrevented);check('alt-t-not-forwarded',!forwarded.includes('down:t'));
      check('alt-t-accepts-theirs',captured.some(value=>value.type==='resolve'&&value.action==='acceptTheirs'&&value.keys.length===1&&value.keys[0]===data.first));
      key(row(data.first),'keyup',{key:'t',code:'KeyT',altKey:true});key(row(data.first),'keyup',{key:'Alt',code:'AltLeft'});await settle();
      check('alt-keyups-held',!forwarded.includes('up:t')&&!forwarded.includes('up:Alt'));
      const all=key(row(data.first),'keydown',{key:'a',code:'KeyA',ctrlKey:true});await settle();check('select-all-stays-in-table',all.defaultPrevented&&!forwarded.includes('down:a'));
      key(row(data.first),'keydown',{key:'ArrowDown'});await settle();check('navigation-still-forwarded',forwarded.includes('down:ArrowDown')&&document.activeElement===row(data.hostile));
      bridge.postMessage({type:'conflictsReport',session,checks,failures,width:innerWidth,themeClass:data.themeClass});
    }catch(error){bridge.postMessage({type:'conflictsError',session,error:String(error),checks,failures});}
  });
})();`;

async function probe(extension: vscode.Extension<ExtensionDiagnostics>, themeClass: string): Promise<{ failures: string[]; checks: unknown[] }> {
  const parent = await realpath(tmpdir()), dir = await realpath(await mkdtemp(path.join(parent, 'git-pro-conflicts-ux-')));
  let panel: vscode.WebviewPanel | undefined, receiver: vscode.Disposable | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const script = vscode.Uri.file(path.join(dir, 'probe.js')); await writeFile(script.fsPath, driver);
    panel = vscode.window.createWebviewPanel('gitPro.conflictsUxFixture', 'Git Pro: Conflicts UX Check', vscode.ViewColumn.One, { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extension.extensionUri, 'media'), vscode.Uri.file(dir)] });
    const session = randomUUID(), nonce = randomUUID().replace(/-/g, ''), resource = (name: string) => panel!.webview.asWebviewUri(vscode.Uri.joinPath(extension.extensionUri, 'media', name)).toString();
    const html = conflictsHtml({ session, nonce, cspSource: panel.webview.cspSource, resource }), anchor = `<script nonce="${nonce}" src="${resource('conflicts.js')}">`;
    assert.equal(html.split(anchor).length, 2);
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Conflicts DOM probe exceeded 30 seconds.')), 30_000);
      receiver = panel!.webview.onDidReceiveMessage((value: unknown) => {
        const data = value as Record<string, unknown> | undefined; if (!data || data.session !== session) return;
        // Production requests are only recorded by the driver; nothing reaches Git.
        if (data.type === 'ready') void (async () => {
          await panel!.webview.postMessage({ type: 'state', session, revision: 1, repository: 'Fixture', groupByDirectory: false, operation: probeOperation, rows: probeRows, truncated: false, message: '' });
          await panel!.webview.postMessage({ type: 'conflictsProbe', session, themeClass, first: key(1), hostile: key(2), hostilePath });
        })().catch(reject);
        if (data.type === 'conflictsError') reject(new Error(JSON.stringify(data)));
        if (data.type === 'conflictsReport') resolve(data as { failures: string[]; checks: unknown[] });
      });
      panel!.webview.html = html.replace(anchor, `<script nonce="${nonce}" src="${panel!.webview.asWebviewUri(script)}"></script>${anchor}`);
    });
  } finally {
    if (timer) clearTimeout(timer); receiver?.dispose(); panel?.dispose();
    assert.equal(path.dirname(dir), parent); assert.ok(path.basename(dir).startsWith('git-pro-conflicts-ux-')); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** Step 5: the production Conflicts HTML and script in the current theme; all four themes with GIT_PRO_RENDERER_UX_HOST=1, as the other renderer suites. */
async function rendererChecks(extension: vscode.Extension<ExtensionDiagnostics>): Promise<void> {
  const kind = vscode.window.activeColorTheme.kind, current = kind === vscode.ColorThemeKind.Light ? 'vscode-light' : kind === vscode.ColorThemeKind.HighContrast ? 'vscode-high-contrast' : kind === vscode.ColorThemeKind.HighContrastLight ? 'vscode-high-contrast-light' : 'vscode-dark';
  if (process.env.GIT_PRO_RENDERER_UX_HOST !== '1') {
    const report = await probe(extension, current);
    assert.deepEqual(report.failures, [], `Conflicts DOM checks failed: ${JSON.stringify(report.checks)}`); return;
  }
  const config = vscode.workspace.getConfiguration('workbench'), previous = config.inspect<string>('colorTheme')?.globalValue;
  try {
    for (const [theme, themeClass] of themes) {
      await config.update('colorTheme', theme, vscode.ConfigurationTarget.Global);
      const report = await probe(extension, themeClass);
      console.log(JSON.stringify({ conflictsObservation: { theme, ...report } }));
      assert.deepEqual(report.failures, [], `Conflicts DOM checks failed in ${theme}`);
    }
  } finally { await config.update('colorTheme', previous, vscode.ConfigurationTarget.Global); }
}
