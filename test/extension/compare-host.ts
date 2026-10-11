import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { ExtensionDiagnostics } from '../../src/extension';
import { isChangesTab, openChangesTab } from '../../src/webviews/compare/compare-panel';
import { compareHtml } from '../../src/webviews/compare/compare-html';

const allTabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs);
async function until(condition: () => boolean, label: string, timeout = 8000): Promise<void> {
  if (condition()) return;
  await new Promise<void>((resolve, reject) => {
    const done = (error?: Error) => { clearTimeout(timer); subscription.dispose(); if (error) reject(error); else resolve(); };
    const subscription = vscode.window.tabGroups.onDidChangeTabs(() => { if (condition()) done(); });
    const timer = setTimeout(() => done(condition() ? undefined : new Error(`${label}; tabs: ${allTabs().map(tab => tab.label).join(', ')}`)), timeout);
  });
}

/**
 * Compare tab host checks (design §4 WP4), run on VS Code 1.100.0 and 1.141.0 after the view-focus checks. `root` is the harness-owned repository on
 * branch external-host-test with working changes: the topic branch is built with plumbing only, so the index, working tree and current branch stay as they
 * are, and the branch and every tab opened here are removed before returning.
 */
export async function verifyCompareHost(extension: vscode.Extension<ExtensionDiagnostics>, api: ExtensionDiagnostics, root: string): Promise<void> {
  assert.ok(extension.isActive && api.activeRepository() && root.includes('git-pro-host-'), 'Compare host checks run in the owned fixture');
  const commands = await vscode.commands.getCommands(true);
  for (const id of ['gitPro.compareWithCurrent', 'gitPro.diffWithWorkingTree', 'gitPro.compareBranches', 'gitPro.compareWithRef']) assert.ok(commands.includes(id), `Command registered: ${id}`);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Git Pro Host', GIT_AUTHOR_EMAIL: 'host@example.invalid', GIT_COMMITTER_NAME: 'Git Pro Host', GIT_COMMITTER_EMAIL: 'host@example.invalid' };
  const git = (args: string[], input?: string) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env, windowsHide: true, ...(input === undefined ? {} : { input }) }); assert.equal(result.status, 0, result.stderr); return result.stdout; };
  const before = git(['status', '--porcelain=v1', '-z', '--untracked-files=all']), head = git(['rev-parse', 'HEAD']).trim(), branch = 'compare-host-topic', ref = `refs/heads/${branch}`;
  const blob = git(['hash-object', '-w', '--stdin'], 'compare host\n').trim();
  const tree = git(['mktree', '-z'], `${git(['ls-tree', '-z', head])}100644 blob ${blob}\tcompare-host.txt\0`).trim();
  const topic = git(['commit-tree', tree, '-p', head, '-m', 'Compare host topic']).trim();
  git(['update-ref', ref, topic, '']);
  const left = vscode.Uri.from({ scheme: 'git-pro-compare-host', path: '/left/compare.txt' }), right = vscode.Uri.from({ scheme: 'git-pro-compare-host', path: '/right/compare.txt' });
  const provider = vscode.workspace.registerTextDocumentContentProvider('git-pro-compare-host', { provideTextDocumentContent: uri => uri.path.startsWith('/left/') ? 'before\n' : 'after\n' });
  const title = 'Git Pro Compare host check · All Changes', sameLabel = vscode.window.createWebviewPanel('gitPro.compareHostProbe', title, { viewColumn: vscode.ViewColumn.Active, preserveFocus: true }, {});
  const compareTabs = () => allTabs().filter(tab => tab.input instanceof vscode.TabInputWebview && tab.label.startsWith('Compare: ') && tab.label.includes(branch));
  // 1.141 labels a multi-diff tab "<title> (1 file)"; 1.100 uses the title alone.
  const multiDiffTabs = () => allTabs().filter(tab => isChangesTab(tab, title)), sameLabelTabs = () => allTabs().filter(tab => tab.label === title && tab.input instanceof vscode.TabInputWebview);
  try {
    // Branch Actions / Branches view: Compare with Current pins both refs and opens one tab per pair.
    const node = { kind: 'branch', repositoryId: api.activeRepository(), branch: { name: branch, ref, oid: topic, remote: false, upstream: '', worktree: '' } };
    await vscode.commands.executeCommand('gitPro.compareWithCurrent', node);
    await until(() => compareTabs().length === 1, 'Compare with Current opens the Compare tab');
    await vscode.commands.executeCommand('gitPro.compareWithCurrent', node);
    assert.equal(compareTabs().length, 1, 'The same pair reveals the open Compare tab instead of opening another');
    // vscode.changes always opens a new tab; Open All Changes replaces its own multi-diff tab and leaves a webview tab with the same label alone.
    const resources = [[vscode.Uri.file(path.join(root, 'compare-host.txt')), left, right] as const];
    await openChangesTab(title, resources);
    await until(() => multiDiffTabs().length === 1, 'vscode.changes opens one multi-diff tab');
    await openChangesTab(title, resources);
    await until(() => multiDiffTabs().length === 1 && sameLabelTabs().length === 1, 'Reopening replaces the multi-diff tab');
    const input = multiDiffTabs()[0]!.input as { textDiffs: { original?: vscode.Uri; modified?: vscode.Uri }[] };
    assert.equal(input.textDiffs.length, 1); assert.equal(input.textDiffs[0]?.original?.toString(), left.toString()); assert.equal(input.textDiffs[0]?.modified?.toString(), right.toString());
    assert.equal(sameLabelTabs().length, 1, 'The webview tab sharing the label stays open');
  } finally {
    const owned = allTabs().filter(tab => compareTabs().includes(tab) || isChangesTab(tab, title));
    if (owned.length) await vscode.window.tabGroups.close(owned, true);
    sameLabel.dispose(); provider.dispose();
    git(['update-ref', '-d', ref, topic]);
  }
  assert.equal(git(['status', '--porcelain=v1', '-z', '--untracked-files=all']), before, 'The harness working tree and index are unchanged');
  await rendererChecks(extension);
  console.log('Git Pro Compare host passed: Compare with Current opened one Compare tab per pinned pair; vscode.changes opened one multi-diff tab and reopening replaced it, leaving a same-label webview tab open; the Compare renderer passed its DOM checks.');
}

const themes = [['Default Dark Modern', 'vscode-dark'], ['Default Light Modern', 'vscode-light'], ['Default High Contrast', 'vscode-high-contrast'], ['Default High Contrast Light', 'vscode-high-contrast-light']] as const;
const oid = (digit: string) => digit.repeat(40), hostile = '<img src=x onerror=alert(1)> Add login';
const commit = (digit: string, subject: string) => ({ oid: oid(digit), subject, author: 'Fixture', timestamp: 1700000000, refs: [] as string[] });
const probeState = { type: 'state', revision: 1, mode: 'commits', left: { name: 'feature', oid: oid('1'), current: false }, right: { name: 'main', oid: oid('2'), current: true }, swapped: false, head: 'main', filesMode: 'fork', moved: [], loading: false,
  fork: { oid: oid('3'), multiple: false }, sides: { leftOnly: { count: 2, offset: 0, commits: [commit('a', hostile), commit('b', 'Second feature commit')] }, rightOnly: { count: 1, offset: 0, commits: [commit('c', 'Bump deps')] } },
  files: { scope: 'fork', from: oid('3'), to: oid('1'), total: 3, offset: 0, omitted: false, binary: 1, items: [
    { index: 0, status: 'M', path: 'src/app.ts', added: 3, removed: 1, binary: false }, { index: 1, status: 'A', path: 'src/login.ts', added: 20, removed: 0, binary: false }, { index: 2, status: 'A', path: 'logo.png', added: null, removed: null, binary: true }] } };
// Runs before the production script in a test-owned panel. It relays the production messages, and replays host states itself to check the empty state.
const driver = `(() => {
  const bridge=acquireVsCodeApi(),session=document.body.dataset.session;let running=false;
  window.acquireVsCodeApi=()=>({getState:()=>undefined,setState:()=>undefined,postMessage:value=>bridge.postMessage(value)});
  const settle=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))),byId=id=>document.getElementById(id);
  window.addEventListener('message',async event=>{
    const data=event.data;if(data?.type!=='compareProbe'||data.session!==session||running)return;running=true;
    const checks=[],failures=[];const check=(name,ok)=>{checks.push({name,passed:Boolean(ok)});if(!ok)failures.push(name);};
    try{
      await document.fonts.ready;for(let i=0;i<150&&!document.body.classList.contains(data.themeClass);i++)await settle();await settle();
      check('actual-host-theme',document.body.classList.contains(data.themeClass));
      const tree=byId('file-rows');
      check('tree-owns-only-treeitems',tree.getAttribute('role')==='tree'&&tree.children.length===4&&[...tree.children].every(node=>node.getAttribute('role')==='treeitem'));
      for(const node of document.querySelectorAll('.tree-row,.commit-row'))check('row-height:'+(node.dataset.focusKey||node.className),Math.round(node.getBoundingClientRect().height)===22);
      check('no-horizontal-page-scroll',document.documentElement.scrollWidth<=innerWidth+1);
      check('literal-hostile-subject',!document.querySelector('img')&&[...document.querySelectorAll('.subject-text')].some(node=>node.textContent===data.hostile));
      check('accent-marks-current-only',document.querySelectorAll('.ref.current').length===1&&document.querySelector('.ref.current .ref-name')?.textContent==='main');
      check('one-tab-stop-per-list',[...document.querySelectorAll('.commit-rows')].every(list=>[...list.children].filter(node=>node.tabIndex===0).length===1));
      const color=node=>getComputedStyle(node).color,dot=document.querySelector('.ref.current .current-dot');
      check('current-marker-coloured',Boolean(dot)&&color(dot)!==color(document.body));
      window.dispatchEvent(new MessageEvent('message',{data:{...data.state,revision:2,files:{...data.state.files,total:0,binary:0,items:[]}}}));await settle();
      check('empty-state-outside-tree',tree.hidden&&tree.children.length===0&&!byId('files-empty').hidden&&byId('files-empty').textContent==='No differences.');
      bridge.postMessage({type:'compareReport',session,checks,failures,width:innerWidth,themeClass:data.themeClass});
    }catch(error){bridge.postMessage({type:'compareError',session,error:String(error),checks,failures});}
  });
})();`;

async function probe(extension: vscode.Extension<ExtensionDiagnostics>, themeClass: string): Promise<{ failures: string[]; checks: unknown[] }> {
  const parent = await realpath(tmpdir()), dir = await realpath(await mkdtemp(path.join(parent, 'git-pro-compare-ux-')));
  let panel: vscode.WebviewPanel | undefined, receiver: vscode.Disposable | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const script = vscode.Uri.file(path.join(dir, 'probe.js')); await writeFile(script.fsPath, driver);
    panel = vscode.window.createWebviewPanel('gitPro.compareUxFixture', 'Git Pro: Compare UX Check', vscode.ViewColumn.One, { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extension.extensionUri, 'media'), vscode.Uri.file(dir)] });
    const session = randomUUID(), nonce = randomUUID().replace(/-/g, ''), resource = (name: string) => panel!.webview.asWebviewUri(vscode.Uri.joinPath(extension.extensionUri, 'media', name)).toString();
    const html = compareHtml({ session, nonce, cspSource: panel.webview.cspSource, resource }), anchor = `<script nonce="${nonce}" src="${resource('compare.js')}">`;
    assert.equal(html.split(anchor).length, 2);
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Compare DOM probe exceeded 30 seconds.')), 30_000);
      receiver = panel!.webview.onDidReceiveMessage((value: unknown) => {
        const data = value as Record<string, unknown> | undefined; if (!data || data.session !== session) return;
        // Production requests are not answered; nothing reaches Git.
        if (data.type === 'ready') void (async () => {
          await panel!.webview.postMessage({ ...probeState, session });
          await panel!.webview.postMessage({ type: 'compareProbe', session, themeClass, hostile, state: { ...probeState, session } });
        })().catch(reject);
        if (data.type === 'compareError') reject(new Error(JSON.stringify(data)));
        if (data.type === 'compareReport') resolve(data as { failures: string[]; checks: unknown[] });
      });
      panel!.webview.html = html.replace(anchor, `<script nonce="${nonce}" src="${panel!.webview.asWebviewUri(script)}"></script>${anchor}`);
    });
  } finally {
    if (timer) clearTimeout(timer); receiver?.dispose(); panel?.dispose();
    assert.equal(path.dirname(dir), parent); assert.ok(path.basename(dir).startsWith('git-pro-compare-ux-')); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** §3.15: the production Compare HTML and script in the current theme; all four themes with GIT_PRO_RENDERER_UX_HOST=1, as the other renderer suites. */
async function rendererChecks(extension: vscode.Extension<ExtensionDiagnostics>): Promise<void> {
  const kind = vscode.window.activeColorTheme.kind, current = kind === vscode.ColorThemeKind.Light ? 'vscode-light' : kind === vscode.ColorThemeKind.HighContrast ? 'vscode-high-contrast' : kind === vscode.ColorThemeKind.HighContrastLight ? 'vscode-high-contrast-light' : 'vscode-dark';
  if (process.env.GIT_PRO_RENDERER_UX_HOST !== '1') {
    const report = await probe(extension, current);
    assert.deepEqual(report.failures, [], `Compare DOM checks failed: ${JSON.stringify(report.checks)}`); return;
  }
  const config = vscode.workspace.getConfiguration('workbench'), previous = config.inspect<string>('colorTheme')?.globalValue;
  try {
    for (const [theme, themeClass] of themes) {
      await config.update('colorTheme', theme, vscode.ConfigurationTarget.Global);
      const report = await probe(extension, themeClass);
      console.log(JSON.stringify({ compareObservation: { theme, ...report } }));
      assert.deepEqual(report.failures, [], `Compare DOM checks failed in ${theme}`);
    }
  } finally { await config.update('colorTheme', previous, vscode.ConfigurationTarget.Global); }
}
