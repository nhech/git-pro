import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ChangesPanel } from '../../src/views/changes/changes-panel';
import type { RepositoryRegistry } from '../../src/repositories/repository-registry';
import type { ChangesProvider } from '../../src/views/changes/changes.provider';

const themes=[['Default Dark Modern','vscode-dark'],['Default Light Modern','vscode-light'],['Default High Contrast','vscode-high-contrast'],['Default High Contrast Light','vscode-high-contrast-light']] as const;
const rows=[
  {key:'gw',kind:'group',group:'working',label:'Working Tree',count:1,depth:0},
  {key:'folder',kind:'folder',group:'working',label:'src',parent:'gw',depth:1},
  {key:'modified',kind:'file',group:'working',status:'Modified',label:'src/'+ 'x'.repeat(320)+'/<img onerror=alert(1)>.ts',parent:'folder',depth:2},
  {key:'gs',kind:'group',group:'staged',label:'Staged',count:1,depth:0},
  {key:'staged',kind:'file',group:'staged',status:'Modified',label:'README.md',parent:'gs',depth:1},
  {key:'gu',kind:'group',group:'untracked',label:'Untracked',count:1,depth:0},
  {key:'untracked',kind:'file',group:'untracked',status:'Untracked',label:'notes.txt',parent:'gu',depth:1},
  {key:'gc',kind:'group',group:'conflicts',label:'Conflicts',count:1,depth:0},
  {key:'conflict',kind:'file',group:'conflicts',status:'Conflict',label:'merge-conflict.txt',parent:'gc',depth:1},
];

const driver=`(() => {
  const bridge=acquireVsCodeApi(),session=document.body.dataset.session,captured=[];
  window.acquireVsCodeApi=()=>({getState:()=>bridge.getState(),setState:value=>bridge.setState(value),postMessage:value=>{if(captured.length>=100)throw Error('Message bound');captured.push(value);bridge.postMessage(value);}});
  const settle=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))),byId=id=>document.getElementById(id),row=key=>document.querySelector('[data-key="'+key+'"]');
  const post=data=>window.dispatchEvent(new MessageEvent('message',{data:{...data,session:data.session??session}}));
  const key=(node,key,extra={})=>node.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra}));
  const menu=()=>document.querySelector('.context-menu'),actions=()=>captured.filter(value=>value.type==='action');let running=false;
  window.addEventListener('message',async event=>{
    const data=event.data;if(data?.type!=='changesProbe'||data.session!==session||running)return;running=true;
    const checks=[],failures=[],measurements=[],outlines=[];const check=(name,ok)=>{checks.push({name,passed:Boolean(ok)});if(!ok)failures.push(name);};
    const outline=(name,node)=>{node.focus();const style=getComputedStyle(node);outlines.push({name,focused:document.activeElement===node,focusVisible:node.matches(':focus-visible'),style:style.outlineStyle,width:style.outlineWidth,color:style.outlineColor,offset:style.outlineOffset});check('focus:'+name,document.hasFocus()&&document.activeElement===node&&node.matches(':focus-visible')&&style.outlineStyle!=='none'&&parseFloat(style.outlineWidth)>=2);};
    const container=selector=>{for(const node of document.querySelectorAll(selector)){measurements.push({selector,width:node.getBoundingClientRect().width,clientWidth:node.clientWidth,scrollWidth:node.scrollWidth});check('container:'+selector,node.scrollWidth<=node.clientWidth+1);}};
    const bounds=()=>{const rect=menu().getBoundingClientRect();measurements.push({selector:'.context-menu',left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom});check('menu-inside-viewport',rect.left>=0&&rect.top>=0&&rect.right<=innerWidth&&rect.bottom<=innerHeight);};
    try{
      await document.fonts.ready;for(let i=0;i<150&&!document.body.classList.contains(data.themeClass);i++)await settle();await settle();
      check('actual-host-theme',document.body.classList.contains(data.themeClass));
      check('semantic-tree',byId('rows').getAttribute('role')==='tree'&&byId('rows').getAttribute('aria-multiselectable')==='true'&&byId('rows').getAttribute('aria-label')==='Fixture changes');
      check('single-heading',!document.querySelector('header,h1,.toolbar,#total'));
      check('semantic-selection-toolbar',document.querySelectorAll('[role=toolbar][aria-label]').length===1&&byId('selection-actions').getAttribute('aria-label')==='Selected change actions');
      check('semantic-status',byId('notice').getAttribute('role')==='status'&&byId('notice').getAttribute('aria-live')==='polite');
      for(const item of data.rows){const node=row(item.key);check('tree-level:'+item.key,node?.getAttribute('role')==='treeitem'&&node.getAttribute('aria-level')===String(item.depth+1));}
      check('literal-hostile-path',row('modified').querySelector('.name').textContent===data.rows[2].label&&!document.querySelector('img'));
      for(const id of ['modified','staged','untracked','conflict']){
        const node=row(id),status=node.querySelector('.status'),label=node.querySelector('.name'),entryRect=node.getBoundingClientRect(),badgeRect=status.getBoundingClientRect(),labelRect=label.getBoundingClientRect();
        check('right-status:'+id,badgeRect.right>=entryRect.right-7&&badgeRect.right<=entryRect.right&&labelRect.right<=badgeRect.left&&node.getAttribute('aria-label').includes(status.textContent));
        check('marker:'+id,node.querySelector('.marker').getAttribute('aria-hidden')==='true'&&Boolean(node.querySelector('.marker').textContent));
      }
      for(const selector of ['body','.entry','.entry-main'])container(selector);
      check('document-inside-viewport',document.documentElement.scrollWidth<=innerWidth+1);
      row('modified').click();await settle();check('compatible-selection-actions',!byId('selection-actions').hidden&&!document.querySelector('#selection-actions [data-action=stage]').disabled&&document.querySelector('#selection-actions [data-action=unstage]').disabled&&!document.querySelector('#selection-actions [data-action=discard]').disabled);container('#selection-actions');
      outline('changed-row',row('modified'));for(const button of document.querySelectorAll('#selection-actions button:not(:disabled)'))outline('selected-'+button.dataset.action,button);row('modified').focus();
      row('modified').dispatchEvent(new MouseEvent('contextmenu',{clientX:innerWidth-1,clientY:innerHeight-1,bubbles:true,cancelable:true}));await settle();bounds();
      check('working-menu-actions',[...menu().querySelectorAll('button')].map(node=>node.textContent).join('|')==='Diff|Stage|File History|Copy Relative Path|Discard');
      check('semantic-menu',menu().getAttribute('role')==='menu'&&menu().getAttribute('aria-label').includes(data.rows[2].label)&&[...menu().querySelectorAll('button')].every(node=>node.getAttribute('role')==='menuitem'));
      const separator=menu().querySelector('[role=separator]');check('discard-separated-last',separator?.getAttribute('aria-orientation')==='horizontal'&&separator.tabIndex===-1&&separator.nextElementSibling?.dataset.menuAction==='discard'&&menu().lastElementChild===separator.nextElementSibling);
      for(const button of menu().querySelectorAll('button')){
        const icon=button.querySelector('svg'),label=button.querySelector('.menu-label'),ir=icon?.getBoundingClientRect(),lr=label?.getBoundingClientRect(),br=button.getBoundingClientRect();
        check('decorative-icon:'+button.dataset.menuAction,icon?.getAttribute('aria-hidden')==='true'&&icon.getAttribute('focusable')==='false'&&icon.textContent===''&&ir.width===16&&ir.height===16);
        check('bounded-menu-label:'+button.dataset.menuAction,lr.left>=ir.right&&lr.right<=br.right&&button.scrollWidth<=button.clientWidth+1&&!button.dataset.action);
      }
      outline('menu-first',menu().firstElementChild);key(menu(),'End');await settle();check('menu-end-focus',document.activeElement===menu().lastElementChild);key(menu(),'Home');await settle();check('menu-home-focus',document.activeElement===menu().firstElementChild);
      key(menu(),'Escape');await settle();check('escape-restores-row',!menu()&&document.activeElement===row('modified'));
      key(row('modified'),'F10',{shiftKey:true});await settle();bounds();const copy=menu().querySelector('[data-menu-action=copyPath]');copy.click();await settle();
      check('known-key-request',actions().length===1&&actions()[0].action==='copyPath'&&actions()[0].key==='modified'&&actions()[0].keys.length===1&&actions()[0].keys[0]==='modified'&&!('path' in actions()[0]));
      check('action-restores-row',!menu()&&document.activeElement===row('modified'));
      row('staged').dispatchEvent(new MouseEvent('click',{ctrlKey:true,bubbles:true}));await settle();check('mixed-selection-disabled',[...document.querySelectorAll('#selection-actions button')].every(node=>node.disabled));container('#selection-actions');
      row('untracked').click();key(row('untracked'),'ContextMenu');await settle();check('untracked-no-discard',[...menu().children].map(node=>node.textContent).join('|')==='Diff|Stage|File History|Copy Relative Path');key(menu(),'Escape');
      post({type:'busy',busy:true});row('untracked').dispatchEvent(new MouseEvent('contextmenu',{clientX:10,clientY:10,bubbles:true,cancelable:true}));await settle();
      check('busy-locks-actions',[...menu().querySelectorAll('button'),...document.querySelectorAll('#selection-actions button')].every(node=>node.disabled));for(const node of menu().querySelectorAll('button'))node.click();check('busy-sends-no-action',actions().length===1);key(menu(),'Escape');post({type:'busy',busy:false});
      const treeName=byId('rows').getAttribute('aria-label'),count=byId('rows').childElementCount,notice=byId('notice').textContent;post({type:'state',session:'expired-fixture-session',repository:'Expired',total:999,rows:[]});post({type:'error',session:'expired-fixture-session',message:'Expired'});await settle();check('foreign-session-ignored',byId('rows').getAttribute('aria-label')===treeName&&byId('rows').childElementCount===count&&byId('notice').textContent===notice&&row('modified'));
      row('modified').focus();key(row('modified'),'End');await settle();check('tree-end-focus',document.activeElement===row('conflict'));key(row('conflict'),'Home');await settle();check('tree-home-focus',document.activeElement===row('gw'));
      key(row('gw'),'ArrowLeft');await settle();check('collapse-group',row('gw').getAttribute('aria-expanded')==='false'&&!row('modified')&&!row('folder'));key(row('gw'),'ArrowRight');await settle();check('expand-group',row('gw').getAttribute('aria-expanded')==='true'&&row('modified')&&row('folder'));
      bridge.postMessage({type:'changesReport',session,themeClass:data.themeClass,bodyClasses:document.body.className,width:innerWidth,height:innerHeight,focused:document.hasFocus(),measurements,outlines,checks,failures,messageCount:captured.length,observedActions:actions()});
    }catch(error){bridge.postMessage({type:'changesError',session,error:String(error),checks,failures,measurements,outlines});}
  });
})();`;

async function probe(extension:vscode.Extension<unknown>,themeClass:string):Promise<Record<string,unknown>>{
  const parent=await realpath(tmpdir()),root=await realpath(await mkdtemp(path.join(parent,'git-pro-changes-ux-')));
  let panel:vscode.WebviewPanel|undefined,receiver:vscode.Disposable|undefined,timer:ReturnType<typeof setTimeout>|undefined,provider:ChangesPanel|undefined;
  const events=new vscode.EventEmitter<void>(),disposed=new vscode.EventEmitter<void>();
  try{
    const script=vscode.Uri.file(path.join(root,'probe.js'));await writeFile(script.fsPath,driver);
    panel=vscode.window.createWebviewPanel('gitPro.changesUxFixture','Git Pro: Changes UX Check',vscode.ViewColumn.One,{enableScripts:true,localResourceRoots:[vscode.Uri.joinPath(extension.extensionUri,'media'),vscode.Uri.file(root)]});
    let html='';
    // An inert production HTML sink. Provider messages cannot reach Git or the test panel.
    const facade={options:{},cspSource:panel.webview.cspSource,asWebviewUri:(uri:vscode.Uri)=>panel!.webview.asWebviewUri(uri),get html(){return html;},set html(value:string){html=value;},onDidReceiveMessage:()=>new vscode.Disposable(()=>{}),postMessage:async()=>true};
    provider=new ChangesPanel({extensionUri:extension.extensionUri} as vscode.ExtensionContext,{onDidChange:events.event,active:undefined} as unknown as RepositoryRegistry,{onDidChangeTreeData:events.event} as unknown as ChangesProvider);
    provider.resolveWebviewView({webview:facade,onDidDispose:disposed.event} as unknown as vscode.WebviewView);
    const session=/data-session="([a-f0-9-]+)"/.exec(html)?.[1],nonce=/<script nonce="([a-f0-9]+)"/.exec(html)?.[1];assert.ok(session&&nonce);
    return await new Promise<Record<string,unknown>>((resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error('Changes DOM probe exceeded 30 seconds.')),30_000);
      receiver=panel!.webview.onDidReceiveMessage((value:unknown)=>{
        if(!value||typeof value!=='object')return;const data=value as Record<string,unknown>;if(data.session!==session)return;
        if(data.type==='ready')void (async()=>{await panel!.webview.postMessage({type:'state',session,repository:'Fixture',total:4,rows,message:''});await panel!.webview.postMessage({type:'changesProbe',session,rows,themeClass});})().catch(reject);
        if(data.type==='changesError')reject(new Error(JSON.stringify(data)));
        if(data.type==='changesReport')resolve(data);
        // No outgoing renderer request is routed to production receive/run.
      });
      const resource=panel!.webview.asWebviewUri(vscode.Uri.joinPath(extension.extensionUri,'media','changes.js')).toString(),anchor=`<script nonce="${nonce}" src="${resource}">`;assert.equal(html.split(anchor).length,2);
      panel!.webview.html=html.replace(anchor,`<script nonce="${nonce}" src="${panel!.webview.asWebviewUri(script)}"></script>${anchor}`);
    });
  }finally{
    if(timer)clearTimeout(timer);receiver?.dispose();disposed.fire();provider?.dispose();events.dispose();disposed.dispose();panel?.dispose();
    assert.equal(path.dirname(root),parent);assert.ok(path.basename(root).startsWith('git-pro-changes-ux-'));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
}

export async function run():Promise<void>{
  const extension=vscode.extensions.getExtension('nhech.git-pro');assert.ok(extension);await extension.activate();
  const config=vscode.workspace.getConfiguration('workbench'),previousTheme=config.inspect<string>('colorTheme')?.globalValue,previousClose=config.inspect<boolean>('editor.closeEmptyGroups')?.globalValue,results:Record<string,unknown>[]=[];
  try{
    await config.update('editor.closeEmptyGroups',false,vscode.ConfigurationTarget.Global);
    for(const [theme,themeClass] of themes){await config.update('colorTheme',theme,vscode.ConfigurationTarget.Global);for(const columns of [1,2,3]){await vscode.commands.executeCommand('vscode.setEditorLayout',{orientation:0,groups:Array.from({length:columns},()=>({}))});const report=await probe(extension,themeClass);results.push({theme,columns,...report});console.log(JSON.stringify({changesObservation:results.at(-1)}));}}
  }finally{
    await config.update('colorTheme',previousTheme,vscode.ConfigurationTarget.Global);await config.update('editor.closeEmptyGroups',previousClose,vscode.ConfigurationTarget.Global);await vscode.commands.executeCommand('vscode.setEditorLayout',{orientation:0,groups:[{}]});
    if(process.env.GIT_PRO_CHANGES_UX_OUTPUT)await writeFile(process.env.GIT_PRO_CHANGES_UX_OUTPUT,JSON.stringify({version:vscode.version,platform:process.platform,extensionPath:extension.extensionPath,results,note:'Production Changes HTML through an inert facade, exact installed CSS/JS, synthetic fixture rows/events in a separate editor panel. No Git routing, actual sidebar sizing/provider integration, physical keyboard, speech or native screenshots.'},null,2)+'\n');
  }
  assert.equal(results.length,12);assert.ok(results.every(result=>Array.isArray(result.failures)&&result.failures.length===0),'Changes DOM checks failed; preserve raw observations.');const widths=results.map(result=>Number(result.width));assert.ok(Math.min(...widths)<320&&Math.max(...widths)>650);
  console.log('Installed Changes DOM checks passed.');
}
