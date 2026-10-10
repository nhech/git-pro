import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { AdvancedService, type OperationSnapshot } from '../advanced/advanced.service';
import { parseIndex, type IndexEntry } from './index-parser';
import { acceptBothText, hasConflictMarkers } from './text-conflicts';
import { decode } from '../history/history-parser';
import { boundedFile } from '../../utils/bounded-file';
export interface ConflictPreview { snapshot: OperationSnapshot; path: string; entries: readonly IndexEntry[]; text?: string; markers: boolean }
export class ConflictsService {
  private readonly previews = new WeakSet<ConflictPreview>();
  constructor(private readonly advanced:AdvancedService){}
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
    const preview=Object.freeze({snapshot,path:file,entries,...(text!==undefined?{text}:{}),markers:text!==undefined&&hasConflictMarkers(text)});this.previews.add(preview);return preview;
  }
  async side(preview:ConflictPreview,stage:1|2|3):Promise<Buffer>{
    if(!this.previews.has(preview))throw new Error('Conflict preview expired.');
    const entry=preview.entries.find(item=>item.stage===stage);if(!entry)return Buffer.alloc(0);
    const repo=this.advanced.git.repository(preview.snapshot.repositoryId),size=Number((await this.advanced.git.executor.read(repo.root,{kind:'blobSize',oid:entry.oid})).stdout.toString().trim());
    if(!Number.isSafeInteger(size)||size<0||size>5*1024*1024)throw new Error('Conflict side exceeds text preview limit.');
    return(await this.advanced.git.executor.read(repo.root,{kind:'blob',oid:entry.oid},{maxOutputBytes:5*1024*1024})).stdout;
  }
  resolve(preview:ConflictPreview,choice:'current'|'incoming'|'both'|'mark',allowMarkers=false):Promise<void>{
    if(!this.previews.has(preview))return Promise.reject(new Error('Conflict preview expired.'));
    return this.advanced.guarded(preview.snapshot,async repo=>{
      this.previews.delete(preview);
      const git=this.advanced.git,absolute=await git.authorizePath(repo.id,preview.path);
      if(choice==='current'||choice==='incoming'){
        const exists=preview.entries.some(entry=>entry.stage===(choice==='current'?2:3));
        await git.executor.mutate(repo.root,exists?{kind:'acceptConflict',side:choice==='current'?'ours':'theirs',paths:[preview.path]}:{kind:'deleteConflict',paths:[preview.path]});return;
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
}
