import { historyPath, historyEdgeInput, type HistoryEdge, type HistoryFilters } from './history-builders';
import { parseHistory, parseChangedFiles, decode, type HistoryCommit, type ChangedFile } from './history-parser';
import { validateOid } from '../../security/refs';

export interface LineageCommit {commit:HistoryCommit;message:string;committerTimestamp:number}
export interface LineageEdge extends HistoryEdge {files:readonly ChangedFile[]}
export interface FileCursor {tip:string;path:string;scanOffset:number;displayOffset:number;frontier:ReadonlyMap<string,ReadonlySet<string>>;done:boolean}
function fields(buffer:Buffer):string[]{if(!buffer.length)return[];if(buffer.at(-1)!==0)throw new Error('Truncated lineage records.');return decode(buffer).slice(0,-1).split('\0');}
export function parseLineageHistory(buffer:Buffer):LineageCommit[]{
  const parts=fields(buffer);if(parts.length%8)throw new Error('Invalid lineage metadata framing.');const result:LineageCommit[]=[];
  for(let index=0;index<parts.length;index+=8){
    const commit=parseHistory(Buffer.from(parts.slice(index,index+6).join('\0')+'\0'))[0]!,time=parts[index+7]!;
    if(!/^\d+$/.test(time)||!Number.isSafeInteger(Number(time)))throw new Error('Invalid lineage committer timestamp.');
    result.push({commit,message:parts[index+6]!,committerTimestamp:Number(time)});
  }
  return result;
}
export function parseHistoryEdges(buffer:Buffer,expected:readonly HistoryEdge[]):LineageEdge[]{
  historyEdgeInput(expected);const parts=fields(buffer),result:LineageEdge[]=[];let index=0;
  while(index<parts.length){
    if(parts[index++]!=='')throw new Error('Invalid history edge boundary.');
    const child=validateOid(parts[index++]!),parent=parts[index++];if(parent===undefined)throw new Error('Missing history edge parent.');if(parent)validateOid(parent);
    if(parts[index++]!=='')throw new Error('Invalid history edge separator.');
    const fileParts:string[]=[];
    while(index<parts.length&&parts[index]!==''){
      const status=parts[index++]!.replace(/^\n/,'');if(!/^(?:[ACDMRTUXB]|[RC]\d{1,3})$/.test(status))throw new Error('Invalid history edge status.');
      const count=/^[RC]/.test(status)?2:1;fileParts.push(status);
      for(let position=0;position<count;position++){const file=parts[index++];if(!file)throw new Error('Missing history edge path.');fileParts.push(historyPath(file));}
    }
    const files=fileParts.length?parseChangedFiles(Buffer.from(fileParts.join('\0')+'\0')):[];
    const requested=expected[result.length];if(!requested||child!==requested.child||parent!==(requested.parent??''))throw new Error('History edge identity/order changed.');
    result.push({child,...(parent?{parent}:{}),files});
  }
  if(result.length!==expected.length)throw new Error('Missing history edge result.');return result;
}
function boundedFrontier(frontier:ReadonlyMap<string,ReadonlySet<string>>):void{
  let states=0,bytes=0;
  for(const [oid,paths] of frontier){validateOid(oid);bytes+=oid.length+8;for(const file of paths){historyPath(file);states++;bytes+=Buffer.byteLength(JSON.stringify(file))+1;}}
  if(states>1000||bytes>512*1024)throw new Error('File history frontier limit exceeded. Narrow the ref/path.');
}
export function initialFileCursor(tip:string,path:string):FileCursor{return{tip:validateOid(tip),path:historyPath(path),scanOffset:0,displayOffset:0,frontier:new Map([[tip,new Set([path])]]),done:false};}
export async function advanceFileCursor(cursor:FileCursor,filters:Readonly<HistoryFilters>,size:number,readHistory:(offset:number)=>Promise<LineageCommit[]>,readEdges:(edges:readonly HistoryEdge[])=>Promise<LineageEdge[]>,signal?:AbortSignal){
  boundedFrontier(cursor.frontier);const frontier=new Map([...cursor.frontier].map(([oid,paths])=>[oid,new Set(paths)]));
  const commits:HistoryCommit[]=[],paths:{oid:string;path:string}[]=[];let scanOffset=cursor.scanOffset,scanned=0,done=cursor.done;
  const since=filters.from?Date.parse(`${filters.from}T00:00:00Z`)/1000:-Infinity,until=filters.to?Date.parse(`${filters.to}T23:59:59Z`)/1000:Infinity;
  const check=()=>{if(signal?.aborted)throw new Error('History read cancelled.');};
  while(!done&&commits.length<size&&scanned<1000){
    check();const batch=await readHistory(scanOffset);check();if(batch.length>101)throw new Error('Lineage batch exceeds 101.');
    const entries=batch.slice(0,100);if(!entries.length){done=true;break;}
    const edges=entries.flatMap(({commit})=>commit.parents.length?commit.parents.map(parent=>({child:commit.oid,parent})):[{child:commit.oid}]);
    historyEdgeInput(edges);const records=await readEdges(edges);check();let edgeOffset=0,consumed=0;
    for(const item of entries){
      const commit=item.commit,current=frontier.get(commit.oid)??new Set<string>(),cost=Math.max(1,current.size);
      if(scanned+cost>1000)break;
      const selected=records.slice(edgeOffset,edgeOffset+Math.max(1,commit.parents.length));edgeOffset+=selected.length;
      if(selected.length!==Math.max(1,commit.parents.length))throw new Error('Missing lineage edge.');
      frontier.delete(commit.oid);let changedPath:string|undefined;
      for(const file of [...current].sort())for(const edge of selected){
        const change=edge.files.find(entry=>entry.path===file)??edge.files.find(entry=>entry.status.startsWith('R')&&entry.originalPath===file);
        if(change)changedPath??=file;
        if(!edge.parent||change?.status==='A'||change?.status.startsWith('C'))continue;
        const previous=change?.status.startsWith('R')&&change.path===file?change.originalPath!:file;
        if(!frontier.has(edge.parent))frontier.set(edge.parent,new Set());frontier.get(edge.parent)!.add(previous);
      }
      boundedFrontier(frontier);scanOffset++;scanned+=cost;consumed++;
      if(changedPath&&(!filters.author||`${commit.author} <${commit.email}>`.includes(filters.author))&&(!filters.text||item.message.includes(filters.text))&&item.committerTimestamp>=since&&item.committerTimestamp<=until){commits.push(commit);paths.push({oid:commit.oid,path:changedPath});}
      if(commits.length===size)break;
    }
    done=!frontier.size||(consumed===entries.length&&batch.length<=100);
    if(done||consumed<entries.length)break;
  }
  check();const next:FileCursor={...cursor,scanOffset,displayOffset:cursor.displayOffset+commits.length,frontier,done};
  return{commits:Object.freeze(commits),paths:Object.freeze(paths),scanned,hasMore:!done,cursor:next};
}
