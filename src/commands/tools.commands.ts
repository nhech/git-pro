import * as vscode from 'vscode';
import { ToolsService, type ToolPreview } from '../git/tools/tools.service';
import { WorktreeService, type WorktreePreview } from '../git/tools/worktree.service';
import { redact } from '../security/redaction';
import { validateBranchName } from '../security/refs';
import { HistoryService } from '../git/history/history.service';
import { RevisionProvider } from '../documents/revision-provider';
import { editMessage } from './message-editor';
import { readRepositoryToolsContext } from '../views/tools/repository-tools-context';
export class ToolsCommands {
  constructor(private readonly tools:ToolsService,private readonly worktrees:WorktreeService,private readonly history:HistoryService,private readonly revisions:RevisionProvider){}
  private async pick(title:string,items:readonly string[]){return vscode.window.showQuickPick(items.map(value=>({label: value})),{title}).then(choice=>choice?.label);}
  private async input(prompt:string,value?:string){return vscode.window.showInputBox({prompt,...(value?{value}:{}),ignoreFocusOut:true});}
  private async confirm(preview:ToolPreview|WorktreePreview,details:string,execute:()=>Promise<void>){
    const choice=await vscode.window.showWarningMessage(redact(details),{modal:true,detail:redact(`Repository: ${this.tools.advanced.git.repository(preview.snapshot.repositoryId).root}\nHEAD: ${preview.snapshot.head??'unborn'}\n${'summary' in preview?preview.summary.join('\n'):preview.details.join('\n')}`)},'Apply');
    if(choice==='Apply')await execute();
  }
  async actions(category?:unknown,repositoryId?:unknown,selectedKey?:unknown){
    if(category&&typeof category==='object'){const node=readRepositoryToolsContext(category);if(!node)throw new Error('Select a Repository Tools group or entry.');category=node.group;repositoryId=node.repositoryId;selectedKey=node.key;}
    if(selectedKey!==undefined&&(typeof selectedKey!=='string'||!selectedKey||selectedKey.length>65536||selectedKey.includes('\0')))throw new Error('Select an entry from Repository Tools.');
    const repo=typeof repositoryId==='string'?this.tools.advanced.git.repository(repositoryId):this.tools.advanced.git.registry.active;if(!repo)throw new Error('Select a repository first.');
    const group=typeof category==='string'&&['Stashes','Tags','Remotes','Worktrees'].includes(category)?category:await this.pick('Repository Tools',['Stashes','Tags','Remotes','Worktrees']);
    const key=typeof selectedKey==='string'?selectedKey:undefined;
    if(group==='Stashes')await this.stashes(repo.id,key);else if(group==='Tags')await this.tags(repo.id,key);else if(group==='Remotes')await this.remotes(repo.id,key);else if(group==='Worktrees')await this.worktreeActions(repo.id,key);
  }
  private async apply(id:string,command:ToolPreview['command'],description:string){const preview=await this.tools.preview(id,command);await this.confirm(preview,description,()=>this.tools.execute(preview));}
  private async stashes(id:string,key?:string){
    const list=await this.tools.stashes(id);if(list.length>500)throw new Error('Stash list exceeds 500 entries. Review older entries in native Git.');
    const selected=key?{stash:list.find(stash=>stash.oid+stash.selector===key)}:await vscode.window.showQuickPick([{label:'$(add) Create Stash',stash:undefined},...list.map(stash=>({label:redact(`${stash.selector} ${stash.subject}`),description:stash.oid.slice(0,10),stash}))],{title:'Stashes — repository pinned'});if(!selected)return;if(key&&!selected.stash)throw new Error('Stash selection changed. Refresh and select again.');
    if(!selected.stash){const message=await this.input('Stash message');if(!message)return;const option=await this.pick('Include untracked files?',['Tracked files only','Tracked and untracked files']);if(!option)return;await this.apply(id,{kind:'stashCreate',message,untracked:option==='Tracked and untracked files'},'Create stash from the reviewed working tree?');return;}
    const stash=selected.stash,action=await this.pick('Stash Actions',['Inspect Files','Apply','Pop','Create Branch','Drop']);if(!action)return;
    if(action==='Inspect Files'){
      const files=await this.tools.stashDetails(id,stash),selectedFile=await vscode.window.showQuickPick(files.map(file=>({label:redact(file.path),description:file.status,file})),{title:`${stash.oid.slice(0,10)} — choose file to compare`});if(!selectedFile)return;
      const details=await this.history.details(id,stash.oid),untracked=details.commit.parents[2];
      const untrackedFiles=untracked?(await this.history.details(id,untracked)).files:[];
      const file=selectedFile.file,to=untracked&&untrackedFiles.some(item=>item.path===file.path)?untracked:stash.oid;
      const [left,right]=await Promise.all([this.history.revision(id,details.commit.parents[0],file.originalPath??file.path),this.history.revision(id,to,file.path)]);
      await vscode.commands.executeCommand('vscode.diff',this.revisions.add(left,file.path),this.revisions.add(right,file.path),redact(`Stash ${stash.oid.slice(0,10)}: ${file.path}`));return;
    }
    if(action==='Drop'){await this.apply(id,{kind:'stashDrop',selector:stash.selector,expected:stash.oid},`Drop ${stash.selector} (${stash.oid})?`);return;}
    if(action==='Create Branch'){const name=await this.input('New branch from stash');if(name)await this.apply(id,{kind:'stashBranch',selector:stash.selector,expected:stash.oid,name},`Create branch ${name} and apply this stash?`);return;}
    const index=await this.pick('Restore original staged state?',['Working tree only','Restore index too']);if(!index)return;
    const preview=await this.tools.preview(id,{kind:'stashApply',oid:stash.oid,index:index==='Restore index too'});
    await this.confirm(preview,`${action} stash ${stash.oid}? Conflicts retain the stash.`,()=>action==='Pop'?this.tools.pop(preview,stash):this.tools.execute(preview));
  }
  private async tags(id:string,key?:string){
    const prefix=key?'':await this.input('Tag prefix filter (empty lists first 500)','');if(prefix===undefined)return;
    const list=await this.tools.tags(id,prefix||undefined),selected=key?{tag:list.find(tag=>tag.name===key)}:await vscode.window.showQuickPick([{label:'$(add) Create Tag',tag:undefined},...list.slice(0,500).map(tag=>({label:redact(tag.name),description:`${tag.annotated?'annotated':'lightweight'} · ${tag.target.slice(0,10)}`,tag}))],{title:list.length>500?'Tags — first 500; narrow prefix to see more':'Tags'});if(!selected)return;if(key&&!selected.tag)throw new Error('Tag selection changed. Refresh and select again.');
    if(!selected.tag){const name=await this.input('New tag name');if(!name)return;validateBranchName(name);const snapshot=await this.tools.advanced.snapshot(id);if(!snapshot.head)throw new Error('Create a commit first.');const type=await this.pick('Tag type',['Lightweight','Annotated']);if(!type)return;const message=type==='Annotated'?await editMessage('','Tag annotation'):undefined;if(type==='Annotated'&&!message)return;await this.apply(id,{kind:'tagCreate',name,oid:snapshot.head,...(message?{message}:{})},`Create ${type.toLowerCase()} tag ${name} at ${snapshot.head}? Configured signing applies.`);return;}
    const tag=selected.tag,action=await this.pick('Tag Actions',['View Message','Compare With HEAD','Checkout Detached','Create Branch','Push',...(key?[]:['Push All Listed Tags']),'Delete Local','Delete Remote']);if(!action)return;
    if(action==='Compare With HEAD'){
      const comparison=await this.history.compare(id,await this.tools.tagCommit(id,tag),'HEAD');
      if(!comparison.files.length){await vscode.window.showInformationMessage('No file changes between this tag and pinned HEAD.');return;}
      const choice=await vscode.window.showQuickPick(comparison.files.map(file=>({label:redact(file.path),description:file.status,file})),{title:redact(`${tag.name} → HEAD — choose a file`)});if(!choice)return;
      const file=choice.file,[left,right]=await Promise.all([this.history.revision(id,comparison.from,file.originalPath??file.path),this.history.revision(id,comparison.to,file.path)]);
      await vscode.commands.executeCommand('vscode.diff',this.revisions.add(left,file.originalPath??file.path),this.revisions.add(right,file.path),redact(`${tag.name} (${comparison.from.slice(0,8)}) → HEAD (${comparison.to.slice(0,8)}): ${file.path}`));return;
    }
    if(action==='Checkout Detached'){await this.apply(id,{kind:'tagCheckout',oid:await this.tools.tagCommit(id,tag)},`Checkout ${tag.name} at its pinned commit in detached HEAD?`);return;}
    if(action==='Create Branch'){const name=await this.input('New branch from tag');if(name)await this.apply(id,{kind:'tagBranch',name,oid:await this.tools.tagCommit(id,tag)},`Create and checkout ${name} from ${tag.name}?`);return;}
    if(action==='View Message'){const document=await vscode.workspace.openTextDocument({content:await this.tools.tagMessage(id,tag.name),language:'git-commit'});await vscode.window.showTextDocument(document,{preview:true});return;}
    if(action==='Delete Local'){await this.apply(id,{kind:'tagDelete',name:tag.name,expected:tag.oid},`Delete local tag ${tag.name} (${tag.oid})?`);return;}
    const remote=await this.pick('Choose push remote',(await this.tools.remotes(id)).map(item=>item.name));if(!remote)return;const url=await this.tools.pushUrl(id,remote);
    if(action==='Push'||action==='Push All Listed Tags'){
      if(action==='Push All Listed Tags'&&list.length>500)throw new Error('Narrow the prefix to at most 500 tags before pushing all listed tags.');
      const tags=action==='Push'? [tag]:list;
      await this.apply(id,{kind:'tagPush',url,tags:tags.map(item=>({name:item.name,oid:item.oid}))},`Push ${tags.length} reviewed tag(s) to ${url}?`);
    }
    else {const preview=await this.tools.remoteTagDeletePreview(id,url,tag.name);await this.confirm(preview,`Delete remote tag ${tag.name} from ${url}?`,()=>this.tools.execute(preview));}
  }
  private async remotes(id:string,key?:string){
    const list=await this.tools.remotes(id),selected=key?{remote:list.find(remote=>remote.name===key)}:await vscode.window.showQuickPick([{label:'$(add) Add Remote',remote:undefined},...list.map(remote=>({label:remote.name,description:redact(`Fetch: ${remote.fetch.join(', ')} · Push: ${remote.push.join(', ')}`),remote}))],{title:'Remotes'});if(!selected)return;if(key&&!selected.remote)throw new Error('Remote selection changed. Refresh and select again.');
    if(!selected.remote){const name=await this.input('Remote name');if(!name)return;const url=await this.input('Remote URL');if(url)await this.apply(id,{kind:'remoteAdd',name,url},`Add remote ${name}: ${url}?`);return;}
    const name=selected.remote.name,action=await this.pick('Remote Actions',['Fetch','Push Local Branch','Set Branch Upstream','Rename','Set Fetch URL','Set Push URL','Prune','Remove']);if(!action)return;
    if(action==='Fetch'){await this.tools.advanced.git.fetch(id,name);return;}
    if(action==='Push Local Branch'){
      const branch=await vscode.window.showQuickPick((await this.tools.advanced.git.branches(id)).filter(item=>!item.remote).map(item=>({label:redact(item.name),branch:item})),{title:'Local branch to push — current branch will not switch'});if(!branch)return;
      const destination=await this.input('Destination branch name',branch.branch.name);if(!destination)return;const url=await this.tools.pushUrl(id,name);
      await this.apply(id,{kind:'branchPush',url,localBranch:branch.branch.name,destination,source:branch.branch.oid},`Push ${branch.branch.name} (${branch.branch.oid}) to ${url} refs/heads/${destination}? No force.`);return;
    }
    if(action==='Set Branch Upstream'){
      const branches=await this.tools.advanced.git.branches(id),branch=await this.pick('Local branch',branches.filter(item=>!item.remote).map(item=>item.name));if(!branch)return;
      const upstream=await this.pick('Remote-tracking upstream',branches.filter(item=>item.remote&&item.name.startsWith(name+'/')).map(item=>item.name));if(!upstream)return;
      if(await vscode.window.showWarningMessage(redact(`Set ${branch} upstream to ${upstream}?`),{modal:true},'Set Upstream')==='Set Upstream')await this.tools.advanced.git.setUpstream(id,branch,upstream);return;
    }
    if(action==='Remove')await this.apply(id,{kind:'remoteRemove',name},`Remove remote ${name} and its tracking references?`);
    else if(action==='Prune')await this.apply(id,{kind:'remotePrune',remote:name},`Prune reviewed stale tracking refs for ${name}?`);
    else if(action==='Rename'){const newName=await this.input('New remote name');if(newName)await this.apply(id,{kind:'remoteRename',name,newName},`Rename ${name} to ${newName}?`);}
    else{const url=await this.input('New remote URL');if(url)await this.apply(id,{kind:'remoteSetUrl',name,url,push:action==='Set Push URL'},`${action} for ${name}: ${url}?`);}
  }
  private async worktreeActions(id:string,key?:string){
    const list=await this.tools.worktrees(id),selected=key?{worktree:list.find(worktree=>worktree.path===key),prune:false}:await vscode.window.showQuickPick([{label:'$(add) Create Worktree',worktree:undefined,prune:false},{label:'Prune Stale Worktree Metadata',worktree:undefined,prune:true},...list.map(worktree=>({label:redact(worktree.path),description:worktree.locked?'locked':worktree.branch??'detached',worktree,prune:false}))],{title:'Worktrees — reviewed destinations'});if(!selected)return;if(key&&!selected.worktree)throw new Error('Worktree selection changed. Refresh and select again.');
    let command:WorktreePreview['command'];
    if(selected.prune)command={kind:'worktreePrune'};
    else if(!selected.worktree){const destination=await this.input('Absolute empty worktree destination; external paths require approval for this operation');if(!destination)return;const branch=await this.input('New branch name (empty for detached HEAD)');if(branch===undefined)return;const snapshot=await this.tools.advanced.snapshot(id);if(!snapshot.head)throw new Error('Create a commit first.');command={kind:'worktreeAdd',destination,oid:snapshot.head,...(branch?{branch}:{})};}
    else{const action=await this.pick('Worktree Actions',['Open in New Window','Remove']);if(!action)return;if(action==='Open in New Window'){await vscode.commands.executeCommand('vscode.openFolder',vscode.Uri.file(selected.worktree.path),true);return;}command={kind:'worktreeRemove',destination:selected.worktree.path};}
    let grant;
    if(command.kind!=='worktreePrune'&&await this.worktrees.destinationNeedsApproval(command.destination)){
      const answer=await vscode.window.showWarningMessage('Approve this external worktree destination for this operation?',{modal:true,detail:redact(`${command.destination}\nOnly this exact destination is approved. It is not added to the workspace. Removal still requires a registered clean, unlocked linked worktree and a final review.`)},'Approve Destination');
      if(answer!=='Approve Destination')return;grant=await this.worktrees.approveDestination(command.destination);
    }
    const preview=await this.worktrees.preview(id,command,grant);await this.confirm(preview,`Review ${command.kind} before applying.`,()=>this.worktrees.execute(preview));
  }
}
