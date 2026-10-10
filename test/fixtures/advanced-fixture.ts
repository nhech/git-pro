import * as path from 'node:path';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { fixture, gitExecutable } from './repository-fixture';
import { GitExecutor } from '../../src/git/git-executor';
import { PathPolicy } from '../../src/security/paths';
import { RepositoryRegistry } from '../../src/repositories/repository-registry';
import { RepositoryStore } from '../../src/state/repository-store';
import { OperationCoordinator } from '../../src/state/operation-coordinator';
import { Emitter } from '../../src/utils/events';
import { silentLogger } from '../../src/utils/logging';
import { GitService } from '../../src/git/git.service';
import { AdvancedService } from '../../src/git/advanced/advanced.service';
import type { DailyBackend } from '../../src/git/daily-backend';
export async function advancedFixture(helperSource=path.resolve('media/helpers/preserve-editor.cjs'),repositoryOnly=false) {
  const f = await fixture(), policy = new PathPolicy(()=>repositoryOnly?[f.root]:[f.parent],()=>true);
  const helperDir = path.join(f.parent,"editor's path with spaces"); await mkdir(helperDir);
  const helper = path.join(helperDir,'preserve-editor.cjs'); await copyFile(helperSource,helper);
  const executor = new GitExecutor(gitExecutable,policy,silentLogger,undefined,f.env,{node:process.execPath,helper});
  const store = new RepositoryStore(), registry = new RepositoryRegistry(policy,executor,store,silentLogger,60_000), event = new Emitter<void>(), coordinator = new OperationCoordinator(()=>policy.checkTrust());
  const unsupported = async (): Promise<never> => {throw new Error('Unexpected daily backend action.');};
  const backend: DailyBackend = {stage:unsupported,commit:unsupported,fetch:unsupported,push:unsupported,createBranch:unsupported,checkout:unsupported,deleteBranch:unsupported,setUpstream:unsupported,remotes:unsupported};
  await registry.sync([{root:f.root,onDidChange:event.event}]);
  const git = new GitService(registry,executor,policy,coordinator,backend), advanced = new AdvancedService(git,coordinator), id = registry.active!.id;
  const commit = async (file:string,content:string,message:string) => {await writeFile(path.join(f.root,file),content);f.git(['add','--',file]);f.git(['commit','-m',message]);return f.git(['rev-parse','HEAD']).trim();};
  const close = async()=>{coordinator.dispose();registry.dispose();executor.dispose();store.dispose();event.dispose();await f.cleanup();};
  return {...f,policy,executor,gitService:git,registry,coordinator,advanced,id,event,commit,close};
}
