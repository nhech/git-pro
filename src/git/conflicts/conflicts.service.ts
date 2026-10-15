import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { AdvancedService, type OperationSnapshot } from '../advanced/advanced.service';
import { parseIndex, type IndexEntry } from './index-parser';
import { acceptBothText, countConflictBlocks, hasConflictMarkers } from './text-conflicts';
import { decode } from '../history/history-parser';
import { boundedFile } from '../../utils/bounded-file';
import { chunkPaths } from '../argv-chunks';
import { GitFailure, partiallyApplied } from '../git-error-parser';
import { LinkOutsideError, containsPath } from '../../security/paths';
import { conflictKind, isConflictCode, sidePresent, sideStatus, sidesFor, stagePresence } from './conflict-kinds';
import { OperationContext, stashLabel } from './operation-context';
import type { MutationCommand } from '../command-builders';
import type { RepositoryDescriptor } from '../../repositories/repository-registry';
import type { ConflictBatch, ConflictList, ConflictRow, ConflictSide, ConflictSource, ConflictsApi, StageBlobs } from './conflict-contract';
export interface ConflictPreview { snapshot: OperationSnapshot; path: string; entries: readonly IndexEntry[]; text?: string; markers: boolean; workingFile: boolean }
/** Marker counting reads at most this much of the conflicted files per list, the same budget as the operation fingerprint. */
const markerBudget = 16 * 1024 * 1024;
type Refusal = 'missing' | 'binary' | 'markers' | 'oneSided';
function refusal(file: string, reason: Refusal): Error {
  return new Error(reason === 'markers' ? `Conflict markers remain in ${file}. Review the file before marking resolved.` : reason === 'oneSided' ? `${file}: Mark Resolved would keep only the version Git left in the working tree. Choose Accept Yours or Accept Theirs.` : `${file} ${reason === 'binary' ? 'is binary' : 'has no working file'}. Choose Accept Yours or Accept Theirs.`);
}
/** Why Mark Resolved cannot stage this file as it is (N13, one-sided rows): the same gate as the Conflicts tab's batch. */
function markRefusal(preview: ConflictPreview): Refusal | undefined {
  if (!preview.workingFile) return 'missing';
  if (preview.text === undefined) return 'binary';
  return preview.entries.some(entry => entry.stage === 2) && preview.entries.some(entry => entry.stage === 3) ? undefined : 'oneSided';
}
/** A mode-only patch for `git apply --cached`. Both names are C-quoted, so no byte of the path can change how Git reads the header. */
function modePatch(file: string, from: string, to: string): Buffer {
  const quote = (name: string) => `"${[...Buffer.from(name, 'utf8')].map(byte => byte === 0x22 || byte === 0x5c ? `\\${String.fromCharCode(byte)}` : byte < 0x20 || byte > 0x7e ? `\\${byte.toString(8).padStart(3, '0')}` : String.fromCharCode(byte)).join('')}"`;
  return Buffer.from(`diff --git ${quote(`a/${file}`)} ${quote(`b/${file}`)}\nold mode ${from}\nnew mode ${to}\n`);
}
export class ConflictsService implements ConflictsApi {
  private readonly previews = new WeakSet<ConflictPreview>();
  /** Each single-use batch with the index entries it was reviewed with; the snapshot fingerprint (status records carry the stage modes) keeps them current. */
  private readonly batches = new WeakMap<ConflictBatch, ReadonlyMap<string, readonly IndexEntry[]>>();
  /** Titles and labels for the list, the banner and the merge editor; `sources` is the in-memory record of Git Pro actions that stopped on conflicts. */
  readonly context: OperationContext;
  constructor(private readonly advanced:AdvancedService,sources:ReadonlyMap<string,ConflictSource>=new Map()){this.context=new OperationContext(advanced,sources);}
  async preview(id:string,file:string):Promise<ConflictPreview>{
    const snapshot=await this.advanced.snapshot(id);
    if(!snapshot.status.changes.some(change=>change.group==='conflicts'&&change.path===file))throw new Error('Select a current conflicted file.');
    const absolute=await this.advanced.git.authorizePath(id,file);
    if((await this.advanced.git.registry.resolveFile(absolute))?.id!==id)throw new Error('Conflict belongs to another repository.');
    const info=await lstat(absolute).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;});
    if(info&&(!info.isFile()||info.isSymbolicLink()||info.size>5*1024*1024))throw new Error('Use native Git for symlink, submodule or oversized conflicts.');
    const entries=Object.freeze(parseIndex((await this.advanced.git.executor.read(this.advanced.git.repository(id).root,{kind:'index',paths:[file]})).stdout).filter(entry=>entry.stage>0).map(entry=>Object.freeze(entry)));
    if(!entries.length||entries.some(entry=>!/^100(?:644|755)$/.test(entry.mode)))throw new Error('Use native Git for symlink or submodule conflicts.');
    let text:string|undefined;
    if(info){const data=await boundedFile(absolute);if(!data.includes(0)){try{text=decode(data);}catch{/* binary */}}}
    const preview=Object.freeze({snapshot,path:file,entries,...(text!==undefined?{text}:{}),markers:text!==undefined&&hasConflictMarkers(text),workingFile:info!==undefined});this.previews.add(preview);return preview;
  }
  async side(preview:ConflictPreview,stage:1|2|3):Promise<Buffer>{
    if(!this.previews.has(preview))throw new Error('Conflict preview expired.');
    const entry=preview.entries.find(item=>item.stage===stage);if(!entry)return Buffer.alloc(0);
    const repo=this.advanced.git.repository(preview.snapshot.repositoryId),size=Number((await this.advanced.git.executor.read(repo.root,{kind:'blobSize',oid:entry.oid})).stdout.toString().trim());
    if(!Number.isSafeInteger(size)||size<0||size>5*1024*1024)throw new Error('Conflict side exceeds text preview limit.');
    return(await this.advanced.git.executor.read(repo.root,{kind:'blob',oid:entry.oid},{maxOutputBytes:5*1024*1024})).stdout;
  }
  /**
   * The per-file quick pick's Git-side contract: `current` is `--ours`, `incoming` is `--theirs`; callers map Yours/Theirs through sidesFor. Side acceptance of a
   * text both-sides conflict leaves staging to Mark Resolved; any other row is one Mark Resolved refuses, so Accept stages it, as the Conflicts tab does.
   */
  resolve(preview:ConflictPreview,choice:'current'|'incoming'|'both'|'mark',allowMarkers=false):Promise<void>{
    if(!this.previews.has(preview))return Promise.reject(new Error('Conflict preview expired.'));
    const refused=markRefusal(preview);
    if(choice==='mark'&&refused)return Promise.reject(refusal(preview.path,refused));
    return this.advanced.guarded(preview.snapshot,async repo=>{
      this.previews.delete(preview);
      const git=this.advanced.git,absolute=await git.authorizePath(repo.id,preview.path);
      if(choice==='current'||choice==='incoming'){
        const stage=choice==='current'?2:3;
        if(!preview.entries.some(entry=>entry.stage===stage)){await git.executor.mutate(repo.root,{kind:'deleteConflict',paths:[preview.path]});return;}
        await git.executor.mutate(repo.root,{kind:'acceptConflict',side:choice==='current'?'ours':'theirs',paths:[preview.path]});
        if(refused)try{await this.stageSide(repo.root,[preview.path],new Map([[preview.path,preview.entries]]),stage);}catch(error){throw partiallyApplied(error,1,2);}
        return;
      }
      if(choice==='both'){
        if(preview.text===undefined)throw new Error('Accept Both is available only for bounded UTF-8 text.');
        const result=acceptBothText(preview.text),handle=await open(absolute,constants.O_RDWR|(constants.O_NOFOLLOW??0));
        try{
          const info=await handle.stat();if(!info.isFile()||info.size>5*1024*1024||decode(await handle.readFile())!==preview.text)throw new Error('Conflict file changed.');
          const bytes=Buffer.from(result,'utf8');await handle.truncate(0);let offset=0;
          while(offset<bytes.length){const written=await handle.write(bytes,offset,bytes.length-offset,offset);if(!written.bytesWritten)throw new Error('Conflict write did not complete. Review the working file before retrying.');offset+=written.bytesWritten;}
        }finally{await handle.close();}return;
      }
      if(choice!=='mark')throw new Error('Unknown conflict action.');
      if(preview.markers&&!allowMarkers)throw new Error('Conflict markers remain. Review the file before marking resolved.');
      await git.executor.mutate(repo.root,{kind:'stage',paths:[preview.path]});
    });
  }
  /** Every current conflict (at most 5000, Git's path order) from one snapshot, with its kind, side status and markers. */
  async list(id:string,signal?:AbortSignal):Promise<ConflictList>{
    const snapshot=await this.advanced.snapshot(id),repo=this.advanced.git.repository(id);
    const all=snapshot.status.changes.filter(change=>change.group==='conflicts').map(change=>change.path),paths=all.slice(0,5000);
    const {rows,stashMarkers}=await this.rows(repo,snapshot,paths,markerBudget,signal);
    const summary=await this.context.describe(repo,snapshot.operation,snapshot.status,{stashMarkers},signal);
    if(this.advanced.git.repository(id)!==repo)throw new Error('Repository changed while reading conflicts.');
    return Object.freeze({snapshot,summary,rows:Object.freeze(rows),truncated:all.length>paths.length});
  }
  /** Single-use plan for 1–100 current conflicts from one fresh snapshot. Rows Git Pro leaves to native Git are refused. */
  async previewBatch(id:string,paths:readonly string[]):Promise<ConflictBatch>{
    if(!Array.isArray(paths)||!paths.length||paths.length>100||paths.some(file=>typeof file!=='string')||new Set(paths).size!==paths.length)throw new Error('Select 1–100 distinct conflicted files.');
    const snapshot=await this.advanced.snapshot(id),repo=this.advanced.git.repository(id),current=new Set(snapshot.status.changes.filter(change=>change.group==='conflicts').map(change=>change.path));
    if(paths.some(file=>!current.has(file)))throw new Error('Select current conflicted files. Conflicts changed; review again.');
    const {rows,staged}=await this.rows(repo,snapshot,paths,markerBudget);
    const blocked=rows.find(row=>row.unsupported);if(blocked)throw new Error(`${blocked.path}: ${blocked.unsupported}.`);
    const batch:ConflictBatch=Object.freeze({snapshot,sides:sidesFor(snapshot.operation),rows:Object.freeze(rows)});this.batches.set(batch,staged);return batch;
  }
  /**
   * Owner decision Q2: `restore --ours|--theirs --worktree` then `add` (at the chosen side's mode) for paths whose chosen side has a file, `rm -f` for the rest,
   * in one guarded run. N2: restore replaces the files one by one, so a first step that fails part-way (a locked file) is reported as applied when the
   * repository no longer matches the reviewed snapshot.
   */
  acceptSide(batch:ConflictBatch,side:ConflictSide):Promise<void>{
    if(side!=='yours'&&side!=='theirs')return Promise.reject(new Error('Choose Yours or Theirs.'));
    const staged=this.batches.get(batch);if(!staged)return Promise.reject(new Error('Conflict review expired. Review again.'));
    this.batches.delete(batch);
    const target=batch.sides[side],restore=batch.rows.filter(row=>sidePresent(row.stages,target)).map(row=>row.path),remove=batch.rows.filter(row=>!sidePresent(row.stages,target)).map(row=>row.path);
    const modes=this.modeFixes(restore,staged,target.stage),mutate=(command:MutationCommand)=>(root:string)=>this.advanced.git.executor.mutate(root,command);
    const steps:((root:string)=>Promise<unknown>)[]=[...(restore.length?[mutate({kind:'acceptConflict',side:target.flag,paths:restore}),mutate({kind:'stage',paths:restore})]:[]),
      ...(modes.size?[(root:string)=>this.fixModes(root,modes)]:[]),...(remove.length?[mutate({kind:'deleteConflict',paths:remove})]:[])];
    return this.advanced.guarded(batch.snapshot,async repo=>{
      for(let index=0;index<steps.length;index++){
        try{await steps[index]!(repo.root);}
        catch(error){throw index||!await this.unchanged(batch.snapshot)?partiallyApplied(error,Math.max(index,1),steps.length):error;}
      }
    });
  }
  /** False when the repository differs from the reviewed snapshot, or cannot be read to tell. */
  private async unchanged(snapshot:OperationSnapshot):Promise<boolean>{
    try{return(await this.advanced.snapshot(snapshot.repositoryId)).fingerprint===snapshot.fingerprint;}catch{return false;}
  }
  /**
   * Restored paths whose stages disagree on the file mode, with the chosen side's mode. With core.filemode=false `git add` keeps the unmerged entry's mode
   * (stage 2 first) whichever side was restored; with core.filemode=true restore already set it. Only these paths are read back after the add.
   */
  private modeFixes(paths:readonly string[],staged:ReadonlyMap<string,readonly IndexEntry[]>,stage:2|3):Map<string,string>{
    const fixes=new Map<string,string>();
    for(const file of paths){
      const entries=staged.get(file)??[],mode=entries.find(entry=>entry.stage===stage)?.mode;
      if(mode&&entries.some(entry=>entry.mode!==mode))fixes.set(file,mode);
    }
    return fixes;
  }
  /**
   * The staged entry of each path at its wanted mode: a mode-only patch where `git add` left another one. `apply --cached` leaves the entry without stat data,
   * which `merge --abort` reads as a local change, so the patched paths are added once more: Git keeps a stage-0 entry's mode when it ignores the file system's.
   */
  private async fixModes(root:string,wanted:ReadonlyMap<string,string>):Promise<void>{
    const patched:string[]=[];
    for(const batch of chunkPaths([...wanted.keys()]))for(const entry of parseIndex((await this.advanced.git.executor.read(root,{kind:'index',paths:batch})).stdout)){
      const mode=wanted.get(entry.path);
      if(entry.stage!==0||!mode||entry.mode===mode)continue;
      await this.advanced.git.executor.mutate(root,{kind:'applyHunk',paths:[entry.path],direction:'stage',check:false},{patchBuffer:modePatch(entry.path,entry.mode,mode)});patched.push(entry.path);
    }
    if(patched.length)await this.advanced.git.executor.mutate(root,{kind:'stage',paths:patched});
  }
  /** `git add` at the chosen stage's mode, for a side Accept that also stages. */
  private async stageSide(root:string,paths:readonly string[],staged:ReadonlyMap<string,readonly IndexEntry[]>,stage:2|3):Promise<void>{
    await this.advanced.git.executor.mutate(root,{kind:'stage',paths});
    const modes=this.modeFixes(paths,staged,stage);if(modes.size)await this.fixModes(root,modes);
  }
  /**
   * `git add` for the whole batch. Every file is read again inside the guarded run, never trusted from a row, and the batch is refused as a whole when one has marker lines (N14),
   * is binary (N13: staging it would silently keep Git's stage-2 copy, the upstream during a rebase), has no working file, or is not a both-sides conflict:
   * for DU/UD/AU/UA the working file is only the side Git kept, so staging it would drop the other side's deletion or addition just as silently.
   */
  markResolved(batch:ConflictBatch):Promise<void>{
    if(!this.batches.has(batch))return Promise.reject(new Error('Conflict review expired. Review again.'));
    this.batches.delete(batch);
    const refuse=(row:{path:string},reason:Refusal)=>refusal(row.path,reason);
    const early=batch.rows.find(row=>!row.workingFile||row.binary||row.code!=='UU'&&row.code!=='AA'||row.markers?.present);
    if(early)return Promise.reject(refuse(early,!early.workingFile?'missing':early.binary?'binary':early.code!=='UU'&&early.code!=='AA'?'oneSided':'markers'));
    return this.advanced.guarded(batch.snapshot,async repo=>{
      for(const row of batch.rows){
        const absolute=await this.advanced.git.authorizePath(repo.id,row.path),info=await lstat(absolute).catch(()=>undefined);
        if(!info?.isFile()||info.isSymbolicLink())throw refuse(row,'missing');
        const data=await boundedFile(absolute);let text:string|undefined;
        if(!data.includes(0)){try{text=decode(data);}catch{/* binary */}}
        if(text===undefined)throw refuse(row,'binary');if(hasConflictMarkers(text))throw refuse(row,'markers');
      }
      await this.advanced.git.executor.mutate(repo.root,{kind:'stage',paths:batch.rows.map(row=>row.path)});
    });
  }
  /** Bounded stage blobs (5 MiB each, no textconv) for compares and the merge editor; the file passes the same checks as a preview. */
  async stageBlobs(id:string,file:string):Promise<StageBlobs>{
    const preview=await this.preview(id,file);
    try{const [base,ours,theirs]=await Promise.all([this.side(preview,1),this.side(preview,2),this.side(preview,3)]);return Object.freeze({path:file,operation:preview.snapshot.operation,sides:sidesFor(preview.snapshot.operation),base,ours,theirs});}
    finally{this.previews.delete(preview);}
  }
  /**
   * Rows in request order from the snapshot's conflicts and one batched stage listing. Working files are read for markers until `budget` bytes;
   * a row past it has `markers:null`, and its `mergeable` is not proven text: the merge bridge's own preview decides.
   */
  private async rows(repo:RepositoryDescriptor,snapshot:OperationSnapshot,paths:readonly string[],budget:number,signal?:AbortSignal):Promise<{rows:ConflictRow[];stashMarkers:boolean;staged:ReadonlyMap<string,readonly IndexEntry[]>}>{
    const cancelled=()=>{if(signal?.aborted)throw new GitFailure('cancelled','Conflict list cancelled.');};
    const codes=new Map(snapshot.status.changes.filter(change=>change.group==='conflicts').map(change=>[change.path,change.status])),wanted=new Set(paths),staged=new Map<string,IndexEntry[]>();
    for(const batch of chunkPaths(paths)){
      cancelled();
      for(const entry of parseIndex((await this.advanced.git.executor.read(repo.root,{kind:'index',paths:batch},signal?{signal}:{})).stdout))if(entry.stage>0&&wanted.has(entry.path))staged.set(entry.path,[...(staged.get(entry.path)??[]),entry]);
    }
    const git=this.advanced.git,sides=sidesFor(snapshot.operation),nested=git.registry.list().some(other=>other.id!==repo.id&&containsPath(repo.root,other.root));
    let used=0,stashMarkers=false;const rows:ConflictRow[]=[];
    const prepare=async(file:string)=>{
      const status=codes.get(file),entries=staged.get(file)??[];
      if(!status||!isConflictCode(status))throw new Error('Unsupported conflict record.');
      if(!entries.length)throw new Error('Conflicts changed while reading. Refresh and review again.');
      const stages=stagePresence(entries),base={path:file,code:status,kind:conflictKind(status,snapshot.operation),yours:sideStatus(stages,sides.yours),theirs:sideStatus(stages,sides.theirs),stages};
      const unsupported=(reason:string,workingFile=false)=>({base,reason,workingFile});
      const mode=entries.find(entry=>!/^100(?:644|755)$/.test(entry.mode))?.mode;
      if(mode)return unsupported(mode==='120000'?'symlink':mode==='160000'?'submodule':'unsupported file type');
      let absolute:string;
      try{absolute=await git.authorizePath(repo.id,file);}catch(error){if(error instanceof LinkOutsideError)return unsupported('path through a link outside the repository');throw error;}
      if(nested&&(await git.registry.resolveFile(absolute))?.id!==repo.id)return unsupported('nested repository');
      const info=await lstat(absolute).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;});
      if(info&&(info.isSymbolicLink()||!info.isFile()))return unsupported(info.isSymbolicLink()?'symlink':'not a regular file');
      if(info&&info.size>5*1024*1024)return unsupported('larger than 5 MiB',true);
      return {base,absolute,size:info?.size};
    };
    // Groups bound the files open at once; the budget is spent in path order, so which rows are counted does not depend on timing.
    for(let start=0;start<paths.length;start+=8){
      cancelled();
      const prepared=await Promise.all(paths.slice(start,start+8).map(prepare)),reads=prepared.map(item=>{
        if('reason' in item||item.size===undefined||used+item.size>budget)return false;used+=item.size;return true;
      });
      rows.push(...await Promise.all(prepared.map(async(item,index):Promise<ConflictRow>=>{
        if('reason' in item)return Object.freeze({...item.base,markers:null,binary:false,mergeable:false,unsupported:`Use native Git: ${item.reason}`,workingFile:item.workingFile});
        let markers:ConflictRow['markers']=null,binary=false;
        if(reads[index]){
          const data=await boundedFile(item.absolute);
          if(data.includes(0))binary=true;
          else try{const text=decode(data);markers=Object.freeze({present:hasConflictMarkers(text),blocks:countConflictBlocks(text)});if(stashLabel.test(text))stashMarkers=true;}catch{binary=true;}
        }
        const workingFile=item.size!==undefined;
        return Object.freeze({...item.base,markers,binary,mergeable:(item.base.code==='UU'||item.base.code==='AA')&&workingFile&&!binary,workingFile});
      })));
    }
    return {rows,stashMarkers,staged};
  }
}
