import * as vscode from 'vscode';
import * as path from 'node:path';
import { AdvancedService } from '../git/advanced/advanced.service';
import { FileActionsService, type HunkDirection } from '../git/files/file-actions.service';
import { RevisionProvider } from '../documents/revision-provider';
import { canonicalFilePath } from '../security/paths';
import { redact } from '../security/redaction';
import { editMessage } from './message-editor';
import { hunkLineLabel, hunkChangeDescription } from '../views/hunk-visuals';
export class FileActionsCommands {
  private readonly service:FileActionsService;
  constructor(private readonly advanced:AdvancedService,private readonly revisions:RevisionProvider){this.service=new FileActionsService(advanced);}
  private async selected(arg:unknown):Promise<{id:string;file:string}>{
    let id:string,file:string;
    if(arg&&typeof arg==='object'&&'kind' in arg&&arg.kind==='file'&&'repositoryId' in arg&&typeof arg.repositoryId==='string'&&'change' in arg){
      const change=arg.change as {path?:unknown};if(typeof change?.path!=='string')throw new Error('Select a changed file.');id=arg.repositoryId;file=change.path;
    }else{
      const uri=arg instanceof vscode.Uri?arg:vscode.window.activeTextEditor?.document.uri;if(!uri||uri.scheme!=='file')throw new Error('Select a file in Git Pro or open its editor.');
      const repo=await this.advanced.git.registry.resolveFile(uri.fsPath);if(!repo)throw new Error('File is outside an open repository.');id=repo.id;file=path.relative(repo.root,await canonicalFilePath(uri.fsPath)).replace(/\\/g,'/');
    }
    const absolute=await this.advanced.git.authorizePath(id,file);
    const selectedCanonical=await canonicalFilePath(absolute),normalize=(value:string)=>process.platform==='win32'?value.toLowerCase():value;
    for(const document of vscode.workspace.textDocuments)if(document.uri.scheme==='file'&&document.isDirty&&normalize(await canonicalFilePath(document.uri.fsPath))===normalize(selectedCanonical))throw new Error('Save this file before reviewing Git actions; Git reads saved working contents.');
    return {id,file};
  }
  async hunks(arg:unknown):Promise<void>{
    const selected=await this.selected(arg),choice=await vscode.window.showQuickPick([
      {label:'Stage Hunk',direction:'stage' as const,iconPath:new vscode.ThemeIcon('add',new vscode.ThemeColor('charts.green')),description:'Working file → index',detail:'Keep the saved working file unchanged.'},
      {label:'Unstage Hunk',direction:'unstage' as const,iconPath:new vscode.ThemeIcon('remove',new vscode.ThemeColor('charts.orange')),description:'Index → working changes',detail:'Keep the saved working file unchanged.'},
      {label:'Revert Hunk',direction:'revert' as const,iconPath:new vscode.ThemeIcon('discard',new vscode.ThemeColor('charts.red')),description:'Discard selected working changes',detail:'The index is unchanged. Destructive confirmation required.'},
    ],{title:redact(`Hunk actions: ${selected.file}`),placeHolder:'Choose how to handle one changed block.'});if(!choice)return;
    const direction:HunkDirection=choice.direction,preview=await this.service.hunks(selected.id,selected.file,direction),hunk=await vscode.window.showQuickPick(preview.hunks.map((value,index)=>({label:hunkLineLabel(value.label,index+1),description:hunkChangeDescription(value.added,value.removed),detail:'Range includes context lines. Review the exact patch before applying.',index})),{title:redact(`${choice.label}: ${selected.file}`),placeHolder:'Choose one changed block to review.',matchOnDescription:true});if(!hunk)return;
    await vscode.commands.executeCommand('vscode.open',this.revisions.add(preview.hunks[hunk.index]!.patch,`${path.basename(selected.file)}.patch`));
    const review=redact(`${choice.label} in ${selected.file}?${direction==='revert'?' The selected unstaged changes will be lost.':''}`);
    if(await vscode.window.showWarningMessage(review,{modal:true,detail:`Repository: ${redact(this.advanced.git.repository(selected.id).root)}\nHEAD: ${preview.snapshot.head}\nOnly the displayed hunk is applied. Changed state rejects this review.`},choice.label)===choice.label)await this.service.apply(preview,hunk.index);
  }
  async commitFile(arg:unknown):Promise<void>{
    const selected=await this.selected(arg),preview=await this.service.commitPreview(selected.id,selected.file);
    const message=await editMessage('',redact(`Commit File: ${selected.file}`));if(!message)return;
    if(await vscode.window.showWarningMessage(redact(`Commit full working content of ${selected.file}? Includes its unstaged edits.`),{modal:true,detail:`HEAD: ${preview.snapshot.head}\nOther staged files remain staged. Hooks/signing run. No automatic push.\n\n${message}`},'Commit File')==='Commit File')await this.service.commit(preview,message);
  }
}
