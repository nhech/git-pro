import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, readFile, writeFile, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { ExtensionDiagnostics } from '../../src/extension';
import type { GitExtension } from '../../src/types/git';

const themes=['Default Dark Modern','Default Light Modern','Default High Contrast','Default High Contrast Light'];
async function until(predicate:()=>boolean,label:string):Promise<void>{
  for(let n=0;n<400;n++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('Installed view wait exceeded 20 seconds: '+label);
}
export async function run():Promise<void>{
  assert.equal(process.platform,'linux');
  const folders=vscode.workspace.workspaceFolders;assert.equal(folders?.length,1);const root=await realpath(folders![0]!.uri.fsPath),temporary=await realpath(tmpdir()),hostParent=path.dirname(root);
  assert.equal(path.dirname(hostParent),temporary);assert.ok(path.basename(hostParent).startsWith('git-pro-host-'));assert.equal(path.basename(root),'workspace');
  const owned=await realpath(await mkdtemp(path.join(temporary,'git-pro-installed-views-'))),second=path.join(owned,'second');await mkdir(second);
  const git=(args:string[],cwd=root)=>{assert.ok(cwd===root||cwd===second);const result=spawnSync('git',args,{cwd,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'},encoding:'utf8',shell:false,windowsHide:true,timeout:10_000});assert.equal(result.status,0,result.stderr);return result.stdout;};
  const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
  const fingerprint=async(cwd:string,files:string[])=>({head:git(['rev-parse','HEAD'],cwd),refs:git(['show-ref'],cwd),index:digest(await readFile(path.join(cwd,'.git/index'))),status:git(['status','--porcelain=v2','-z'],cwd),working:git(['diff','--binary'],cwd),staged:git(['diff','--cached','--binary'],cwd),contents:Object.fromEntries(await Promise.all(files.map(async file=>[file,digest(await readFile(path.join(cwd,file)))])))});
  const workbench=vscode.workspace.getConfiguration('workbench'),config=vscode.workspace.getConfiguration('gitPro'),oldTheme=workbench.inspect<string>('colorTheme')?.globalValue,oldGrouping=config.inspect<string>('changes.groupBy')?.globalValue;
  const checks:{name:string;passed:boolean}[]=[],observations:Record<string,unknown>[]=[],fingerprints:Record<string,unknown>={};let added=false,api:ExtensionDiagnostics|undefined,failure:string|undefined;
  const check=(name:string,condition:unknown)=>{checks.push({name,passed:Boolean(condition)});assert.ok(condition,name);};
  const observe=(name:string)=>{assert.ok(api);const snapshot=api.activeSnapshot();observations.push({name,resolved:api.changesViewResolved(),active:api.activeRepository(),counts:api.viewItemCounts(),folders:vscode.workspace.workspaceFolders?.map(folder=>folder.uri.fsPath),snapshot:snapshot?{id:snapshot.id,version:snapshot.version,head:snapshot.head,oid:snapshot.oid,changes:snapshot.changes}:undefined});console.log(JSON.stringify({installedChangesObservation:observations.at(-1)}));};
  try{
    // Only owned fixture setup mutates Git. No production write command is invoked.
    await mkdir(path.join(root,'src'));await writeFile(path.join(root,'src/tracked.ts'),'baseline\n');git(['add','--','changed.txt','src/tracked.ts']);git(['commit','-m','Installed sidebar fixture baseline']);
    await writeFile(path.join(root,'changed.txt'),'staged\n');git(['add','--','changed.txt']);await writeFile(path.join(root,'changed.txt'),'working\n');await writeFile(path.join(root,'src/tracked.ts'),'working source\n');await writeFile(path.join(root,'notes.txt'),'untracked\n');
    git(['init','-b','main'],second);git(['config','commit.gpgsign','false'],second);git(['config','core.autocrlf','false'],second);await writeFile(path.join(second,'SECOND.md'),'baseline\n');git(['add','--','SECOND.md'],second);git(['commit','-m','Second repository baseline'],second);await writeFile(path.join(second,'second-notes.txt'),'untracked second\n');
    const extension=vscode.extensions.getExtension<ExtensionDiagnostics>('nhech.git-pro');assert.ok(extension);api=await extension.activate();assert.ok(api);
    const builtin=vscode.extensions.getExtension<GitExtension>('vscode.git');assert.ok(builtin);const builtinApi=(await builtin.activate()).getAPI(1);check('builtin-exported-api-enabled',builtin.exports.enabled);
    await vscode.commands.executeCommand('gitPro.refresh');await until(()=>api?.activeSnapshot()?.changes.length===4,'initial fixture status');
    const contributed=extension.packageJSON.contributes.views.gitPro as {id:string;type?:string}[];check('installed-webview-contribution',contributed.some(view=>view.id==='gitPro.changes'&&view.type==='webview'));
    const commands=await vscode.commands.getCommands();check('installed-focus-command',commands.includes('gitPro.changes.focus'));check('public-sidebar-visibility-command',commands.includes('workbench.action.toggleSidebarVisibility'));
    await vscode.commands.executeCommand('gitPro.changes.focus');await until(()=>api?.changesViewResolved()===true,'installed provider resolution');check('original-registered-view-resolved',api.changesViewResolved());
    check('initial-repository-count',api.repositories()===1);check('initial-provider-file-count',api.viewItemCounts().files===4);check('initial-provider-group-count',api.viewItemCounts().groups===3);
    check('staged-working-overlap',api.activeSnapshot()?.changes.filter(change=>change.path==='changed.txt').length===2&&api.activeSnapshot()?.changes.some(change=>change.path==='changed.txt'&&change.group==='staged')&&api.activeSnapshot()?.changes.some(change=>change.path==='changed.txt'&&change.group==='working'));
    observe('initial installed registration');
    const firstId=api.activeRepository()!;
    fingerprints.firstBefore=await fingerprint(root,['changed.txt','src/tracked.ts','notes.txt']);fingerprints.secondBefore=await fingerprint(second,['SECOND.md','second-notes.txt']);
    for(const theme of themes){await workbench.update('colorTheme',theme,vscode.ConfigurationTarget.Global);for(const grouping of ['status','folder']){
      await config.update('changes.groupBy',grouping,vscode.ConfigurationTarget.Global);await vscode.commands.executeCommand('gitPro.changes.focus');
      await until(()=>api?.changesViewResolved()===true&&api.viewItemCounts().files===4&&api.viewItemCounts().groups===3,'stable provider after focus: '+theme+' / '+grouping);
      check('setting:'+theme+':'+grouping,vscode.workspace.getConfiguration('gitPro',vscode.Uri.file(root)).get('changes.groupBy')===grouping);
      check('provider-count:'+theme+':'+grouping,api.viewItemCounts().files===4&&api.viewItemCounts().groups===3&&api.changesViewResolved());observe(theme+' / '+grouping);
    }}
    await vscode.commands.executeCommand('workbench.action.toggleSidebarVisibility');await new Promise(resolve=>setTimeout(resolve,300));
    await writeFile(path.join(root,'external-hidden.txt'),'external fixture event\n');await vscode.commands.executeCommand('gitPro.refresh');await until(()=>api?.activeSnapshot()?.changes.some(change=>change.path==='external-hidden.txt')===true,'external change while sidebar hidden');
    check('hidden-refresh-provider-count',api.viewItemCounts().files===5);observe('hidden external refresh');
    await vscode.commands.executeCommand('gitPro.changes.focus');await until(()=>api?.changesViewResolved()===true&&api.viewItemCounts().files===5,'resolved view after reopen');check('reopen-installed-view-resolved',api.changesViewResolved());check('reopen-current-data',api.activeSnapshot()?.changes.length===5&&api.viewItemCounts().files===5);observe('reopened external state');
    await unlink(path.join(root,'external-hidden.txt'));await vscode.commands.executeCommand('gitPro.refresh');await until(()=>api?.activeSnapshot()?.changes.length===4,'external fixture removal');
    check('workspace-folder-added',vscode.workspace.updateWorkspaceFolders(1,0,{uri:vscode.Uri.file(second),name:'Second fixture'}));added=true;
    await until(()=>vscode.workspace.workspaceFolders?.length===2,'workspace folder addition');check('second-exported-api-open',await builtinApi.openRepository(vscode.Uri.file(second)));
    await until(()=>api?.repositories()===2,'second production repository discovery');
    await vscode.commands.executeCommand('gitPro.selectRepository',second);await vscode.commands.executeCommand('gitPro.refresh');await until(()=>api?.activeRepository()===second&&api?.activeSnapshot()?.changes.length===1,'switch to second repository');
    check('second-provider-counts',api.viewItemCounts().files===1&&api.viewItemCounts().groups===1&&api.viewItemCounts().repositories===2);check('second-data-isolation',api.activeSnapshot()?.changes[0]?.path==='second-notes.txt');observe('selected second repository');
    await vscode.commands.executeCommand('gitPro.selectRepository',firstId);await until(()=>api?.activeRepository()===firstId&&api.activeSnapshot()?.changes.length===4,'switch back');
    check('first-data-isolation',api.viewItemCounts().files===4&&!api.activeSnapshot()?.changes.some(change=>change.path==='second-notes.txt'));observe('selected first repository again');
    check('second-workspace-folder-removed',vscode.workspace.updateWorkspaceFolders(1,1));await until(()=>vscode.workspace.workspaceFolders?.length===1&&api?.repositories()===1,'second repository removed');added=false;
    check('removed-repository-excluded',api.viewItemCounts().repositories===1&&api.activeRepository()===firstId&&api.viewItemCounts().files===4);observe('removed second workspace folder');
    fingerprints.firstAfter=await fingerprint(root,['changed.txt','src/tracked.ts','notes.txt']);fingerprints.secondAfter=await fingerprint(second,['SECOND.md','second-notes.txt']);assert.deepEqual(fingerprints.firstAfter,fingerprints.firstBefore);check('first-git-state-preserved',true);assert.deepEqual(fingerprints.secondAfter,fingerprints.secondBefore);check('second-git-state-preserved',true);
  }catch(error){failure=String(error);if(api)observe('terminal failure diagnostics');throw error;}finally{
    if(process.env.GIT_PRO_INSTALLED_CHANGES_OUTPUT)await writeFile(process.env.GIT_PRO_INSTALLED_CHANGES_OUTPUT,JSON.stringify({version:vscode.version,platform:process.platform,checks,observations,fingerprints,failure,cleanupPending:true},null,2)+'\n');
    if(added){const index=vscode.workspace.workspaceFolders?.findIndex(folder=>folder.uri.fsPath===second)??-1;if(index>=0){assert.ok(index>0);vscode.workspace.updateWorkspaceFolders(index,1);await until(()=>vscode.workspace.workspaceFolders?.length===1,'cleanup workspace');}}
    await workbench.update('colorTheme',oldTheme,vscode.ConfigurationTarget.Global);await config.update('changes.groupBy',oldGrouping,vscode.ConfigurationTarget.Global);
    if(process.env.GIT_PRO_INSTALLED_CHANGES_OUTPUT)await writeFile(process.env.GIT_PRO_INSTALLED_CHANGES_OUTPUT,JSON.stringify({version:vscode.version,platform:process.platform,checks,observations,fingerprints,failure,workspaceRestored:vscode.workspace.workspaceFolders?.length===1,settingsRestored:true,productionRuntimeInstrumented:false,fixtureViewContributed:false,rendererInjected:false,productionMutationCommandsInvoked:false,externalFixtureFileTransitions:['add/remove external-hidden.txt'],note:'Exact installed bundle original gitPro.changes focus/resolution and public diagnostics, real built-in Git discovery and read-only command refresh/repository selection. No renderer-ready receipt, DOM/visibility measurement, pixel/speech/native keyboard/screenshots or renderer mutation routing.'},null,2)+'\n');
    assert.equal(path.dirname(owned),temporary);assert.ok(path.basename(owned).startsWith('git-pro-installed-views-'));await rm(owned,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
  console.log(JSON.stringify({installedChangesChecks:checks.length,observations:observations.length,passed:true}));
}
