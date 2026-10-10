import * as vscode from 'vscode';
import { editMessage } from './message-editor';
import { AdvancedService } from '../git/advanced/advanced.service';
import { ConflictsService } from '../git/conflicts/conflicts.service';
import { RevisionProvider } from '../documents/revision-provider';
import type { AdvancedMutation } from '../git/advanced/advanced-builders';
import { canonicalFilePath } from '../security/paths';
import { redact } from '../security/redaction';
import * as path from 'node:path';
import { LeaseService } from '../git/advanced/lease.service';
import { InteractiveService } from '../git/rebase/interactive.service';
import { validateRebasePlan, type RebaseStep, type RebaseAction } from '../git/rebase/rebase-plan';
import type { RebasePlanner } from '../webviews/rebase/rebase-planner';
import type { InteractivePreview } from '../git/rebase/interactive.service';
export class AdvancedCommands {
  readonly conflicts:ConflictsService;
  readonly leases:LeaseService;
  constructor(readonly advanced:AdvancedService,private readonly revisions:RevisionProvider,private readonly interactive:InteractiveService,private readonly planner:RebasePlanner,private readonly extensionUri:vscode.Uri){this.conflicts=new ConflictsService(advanced);this.leases=new LeaseService(advanced);}
  private active():string {const id=this.advanced.git.registry.active?.id;if(!id)throw new Error('Select a repository first.');return id;}
  private editMessage(initial:string,title:string):Promise<string|undefined>{return editMessage(initial,title);}
  async forcePush():Promise<void>{
    const id=this.active(),repo=this.advanced.git.repository(id);
    const names=await this.advanced.git.remotes(id),remote=await vscode.window.showQuickPick(names.map(item=>({label:redact(item.name),name:item.name})),{title:'Git Pro: Force-with-lease remote'});if(!remote)return;
    const branch=await vscode.window.showInputBox({title:'Remote branch to replace',value:this.advanced.git.registry.store.get(id)?.head??'',prompt:'Review the exact remote branch and current OID before rewriting history.'});if(!branch)return;
    const preview=await this.leases.preview(id,remote.name,branch);
    if(await vscode.window.showWarningMessage('Replace remote branch history with an explicit lease?',{modal:true,detail:redact(`${repo.root}\n${preview.url}\nrefs/heads/${branch}\nExpected remote: ${preview.expected}\nReplacement: ${preview.source}\nThe push will fail if the remote branch has changed.`)},'Push with lease')!=='Push with lease')return;
    await vscode.window.withProgress({location:vscode.ProgressLocation.Window,title:'Git Pro: Push with lease'},()=>this.leases.push(preview));
  }
  async actions():Promise<void>{
    const id=this.active(),snapshot=await this.advanced.snapshot(id);
    if(snapshot.operation!=='idle'){
      if(!['merging','rebasing','cherry-picking','reverting'].includes(snapshot.operation)){await vscode.window.showInformationMessage(`Git Pro: ${snapshot.operation}. Use native Git to finish this operation.`);return;}
      const editStop=await this.advanced.isEditStop(snapshot);
      const conflicts=snapshot.status.changes.filter(change=>change.group==='conflicts').length;
      const operation=snapshot.operation==='merging'?'Merge':snapshot.operation==='rebasing'?'Rebase':snapshot.operation==='cherry-picking'?'Cherry-pick':'Revert';
      const contrast=vscode.window.activeColorTheme.kind===vscode.ColorThemeKind.HighContrast||vscode.window.activeColorTheme.kind===vscode.ColorThemeKind.HighContrastLight;
      const icon=(name:string)=>contrast?new vscode.ThemeIcon(name):vscode.Uri.joinPath(this.extensionUri,'media','operation-icons',`${name}.svg`);
      const items=[
        {label:'Continue',description:conflicts?'Resume after resolving and staging all conflicted files':editStop?'Resume after reviewing the staged changes':'Resume the stopped operation after reviewing staged changes',iconPath:icon('play'),action:'continue'},
        ...(editStop?[
          {label:'Stage edited files',description:'Choose edited files to stage before amending',iconPath:icon('add'),action:'stageEdit'},
          {label:'Amend stopped commit',description:'Update the stopped commit with reviewed staged changes',iconPath:icon('edit'),action:'amendEdit'}
        ]:[]),
        ...(snapshot.operation==='merging'?[]:[{label:'Skip current commit',description:'Discard this commit from the sequence; review its changes first',iconPath:icon('debug-step-over'),action:'skip'}]),
        {label:'Abort',description:'Return to the original state; review resolutions first',iconPath:icon('circle-slash'),action:'abort'}
      ];
      const guidance=conflicts?`${conflicts} conflicted ${conflicts===1?'file':'files'} · resolve and stage, then Continue`:editStop?'Paused to edit a commit · review and stage edits, then Continue':'No conflicted files · review staged changes, then Continue';
      const item=await vscode.window.showQuickPick(items,{title:`Git Pro: ${operation} paused`,placeHolder:guidance});if(!item)return;
      if(item.action==='stageEdit'){const selected=await vscode.window.showQuickPick(snapshot.status.changes.filter(change=>change.group==='working'||change.group==='untracked').map(change=>({label:redact(change.path),path:change.path})),{title:'Stage selected edited files',canPickMany:true});if(selected?.length)await this.advanced.stageEdit(snapshot,selected.map(item=>item.path));return;}
      if(item.action==='amendEdit'){const mode=await vscode.window.showQuickPick(['Keep existing message','Edit message'],{title:'Amend stopped commit'});if(!mode)return;let message:string|undefined;if(mode==='Edit message'){const original=(await this.advanced.git.executor.read(this.advanced.git.repository(id).root,{kind:'commitMessage',oid:snapshot.head!})).stdout.toString('utf8');message=await this.editMessage(original,'Amend stopped commit');if(message===undefined)return;}if(await vscode.window.showWarningMessage('Amend the stopped commit with the reviewed index?',{modal:true,detail:'Only staged changes will be committed. Hooks and signing remain enabled.'},'Amend')==='Amend')await this.advanced.amendEdit(snapshot,message);return;}
      const detail=item.action==='abort'?'Return to the original state of this Git operation. Review any resolutions before aborting.':item.action==='skip'?'Discard the current commit from this sequence. Review its changes first.':'All conflicts must be staged. Hooks will still run.';
      if(await vscode.window.showWarningMessage(`${item.label} ${snapshot.operation}?`,{modal:true,detail},item.label)!==item.label)return;
      await this.advanced.control(snapshot,item.action as 'continue'|'abort'|'skip');return;
    }
    const action=await vscode.window.showQuickPick(['Merge','Rebase','Interactive Rebase','Cherry-pick','Revert','Reset'],{title:'Git Pro: Advanced Actions',placeHolder:'Review pinned targets and affected files before applying'});if(!action)return;
    if(action==='Interactive Rebase'){await this.rebasePlan();return;}
    let command:AdvancedMutation;
    if(action==='Cherry-pick'||action==='Revert'){
      const value=await vscode.window.showInputBox({title:`Git Pro: ${action} commits in application order`,prompt:'Full commit IDs separated by spaces; first listed is applied first (maximum 100).'});if(!value)return;
      const oids=value.trim().split(/\s+/);let parent:number|undefined;
      if(oids.length===1){const result=(await this.advanced.git.executor.read(this.advanced.git.repository(id).root,{kind:'history',tips:oids,offset:0,limit:1})).stdout;
        const {parseHistory}=await import('../git/history/history-parser');const commit=parseHistory(result)[0];
        if(commit&&commit.parents.length>1){const selected=await vscode.window.showQuickPick(commit.parents.map((oid,index)=>({label:`Parent ${index+1}`,description:oid,index:index+1})),{title:'Choose merge mainline parent'});if(!selected)return;parent=selected.index;}}
      command={kind:action==='Cherry-pick'?'cherryPick':'revert',oids,...(parent!==undefined?{parent}:{})};
    }else{
      const ref=await vscode.window.showInputBox({title:`Git Pro: ${action} target`,value:action==='Reset'?'HEAD~1':'',prompt:'Branch, full commit ID, or bounded numeric ancestry (for example HEAD~1).'});if(!ref)return;
      const oid=await this.advanced.resolve(id,ref);
      if(action==='Merge'){const strategy=await vscode.window.showQuickPick([{label:'Default / fast-forward if possible',value:'ff' as const},{label:'Fast-forward only',value:'ff-only' as const},{label:'Always create merge commit',value:'no-ff' as const},{label:'Squash into staged changes',value:'squash' as const}],{title:'Merge strategy'});if(!strategy)return;command={kind:'merge',oid,strategy:strategy.value};}
      else if(action==='Rebase')command={kind:'rebase',oid};
      else{const mode=await vscode.window.showQuickPick([{label:'Soft — move HEAD, keep index and working files',value:'soft' as const},{label:'Mixed — move HEAD/reset index, keep working files',value:'mixed' as const},{label:'Hard — discard tracked index and working changes',value:'hard' as const},{label:'Keep — abort if local working changes would be overwritten',value:'keep' as const}],{title:'Reset mode'});if(!mode)return;command={kind:'reset',oid,mode:mode.value};}
    }
    const preview=await this.advanced.preview(id,command),label=action==='Reset'?`${action} (${command.kind==='reset'?command.mode:''})`:action;
    const target='oid' in command?command.oid:command.kind==='cherryPick'||command.kind==='revert'?command.oids.join('\n'):'';
    const warning=command.kind==='reset'&&command.mode==='hard'?'\nHard reset can also remove untracked files that obstruct tracked target paths. Reviewed content will be discarded.':'';
    const local=preview.snapshot.status.changes.map(change=>`${change.group}: ${change.path}`);
    const rebase=preview.rebaseContext?`\nLocal-only commits: ${preview.rebaseContext.localCount} · first ${preview.rebaseContext.candidates.length} shown\n${preview.rebaseContext.candidates.map(commit=>`${commit.oid.slice(0,10)} ${commit.subject.slice(0,200)}`).join('\n')}\nTopology context: Git may flatten merges or skip equivalent commits.`:'';
    const merge=preview.mergeContext?`\nTopology: ${preview.mergeContext.headOnly} HEAD-only / ${preview.mergeContext.targetOnly} target-only commits\nResulting history depends on the selected merge strategy.`:'';
    const detail=redact(`${this.advanced.git.repository(id).root}\nHEAD: ${preview.snapshot.head}\nTarget(s): ${target}\n${preview.files.length} changed files between HEAD and target\n${preview.files.slice(0,20).map(file=>file.path).join('\n')}\nLocal changes: ${local.length}\n${local.slice(0,20).join('\n')}${warning}${rebase}${merge}`);
    if(await vscode.window.showWarningMessage(`${label}?`,{modal:true,detail},'Apply')!=='Apply')return;
    await vscode.window.withProgress({location:vscode.ProgressLocation.Window,title:`Git Pro: ${label}`},()=>this.advanced.execute(preview));
    if(command.kind==='merge'&&command.strategy==='squash'){await vscode.window.showInformationMessage('Squash changes are staged. Review and commit them in the composer.');await vscode.commands.executeCommand('gitPro.commitView.focus');}
  }
  async rebasePlan():Promise<void>{
    const id=this.active(),ref=await vscode.window.showInputBox({title:'Git Pro: Interactive Rebase base',value:'HEAD~1',prompt:'Rewrite commits after this ancestor. Initial planner supports 1–200 linear commits.'});if(!ref)return;
    const preview=await this.interactive.preview(id,ref),steps:RebaseStep[]=preview.commits.map(commit=>({oid:commit.oid,action:'pick'}));
    const chosen=await this.planner.choose(preview,this.advanced.git.repository(id).root,async(oid,initial)=>this.editMessage(initial??(await this.advanced.git.executor.read(this.advanced.git.repository(id).root,{kind:'commitMessage',oid})).stdout.toString('utf8'),'Reword commit'),steps=>this.confirmRebasePlan(preview,steps));
    if(!chosen)return;if(!('native' in chosen)){await this.applyRebasePlan(preview,chosen);return;}
    steps.splice(0,steps.length,...chosen.native.map(step=>({...step})));
    for(;;){
      const choice=await vscode.window.showQuickPick([{label:'Apply reviewed plan',index:-1},...steps.map((step,index)=>({label:`${index+1}. ${step.action} ${step.oid.slice(0,8)}`,description:redact(preview.commits.find(commit=>commit.oid===step.oid)!.subject),index}))],{title:'Interactive Rebase — oldest first',placeHolder:'Select a commit to change action or move up/down; Escape cancels'});if(!choice)return;
      if(choice.index===-1){validateRebasePlan(preview.commits,steps);const detail=redact(`${this.advanced.git.repository(id).root}\nHEAD ${preview.snapshot.head}\nBase ${preview.base}\n${steps.map((step,index)=>`${index+1}: ${step.action} ${step.oid}`).join('\n')}`);if(await vscode.window.showWarningMessage('Rewrite the reviewed history?',{modal:true,detail},'Apply rebase')!=='Apply rebase')continue;await this.interactive.execute(preview,steps);const status=await this.advanced.snapshot(id);await vscode.window.showInformationMessage(status.operation==='rebasing'?'Rebase paused. Use Advanced Actions to resolve/edit and continue, skip or abort.':'Interactive rebase completed.');return;}
      const selected=steps[choice.index]!,action=await vscode.window.showQuickPick(['pick','reword','edit','squash','fixup','drop','Move up','Move down'],{title:`Action for ${selected.oid.slice(0,8)}`});if(!action)continue;
      if(action==='Move up'||action==='Move down'){const next=choice.index+(action==='Move up'?-1:1);if(next>=0&&next<steps.length)[steps[choice.index],steps[next]]=[steps[next]!,selected];continue;}
      let message:string|undefined;if(action==='reword'){const original=selected.message??(await this.advanced.git.executor.read(this.advanced.git.repository(id).root,{kind:'commitMessage',oid:selected.oid})).stdout.toString('utf8');message=await this.editMessage(original,'Reword commit');if(message===undefined)continue;}
      steps[choice.index]={oid:selected.oid,action:action as RebaseAction,...(message!==undefined?{message}:{})};
    }
  }
  private async confirmRebasePlan(preview:InteractivePreview,steps:readonly RebaseStep[]):Promise<boolean>{
    validateRebasePlan(preview.commits,steps);const id=preview.snapshot.repositoryId;
    const detail=redact(`${this.advanced.git.repository(id).root}\nHEAD ${preview.snapshot.head}\nBase ${preview.base}\n${steps.map((step,index)=>`${index+1}: ${step.action} ${step.oid}${step.action==='reword'?`\nMessage: ${step.message?.slice(0,1000)}`:''}`).join('\n')}`);
    return await vscode.window.showWarningMessage('Rewrite the reviewed history?',{modal:true,detail},'Apply rebase')==='Apply rebase';
  }
  private async applyRebasePlan(preview:InteractivePreview,steps:readonly RebaseStep[]):Promise<void>{
    const id=preview.snapshot.repositoryId;
    await this.interactive.execute(preview,steps);const status=await this.advanced.snapshot(id);
    await vscode.window.showInformationMessage(status.operation==='rebasing'?'Rebase paused. Use Advanced Actions to resolve/edit and continue, skip or abort.':'Interactive rebase completed.');
  }
  async conflict(arg?:unknown):Promise<void>{
    const value=arg as {repositoryId?:unknown;change?:{path?:unknown}}|undefined;
    let id:string,file:string;
    if(arg instanceof vscode.Uri){const repo=await this.advanced.git.registry.resolveFile(arg.fsPath);if(!repo)throw new Error('File is outside open repositories.');id=repo.id;file=path.relative(repo.root,await canonicalFilePath(arg.fsPath)).replace(/\\/g,'/');}
    else if(typeof value?.repositoryId==='string'&&typeof value?.change?.path==='string'){id=value.repositoryId;file=value.change.path;}
    else{id=this.active();const snapshot=await this.advanced.snapshot(id);const selected=await vscode.window.showQuickPick(snapshot.status.changes.filter(change=>change.group==='conflicts').map(change=>({label:redact(change.path),path:change.path})),{title:'Git Pro: Conflicts'});if(!selected)return;file=selected.path;}
    const preview=await this.conflicts.preview(id,file),repo=this.advanced.git.repository(id),uri=vscode.Uri.file(await this.advanced.git.authorizePath(id,file));
    const operation=preview.snapshot.operation;
    const canContinue=['merging','rebasing','cherry-picking','reverting'].includes(operation);
    const current=operation==='rebasing'?'upstream plus commits already replayed':'checked-out file version';
    const incoming=operation==='rebasing'?'commit being replayed':operation==='cherry-picking'?'commit being cherry-picked':operation==='reverting'?'inverse patch: content before the reverted commit':operation==='merging'?'branch or commit being merged':'other side; for stash conflicts, the stashed version';
    const currentExists=preview.entries.some(entry=>entry.stage===2),incomingExists=preview.entries.some(entry=>entry.stage===3);
    const items=[
      {label:'Open native Merge Editor / file',icon:'split-horizontal',description:'Review the conflict and edit the result',action:'editor'},
      {label:'Compare Base ↔ Current',icon:'diff',description:`Current = ${current}`,action:'baseCurrent'},
      {label:'Compare Base ↔ Incoming',icon:'diff',description:`Incoming = ${incoming}`,action:'baseIncoming'},
      {label:`Accept Current${currentExists?'':' (delete file)'}`,icon:currentExists?'arrow-left':'trash',description:currentExists?`Use ${current}; review before staging`:'Current has no file: resolve as deletion',action:'current'},
      {label:`Accept Incoming${incomingExists?'':' (delete file)'}`,icon:incomingExists?'arrow-right':'trash',description:incomingExists?`Use ${incoming}; review before staging`:'Incoming has no file: resolve as deletion',action:'incoming'},
      ...(preview.text!==undefined?[{label:'Accept Both text hunks',icon:'git-merge',description:'Combine Current then Incoming hunks; review before staging',action:'both'}]:[]),
      {label:'Mark Resolved',icon:'check',description:canContinue?'Stage the reviewed working file; then Continue the operation':'Stage the reviewed working file; then review staged changes',action:'mark'}
    ].map(item=>({...item,plainLabel:item.label,label:`$(${item.icon}) ${item.label}`}));
    const selected=await vscode.window.showQuickPick(items,{title:`Git Pro: Resolve ${redact(file)}${operation==='idle'?'':` (${operation})`}`,placeHolder:canContinue?'Choose a side → review the file → Mark Resolved → Continue':'Choose a side → review the file → Mark Resolved → review staged changes',matchOnDescription:true});if(!selected)return;
    await this.advanced.git.authorizePath(id,file);
    if(selected.action==='editor'){
      if((await vscode.commands.getCommands(true)).includes('git.openMergeEditor')){try{await vscode.commands.executeCommand('git.openMergeEditor',uri);return;}catch{/* public-command bridge unavailable */}}
      await vscode.commands.executeCommand('vscode.open',uri);return;
    }
    if(selected.action==='baseCurrent'||selected.action==='baseIncoming'){
      const [base,side]=await Promise.all([this.conflicts.side(preview,1),this.conflicts.side(preview,selected.action==='baseCurrent'?2:3)]);
      await vscode.commands.executeCommand('vscode.diff',this.revisions.add(base,file),this.revisions.add(side,file),`${file}: Base ↔ ${selected.action==='baseCurrent'?'Current':'Incoming'}`);return;
    }
    const choice=selected.action as 'current'|'incoming'|'both'|'mark';let allowMarkers=false;
    if(choice==='mark'&&preview.markers){allowMarkers=await vscode.window.showWarningMessage('Conflict markers remain. Stage this file anyway?',{modal:true,detail:'Markers can become part of the commit. Review the result carefully.'},'Stage with markers')==='Stage with markers';if(!allowMarkers)return;}
    else if(await vscode.window.showWarningMessage(`${selected.plainLabel}?`,{modal:true,detail:redact(`${repo.root}\n${file}\n${selected.description}\nSide acceptance changes the working file; Mark Resolved stages the result.`)},'Apply')!=='Apply')return;
    await this.conflicts.resolve(preview,choice,allowMarkers);
    const deleted=(choice==='current'||choice==='incoming')&&!preview.entries.some(entry=>entry.stage===(choice==='current'?2:3));
    if(deleted)await vscode.window.showInformationMessage('Conflict resolved as deletion. Review staged changes before continuing.');
    else if(choice!=='mark')await vscode.commands.executeCommand('vscode.open',uri);
  }
}
