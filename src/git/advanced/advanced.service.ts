import { createHash } from 'node:crypto';
import { lstat, readlink } from 'node:fs/promises';
import * as path from 'node:path';
import { GitService } from '../git.service';
import { parseStatus, type StatusSnapshot } from '../git-parser';
import { detectOperation, type GitOperation } from '../../state/operation-state';
import { OperationCoordinator } from '../../state/operation-coordinator';
import { validateOid } from '../../security/refs';
import { buildAdvancedMutation, type AdvancedMutation } from './advanced-builders';
import type { RepositoryDescriptor } from '../../repositories/repository-registry';
import { decode, parseHistory, parseChangedFiles, parseComparisonCounts,type HistoryCommit, type ChangedFile } from '../history/history-parser';
import { boundedFile } from '../../utils/bounded-file';
import { LinkOutsideError } from '../../security/paths';
import type { EditorJob } from './owned-editor';

/** `external` lists untracked paths Git reaches through a symlink or junction that leaves the repository. */
export interface OperationSnapshot { repositoryId: string; head?: string; operation: GitOperation; status: StatusSnapshot; fingerprint: string; external: readonly string[] }
/** The first symlink or junction on a repository-relative path and its target: identifies the path without reading outside content. */
async function linkChain(root: string, relative: string): Promise<string> {
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    const info = await lstat(current).catch(() => undefined);
    if (!info) return `missing:${relative}`;
    if (info.isSymbolicLink()) return `${path.relative(root, current)}->${await readlink(current)}`;
  }
  return `unlinked:${relative}`;
}
export interface AdvancedPreview { snapshot: OperationSnapshot; command: AdvancedMutation; files: readonly ChangedFile[];mergeContext?:{readonly headOnly:number;readonly targetOnly:number};rebaseContext?:{readonly localCount:number;readonly candidates:readonly HistoryCommit[]} }
export class AdvancedService {
  private editorJobs: {resume(id:string):Promise<EditorJob|undefined>;cleanup(id:string):Promise<void>}|undefined;
  setEditorJobs(jobs:{resume(id:string):Promise<EditorJob|undefined>;cleanup(id:string):Promise<void>}):void{this.editorJobs=jobs;}
  private readonly previews = new WeakSet<AdvancedPreview>();
  private readonly snapshots = new WeakSet<OperationSnapshot>();
  private readonly owners = new WeakMap<OperationSnapshot,RepositoryDescriptor>();
  constructor(readonly git: GitService, private readonly coordinator: OperationCoordinator) {}
  private async inspect(repo: RepositoryDescriptor): Promise<OperationSnapshot> {
    const statusBuffer = (await this.git.executor.read(repo.root,{kind:'status'})).stdout;
    const parsed = parseStatus(statusBuffer), status = Object.freeze({...parsed,changes:Object.freeze(parsed.changes.map(change=>Object.freeze(change)))}), operation = await detectOperation(repo.gitDir);
    const digest = createHash('sha256');
    const append=(tag:string,data:Buffer)=>digest.update(`${Buffer.byteLength(tag)}:${tag}:${data.length}:`).update(data);
    append('status',statusBuffer);
    // Every index entry that differs from HEAD appears in the status bytes above with both OIDs, so a whole-index listing adds nothing.
    // `git diff` can only print something when a tracked file differs from the index; skip the unbounded read otherwise.
    // Hashed while streaming: a large unstaged file must not turn the fingerprint into an output-limit failure.
    if(status.changes.some(change=>change.group==='working'||change.group==='conflicts'))append('working',Buffer.from((await this.git.executor.read(repo.root,{kind:'workDiff',paths:[]},{digest:true})).digest!));
    let bytes = 0; const external: string[] = [];
    for (const change of status.changes.filter(item=>item.group==='untracked'||item.group==='conflicts')) {
      const file = await this.git.authorizePath(repo.id,change.path).catch(error=>{if(change.group==='untracked'&&error instanceof LinkOutsideError)return;throw error;});
      // Git lists files behind an untracked link to elsewhere; their content is not this repository's to read, so the link identifies them.
      if(!file){external.push(change.path);append(`external:${change.path}`,Buffer.from(await linkChain(repo.root,change.path)));continue;}
      const info = await lstat(file).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;});
      if(!info){append(`missing:${change.path}`,Buffer.alloc(0));continue;}
      if(info.isSymbolicLink()){append(`link:${change.path}`,Buffer.from(await readlink(file)));continue;}
      // An untracked nested repository is listed as its directory; Git treats it as opaque.
      if(info.isDirectory()){append(`directory:${change.path}`,Buffer.alloc(0));continue;}
      if(!info.isFile())throw new Error(`Unsupported file type in the working tree: ${change.path}. Use native Git.`);
      // Content up to the read bounds; beyond them, size, modification time and inode identify the file, as Git's own index does.
      if (info.size>5*1024*1024 || bytes+info.size>16*1024*1024) { append(`stat:${change.path}`,Buffer.from(`${info.size}:${info.mtimeMs}:${info.ino}`)); continue; }
      bytes+=info.size; append(`file:${change.path}`,await boundedFile(file));
    }
    for (const name of ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','sequencer/todo','rebase-merge/git-rebase-todo','rebase-merge/done','rebase-merge/stopped-sha','rebase-merge/head-name','rebase-apply/next']) {
      const file = path.join(repo.gitDir,name), info = await lstat(file).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;});
      if (!info) continue;
      if (!info.isFile() || info.isSymbolicLink() || info.size>1024*1024) throw new Error('Unsupported operation metadata.');
      append(`metadata:${name}`,await boundedFile(file,1024*1024));
    }
    if (this.git.repository(repo.id)!==repo) throw new Error('Repository changed during operation preview.');
    const snapshot: OperationSnapshot = Object.freeze({repositoryId:repo.id,...(status.oid?{head:status.oid}:{}),operation,status,fingerprint:digest.digest('hex'),external:Object.freeze(external)});
    this.snapshots.add(snapshot); this.owners.set(snapshot,repo); return snapshot;
  }
  snapshot(id: string): Promise<OperationSnapshot> { return this.inspect(this.git.repository(id)); }
  async resolve(id: string, ref: string): Promise<string> { return validateOid(decode((await this.git.executor.read(this.git.repository(id).root,{kind:'ref',ref})).stdout).trim()); }
  async preview(id: string, command: AdvancedMutation): Promise<AdvancedPreview> {
    buildAdvancedMutation(command);
    const captured = Object.freeze({...command,...('oids' in command?{oids:Object.freeze([...command.oids])}:{})}) as AdvancedMutation;
    const snapshot = await this.snapshot(id);
    if (snapshot.operation!=='idle') throw new Error('Finish or abort the current Git operation first.');
    if (!snapshot.head) throw new Error('Create a first commit before advanced Git actions.');
    if (command.kind!=='reset' && snapshot.status.changes.length) throw new Error('Commit or stash local changes before this operation.');
    if (command.kind==='operationControl'||command.kind==='interactiveRebase'||command.kind==='amendStopped') throw new Error('Use the state-backed operation control or interactive planner.');
    if (command.kind==='cherryPick' || command.kind==='revert') {
      for (const oid of command.oids) {
        const commit = parseHistory((await this.git.executor.read(this.git.repository(id).root,{kind:'history',tips:[oid],offset:0,limit:1})).stdout)[0];
        if (!commit || commit.oid!==oid) throw new Error('Selected commit is unavailable.');
        if (commit.parents.length>1 && (!command.parent || command.parent>commit.parents.length)) throw new Error('Select a valid mainline parent for the merge commit.');
        if (commit.parents.length<=1 && command.parent!==undefined) throw new Error('Mainline parent only applies to a merge commit.');
      }
    }
    const target = 'oid' in command ? command.oid : undefined;
    const affected = target ? (await this.git.executor.read(this.git.repository(id).root,{kind:'changedFiles',from:snapshot.head,to:target})).stdout : Buffer.alloc(0);
    let rebaseContext:AdvancedPreview['rebaseContext'];
    if(command.kind==='rebase'&&snapshot.head){
      const repo=this.git.repository(id),[count,candidates]=await Promise.all([this.git.executor.read(repo.root,{kind:'comparisonCount',from:command.oid,to:snapshot.head}),this.git.executor.read(repo.root,{kind:'comparisonCommits',tip:snapshot.head,exclude:command.oid})]);
      rebaseContext=Object.freeze({localCount:parseComparisonCounts(count.stdout).right,candidates:Object.freeze(parseHistory(candidates.stdout).map(commit=>Object.freeze({...commit,parents:Object.freeze([...commit.parents])})))});
    }
    let mergeContext:AdvancedPreview['mergeContext'];
    if(command.kind==='merge'&&snapshot.head){const counts=parseComparisonCounts((await this.git.executor.read(this.git.repository(id).root,{kind:'comparisonCount',from:snapshot.head,to:command.oid})).stdout);mergeContext=Object.freeze({headOnly:counts.left,targetOnly:counts.right});}
    const preview: AdvancedPreview = Object.freeze({snapshot,command:captured,files:Object.freeze(parseChangedFiles(affected).map(file=>Object.freeze(file))),...(rebaseContext?{rebaseContext}:{}),...(mergeContext?{mergeContext}:{})});
    this.previews.add(preview); return preview;
  }
  private async fresh(snapshot: OperationSnapshot): Promise<RepositoryDescriptor> {
    if (!this.snapshots.has(snapshot)) throw new Error('Operation preview expired.');
    const repo = this.git.repository(snapshot.repositoryId), current = await this.inspect(repo);
    if (this.owners.get(snapshot)!==repo) throw new Error('Repository session changed. Review the operation again.');
    if (current.fingerprint!==snapshot.fingerprint || current.operation!==snapshot.operation) throw new Error('Git state changed. Review the operation again.');
    return repo;
  }
  execute(preview: AdvancedPreview): Promise<void> {
    const repo = this.git.repository(preview.snapshot.repositoryId);
    return this.coordinator.run(repo.commonDir,async()=>{
      if (!this.previews.has(preview)) throw new Error('Operation preview expired.');
      await this.fresh(preview.snapshot); this.previews.delete(preview);
      await this.git.executor.mutate(repo.root,preview.command);
    },()=>this.git.registry.refresh(repo.id));
  }
  control(snapshot: OperationSnapshot, action: 'continue'|'abort'|'skip'): Promise<void> {
    const repo = this.git.repository(snapshot.repositoryId);
    return this.coordinator.run(repo.commonDir,async()=>{
      await this.fresh(snapshot);
      const operation = snapshot.operation;
      if (!['merging','rebasing','cherry-picking','reverting'].includes(operation)) throw new Error('No supported operation is in progress. Use native Git for bisect or git-am.');
      if (action==='continue' && snapshot.status.changes.some(change=>change.group==='conflicts')) throw new Error('Resolve and stage all conflicts before continuing.');
      this.snapshots.delete(snapshot);
      const editorJob=operation==='rebasing'&&action!=='abort'?await this.editorJobs?.resume(repo.id):undefined;
      try{await this.git.executor.mutate(repo.root,{kind:'operationControl',operation:operation as 'merging'|'rebasing'|'cherry-picking'|'reverting',action},{...(editorJob?{editorJob}:{})});}
      finally{await this.editorJobs?.cleanup(repo.id);}
    },()=>this.git.registry.refresh(repo.id));
  }
  guarded<T>(snapshot: OperationSnapshot, action: (repo:RepositoryDescriptor)=>Promise<T>): Promise<T> {
    const repo=this.git.repository(snapshot.repositoryId);
    return this.coordinator.run(repo.commonDir,async()=>{await this.fresh(snapshot);this.snapshots.delete(snapshot);return action(repo);},()=>this.git.registry.refresh(repo.id));
  }
  async isEditStop(snapshot:OperationSnapshot):Promise<boolean>{
    if(snapshot.operation!=='rebasing'||snapshot.status.changes.some(change=>change.group==='conflicts'))return false;
    const repo=this.git.repository(snapshot.repositoryId);
    try{const done=decode(await boundedFile(path.join(repo.gitDir,'rebase-merge','done'),1024*1024)).split(/\r?\n/).filter(line=>line&&!line.startsWith('#')).at(-1);return /^edit [a-f0-9]+(?: |$)/.test(done??'');}catch{return false;}
  }
  stageEdit(snapshot:OperationSnapshot,paths:readonly string[]):Promise<void>{
    return this.guarded(snapshot,async repo=>{
      if(!await this.isEditStop(snapshot))throw new Error('Stage Edit is available only at an interactive edit stop.');
      const allowed=new Set(snapshot.status.changes.filter(change=>change.group==='working'||change.group==='untracked').map(change=>change.path));
      if(!paths.length||paths.some(file=>!allowed.has(file)))throw new Error('Select reviewed edited files.');
      for(const file of paths){const absolute=await this.git.authorizePath(repo.id,file);if((await this.git.registry.resolveFile(absolute))?.id!==repo.id)throw new Error('Edited file belongs to another repository.');}
      await this.git.executor.mutate(repo.root,{kind:'stage',paths});
    });
  }
  amendEdit(snapshot:OperationSnapshot,message?:string):Promise<void>{
    return this.guarded(snapshot,async repo=>{if(!await this.isEditStop(snapshot))throw new Error('Amend is available only at an interactive edit stop.');await this.git.executor.mutate(repo.root,{kind:'amendStopped',...(message?{message}:{})});});
  }
}
