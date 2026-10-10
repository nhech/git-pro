import * as path from 'node:path';
import { lstat, readdir } from 'node:fs/promises';
import { PathPolicy, canonicalFilePath, type WorktreeDestinationGrant } from '../../security/paths';
import type { OperationSnapshot } from '../advanced/advanced.service';
import { ToolsService } from './tools.service';
import { buildToolsMutation, type ToolsMutation } from './tools-builders';
import { parseStatus } from '../git-parser';
import { detectOperation } from '../../state/operation-state';
type Command=Extract<ToolsMutation,{kind:'worktreeAdd'|'worktreeRemove'|'worktreePrune'}>;
export interface WorktreePreview {snapshot:OperationSnapshot;command:Command;fingerprint:string;details:readonly string[]}

/** Destination authorization is per review; it never broadens the executor policy. */
export class WorktreeService {
  private readonly previews=new WeakSet<WorktreePreview>();
  private readonly grants=new WeakMap<WorktreePreview,WorktreeDestinationGrant>();
  constructor(private readonly tools:ToolsService,private readonly policy:PathPolicy){}
  async destinationNeedsApproval(destination:string):Promise<boolean>{
    const canonical=await canonicalFilePath(destination);
    if(canonical!==path.resolve(destination))throw new Error('Choose a canonical destination without symlink or alias parents.');
    try{try{await this.policy.authorizeRoot(canonical);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await this.policy.authorizeRoot(path.dirname(canonical));}return false;}
    catch(error){if(error instanceof Error&&error.message==='Repository is outside the workspace. Open its root folder explicitly.')return true;throw error;}
  }
  approveDestination(destination:string):Promise<WorktreeDestinationGrant>{return this.policy.approveWorktreeDestination(destination);}
  private async inspect(id:string,command:Command,grant?:WorktreeDestinationGrant):Promise<{fingerprint:string;details:string[]}>{
    const repo=this.tools.advanced.git.repository(id),list=await this.tools.worktrees(id);
    const fingerprintParts=[JSON.stringify(list)];let details:string[]=[];
    if(command.kind==='worktreeAdd'){
      const destination=await canonicalFilePath(command.destination);
      if(destination!==path.resolve(command.destination))throw new Error('Choose a canonical destination without symlink or alias parents.');
      if(grant)await this.policy.authorizeWorktreeDestination(destination,grant);else await this.policy.authorizeRoot(path.dirname(destination));
      const info=await lstat(destination).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;});
      if(info&&(!info.isDirectory()||info.isSymbolicLink()||(await readdir(destination)).length))throw new Error('Worktree destination must be absent or an empty regular directory.');
      fingerprintParts.push(info?'empty-directory':'absent');details=[destination,command.branch?`New branch: ${command.branch}`:'Detached HEAD',command.oid];
    }else if(command.kind==='worktreeRemove'){
      const destination=grant?await this.policy.authorizeWorktreeDestination(command.destination,grant):await this.policy.authorizeRoot(command.destination);
      const canonical=await Promise.all(list.map(async item=>({item,canonical:await canonicalFilePath(item.path)})));
      const selected=canonical.find(entry=>entry.canonical===destination);
      if(!selected)throw new Error('Select a registered worktree.');
      if(selected===canonical[0]||destination===repo.root||selected.item.bare)throw new Error('The primary or active repository cannot be removed.');
      if(selected.item.locked||selected.item.prunable)throw new Error('Locked or missing worktrees require native Git review.');
      const external=grant?await this.tools.advanced.git.executor.inspectLinkedWorktree(repo.root,destination,grant):undefined;
      const gitDir=external?.gitDir??(await this.tools.advanced.git.executor.read(destination,{kind:'metadata',field:'gitDir'})).stdout.toString('utf8').trim();
      if(await detectOperation(gitDir)!=='idle')throw new Error('Finish the linked worktree Git operation before removal.');
      const status=external?.status??(await this.tools.advanced.git.executor.read(destination,{kind:'status'})).stdout;
      if(parseStatus(status).changes.length)throw new Error('Worktree contains changes or untracked files. Commit or stash them first.');
      fingerprintParts.push(status.toString('base64'));details=[destination,selected.item.branch??'Detached HEAD'];
    }else{
      // Prune changes administrative records in the trusted owner's commonDir,
      // never removes an external working directory. Keep Git's expiry/locks.
      const result=await this.tools.advanced.git.executor.read(repo.root,{kind:'worktreePrunePreview'});
      const dry=Buffer.concat([result.stdout,result.stderr]).toString('utf8');
      fingerprintParts.push(dry);details=[`Administrative metadata only: ${repo.commonDir}`,...dry.split(/\r?\n/).filter(Boolean)];
    }
    return {fingerprint:JSON.stringify(fingerprintParts),details};
  }
  async preview(id:string,command:Command,grant?:WorktreeDestinationGrant):Promise<WorktreePreview>{
    buildToolsMutation(command);const snapshot=await this.tools.advanced.snapshot(id);
    if(snapshot.operation!=='idle'||snapshot.status.changes.some(change=>change.group==='conflicts'))throw new Error('Finish current Git operations first.');
    if(grant&&command.kind==='worktreePrune')throw new Error('Prune requires registered paths inside open workspace roots.');
    const inspected=await this.inspect(id,command,grant),preview=Object.freeze({snapshot,command:Object.freeze({...command}),fingerprint:inspected.fingerprint,details:Object.freeze(inspected.details)});
    this.previews.add(preview);if(grant)this.grants.set(preview,grant);return preview;
  }
  async execute(preview:WorktreePreview):Promise<void>{
    if(!this.previews.has(preview))throw new Error('Worktree preview expired.');
    await this.tools.advanced.guarded(preview.snapshot,async repo=>{
      if((await this.inspect(repo.id,preview.command,this.grants.get(preview))).fingerprint!==preview.fingerprint)throw new Error('Worktree state or destination changed. Review again.');
      this.previews.delete(preview);await this.tools.advanced.git.executor.mutate(repo.root,preview.command);
    });
  }
}
