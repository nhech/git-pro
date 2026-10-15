import * as vscode from 'vscode';
import { createHash, randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import * as path from 'node:path';
import type { RepositoryDescriptor, RepositoryRegistry } from '../../repositories/repository-registry';
import type { RepositorySnapshot } from '../../state/repository-store';
import type { FileChange } from '../../git/git-parser';
import type { ChangeNode, ChangesProvider } from './changes.provider';
import { parseChangesAction } from './changes-protocol';
import { unlistedChanges } from './unlisted';
import { redact } from '../../security/redaction';
import { createSurfaces, type Surfaces } from '../../conflicts/surfaces';
import { operationBanner, type BannerActionId, type OperationBanner } from '../../conflicts/operation-text';
import type { OperationSummary } from '../../git/conflicts/conflict-contract';

interface ChangeRow { key:string;kind:'group'|'folder'|'file'|'message';label:string;group?:string;status?:string;icon?:string;count?:number;depth:number;parent?:string;conflict?:{mergeable:boolean;workingFile:boolean} }
interface StateInputs { view:vscode.WebviewView;session:string;repo:RepositoryDescriptor|undefined;snapshot:RepositorySnapshot|undefined;error:string|undefined;hasError:boolean;groupBy:string;source:unknown }
type FileNode=Extract<ChangeNode,{kind:'file'}>;
const labelOf=(value:vscode.TreeItem['label']):string=>typeof value==='string'?value:typeof value==='object'&&value!==null&&'label'in value?value.label:'';
/** Open File needs a working file; beyond this many conflicts the row keeps it and gitPro.openFile reports a missing file. */
const MAX_PRESENCE_CHECKS=5000;
/** A summary not ready by then is shown when it arrives; the rows never wait longer for the banner wording. */
const SUMMARY_WAIT_MS=300;
const settle=<T>(promise:Promise<T>,ms:number):Promise<T|undefined>=>new Promise(resolve=>{const timer=setTimeout(()=>resolve(undefined),ms);promise.then(value=>{clearTimeout(timer);resolve(value);},()=>{clearTimeout(timer);resolve(undefined);});});

export class ChangesPanel implements vscode.WebviewViewProvider,vscode.Disposable {
  private view:vscode.WebviewView|undefined;
  private session='';
  private busy=false;
  private rows=new Map<string,ChangeNode>();
  private currentSelection:ChangeNode[]=[];
  private lastState:StateInputs|undefined;
  /** Each render waits for the operation summary and file checks; only the newest may post. */
  private generation=0;
  /** The banner the webview shows: a banner request is honoured only for one of its enabled buttons. */
  private banner:{repositoryId:string;value:OperationBanner}|undefined;
  private readonly awaited=new WeakSet<RepositorySnapshot>();
  private readonly subscriptions:vscode.Disposable[];
  get selection():readonly ChangeNode[]{return this.currentSelection;}
  get isResolved():boolean{return this.view!==undefined;}
  constructor(private readonly context:vscode.ExtensionContext,private readonly registry:RepositoryRegistry,private readonly provider:ChangesProvider,private readonly surfaces:Surfaces=createSurfaces()){
    this.subscriptions=[registry.onDidChange(()=>{void this.update();}),provider.onDidChangeTreeData(()=>{void this.update();}),vscode.workspace.onDidChangeConfiguration(event=>{if(event.affectsConfiguration('gitPro.changes.groupBy'))void this.update();})];
  }
  resolveWebviewView(view:vscode.WebviewView):void{
    this.lastState=undefined;this.view=view;this.session=randomUUID();const nonce=randomUUID().replace(/-/g,'');
    view.webview.options={enableScripts:true,localResourceRoots:[vscode.Uri.joinPath(this.context.extensionUri,'media')]};
    const css=view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri,'media','changes.css'));
    const script=view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri,'media','changes.js'));
    const icons=view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri,'media','codicons','codicon.css'));
    view.webview.html=`<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; font-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${icons}"><link rel="stylesheet" href="${css}"><title>Git Pro Changes</title></head><body data-session="${this.session}"><div id="operation" role="region" aria-label="Git operation" hidden><span id="operation-icon" class="codicon" aria-hidden="true"></span><span id="operation-text" aria-live="polite"></span><div id="operation-actions"></div></div><div id="notice" role="status" aria-live="polite"></div><div id="selection-actions" role="toolbar" aria-label="Selected change actions" hidden><span id="selection-count"></span><button data-action="stage">Stage</button><button data-action="unstage">Unstage</button><button data-action="discard">Discard…</button><button data-action="acceptYours" hidden>Accept Yours</button><button data-action="acceptTheirs" hidden>Accept Theirs</button></div><div id="rows" role="tree" aria-multiselectable="true" aria-label="Repository changes"></div><button id="more" type="button" hidden>Show more changes</button><script nonce="${nonce}" src="${script}"></script></body></html>`;
    const receive=view.webview.onDidReceiveMessage(value=>{void this.receive(value);});
    // Hidden views are not rebuilt: the renderer is recreated (and sends `ready`) when the view is shown again.
    const visibility=view.onDidChangeVisibility?.(()=>{if(this.view!==view)return;if(view.visible){void this.update();return;}this.lastState=undefined;this.rows.clear();this.currentSelection=[];this.banner=undefined;});
    const disposed=view.onDidDispose(()=>{if(this.view===view){this.lastState=undefined;this.view=undefined;this.session='';this.rows.clear();this.currentSelection=[];this.busy=false;this.banner=undefined;}receive.dispose();visibility?.dispose();disposed.dispose();});
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
      try{if(action.type==='operation')await this.operation(action.action);else await this.run(action.action,action.key,action.keys);}finally{this.busy=false;await this.view?.webview.postMessage({type:'busy',session:this.session,busy:false});await this.update();}
    }catch(error){await this.view?.webview.postMessage({type:'error',session:this.session,message:redact(error instanceof Error?error.message:String(error))});}
  }
  /** Banner buttons only navigate or start a command that asks before it changes anything (N10). */
  private async operation(action:BannerActionId):Promise<void>{
    const repo=this.registry.active,offered=repo&&this.banner?.repositoryId===repo.id?this.banner.value.actions.find(item=>item.id===action):undefined;
    if(!repo||!offered)throw new Error('The operation changed. Review the banner again.');
    if(offered.disabled)throw new Error(`${offered.disabled}.`);
    if(action==='resolve'){await vscode.commands.executeCommand('gitPro.conflicts.open',repo.id);return;}
    if(action==='amend'){await vscode.commands.executeCommand('gitPro.advancedActions');return;}
    if(action==='sourceControl'){await vscode.commands.executeCommand('workbench.view.scm');return;}
    await vscode.commands.executeCommand(`gitPro.operation.${action}`,repo.id);
  }
  /** 1–100 conflict rows of one open repository, sent to the Conflicts commands as (repositoryId, paths); they re-check every path against a fresh snapshot. */
  private conflictFiles(nodes:readonly ChangeNode[]):{repo:RepositoryDescriptor;paths:string[];files:FileNode[]}{
    if(!nodes.length||nodes.length>100||nodes.some(node=>node.kind!=='file'||node.change.group!=='conflicts'))throw new Error('Select current conflicts only.');
    const files=nodes as FileNode[],repo=this.registry.list().find(item=>item.id===files[0]!.repositoryId);
    if(!repo||files.some(node=>node.repositoryId!==repo.id))throw new Error('Repository is no longer open.');
    return {repo,paths:files.map(node=>node.change.path),files};
  }
  private async run(action:Extract<ReturnType<typeof parseChangesAction>,{type:'action'}>['action'],key?:string,keys?:string[]):Promise<void>{
    if(action==='refresh'){await vscode.commands.executeCommand('gitPro.refresh');return;}
    if(action==='stageAll'||action==='unstageAll'){
      if(key!==undefined||keys!==undefined){
        const supplied=keys??(key?[key]:[]);if(supplied.length!==1)throw new Error('Choose one Changes group.');
        const group=this.resolve(supplied[0]!);
        if(group.kind!=='group'||(action==='stageAll'?!['working','untracked'].includes(group.group):group.group!=='staged'))throw new Error('This action is unavailable for the selected group.');
        const files=[...this.rows.values()].filter((node):node is FileNode=>node.kind==='file'&&node.change.group===group.group);
        if(!files.length)throw new Error('This Changes group is empty. Refresh and try again.');
        await vscode.commands.executeCommand(action==='stageAll'?'gitPro.stage':'gitPro.unstage',files[0],files);return;
      }
      await vscode.commands.executeCommand(action==='stageAll'?'gitPro.stageAll':'gitPro.unstageAll');return;
    }
    const nodes=(keys?.length?keys:key?[key]:this.currentSelection.map(node=>this.identity(node))).map(item=>this.resolve(item));
    if(!nodes.length)throw new Error('Select changed entries first.');
    // Git has no diff for a conflicted file; its default action is Merge… or the Conflicts tab (§3.6).
    if(action==='diff'&&nodes.length===1&&nodes[0]!.kind==='file'&&nodes[0]!.change.group==='conflicts')action=mergeable(nodes[0]!.change)?'merge':'openConflicts';
    if(action==='openConflicts'){
      if(nodes.length===1&&nodes[0]!.kind==='group'&&nodes[0]!.group==='conflicts'){const repo=this.registry.active;if(!repo)throw new Error('Select a repository first.');await vscode.commands.executeCommand('gitPro.conflicts.open',repo.id);return;}
      const {repo,paths}=this.conflictFiles(nodes);await vscode.commands.executeCommand('gitPro.conflicts.open',repo.id,{select:paths});return;
    }
    if(action==='merge'){
      const {repo,paths,files}=this.conflictFiles(nodes);if(files.length!==1)throw new Error('Choose one conflicted file to merge.');
      if(!mergeable(files[0]!.change))throw new Error('This conflict has no two versions to merge. Choose Accept Yours or Accept Theirs.');
      await vscode.commands.executeCommand('gitPro.conflicts.merge',repo.id,paths);return;
    }
    // The Conflicts command shows the one confirmation (N2) and refuses unsaved or open-in-merge files (N12): the sidebar never overwrites in one click.
    if(action==='acceptYours'||action==='acceptTheirs'){const {repo,paths}=this.conflictFiles(nodes);await vscode.commands.executeCommand(`gitPro.conflicts.${action}`,repo.id,paths);return;}
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
    const inputs:StateInputs={view:this.view,session:this.session,repo,snapshot,error:repo?this.registry.errors.get(repo.id):undefined,hasError,groupBy:repo?vscode.workspace.getConfiguration('gitPro',vscode.Uri.file(repo.root)).get<string>('changes.groupBy','status'):'status',source:repo?this.surfaces.conflictSources.get(repo.id):undefined};
    const prior=this.lastState;
    if(!force&&prior&&prior.view===inputs.view&&prior.session===inputs.session&&prior.repo===repo&&prior.snapshot===snapshot&&prior.error===inputs.error&&prior.hasError===inputs.hasError&&prior.groupBy===inputs.groupBy&&prior.source===inputs.source)return;
    // Reserve before building rows: provider forwards registry events synchronously.
    this.lastState=inputs;
    try{if(!await this.renderState(inputs)&&this.lastState===inputs)this.lastState=undefined;}
    catch{if(this.lastState===inputs)this.lastState=undefined;}
  }
  private setBadge(view:vscode.WebviewView,repo:RepositoryDescriptor|undefined,snapshot:RepositorySnapshot|undefined,hasError:boolean):void{
    const count=(snapshot?.changes.length??0)+(snapshot?.omitted?.length??0);view.badge=repo&&!hasError&&count>0?{value:count,tooltip:`${count} ${count===1?'change':'changes'}`} :undefined;
  }
  /** §3.4 banner, worded from the operation summary when it is ready in time; otherwise plain wording now and a re-render once it arrives. */
  private async operationBanner(inputs:StateInputs,repo:RepositoryDescriptor,snapshot:RepositorySnapshot,conflicts:number):Promise<OperationBanner|undefined>{
    if(!operationBanner(snapshot.operation,conflicts))return undefined;
    let pending:Promise<OperationSummary>|undefined;
    try{pending=this.surfaces.operation?.summary(repo.id);}catch{pending=undefined;}
    const summary=pending?await settle(pending,SUMMARY_WAIT_MS):undefined;
    // Once per snapshot, so a provider that is always slow cannot keep re-rendering.
    if(pending&&!summary&&!this.awaited.has(snapshot)){this.awaited.add(snapshot);void pending.then(()=>{if(this.lastState===inputs){this.lastState=undefined;void this.update();}},()=>undefined);}
    const banner=operationBanner(snapshot.operation,conflicts,summary);
    return banner&&{...banner,text:redact(banner.text)};
  }
  /** lstat only: a conflict whose working file is gone (normally both deleted) offers no Open File. */
  private async workingFiles(repo:RepositoryDescriptor,conflicts:readonly FileChange[]):Promise<Set<string>>{
    const present=new Set<string>(conflicts.slice(MAX_PRESENCE_CHECKS).map(change=>change.path));
    await Promise.all(conflicts.slice(0,MAX_PRESENCE_CHECKS).map(async change=>{if((await lstat(path.join(repo.root,change.path)).catch(()=>undefined))?.isFile())present.add(change.path);}));
    return present;
  }
  private async renderState(inputs:StateInputs):Promise<boolean>{
    const {view,session,repo,snapshot,error,hasError}=inputs,generation=++this.generation;
    this.setBadge(view,repo,snapshot,hasError);
    const empty=(repository:string,message:string)=>{this.rows.clear();this.currentSelection=[];this.banner=undefined;return view.webview.postMessage({type:'state',session,repository,total:0,rows:[],operation:null,message});};
    if(!repo)return empty('No repository','Open a trusted folder containing a Git repository.');
    if(error)return empty(path.basename(repo.root),error);
    if(!snapshot)return empty(path.basename(repo.root),'Loading repository status…');
    const conflicts=snapshot.changes.filter(change=>change.group==='conflicts');
    const [banner,present]=await Promise.all([this.operationBanner(inputs,repo,snapshot,conflicts.length),this.workingFiles(repo,conflicts)]);
    // A newer render owns the view now; posting this one would show older state after it.
    if(generation!==this.generation||this.view!==view)return true;
    this.rows.clear();
    const rows:ChangeRow[]=[];
    const visit=(node:ChangeNode,depth:number,parent?:string):void=>{
      const key=this.identity(node);this.rows.set(key,node);const item=this.provider.getTreeItem(node);const row:ChangeRow={key,kind:node.kind,label:redact(labelOf(item.label)),depth,...(parent?{parent}:{}),...(node.kind==='file'?{group:node.change.group,status:redact(String(item.description??'')),icon:(item.iconPath as vscode.ThemeIcon|undefined)?.id??'file',...(node.change.group==='conflicts'?{conflict:{mergeable:mergeable(node.change),workingFile:present.has(node.change.path)}}:{})}:node.kind==='folder'?{group:node.group,icon:'folder'}:node.kind==='group'?{group:node.group,count:Number(item.description??0),icon:(item.iconPath as vscode.ThemeIcon|undefined)?.id??'circle'}:{})};rows.push(row);
      if(node.kind==='group'||node.kind==='folder')for(const child of this.provider.getChildren(node))visit(child,depth+1,key);
    };
    for(const node of this.provider.getChildren())visit(node,0);
    const retained=this.currentSelection.map(item=>this.identity(item)).filter(key=>this.rows.has(key));this.currentSelection=retained.map(key=>this.rows.get(key)!);
    this.banner=banner&&{repositoryId:repo.id,value:banner};
    return view.webview.postMessage({type:'state',session,repository:redact(path.basename(repo.root)),total:snapshot.changes.length,rows,operation:banner??null,message:snapshot.changes.length?'':snapshot.omitted?.length?unlistedChanges:'Working tree clean'});
  }
  dispose():void{for(const subscription of this.subscriptions)subscription.dispose();this.lastState=undefined;this.view=undefined;this.rows.clear();this.currentSelection=[];this.session='';this.busy=false;this.banner=undefined;}
}
/** Merge… needs two versions of one text: both modified or both added (§3.6). The bridge still refuses binary and oversized files. */
function mergeable(change:Pick<FileChange,'status'>):boolean{return change.status==='UU'||change.status==='AA';}
