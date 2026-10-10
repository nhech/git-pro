import { AdvancedService, type OperationSnapshot } from './advanced.service';
import { validateBranchName, validateOid } from '../../security/refs';
import { validateRemoteUrl } from '../../security/remotes';
import { decode } from '../history/history-parser';
export interface LeasePreview {snapshot:OperationSnapshot;remote:string;url:string;branch:string;source:string;expected:string}
export class LeaseService {
  private readonly previews=new WeakSet<LeasePreview>();
  constructor(private readonly advanced:AdvancedService){}
  private async url(id:string,remote:string):Promise<string>{
    const result=decode((await this.advanced.git.executor.read(this.advanced.git.repository(id).root,{kind:'remoteUrls',remote,push:true})).stdout).trim().split(/\r?\n/);
    if(result.length!==1)throw new Error('Force-with-lease requires exactly one push URL.');return validateRemoteUrl(result[0]!);
  }
  async preview(id:string,remote:string,branch:string):Promise<LeasePreview>{
    validateBranchName(remote);validateBranchName(branch);const snapshot=await this.advanced.snapshot(id);
    if(snapshot.operation!=='idle'||!snapshot.head||snapshot.status.head==='(detached)')throw new Error('Finish current Git operations and select a local branch first.');
    const url=await this.url(id,remote),output=decode((await this.advanced.git.executor.read(this.advanced.git.repository(id).root,{kind:'remoteRef',url,branch},{timeoutMs:120_000})).stdout);
    const lines=output.trim().split('\n'),expected=lines[0]?.split('\t');
    if(lines.length!==1||expected?.[1]!==`refs/heads/${branch}`)throw new Error('Remote branch does not have a unique current commit. Use normal publish for a new branch.');
    const preview=Object.freeze({snapshot,remote,url,branch,source:snapshot.head,expected:validateOid(expected[0]!)});this.previews.add(preview);return preview;
  }
  push(preview:LeasePreview):Promise<void>{
    if(!this.previews.has(preview))return Promise.reject(new Error('Force push preview expired.'));
    return this.advanced.guarded(preview.snapshot,async repo=>{if(await this.url(repo.id,preview.remote)!==preview.url)throw new Error('Remote URL changed. Review the push again.');this.previews.delete(preview);await this.advanced.git.executor.mutate(repo.root,{kind:'pushLease',url:preview.url,branch:preview.branch,source:preview.source,expected:preview.expected});});
  }
}
