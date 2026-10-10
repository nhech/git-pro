import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { mkdir, writeFile, realpath, lstat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { PathPolicy, canonicalFilePath, containsPath } from '../../src/security/paths';
import { GitExecutor } from '../../src/git/git-executor';
import { RepositoryRegistry } from '../../src/repositories/repository-registry';
import { RepositoryStore } from '../../src/state/repository-store';
import { OperationCoordinator } from '../../src/state/operation-coordinator';
import { GitService } from '../../src/git/git.service';
import type { DailyBackend } from '../../src/git/daily-backend';
import { AdvancedService } from '../../src/git/advanced/advanced.service';
import { InteractiveService } from '../../src/git/rebase/interactive.service';
import { workspaceRebaseJournal } from '../../src/git/rebase/workspace-journal';
import { Emitter } from '../../src/utils/events';
import { silentLogger } from '../../src/utils/logging';
import { gitExecutable } from '../fixtures/repository-fixture';

interface FixtureContext { state: vscode.Memento; storage: string }
export async function run(): Promise<void> {
  const stage=process.env.GIT_PRO_TEST_RESTART_STAGE;assert.ok(stage==='seed'||stage==='resume');
  const folder=vscode.workspace.workspaceFolders?.[0];assert.ok(folder);
  const root=await canonicalFilePath(folder.uri.fsPath),parent=path.dirname(root);
  assert.ok(containsPath(await realpath(tmpdir()),parent)&&path.basename(parent).startsWith('git-pro-host-')&&path.basename(root)==='workspace','Restart stays inside the harness-owned repository.');
  const fixture=vscode.extensions.getExtension<FixtureContext>('git-pro-fixture.restart-journal'),extension=vscode.extensions.getExtension('nhech.git-pro');assert.ok(fixture&&extension);await extension.activate();
  const context=await fixture.activate();assert.ok(containsPath(parent,await canonicalFilePath(context.storage)),'Memento storage stays inside the temporary profile.');
  await mkdir(context.storage,{recursive:true});const storage=await realpath(context.storage);assert.ok(containsPath(parent,storage));
  const runGit=(args:string[])=>{const result=spawnSync(gitExecutable,args,{cwd:root,env:process.env,encoding:'utf8',windowsHide:true,shell:false});assert.equal(result.status,0,result.stderr);return result.stdout;};
  if(stage==='seed'){
    for(const [key,value] of [['user.name','Fixture'],['user.email','fixture@example.invalid'],['commit.gpgsign','false'],['core.autocrlf','false'],['core.eol','lf']])runGit(['config',key!,value!]);
    runGit(['add','--','changed.txt']);runGit(['commit','-m','restart base']);await context.state.update('fixture.base',runGit(['rev-parse','HEAD']).trim());
    for(const name of ['first','second']){await writeFile(path.join(root,`${name}.txt`),`${name}\n`);runGit(['add','--',`${name}.txt`]);runGit(['commit','-m',name]);}
  }
  const policy=new PathPolicy(()=>[root],()=>true),event=new Emitter<void>(),store=new RepositoryStore();
  const executor=new GitExecutor(gitExecutable,policy,silentLogger,undefined,process.env,{node:process.execPath,helper:path.join(extension.extensionPath,'media','helpers','preserve-editor.cjs')});
  const registry=new RepositoryRegistry(policy,executor,store,silentLogger,60_000),coordinator=new OperationCoordinator(()=>policy.checkTrust());
  try{
    await registry.sync([{root,onDidChange:event.event}]);const id=registry.active!.id;
    const unsupported=async():Promise<never>=>{throw new Error('Unexpected restart fixture backend call.');};
    const backend:DailyBackend={stage:unsupported,commit:unsupported,fetch:unsupported,push:unsupported,createBranch:unsupported,checkout:unsupported,deleteBranch:unsupported,setUpstream:unsupported,remotes:unsupported};
    const git=new GitService(registry,executor,policy,coordinator,backend),advanced=new AdvancedService(git,coordinator),journal=workspaceRebaseJournal(context.state);
    const interactive=new InteractiveService(advanced,path.join(storage,'rebase-jobs'),{node:process.execPath,helper:path.join(extension.extensionPath,'media','helpers','rebase-editor.cjs')},journal);advanced.setEditorJobs(interactive);
    if(stage==='seed'){
      const base=context.state.get<string>('fixture.base');assert.ok(base);const preview=await interactive.preview(id,base);assert.equal(preview.commits.length,2);
      await interactive.execute(preview,[{oid:preview.commits[0]!.oid,action:'edit'},{oid:preview.commits[1]!.oid,action:'reword',message:'Actual VS Code Memento restart\n\nPersisted future message'}]);
      assert.equal((await advanced.snapshot(id)).operation,'rebasing');assert.ok(await journal.get(id));await context.state.update('fixture.pid',process.pid);await context.state.update('fixture.repositoryId',id);
    }else{
      assert.notEqual(context.state.get<number>('fixture.pid'),process.pid);assert.equal(context.state.get<string>('fixture.repositoryId'),id);
      const job=await journal.get(id);assert.ok(job,'Real Memento retained the owned job across VS Code processes.');assert.ok(containsPath(storage,await realpath(job.directory)));
      assert.equal((await advanced.snapshot(id)).operation,'rebasing');await advanced.control(await advanced.snapshot(id),'continue');
      assert.equal((await advanced.snapshot(id)).operation,'idle');assert.equal(await journal.get(id),undefined);await assert.rejects(lstat(job.directory),/ENOENT/);
      assert.match(runGit(['log','-1','--format=%B']),/Actual VS Code Memento restart\n\nPersisted future message/);assert.equal(runGit(['status','--porcelain']).trim(),'',runGit(['diff','--no-ext-diff','--','second.txt']));
      for(const key of ['fixture.base','fixture.pid','fixture.repositoryId'])await context.state.update(key,undefined);
    }
    console.log(`VS Code Memento fixture ${stage} passed in process ${process.pid}; adapter/services verified, native recovery UI not certified.`);
  }finally{coordinator.dispose();registry.dispose();executor.dispose();store.dispose();event.dispose();}
}
