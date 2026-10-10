import * as vscode from 'vscode';
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { RepositoryDescriptor, RepositoryRegistry } from '../../repositories/repository-registry';
import type { RepositorySnapshot } from '../../state/repository-store';
import type { ChangeNode, ChangesProvider } from './changes.provider';
import { parseChangesAction } from './changes-protocol';
import { redact } from '../../security/redaction';

interface ChangeRow { key:string;kind:'group'|'folder'|'file'|'message';label:string;group?:string;status?:string;icon?:string;count?:number;depth:number;parent?:string }
interface StateInputs { view:vscode.WebviewView;session:string;repo:RepositoryDescriptor|undefined;snapshot:RepositorySnapshot|undefined;error:string|undefined;hasError:boolean;groupBy:string }
const labelOf=(value:vscode.TreeItem['label']):string=>typeof value==='string'?value:typeof value==='object'&&value!==null&&'label'in value?value.label:'';

export class ChangesPanel implements vscode.WebviewViewProvider,vscode.Disposable {
  private view:vscode.WebviewView|undefined;
  private session='';
  private busy=false;
  private rows=new Map<string,ChangeNode>();
  private currentSelection:ChangeNode[]=[];
  private lastState:StateInputs|undefined;
  private readonly subscriptions:vscode.Disposable[];
  get selection():readonly ChangeNode[]{return this.currentSelection;}
  get isResolved():boolean{return this.view!==undefined;}
  constructor(private readonly context:vscode.ExtensionContext,private readonly registry:RepositoryRegistry,private readonly provider:ChangesProvider){
    this.subscriptions=[registry.onDidChange(()=>{void this.update();}),provider.onDidChangeTreeData(()=>{void this.update();}),vscode.workspace.onDidChangeConfiguration(event=>{if(event.affectsConfiguration('gitPro.changes.groupBy'))void this.update();})];
  }
  resolveWebviewView(view:vscode.WebviewView):void{
    this.lastState=undefined;this.view=view;this.session=randomUUID();const nonce=randomUUID().replace(/-/g,'');
    view.webview.options={enableScripts:true,localResourceRoots:[vscode.Uri.joinPath(this.context.extensionUri,'media')]};
    const css=view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri,'media','changes.css'));
    const script=view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri,'media','changes.js'));
    const icons=view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri,'media','codicons','codicon.css'));
    view.webview.html=`<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; font-src ${view.webview.cspSource}; script-src 'nonce-${nonce}' ${view.webview.cspSource};"><link rel="stylesheet" href="${icons}"><link rel="stylesheet" href="${css}"><title>Git Pro Changes</title></head><body data-session="${this.session}"><div id="notice" role="status" aria-live="polite"></div><div id="selection-actions" role="toolbar" aria-label="Selected change actions" hidden><span id="selection-count"></span><button data-action="stage">Stage</button><button data-action="unstage">Unstage</button><button data-action="discard">Discard…</button></div><div id="rows" role="tree" aria-multiselectable="true" aria-label="Repository changes"></div><button id="more" type="button" hidden>Show more changes</button><script nonce="${nonce}" src="${script}"></script></body></html>`;
    const receive=view.webview.onDidReceiveMessage(value=>{void this.receive(value);});
    // Hidden views are not rebuilt: the renderer is recreated (and sends `ready`) when the view is shown again.
    const visibility=view.onDidChangeVisibility?.(()=>{if(this.view!==view)return;if(view.visible){void this.update();return;}this.lastState=undefined;this.rows.clear();this.currentSelection=[];});
    const disposed=view.onDidDispose(()=>{if(this.view===view){this.lastState=undefined;this.view=undefined;this.session='';this.rows.clear();this.currentSelection=[];this.busy=false;}receive.dispose();visibility?.dispose();disposed.dispose();});
    void this.update();
  }
  private async receive(raw:unknown):Promise<void>{
    try{
      const action=parseChangesAction(raw);if(action.session!==this.session||!this.view)throw new Error('Changes view session expired.');
      if(action.type==='ready'){await this.update(true);return;}
      if(action.type==='select'){this.currentSelection=action.keys.map(key=>this.resolve(key));return;}
      if(action.type==='toggle'){const node=this.resolve(action.key);if(node.kind==='group')return;const current=this.currentSelection.findIndex(item=>this.identity(item)===action.key);this.currentSelection=current<0?[...this.currentSelection,node]:this.currentSelection.filter(item=>this.identity(item)!==action.key);return;}
      if(this.busy)throw new Error('Wait for the current Changes action to finish.');
      this.busy=true;await this.view.webview.postMessage({type:'busy',session:this.session,busy:true});
      try{await this.run(action.action,action.key,action.keys);}finally{this.busy=false;await this.view?.webview.postMessage({type:'busy',session:this.session,busy:false});await this.update();}
    }catch(error){await this.view?.webview.postMessage({type:'error',session:this.session,message:redact(error instanceof Error?error.message:String(error))});}
  }
  private async run(action:Extract<ReturnType<typeof parseChangesAction>,{type:'action'}>['action'],key?:string,keys?:string[]):Promise<void>{
    if(action==='refresh'){await vscode.commands.executeCommand('gitPro.refresh');return;}
    if(action==='stageAll'||action==='unstageAll'){
      if(key!==undefined||keys!==undefined){
        const supplied=keys??(key?[key]:[]);if(supplied.length!==1)throw new Error('Choose one Changes group.');
        const group=this.resolve(supplied[0]!);
        if(group.kind!=='group'||(action==='stageAll'?!['working','untracked'].includes(group.group):group.group!=='staged'))throw new Error('This action is unavailable for the selected group.');
        const files=[...this.rows.values()].filter((node):node is Extract<ChangeNode,{kind:'file'}>=>node.kind==='file'&&node.change.group===group.group);
        if(!files.length)throw new Error('This Changes group is empty. Refresh and try again.');
        await vscode.commands.executeCommand(action==='stageAll'?'gitPro.stage':'gitPro.unstage',files[0],files);return;
      }
      await vscode.commands.executeCommand(action==='stageAll'?'gitPro.stageAll':'gitPro.unstageAll');return;
    }
    const nodes=(keys?.length?keys:key?[key]:this.currentSelection.map(node=>this.identity(node))).map(item=>this.resolve(item));
    if(!nodes.length)throw new Error('Select changed entries first.');
    if(action==='history'||action==='copyPath'){
      if(nodes.length!==1||nodes[0]!.kind!=='file')throw new Error('Choose one changed file.');
      const item=nodes[0]!;if(action==='copyPath'){await vscode.commands.executeCommand('gitPro.copyPath',item);return;}
      const repo=this.registry.list().find(value=>value.id===item.repositoryId);if(!repo)throw new Error('Repository is no longer open.');
      await vscode.commands.executeCommand('gitPro.fileHistory',vscode.Uri.file(path.join(repo.root,item.change.path)));return;
    }
    if(action==='open'){
      if(nodes.length!==1||nodes[0]!.kind!=='file')throw new Error('Choose one changed file to open.');
      await vscode.commands.executeCommand('gitPro.openFile',nodes[0]!.repositoryId,nodes[0]!.change.path);return;
    }
    if(action==='resolve'){
      if(nodes.length!==1||nodes[0]!.kind!=='file'||nodes[0]!.change.group!=='conflicts')throw new Error('Select one current conflict.');
      await vscode.commands.executeCommand('gitPro.resolveConflict',nodes[0]);return;
    }
    if(action==='diff'){
      if(nodes.length!==1||nodes[0]!.kind!=='file')throw new Error('Choose one changed file to diff.');
      await vscode.commands.executeCommand('gitPro.diff',nodes[0]);return;
    }
    if(nodes.length===1&&nodes[0]!.kind==='folder'){
      const command=action==='stage'?'gitPro.stageFolder':action==='unstage'?'gitPro.unstageFolder':action==='discard'?'gitPro.discardFolder':undefined;
      if(!command)throw new Error('This action is unavailable for folders.');await vscode.commands.executeCommand(command,nodes[0]);return;
    }
    if(nodes.some(node=>node.kind!=='file'))throw new Error('Select changed file rows only.');
    const command=action==='stage'?'gitPro.stage':action==='unstage'?'gitPro.unstage':action==='discard'?'gitPro.discard':undefined;
    if(!command)throw new Error('Unsupported Changes action.');await vscode.commands.executeCommand(command,nodes[0],nodes);
  }
  /** Fixed-length row identity, so a path of any length fits the protocol bound and each posted row stays small. */
  private identity(node:ChangeNode):string{
    const data=node.kind==='file'?[node.repositoryId,'file',node.change.group,node.change.path]:node.kind==='folder'?[node.repositoryId,'folder',node.group,node.prefix]:node.kind==='group'?['group',this.registry.active?.id,node.group]:['message',this.registry.active?.id,node.message];
    return createHash('sha256').update(JSON.stringify(data)).digest('base64url');
  }
  private resolve(key:string):ChangeNode{const node=this.rows.get(key);if(!node)throw new Error('This selection is stale. Refresh Changes and try again.');return node;}
  private async update(force=false):Promise<void>{
    if(!this.view||!this.session)return;
    const repo=this.registry.active,snapshot=repo?this.registry.store.get(repo.id):undefined,hasError=repo?this.registry.errors.has(repo.id):false;
    if(this.view.visible===false&&!force){this.lastState=undefined;this.setBadge(this.view,repo,snapshot,hasError);return;}
    const inputs:StateInputs={view:this.view,session:this.session,repo,snapshot,error:repo?this.registry.errors.get(repo.id):undefined,hasError,groupBy:repo?vscode.workspace.getConfiguration('gitPro',vscode.Uri.file(repo.root)).get<string>('changes.groupBy','status'):'status'};
    const prior=this.lastState;
    if(!force&&prior&&prior.view===inputs.view&&prior.session===inputs.session&&prior.repo===repo&&prior.snapshot===snapshot&&prior.error===inputs.error&&prior.hasError===inputs.hasError&&prior.groupBy===inputs.groupBy)return;
    // Reserve before building rows: provider forwards registry events synchronously.
    this.lastState=inputs;
    try{if(!await this.renderState(inputs)&&this.lastState===inputs)this.lastState=undefined;}
    catch{if(this.lastState===inputs)this.lastState=undefined;}
  }
  private setBadge(view:vscode.WebviewView,repo:RepositoryDescriptor|undefined,snapshot:RepositorySnapshot|undefined,hasError:boolean):void{
    const count=snapshot?.changes.length??0;view.badge=repo&&!hasError&&count>0?{value:count,tooltip:`${count} ${count===1?'change':'changes'}`} :undefined;
  }
  private async renderState({view,session,repo,snapshot,error,hasError}:StateInputs):Promise<boolean>{
    this.rows.clear();
    this.setBadge(view,repo,snapshot,hasError);
    if(!repo){this.currentSelection=[];return view.webview.postMessage({type:'state',session,repository:'No repository',total:0,rows:[],message:'Open a trusted folder containing a Git repository.'});}
    if(error){this.currentSelection=[];return view.webview.postMessage({type:'state',session,repository:path.basename(repo.root),total:0,rows:[],message:error});}
    if(!snapshot){this.currentSelection=[];return view.webview.postMessage({type:'state',session,repository:path.basename(repo.root),total:0,rows:[],message:'Loading repository status…'});}
    const rows:ChangeRow[]=[];
    const visit=(node:ChangeNode,depth:number,parent?:string):void=>{
      const key=this.identity(node);this.rows.set(key,node);const item=this.provider.getTreeItem(node);const row:ChangeRow={key,kind:node.kind,label:redact(labelOf(item.label)),depth,...(parent?{parent}:{}),...(node.kind==='file'?{group:node.change.group,status:redact(String(item.description??'')),icon:(item.iconPath as vscode.ThemeIcon|undefined)?.id??'file'}:node.kind==='folder'?{group:node.group,icon:'folder'}:node.kind==='group'?{group:node.group,count:Number(item.description??0),icon:(item.iconPath as vscode.ThemeIcon|undefined)?.id??'circle'}:{})};rows.push(row);
      if(node.kind==='group'||node.kind==='folder')for(const child of this.provider.getChildren(node))visit(child,depth+1,key);
    };
    for(const node of this.provider.getChildren())visit(node,0);
    const retained=this.currentSelection.map(item=>this.identity(item)).filter(key=>this.rows.has(key));this.currentSelection=retained.map(key=>this.rows.get(key)!);
    return view.webview.postMessage({type:'state',session,repository:redact(path.basename(repo.root)),total:snapshot.changes.length,rows,message:snapshot.changes.length?'':'Working tree clean'});
  }
  dispose():void{for(const subscription of this.subscriptions)subscription.dispose();this.lastState=undefined;this.view=undefined;this.rows.clear();this.currentSelection=[];this.session='';this.busy=false;}
}
