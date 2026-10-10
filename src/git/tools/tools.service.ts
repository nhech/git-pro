import { AdvancedService, type OperationSnapshot } from '../advanced/advanced.service';
import { parseStashes, parseTags, parseWorktrees, type Stash, type Tag } from './tools-parser';
import { buildToolsMutation, type ToolsMutation, type ToolsRead } from './tools-builders';
import { decode, parseChangedFiles } from '../history/history-parser';
import type { ReadCommand } from '../command-builders';
import { validateBranchName, validateOid } from '../../security/refs';
import { validateRemoteUrl } from '../../security/remotes';
export interface Remote {name:string;fetch:readonly string[];push:readonly string[]}
export interface ToolPreview {snapshot:OperationSnapshot;command:ToolsMutation;fingerprint:string;summary:readonly string[]}
export class ToolsService {
  private readonly previews=new WeakSet<ToolPreview>();
  constructor(readonly advanced:AdvancedService){}
  private async read(id:string,command:ToolsRead|ReadCommand):Promise<Buffer>{const repo=this.advanced.git.repository(id);const result=await this.advanced.git.executor.read(repo.root,command,{maxOutputBytes:5*1024*1024});if(this.advanced.git.repository(id)!==repo)throw new Error('Repository changed during tools read.');return result.stdout;}
  async stashes(id:string):Promise<Stash[]>{return parseStashes(await this.read(id,{kind:'stashes'}));}
  async tags(id:string,prefix?:string):Promise<Tag[]>{return parseTags(await this.read(id,{kind:'tags',...(prefix?{prefix}:{})}));}
  async worktrees(id:string){return parseWorktrees(await this.read(id,{kind:'worktrees'}));}
  async remotes(id:string):Promise<Remote[]>{
    const names=decode(await this.read(id,{kind:'remoteNames'})).trim().split(/\r?\n/).filter(Boolean);if(names.length>100)throw new Error('Too many remotes for a bounded tools view.');
    const result:Remote[]=[];for(const name of names){validateBranchName(name);const fetch=decode(await this.read(id,{kind:'remoteUrls',remote:name,push:false})).trim().split(/\r?\n/),push=decode(await this.read(id,{kind:'remoteUrls',remote:name,push:true})).trim().split(/\r?\n/);result.push({name,fetch,push});}return result;
  }
  async pushUrl(id:string,name:string):Promise<string>{const remote=(await this.remotes(id)).find(item=>item.name===name);if(!remote||remote.push.length!==1)throw new Error('Choose a remote with one push URL.');return validateRemoteUrl(remote.push[0]!);}
  async stashDetails(id:string,stash:Stash){const current=(await this.stashes(id)).find(item=>item.selector===stash.selector);if(!current||current.oid!==stash.oid)throw new Error('Stash list changed. Refresh and select again.');return parseChangedFiles(await this.read(id,{kind:'stashFiles',oid:stash.oid}));}
  async tagMessage(id:string,name:string){validateBranchName(name);return decode(await this.read(id,{kind:'tagMessage',name}));}
  async tagCommit(id:string,tag:Tag):Promise<string>{return validateOid(decode(await this.read(id,{kind:'ref',ref:tag.oid})).trim());}
  private async fingerprint(id:string,command:ToolsMutation):Promise<string>{
    if(command.kind==='branchPush'){
      const current=validateOid(decode(await this.read(id,{kind:'ref',ref:`refs/heads/${command.localBranch}`})).trim());
      if(current!==command.source)throw new Error('Local push branch changed. Review again.');
      return JSON.stringify(await this.remotes(id))+current;
    }
    if(command.kind.startsWith('stash'))return JSON.stringify(await this.stashes(id));
    if(command.kind.startsWith('tag')&&command.kind!=='tagRemoteDelete')return JSON.stringify(await this.tags(id));
    if(command.kind==='tagRemoteDelete')return decode(await this.read(id,{kind:'remoteTagRef',url:command.url,name:command.name}));
    if(command.kind==='remotePrune'){const remote=(await this.remotes(id)).find(item=>item.name===command.remote);if(!remote||remote.fetch.length!==1)throw new Error('Prune requires one fetch URL.');validateRemoteUrl(remote.fetch[0]!);return JSON.stringify(remote)+decode(await this.read(id,{kind:'remotePrunePreview',remote:command.remote}));}
    if(command.kind.startsWith('remote'))return JSON.stringify(await this.remotes(id));
    return JSON.stringify(await this.worktrees(id));
  }
  async preview(id:string,command:ToolsMutation):Promise<ToolPreview>{
    if(command.kind.startsWith('worktree'))throw new Error('Worktree mutations require a scoped worktree review service.');
    buildToolsMutation(command);const snapshot=await this.advanced.snapshot(id);
    if(snapshot.operation!=='idle'||snapshot.status.changes.some(change=>change.group==='conflicts'))throw new Error('Finish current conflicts/Git operations first.');
    if(command.kind==='stashCreate'&&!snapshot.head)throw new Error('Create a first commit before stashing.');
    // Stashing untracked files removes them afterwards, which would delete files outside the repository through the link.
    if(command.kind==='stashCreate'&&command.untracked&&snapshot.external.length)throw new Error(`Untracked ${snapshot.external[0]} is reached through a link outside the repository. Remove the link or stash tracked files only.`);
    if(command.kind==='stashBranch'&&snapshot.status.changes.length)throw new Error('Stash Branch requires a clean working tree.');
    if((command.kind==='tagCheckout'||command.kind==='tagBranch')&&snapshot.status.changes.length)throw new Error('Commit or stash local changes before checking out a tag.');
    if(command.kind==='stashDrop'||command.kind==='stashBranch'){const list=await this.stashes(id),selected=list.find(item=>item.selector===command.selector);if(!selected||selected.oid!==command.expected)throw new Error('Stash selector changed. Refresh and select again.');if(list.filter(item=>item.oid===selected.oid).length!==1)throw new Error('Duplicate stash identity requires native Git review.');}
    if(command.kind==='stashApply'&&!(await this.stashes(id)).some(stash=>stash.oid===command.oid))throw new Error('Select an existing stash OID.');
    if(command.kind==='tagCreate'&&(await this.tags(id)).some(tag=>tag.name===command.name))throw new Error('Tag already exists.');
    if(command.kind==='tagDelete'&&!(await this.tags(id)).some(tag=>tag.name===command.name&&tag.oid===command.expected))throw new Error('Tag changed. Refresh and select again.');
    const fingerprint=await this.fingerprint(id,command);
    if(command.kind.startsWith('stash')){
      const captured=JSON.parse(fingerprint) as Stash[];
      if(captured.length>500)throw new Error('Stash list exceeds 500 entries. Review in native Git.');
      if((command.kind==='stashDrop'||command.kind==='stashBranch')&&!captured.some(item=>item.selector===command.selector&&item.oid===command.expected))throw new Error('Stash selector changed during review.');
    }
    const frozen=Object.freeze({...command,...(command.kind==='tagPush'?{tags:Object.freeze(command.tags.map(tag=>Object.freeze({...tag})))}:{})}) as ToolsMutation;
    const summary=command.kind==='remotePrune'?fingerprint.split('\n').filter(line=>line.includes('[would prune]')):command.kind==='stashCreate'?snapshot.status.changes.map(change=>`${change.group}: ${change.path}`):command.kind==='tagPush'?command.tags.map(tag=>`${tag.name}: ${tag.oid}`):[];
    const result=Object.freeze({snapshot,command:frozen,fingerprint,summary:Object.freeze(summary)});this.previews.add(result);return result;
  }
  execute(preview:ToolPreview):Promise<void>{
    if(!this.previews.has(preview))return Promise.reject(new Error('Tools preview expired.'));
    return this.advanced.guarded(preview.snapshot,async repo=>{if(await this.fingerprint(repo.id,preview.command)!==preview.fingerprint)throw new Error('Repository tools state changed. Refresh and review again.');this.previews.delete(preview);await this.advanced.git.executor.mutate(repo.root,preview.command);});
  }
  async pop(preview:ToolPreview,stash:Stash):Promise<void>{
    if(!this.previews.has(preview)||preview.command.kind!=='stashApply'||preview.command.oid!==stash.oid)throw new Error('Review a stash apply preview first.');
    await this.advanced.guarded(preview.snapshot,async repo=>{
      const before=await this.stashes(repo.id);if(JSON.stringify(before)!==preview.fingerprint||before.filter(item=>item.oid===stash.oid).length!==1)throw new Error('Stash list changed. Review pop again.');this.previews.delete(preview);
      // Drop only after a successful apply. A conflict keeps the original stash.
      await this.advanced.git.executor.mutate(repo.root,preview.command);
      const after=await this.stashes(repo.id),item=after.find(item=>item.oid===stash.oid);if(!item||after.filter(entry=>entry.oid===stash.oid).length!==1)throw new Error('Stash applied; list changed, so it was retained. Review before dropping.');
      await this.advanced.git.executor.mutate(repo.root,{kind:'stashDrop',selector:item.selector,expected:item.oid});
    });
  }
  async remoteTagDeletePreview(id:string,url:string,name:string):Promise<ToolPreview>{
    const output=decode(await this.read(id,{kind:'remoteTagRef',url,name})).trim().split('\n');const fields=output[0]?.split('\t');if(output.length!==1||fields?.[1]!==`refs/tags/${name}`)throw new Error('Remote tag is unavailable.');return this.preview(id,{kind:'tagRemoteDelete',url,name,expected:validateOid(fields[0]!)});
  }
}
