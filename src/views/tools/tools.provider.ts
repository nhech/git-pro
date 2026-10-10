import * as vscode from 'vscode';
import { ToolsService } from '../../git/tools/tools.service';
import { redact } from '../../security/redaction';
import { repositoryToolVisual } from '../tree-visuals';
const groups=['Stashes','Tags','Remotes','Worktrees'] as const;
type Group=typeof groups[number];
type Node={kind:'group';group:Group;repositoryId:string}|{kind:'row';group:Group;repositoryId:string;key:string;label:string;description:string;detail:string}|{kind:'notice';label:string};
export class ToolsProvider implements vscode.TreeDataProvider<Node>,vscode.Disposable {
  private readonly changed=new vscode.EventEmitter<void>();readonly onDidChangeTreeData=this.changed.event;
  private readonly subscription:{dispose():void};private disposed=false;
  constructor(private readonly tools:ToolsService){this.subscription=tools.advanced.git.registry.onDidInvalidate(()=>this.changed.fire());}
  async getChildren(node?:Node):Promise<Node[]>{
    if(this.disposed)return[];const repo=this.tools.advanced.git.registry.active;if(!repo)return[];
    if(!node)return groups.map(group=>({kind:'group',group,repositoryId:repo.id}));
    if(node.kind!=='group'||node.repositoryId!==repo.id)return[];
    let rows:Node[]=[];const row=(key:string,label:string,description:string,detail:string):Node=>({kind:'row',group:node.group,repositoryId:repo.id,key,label:redact(label),description:redact(description),detail:redact(detail)});
    try{
      switch(node.group){
        case 'Stashes':rows=(await this.tools.stashes(repo.id)).map(stash=>row(stash.oid+stash.selector,stash.selector,stash.subject,stash.oid));break;
        case 'Tags':rows=(await this.tools.tags(repo.id)).map(tag=>row(tag.name,tag.name,tag.annotated?'annotated':'lightweight',`${tag.oid}\nTarget: ${tag.target}`));break;
        case 'Remotes':rows=(await this.tools.remotes(repo.id)).map(remote=>row(remote.name,remote.name,remote.fetch.join(', '),`Fetch: ${remote.fetch.join(', ')}\nPush: ${remote.push.join(', ')}`));break;
        case 'Worktrees':rows=(await this.tools.worktrees(repo.id)).map((worktree,index)=>row(worktree.path,worktree.path,`${index===0?'primary · ':''}${worktree.locked?'locked · ':''}${worktree.branch??'detached'}`,worktree.head??'unborn'));break;
      }
    }catch(error){rows=[{kind:'notice',label:redact(`Unable to load: ${String(error)}`)}];}
    if(this.disposed||this.tools.advanced.git.registry.active!==repo)return[];
    if(rows.length>500)rows=[...rows.slice(0,500),{kind:'notice',label:'First 500 shown — open Tools to filter or review in native Git'}];
    if(!rows.length)rows=[{kind:'notice',label:'No entries — open group actions to create one'}];return rows;
  }
  getTreeItem(node:Node):vscode.TreeItem{
    if(node.kind==='notice'){const item=new vscode.TreeItem(node.label);item.iconPath=new vscode.ThemeIcon('info',new vscode.ThemeColor('descriptionForeground'));return item;}
    const item=new vscode.TreeItem(node.kind==='group'?node.group:node.label,node.kind==='group'?vscode.TreeItemCollapsibleState.Collapsed:vscode.TreeItemCollapsibleState.None);
    item.id=`${node.repositoryId}:${node.group}:${node.kind==='row'?node.key:'group'}`;
    item.contextValue='gitPro.tools';item.command={command:'gitPro.repositoryTools',title:`${node.group} Actions`,arguments:[node.group,node.repositoryId,...(node.kind==='row'?[node.key]:[])]};
    if(node.kind==='row'){item.description=node.description;item.tooltip=node.detail;}const visual=repositoryToolVisual[node.group];item.iconPath=new vscode.ThemeIcon(visual.icon,new vscode.ThemeColor(visual.color));return item;
  }
  dispose(){this.disposed=true;this.subscription.dispose();this.changed.dispose();}
}
