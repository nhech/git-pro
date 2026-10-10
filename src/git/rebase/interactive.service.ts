import { mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AdvancedService, type OperationSnapshot } from '../advanced/advanced.service';
import { validateRebasePlan, type RebaseStep, type LinearCommit } from './rebase-plan';
import { validateOid } from '../../security/refs';
import { decode, parseRangeMessages } from '../history/history-parser';
import { detectOperation } from '../../state/operation-state';
import { boundedFile } from '../../utils/bounded-file';
import type { EditorJob, OwnedEditor } from '../advanced/owned-editor';
export interface RebaseJobInfo {directory:string;token:string;base:string;tip:string;repositoryId:string}
export interface RebaseJournal {get(id:string):Promise<RebaseJobInfo|undefined>;put(id:string,job:RebaseJobInfo|undefined):Promise<void>}
export interface InteractivePreview {snapshot:OperationSnapshot;base:string;commits:readonly LinearCommit[]}
export class InteractiveService {
  private readonly previews=new WeakSet<InteractivePreview>();
  constructor(private readonly advanced:AdvancedService,private readonly storage:string,private readonly editor:OwnedEditor,private readonly journal:RebaseJournal){}
  async preview(id:string,ref:string):Promise<InteractivePreview>{
    const snapshot=await this.advanced.snapshot(id),base=await this.advanced.resolve(id,ref);
    if(snapshot.operation!=='idle'||!snapshot.head||snapshot.status.changes.length)throw new Error('Interactive rebase requires a clean committed repository.');
    const repo=this.advanced.git.repository(id),raw=decode((await this.advanced.git.executor.read(repo.root,{kind:'linearRange',base,tip:snapshot.head})).stdout).trim().split('\n').filter(Boolean);
    if(!raw.length||raw.length>200)throw new Error('Choose a range of 1–200 commits after the base.');
    let parent=base;const chain:{oid:string;parent:string}[]=[];
    for(const line of raw){const fields=line.trim().split(' ');if(fields.length!==2||fields[1]!==parent)throw new Error('Initial planner supports a linear ancestor range only. Merge ranges require native Git.');const oid=validateOid(fields[0]!);chain.push({oid,parent});parent=oid;}
    if(parent!==snapshot.head)throw new Error('Range does not end at the reviewed HEAD.');
    const messages=await this.messages(repo.root,base,snapshot.head,chain.map(link=>link.oid));
    const commits:LinearCommit[]=chain.map(({oid,parent})=>Object.freeze({oid,parent,subject:Buffer.from(((messages.get(oid)??'').split('\n',1)[0]??'').slice(0,500),'utf8').toString('utf8')}));
    const result=Object.freeze({snapshot,base,commits:Object.freeze(commits)});this.previews.add(result);return result;
  }
  /** One `git log` for the whole range; a Git process per commit costs seconds for a 200-commit plan. */
  private async messages(root:string,base:string,tip:string,oids:readonly string[]):Promise<Map<string,string>>{
    const executor=this.advanced.git.executor;
    try{
      const records=parseRangeMessages((await executor.read(root,{kind:'rangeMessages',base,tip},{maxOutputBytes:4*1024*1024})).stdout);
      // Each message keeps the 1 MiB bound it always had; the batch only saves processes.
      if(records.length===oids.length&&records.every((record,index)=>record.oid===oids[index]&&Buffer.byteLength(record.message)<=1024*1024))return new Map(records.map(record=>[record.oid,record.message]));
    }catch(error){if((error as {kind?:string}).kind!=='output-limit')throw error;}
    // Unusually large messages, or an order that differs from the reviewed chain: read each commit separately, as before.
    const result=new Map<string,string>();
    for(const oid of oids)result.set(oid,decode((await executor.read(root,{kind:'commitMessage',oid},{maxOutputBytes:1024*1024})).stdout));
    return result;
  }
  async execute(preview:InteractivePreview,steps:readonly RebaseStep[]):Promise<void>{
    if(!this.previews.has(preview))throw new Error('Rebase preview expired.');validateRebasePlan(preview.commits,steps);
    const frozen=steps.map(step=>({oid:step.oid,action:step.action,...(step.action==='reword'?{message:step.message}:{})}));
    await this.advanced.guarded(preview.snapshot,async repo=>{
      this.previews.delete(preview);await this.cleanup(repo.id);if(await this.journal.get(repo.id))throw new Error('An owned rebase job already exists. Resume or abort it first.');
      await mkdir(this.storage,{recursive:true});const token=randomUUID(),directory=path.join(await realpath(this.storage),token);await mkdir(directory);
      const info:RebaseJobInfo={directory,token,base:preview.base,tip:preview.snapshot.head!,repositoryId:repo.id},file=path.join(directory,'plan.json');
      await writeFile(file,JSON.stringify({token,gitDir:repo.gitDir,steps:frozen}),{encoding:'utf8',flag:'wx',mode:0o600});await this.journal.put(repo.id,info);
      try{await this.advanced.git.executor.mutate(repo.root,{kind:'interactiveRebase',base:preview.base},{editorJob:{...this.editor,file,token}});}finally{await this.cleanup(repo.id);}
    });
  }
  private async owned(job:RebaseJobInfo,id:string):Promise<string>{
    if(job.repositoryId!==id||!/^[a-f0-9-]{36}$/.test(job.token))throw new Error('Invalid persisted rebase job.');
    const root=await realpath(this.storage),directory=await realpath(job.directory);
    if(path.dirname(directory)!==root||path.basename(directory)!==job.token)throw new Error('Rebase job is outside owned storage.');
    return directory;
  }
  async resume(id:string):Promise<EditorJob|undefined>{
    const job=await this.journal.get(id);if(!job)return;
    const directory=await this.owned(job,id),repo=this.advanced.git.repository(id);
    if(await detectOperation(repo.gitDir)!=='rebasing')return;
    const original=decode(await boundedFile(path.join(repo.gitDir,'rebase-merge','orig-head'),1024)).trim(),onto=decode(await boundedFile(path.join(repo.gitDir,'rebase-merge','onto'),1024)).trim();
    if(original!==job.tip||onto!==job.base)throw new Error('Active rebase differs from the persisted plan. Use native Git to review this state.');
    return {...this.editor,file:path.join(directory,'plan.json'),token:job.token};
  }
  async cleanup(id:string):Promise<void>{
    const job=await this.journal.get(id);if(!job||await detectOperation(this.advanced.git.repository(id).gitDir)==='rebasing')return;
    const directory=await this.owned(job,id);await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});await this.journal.put(id,undefined);
  }
}
