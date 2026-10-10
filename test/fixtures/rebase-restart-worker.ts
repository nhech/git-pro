import * as path from 'node:path';
import { realpath, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PathPolicy, containsPath } from '../../src/security/paths';
import { GitExecutor } from '../../src/git/git-executor';
import { RepositoryRegistry } from '../../src/repositories/repository-registry';
import { RepositoryStore } from '../../src/state/repository-store';
import { OperationCoordinator } from '../../src/state/operation-coordinator';
import { GitService } from '../../src/git/git.service';
import type { DailyBackend } from '../../src/git/daily-backend';
import { AdvancedService } from '../../src/git/advanced/advanced.service';
import { ConflictsService } from '../../src/git/conflicts/conflicts.service';
import { InteractiveService, type RebaseJobInfo } from '../../src/git/rebase/interactive.service';
import { Emitter } from '../../src/utils/events';
import { silentLogger } from '../../src/utils/logging';
import { gitExecutable } from './repository-fixture';

async function main(){
  const [mode,requested,base]=process.argv.slice(2);if(!requested||!['seed','resume','seed-conflict','resume-conflict'].includes(mode??''))throw new Error('Invalid fixture worker arguments.');
  const root=await realpath(requested),parent=path.dirname(root);
  if(!containsPath(await realpath(tmpdir()),parent)||!path.basename(parent).startsWith('git-pro-test-')||path.basename(root)!=='repository')throw new Error('Worker only accepts an owned temporary repository.');
  const policy=new PathPolicy(()=>[root],()=>true),event=new Emitter<void>(),store=new RepositoryStore();
  const executor=new GitExecutor(gitExecutable,policy,silentLogger,undefined,process.env,{node:process.execPath,helper:path.resolve('media/helpers/preserve-editor.cjs')});
  const registry=new RepositoryRegistry(policy,executor,store,silentLogger,60_000),coordinator=new OperationCoordinator(()=>policy.checkTrust());
  try{
    await registry.sync([{root,onDidChange:event.event}]);const id=registry.active!.id;
    const unsupported=async():Promise<never>=>{throw new Error('Unexpected fixture backend action.');};
    const backend:DailyBackend={stage:unsupported,commit:unsupported,fetch:unsupported,push:unsupported,createBranch:unsupported,checkout:unsupported,deleteBranch:unsupported,setUpstream:unsupported,remotes:unsupported};
    const git=new GitService(registry,executor,policy,coordinator,backend),advanced=new AdvancedService(git,coordinator),journalFile=path.join(parent,'restart-journal.json');
    const readJournal=async():Promise<Record<string,RebaseJobInfo>>=>{try{return JSON.parse(await readFile(journalFile,'utf8')) as Record<string,RebaseJobInfo>;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return{};throw error;}};
    const interactive=new InteractiveService(advanced,path.join(parent,'restart-owned-jobs'),{node:process.execPath,helper:path.resolve('media/helpers/rebase-editor.cjs')},{get:async key=>(await readJournal())[key],put:async(key,job)=>{const jobs=await readJournal();if(job)jobs[key]=job;else delete jobs[key];await writeFile(journalFile,JSON.stringify(jobs));}});advanced.setEditorJobs(interactive);
    if(mode==='seed-conflict'){
      if(!base)throw new Error('Missing fixture base.');const preview=await interactive.preview(id,base);if(preview.commits.length!==3)throw new Error('Conflict fixture must have three commits.');
      let rejected=false;try{await interactive.execute(preview,[{oid:preview.commits[1]!.oid,action:'pick'},{oid:preview.commits[0]!.oid,action:'pick'},{oid:preview.commits[2]!.oid,action:'reword',message:'Reword after conflict process restart\n\nPersisted future message'}]);}catch{rejected=true;}
      const snapshot=await advanced.snapshot(id);if(!rejected||snapshot.operation!=='rebasing'||!snapshot.status.changes.some(change=>change.group==='conflicts')||!Object.keys(await readJournal()).length)throw new Error('Seed did not persist the reordered conflict.');
    }else if(mode==='resume-conflict'){
      const conflicts=new ConflictsService(advanced);let resolved=0;
      for(let stop=0;stop<3;stop++){
        const snapshot=await advanced.snapshot(id);if(snapshot.operation==='idle')break;
        if(snapshot.operation!=='rebasing'||!snapshot.status.changes.some(change=>change.group==='conflicts'&&change.path==='file.txt'))throw new Error('Unexpected conflict restart state.');
        await conflicts.resolve(await conflicts.preview(id,'file.txt'),'incoming');await conflicts.resolve(await conflicts.preview(id,'file.txt'),'mark');resolved++;
        try{await advanced.control(await advanced.snapshot(id),'continue');}catch(error){if(!(await advanced.snapshot(id)).status.changes.some(change=>change.group==='conflicts'))throw error;}
      }
      if(resolved!==2||(await advanced.snapshot(id)).operation!=='idle'||Object.keys(await readJournal()).length)throw new Error('Conflict recovery did not resolve both patches and clean its journal.');
    }else if(mode==='seed'){
      if(!base)throw new Error('Missing fixture base.');const preview=await interactive.preview(id,base);if(preview.commits.length!==2)throw new Error('Fixture must have two planned commits.');
      await interactive.execute(preview,[{oid:preview.commits[0]!.oid,action:'edit'},{oid:preview.commits[1]!.oid,action:'reword',message:'Reword after real process restart\n\nFuture message body'}]);
      if((await advanced.snapshot(id)).operation!=='rebasing'||!Object.keys(await readJournal()).length)throw new Error('Seed did not persist an active edit stop.');
    }else{
      const snapshot=await advanced.snapshot(id);if(snapshot.operation!=='rebasing')throw new Error('Resume requires the seeded rebase.');await advanced.control(snapshot,'continue');
      if((await advanced.snapshot(id)).operation!=='idle'||Object.keys(await readJournal()).length)throw new Error('Resume did not finish and clean its journal.');
    }
    console.log(`Fixture ${mode} passed in process ${process.pid}.`);
  }finally{coordinator.dispose();registry.dispose();executor.dispose();store.dispose();event.dispose();}
}
void main().catch(error=>{console.error(String(error));process.exitCode=1;});
