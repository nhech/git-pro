import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { writeFile, mkdir, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import {configureFixtureSigning} from '../fixtures/signing-fixture';
import {recoveryFor} from '../../src/utils/recovery';
import { tmpdir } from 'node:os';
import { Session } from 'node:inspector';
import { getHeapStatistics } from 'node:v8';
import { measureHistoryRenderer } from './renderer';
import { verifyHistoryRendererUx } from './history-ux-renderer';
import { recordHostMetric } from './host-metrics';
import { canonicalFilePath, containsPath } from '../../src/security/paths';
import type { ExtensionDiagnostics } from '../../src/extension';
import { BuiltinGitAdapter } from '../../src/git/builtin-git.adapter';
import { advancedFixture } from '../fixtures/advanced-fixture';
import { InteractiveService, type RebaseJobInfo } from '../../src/git/rebase/interactive.service';
import { RebasePlanner } from '../../src/webviews/rebase/rebase-planner';
async function webviewTab(label: string): Promise<void> {
  const exists = () => vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => tab.input instanceof vscode.TabInputWebview && tab.label === label);
  if (exists()) return;
  await new Promise<void>((resolve,reject) => {
    const subscription = vscode.window.tabGroups.onDidChangeTabs(() => { if (exists()) { clearTimeout(timer);subscription.dispose();resolve(); } });
    const timer = setTimeout(() => { subscription.dispose();reject(new Error(`Missing webview tab ${label}; tabs: ${vscode.window.tabGroups.all.flatMap(group=>group.tabs).map(tab=>tab.label).join(', ')}`)); },5000);
    if (exists()) { clearTimeout(timer);subscription.dispose();resolve(); }
  });
}
export async function run(): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([runHostChecks(), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Extension host checks exceeded time budget; inspect modal/errors in host logs.')), process.env.GIT_PRO_STRESS_HOST==='1'?300_000:90_000); })]); }
  finally { if (timeout) clearTimeout(timeout); }
}
async function runHostChecks(): Promise<void> {
  const extension = vscode.extensions.getExtension<ExtensionDiagnostics>('nhech.git-pro');
  assert.ok(extension, 'Git Pro extension is installed in the test host');
  const api = await extension.activate();
  assert.ok(api, 'Foundation activation returned diagnostics');
  const commands = await vscode.commands.getCommands(true);
  const contributed=extension.packageJSON.contributes.commands as {command:string}[];
  for (const {command} of contributed) {
    assert.ok(commands.includes(command), `Command registered: ${command}`);
  }
  assert.ok(api.capabilities().enabled, 'Built-in Git API active');
  assert.equal(api.repositories(), 1, 'Temporary repository detected');
  assert.ok(api.activeRepository());
  assert.equal(api.activeSnapshot()?.head, 'main');
  assert.equal(api.activeSnapshot()?.changes[0]?.path, 'changed.txt');
  assert.equal(api.viewItemCounts().repositories, 1);
  assert.equal(api.viewItemCounts().groups, 1); assert.equal(api.viewItemCounts().files, 1);
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(root);
  // This is the harness-owned temporary repository, not the development workspace.
  assert.ok(root.includes('git-pro-host-'));
  await writeFile(path.join(root, 'second.txt'), 'another change');
  const git = spawnSync('git', ['switch', '-c', 'external-host-test'], { cwd: root, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  await vscode.commands.executeCommand('gitPro.refresh');
  assert.equal(api.activeSnapshot()?.head, 'external-host-test');
  assert.equal(api.viewItemCounts().files, 2);
  await mkdir(path.join(root,'folder'));await writeFile(path.join(root,'folder','nested.txt'),'nested change');await vscode.commands.executeCommand('gitPro.refresh');
  await vscode.workspace.getConfiguration('gitPro').update('changes.groupBy','folder',vscode.ConfigurationTarget.Workspace);
  const groupedFiles=api.viewItemCounts().files;assert.ok(groupedFiles>=3,'Folder grouping retains changed files, including host-created workspace settings');
  for(const file of ['changed.txt','second.txt','folder/nested.txt'])assert.ok(api.activeSnapshot()?.changes.some(change=>change.path===file),`Grouping retains ${file}`);
  await vscode.workspace.getConfiguration('gitPro').update('changes.groupBy','status',vscode.ConfigurationTarget.Workspace);
  assert.equal(api.viewItemCounts().files,api.activeSnapshot()?.changes.length,'Status grouping retains every current snapshot entry');
  const adapter = new BuiltinGitAdapter(); await adapter.initialize();
  try {
    await vscode.commands.executeCommand('gitPro.stage', vscode.Uri.file(path.join(root, 'changed.txt')));
    await vscode.commands.executeCommand('gitPro.refresh');
    assert.equal(api.activeSnapshot()?.changes.find(c => c.path === 'changed.txt')?.group, 'staged');
    await vscode.commands.executeCommand('gitPro.unstage', vscode.Uri.file(path.join(root, 'changed.txt')));
    assert.equal(api.activeSnapshot()?.changes.find(c => c.path === 'changed.txt')?.group, 'untracked');
    await vscode.commands.executeCommand('gitPro.stage', vscode.Uri.file(path.join(root, 'changed.txt')));
    await writeFile(path.join(root, 'changed.txt'), 'unstaged after staging');
    const staged = spawnSync('git', ['show', ':changed.txt'], { cwd: root, encoding: 'utf8' }).stdout;
    await vscode.workspace.getConfiguration('git').update('enableSmartCommit', true, vscode.ConfigurationTarget.Workspace);
    await adapter.dailyBackend().commit(root, 'host staged-only', { amend: false, signoff: true, noVerify: false });
    const committed = spawnSync('git', ['show', 'HEAD:changed.txt'], { cwd: root, encoding: 'utf8' });
    assert.equal(committed.status, 0, committed.stderr); assert.equal(committed.stdout, staged);
    await vscode.commands.executeCommand('gitPro.refresh');
    assert.ok(api.activeSnapshot()?.changes.some(c => c.path === 'changed.txt' && c.group === 'working'));
    await assert.rejects(adapter.dailyBackend().commit(root, 'must not smart stage', { amend: false, signoff: false, noVerify: false }), /Stage changes/);
    const runSigningGit=(args:string[])=>{const result=spawnSync('git',args,{cwd:root,env:process.env,encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);return result.stdout;};
    const signing=await configureFixtureSigning(root,path.dirname(root),runSigningGit,process.env);
    try{
      await writeFile(path.join(root,'signing-test.txt'),'signed by real adapter\n');await adapter.dailyBackend().stage(root,[path.join(root,'signing-test.txt')]);
      await adapter.dailyBackend().commit(root,'host SSH signed fixture',{amend:false,signoff:false,noVerify:false});
      const signed=runSigningGit(['rev-parse','HEAD']).trim();assert.match(runSigningGit(['cat-file','commit',signed]),/BEGIN SSH SIGNATURE/);runSigningGit(['verify-commit',signed]);
      await writeFile(path.join(root,'signing-test.txt'),'staged signing failure\n');await adapter.dailyBackend().stage(root,[path.join(root,'signing-test.txt')]);const index=runSigningGit(['ls-files','--stage']);
      runSigningGit(['config','user.signingkey',signing.key+'-missing']);
      await assert.rejects(adapter.dailyBackend().commit(root,'must preserve signing requirement',{amend:false,signoff:false,noVerify:false}),error=>/will not disable signing/.test(recoveryFor(error).message));
      assert.equal(runSigningGit(['rev-parse','HEAD']).trim(),signed);assert.equal(runSigningGit(['ls-files','--stage']),index);assert.equal(runSigningGit(['config','commit.gpgsign']).trim(),'true');
      assert.equal(runSigningGit(['show',':signing-test.txt']),'staged signing failure\n');
      await recordHostMetric({hostSuiteStage:'ssh-signing-verified',realSignatureVerified:true,failedSignerPreservesHeadIndexAndRequirement:true,nativeSigningUiCertified:false});
      console.log('Git Pro built-in adapter signing passed: real SSH signature verified; failed signer preserves HEAD, staged index and signing requirement. Native pinentry/account UI is not certified.');
    }finally{runSigningGit(['config','commit.gpgsign','false']);runSigningGit(['restore','--staged','signing-test.txt']);runSigningGit(['restore','signing-test.txt']);}
    await vscode.commands.executeCommand('gitPro.refresh');
    const remote = path.join(path.dirname(root), 'remote.git');
    await adapter.dailyBackend().fetch(root, 'origin');
    await adapter.dailyBackend().push(root, 'origin', 'external-host-test', true);
    const remoteHead = spawnSync('git', ['rev-parse', 'refs/heads/external-host-test'], { cwd: remote, encoding: 'utf8' });
    assert.equal(remoteHead.status, 0, remoteHead.stderr);
    assert.equal(remoteHead.stdout, spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout);
    const change = api.activeSnapshot()?.changes.find(c => c.path === 'changed.txt' && c.group === 'working'); assert.ok(change);
    await vscode.commands.executeCommand('gitPro.diff', { kind: 'file', repositoryId: api.activeRepository(), change });
    assert.ok(vscode.window.tabGroups.all.flatMap(g => g.tabs).some(tab => tab.input instanceof vscode.TabInputTextDiff));
    await vscode.commands.executeCommand('gitPro.history');
    await webviewTab('Git Pro: History & Compare');
    await vscode.commands.executeCommand('gitPro.fileHistory', vscode.Uri.file(path.join(root,'changed.txt')));
    await webviewTab('Git Pro: File History');
    assert.equal(vscode.workspace.getConfiguration('gitPro').get('blame.enabled'),false);
    await vscode.commands.executeCommand('gitPro.toggleBlame');
    const lensUri = vscode.Uri.file(path.join(root, 'changed.txt'));
    const lensDocument = await vscode.workspace.openTextDocument(lensUri);
    const lensConfig = vscode.workspace.getConfiguration('gitPro', lensUri);
    assert.equal(lensConfig.get('codeLens.enabled'), false);
    const headBeforeLenses = api.activeSnapshot()?.oid;
    await lensConfig.update('codeLens.enabled', true, vscode.ConfigurationTarget.Workspace);
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', lensUri);
    const historyLens = lenses?.find(lens => lens.command?.command === 'gitPro.fileHistory');
    assert.ok(historyLens); assert.equal(historyLens.command!.arguments?.[0].toString(), lensDocument.uri.toString());
    await vscode.commands.executeCommand(historyLens.command!.command, ...historyLens.command!.arguments!);
    assert.equal(api.activeSnapshot()?.oid, headBeforeLenses);
    await lensConfig.update('codeLens.enabled', false, vscode.ConfigurationTarget.Workspace);
    const disabledLenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', lensUri);
    assert.ok(!disabledLenses?.some(lens => lens.command?.command === 'gitPro.fileHistory'));
    assert.equal(vscode.workspace.getConfiguration('gitPro').get('blame.enabled'),true);
    await vscode.commands.executeCommand('gitPro.toggleBlame');
  } finally { adapter.dispose(); }
  if(process.env.GIT_PRO_TEST_MERGE==='1'){
    const canonicalRoot=await canonicalFilePath(root);assert.ok(containsPath(await realpath(tmpdir()),canonicalRoot)&&canonicalRoot.includes('git-pro-host-'),'Native merge test stays in the owned host fixture');
    const runGit=(args:string[])=>{const result=spawnSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);return result.stdout;};
    runGit(['stash','push','--include-untracked','-m','host changes before merge bridge']);
    await writeFile(path.join(root,'merge-conflict.txt'),'base\n');runGit(['add','merge-conflict.txt']);runGit(['commit','-m','merge base']);runGit(['switch','-c','host-merge-side']);
    await writeFile(path.join(root,'merge-conflict.txt'),'side\n');runGit(['commit','-am','merge side']);runGit(['switch','external-host-test']);await writeFile(path.join(root,'merge-conflict.txt'),'current\n');runGit(['commit','-am','merge current']);
    const conflicted=spawnSync('git',['merge','host-merge-side'],{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(conflicted.status,1);assert.match(runGit(['status','--porcelain']),/UU/);
    await vscode.workspace.getConfiguration('git').update('mergeEditor',true,vscode.ConfigurationTarget.Workspace);await vscode.commands.executeCommand('gitPro.refresh');
    await vscode.commands.executeCommand('git.openMergeEditor',vscode.Uri.file(path.join(root,'merge-conflict.txt')));
    assert.ok(vscode.window.tabGroups.all.flatMap(group=>group.tabs).some(tab=>tab.label.includes('merge-conflict.txt')),'Contributed Git merge command opens the reviewed conflict result editor');
    const mergeTabs=vscode.window.tabGroups.all.flatMap(group=>group.tabs).filter(tab=>tab.label.includes('merge-conflict.txt'));
    if(mergeTabs.length)await vscode.window.tabGroups.close(mergeTabs);
    runGit(['merge','--abort']);console.log('Native merge bridge command passed: real conflict opened its result editor. Stable tab API does not certify three-way rendering; visual/resolution interaction remains manual.');
  }
  await vscode.commands.executeCommand('gitPro.repositories.focus');
  await vscode.commands.executeCommand('gitPro.changes.focus');
  for(let attempt=0;attempt<40&&!api.changesViewResolved();attempt++)await new Promise(resolve=>setTimeout(resolve,25));
  assert.ok(api.changesViewResolved(),'Custom Changes WebviewView resolves when focused.');
  await vscode.commands.executeCommand('gitPro.commitView.focus');
  await vscode.commands.executeCommand('gitPro.branchesView.focus');
  await vscode.commands.executeCommand('gitPro.toolsView.focus');
  if(process.env.GIT_PRO_STRESS_HOST==='1'){
    const closeHistory=async()=>{const tabs=vscode.window.tabGroups.all.flatMap(group=>group.tabs).filter(tab=>tab.input instanceof vscode.TabInputWebview&&tab.label.startsWith('Git Pro:'));if(tabs.length)await vscode.window.tabGroups.close(tabs);assert.equal(api.historyPanelCount(),0);};
    const inspector=new Session();inspector.connect();
    const cycle=async()=>{await vscode.commands.executeCommand('gitPro.history');await webviewTab('Git Pro: History & Compare');assert.equal(api.historyPanelCount(),1);await closeHistory();};
    const collect=async()=>{
      // Wait for owned cancellation callbacks before collecting the whole host.
      await new Promise(resolve=>setTimeout(resolve,1000));
      await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('Owned host heap collection exceeded ten seconds.')),10_000);
        inspector.post('HeapProfiler.collectGarbage',error=>{clearTimeout(timer);if(error)reject(error);else resolve();});
      });
      const memory=process.memoryUsage();
      return {heapUsed:getHeapStatistics().used_heap_size,external:memory.external,arrayBuffers:memory.arrayBuffers};
    };
    try{
      await closeHistory();for(let i=0;i<10;i++)await cycle();const baseline=await collect(),start=Date.now(),samples=[];
      for(let batch=0;batch<2;batch++){
        for(let i=0;i<100;i++)await cycle();
        const sample=await collect();
        const incrementalBytes=Math.max(0,sample.heapUsed-baseline.heapUsed)+Math.max(0,sample.external-baseline.external);
        samples.push({cycles:(batch+1)*100,...sample,incrementalBytes});
        assert.equal(api.historyPanelCount(),0);
        assert.ok(incrementalBytes<128*1024*1024,`Collected host growth exceeds 128 MiB after ${(batch+1)*100} panel cycles: ${incrementalBytes}`);
      }
      await recordHostMetric({historyPanelCycles:200,warmupCycles:10,remainingPanels:api.historyPanelCount(),elapsedMs:Date.now()-start,collection:'in-process HeapProfiler.collectGarbage',baseline,samples,note:'Collected whole extension-host heap/external growth for panel disposal/cancellation; not extension-only object retention, loaded 2000-row retention, renderer frame timing or screen-reader certification.'});
    }finally{inspector.disconnect();}
    await measureHistoryRenderer(extension);
  }
  if(process.env.GIT_PRO_RENDERER_UX_HOST==='1'||process.env.GIT_PRO_STRESS_HOST==='1')await verifyHistoryRendererUx(extension);
  const f=await advancedFixture(path.join(extension.extensionPath,'media','helpers','preserve-editor.cjs'));
  try{
    const base=await f.commit('base.txt','base\n','root'),a=await f.commit('a.txt','a\n','first'),b=await f.commit('b.txt','b\n','second');const jobs=new Map<string,RebaseJobInfo>();
    const interactive=new InteractiveService(f.advanced,path.join(f.parent,'host editor jobs'),{node:process.execPath,helper:path.join(extension.extensionPath,'media','helpers','rebase-editor.cjs')},{get:async id=>jobs.get(id),put:async(id,job)=>{if(job)jobs.set(id,job);else jobs.delete(id);}});f.advanced.setEditorJobs(interactive);
    const preview=await interactive.preview(f.id,base),planner=new RebasePlanner({extensionUri:extension.extensionUri});
    try{
      const draft=planner.choose(preview,f.root,async()=>{throw new Error('Closing the planner must not invoke message editing.');});await webviewTab('Git Pro: Interactive Rebase');
      const tabs=vscode.window.tabGroups.all.flatMap(group=>group.tabs).filter(tab=>tab.input instanceof vscode.TabInputWebview&&tab.label==='Git Pro: Interactive Rebase');assert.equal(tabs.length,1);await vscode.window.tabGroups.close(tabs);
      assert.equal(await draft,undefined);assert.equal(f.git(['rev-parse','HEAD']).trim(),b);assert.equal(jobs.size,0);
    }finally{planner.dispose();}
    await interactive.execute(preview,[{oid:a,action:'edit'},{oid:b,action:'reword',message:'Host reword\n\nElectron helper body'}]);
    assert.equal((await f.advanced.snapshot(f.id)).operation,'rebasing');await f.advanced.control(await f.advanced.snapshot(f.id),'continue');assert.equal(jobs.size,0);assert.match(f.git(['log','-1','--format=%B']),/Electron helper body/);
  }finally{await f.close();}
  await recordHostMetric({hostSuiteStage:'complete-existing-suite',dailyAndHistoryAssertionsResolved:true,ownedElectronRebaseEditRewordContinueResolved:true,nativeMergeBranchEnabled:process.env.GIT_PRO_TEST_MERGE==='1'});
  console.log('Git Pro host passed: daily workflows, History/File History, blame setting, advanced command registrations and owned Electron editor rebase edit/reword/continue.');
}
