import { lstat } from 'node:fs/promises';
import { AdvancedService, type OperationSnapshot } from '../advanced/advanced.service';
import { decode } from '../history/history-parser';
import { boundedFile } from '../../utils/bounded-file';
export type HunkDirection='stage'|'unstage'|'revert';
export interface Hunk {label:string;patch:Buffer;added:number;removed:number}
export interface HunkPreview {snapshot:OperationSnapshot;path:string;direction:HunkDirection;hunks:readonly Hunk[]}
export interface FileCommitPreview {snapshot:OperationSnapshot;path:string}
const escapes:Record<string,number>={a:7,b:8,t:9,n:10,v:11,f:12,r:13,'"':34,'\\':92};
/** Reads the path of a `---`/`+++` header line, undoing Git's C-style quoting and the tab Git appends to names with spaces. */
function headerPath(line:string):string|undefined{
  let value=line.slice(4);if(value.endsWith('\t'))value=value.slice(0,-1);
  if(!value.startsWith('"'))return value;
  if(value.length<2||!value.endsWith('"'))return undefined;
  const bytes:number[]=[];
  for(let index=1;index<value.length-1;index++){
    const char=value[index]!;
    if(char!=='\\'){bytes.push(...Buffer.from(char));continue;}
    const next=value[++index];if(next===undefined)return undefined;
    const octal=/^[0-3][0-7]{2}/.exec(value.slice(index,index+3));
    if(octal){bytes.push(parseInt(octal[0],8));index+=2;}else if(next in escapes)bytes.push(escapes[next]!);else return undefined;
  }
  return Buffer.from(bytes).toString('utf8');
}
/** Splits one file's patch into independently applicable hunks; `file` is the repository-relative path the patch must name. */
export function parseHunks(buffer:Buffer,file:string):Hunk[]{
  const text=decode(buffer);if(!text.startsWith('diff --git ')||(text.match(/^diff --git /gm)?.length??0)!==1)throw new Error('Choose one modified file with text hunks.');
  const lines=text.split('\n'),starts:number[]=[];
  for(let index=0;index<lines.length;index++)if(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(lines[index]!))starts.push(index);
  if(!starts.length)throw new Error('No supported text hunks. Use native Git for binary files.');
  const header=lines.slice(0,starts[0]).join('\n')+'\n';
  if(/^(?:old mode|new mode|new file mode|deleted file mode|rename |copy |similarity |dissimilarity |GIT binary patch|Binary files)/m.test(header))throw new Error('Rename, new/deleted, binary and mode-changing files require native Git.');
  // `git apply` strips one leading component, so anything but a/<file> and b/<file> would patch a different file.
  const [source,target,...extra]=lines.slice(0,starts[0]).filter(line=>line.startsWith('--- ')||line.startsWith('+++ '));
  if(extra.length||!source?.startsWith('--- ')||!target?.startsWith('+++ ')||headerPath(source)!==`a/${file}`||headerPath(target)!==`b/${file}`)throw new Error('The patch does not name the selected file. Use native Git.');
  return starts.map((start,index)=>{
    const content=lines.slice(start,starts[index+1]??lines.length).join('\n');const patch=Buffer.from(header+content+(content.endsWith('\n')?'':'\n'));
    if(patch.length>1024*1024)throw new Error('Selected hunk exceeds 1 MiB. Use native Git.');
    return Object.freeze({label:lines[start]!,patch,added:content.split('\n').filter(line=>line.startsWith('+')).length,removed:content.split('\n').filter(line=>line.startsWith('-')).length});
  });
}
export class FileActionsService {
  private readonly hunkPreviews=new WeakSet<HunkPreview>();private readonly commits=new WeakSet<FileCommitPreview>();
  private readonly patches=new WeakMap<HunkPreview,readonly Buffer[]>();
  constructor(private readonly advanced:AdvancedService){}
  private async path(id:string,file:string):Promise<void>{
    const absolute=await this.advanced.git.authorizePath(id,file);
    if((await this.advanced.git.registry.resolveFile(absolute))?.id!==id)throw new Error('File belongs to another repository.');
    const info=await lstat(absolute);if(!info.isFile()||info.isSymbolicLink())throw new Error('Select a regular text file.');await boundedFile(absolute,5*1024*1024);
  }
  async hunks(id:string,file:string,direction:HunkDirection):Promise<HunkPreview>{
    await this.path(id,file);const snapshot=await this.advanced.snapshot(id);
    if(snapshot.operation!=='idle')throw new Error('Finish the current Git operation first.');
    const group=direction==='unstage'?'staged':'working';
    if(!snapshot.status.changes.some(change=>change.path===file&&change.group===group&&change.status==='M'))throw new Error('Hunk actions support modified tracked files in the selected index/working state.');
    const buffer=(await this.advanced.git.executor.read(this.advanced.git.repository(id).root,{kind:'filePatch',path:file,index:direction==='unstage'},{maxOutputBytes:5*1024*1024})).stdout;
    const hunks=parseHunks(buffer,file),fresh=await this.advanced.snapshot(id);if(fresh.fingerprint!==snapshot.fingerprint)throw new Error('File changed while reading hunks. Review again.');
    const preview=Object.freeze({snapshot:fresh,path:file,direction,hunks:Object.freeze(hunks)});this.hunkPreviews.add(preview);this.patches.set(preview,hunks.map(hunk=>Buffer.from(hunk.patch)));return preview;
  }
  async apply(preview:HunkPreview,index:number):Promise<void>{
    const patch=this.patches.get(preview)?.[index];if(!this.hunkPreviews.has(preview)||!Number.isInteger(index)||!patch)throw new Error('Hunk preview expired.');
    await this.advanced.guarded(preview.snapshot,async repo=>{
      await this.path(repo.id,preview.path);this.hunkPreviews.delete(preview);this.patches.delete(preview);
      const command={kind:'applyHunk' as const,paths:[preview.path],direction:preview.direction};
      await this.advanced.git.executor.mutate(repo.root,{...command,check:true},{patchBuffer:patch});
      await this.advanced.git.executor.mutate(repo.root,{...command,check:false},{patchBuffer:patch});
    });
  }
  async commitPreview(id:string,file:string):Promise<FileCommitPreview>{
    await this.path(id,file);const snapshot=await this.advanced.snapshot(id);
    if(snapshot.operation!=='idle'||!snapshot.head)throw new Error('Commit File requires an existing commit and idle Git state. Use the staged composer for the initial commit.');
    if(!snapshot.status.changes.some(change=>change.path===file&&(change.group==='working'||change.group==='staged')))throw new Error('Select a changed tracked/staged file.');
    const preview=Object.freeze({snapshot,path:file});this.commits.add(preview);return preview;
  }
  async commit(preview:FileCommitPreview,message:string):Promise<void>{
    if(!this.commits.has(preview))throw new Error('File commit preview expired.');
    await this.advanced.guarded(preview.snapshot,async repo=>{await this.path(repo.id,preview.path);this.commits.delete(preview);await this.advanced.git.executor.mutate(repo.root,{kind:'commitFile',paths:[preview.path],message});});
  }
}
