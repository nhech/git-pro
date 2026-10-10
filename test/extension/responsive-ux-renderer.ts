import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { commitHtml } from '../../src/webviews/commit/commit-html';
import { plannerHtml } from '../../src/webviews/rebase/planner-html';

const themes = [
  ['Default Dark Modern', 'vscode-dark'], ['Default Light Modern', 'vscode-light'],
  ['Default High Contrast', 'vscode-high-contrast'], ['Default High Contrast Light', 'vscode-high-contrast-light'],
] as const;
const driver = `(() => {
  const bridge=acquireVsCodeApi(),session=document.body.dataset.session,captured=[];
  window.acquireVsCodeApi=()=>({getState:()=>bridge.getState(),setState:value=>bridge.setState(value),postMessage:value=>{if(captured.length>=100)throw new Error('Message bound');captured.push(value);bridge.postMessage(value);}});
  const settle=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))),byId=id=>document.getElementById(id);
  let running=false;
  window.addEventListener('message',async event=>{
    const data=event.data;if(data?.type!=='responsiveProbe'||data.session!==session||running)return;running=true;
    const failures=[],checks=[];const check=(name,ok)=>{checks.push({name,passed:Boolean(ok)});if(!ok)failures.push(name);};
    try{
      await document.fonts.ready;
      for(let i=0;i<150&&!document.body.classList.contains(data.themeClass);i++)await settle();
      await settle();check('actual-host-theme',document.body.classList.contains(data.themeClass));
      const measurements=[];
      for(const selector of data.kind==='planner'?['body','main','main>section','#commits','.commit','#subject','#message-preview']:['body','#repository','#message','#history','.actions']){
        for(const node of document.querySelectorAll(selector)){
          const rect=node.getBoundingClientRect(),parent=node.parentElement?.getBoundingClientRect(),style=getComputedStyle(node);
          measurements.push({selector,clientWidth:node.clientWidth,scrollWidth:node.scrollWidth,width:rect.width,right:rect.right,parentRight:parent?.right,boxSizing:style.boxSizing,whiteSpace:style.whiteSpace});
          check('no-horizontal-overflow:'+selector,node.scrollWidth<=node.clientWidth+1);
          if(selector==='.commit')check('commit-inside-list',rect.right<=parent.right+1);
        }
      }
      check('document-inside-viewport',document.documentElement.scrollWidth<=innerWidth+1);
      check('native-field-labels',data.kind==='planner'?byId('action').labels.length===1:byId('message').labels.length===1&&byId('history').labels.length===1);
      const focus=data.kind==='planner'?byId('commits'):byId('message');focus.focus();await settle();
      check('real-dom-focus',document.hasFocus()&&document.activeElement===focus);
      const focusStyle=getComputedStyle(focus),focusOutline={style:focusStyle.outlineStyle,width:focusStyle.outlineWidth,color:focusStyle.outlineColor,offset:focusStyle.outlineOffset};check('visible-focus-outline',focusStyle.outlineStyle!=='none'&&parseFloat(focusStyle.outlineWidth)>=2);
      const controlOutlines=[];
      if(data.kind==='planner'){
        focus.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}));await settle();
        const active=byId(focus.getAttribute('aria-activedescendant'));
        check('known-selected-option',active?.getAttribute('aria-selected')==='true'&&active===focus.lastElementChild);
        check('narrow-stack-or-wide-columns',getComputedStyle(document.querySelector('main')).gridTemplateColumns.split(' ').length===(innerWidth<=650?1:2));
      }else{
        check('staged-only-copy',byId('staged').textContent.includes('commits the index'));
        check('actions-enabled',!byId('commit').disabled&&!byId('push').disabled);
        check('input-descriptions',byId('message').getAttribute('aria-describedby')==='warning stagingHelp');
        document.querySelector('details').open=true;
        for(const selector of ['#history','#amend','#signoff','#noVerify','summary','#commit','#push']){
          const node=document.querySelector(selector);focus.focus();node.focus();await settle();const style=getComputedStyle(node);
          controlOutlines.push({selector,focused:document.activeElement===node,style:style.outlineStyle,width:style.outlineWidth,color:style.outlineColor,offset:style.outlineOffset});
          check('control-focus:'+selector,document.activeElement===node&&style.outlineStyle!=='none'&&parseFloat(style.outlineWidth)>=2);
        }
        focus.focus();check('checkbox-native-labels',['amend','signoff','noVerify'].every(id=>byId(id).labels.length===1));
      }
      bridge.postMessage({type:'responsiveReport',session,kind:data.kind,themeClass:data.themeClass,bodyClasses:document.body.className,width:innerWidth,height:innerHeight,focused:document.hasFocus(),focusOutline,controlOutlines,measurements,checks,failures,messageCount:captured.length});
    }catch(error){bridge.postMessage({type:'responsiveError',session,error:String(error)});}
  });
})();`;

async function probe(extension: vscode.Extension<unknown>, kind: 'composer'|'planner', themeClass: string): Promise<Record<string, unknown>> {
  const parent=await realpath(tmpdir()),root=await realpath(await mkdtemp(path.join(parent,'git-pro-responsive-')));
  let panel:vscode.WebviewPanel|undefined,receiver:vscode.Disposable|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const script=vscode.Uri.file(path.join(root,'probe.js'));await writeFile(script.fsPath,driver);
    panel=vscode.window.createWebviewPanel('gitPro.responsiveFixture','Git Pro: Responsive Check',vscode.ViewColumn.One,
      {enableScripts:true,localResourceRoots:[vscode.Uri.joinPath(extension.extensionUri,'media'),vscode.Uri.file(root)]});
    const session=randomUUID(),nonce=randomUUID().replace(/-/g,''),resource=(name:string)=>panel!.webview.asWebviewUri(vscode.Uri.joinPath(extension.extensionUri,'media',name)).toString();
    return await new Promise<Record<string,unknown>>((resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error('Responsive panel exceeded 30 seconds.')),30_000);
      receiver=panel!.webview.onDidReceiveMessage((value:unknown)=>{
        if(!value||typeof value!=='object')return;const data=value as Record<string,unknown>;if(data.session!==session)return;
        if(data.type==='ready')void (async()=>{
          const long='long-unbroken-subject-'+ 'x'.repeat(320);
          if(kind==='planner'){
            await panel!.webview.postMessage({type:'state',session,range:'Fixture base → HEAD',revision:0,steps:[{oid:'1'.repeat(40),subject:long,action:'reword',message:long+'\nSecond line'},{oid:'2'.repeat(40),subject:'Next commit',action:'pick'}]});
            await panel!.webview.postMessage({type:'busy',session,busy:false});
          }else await panel!.webview.postMessage({type:'state',session,repositoryId:'fixture',repository:'Fixture repository',staged:2,operation:'idle',subjectLimit:72,message:'Fixture draft',history:['Previous fixture message'],busy:false});
          await panel!.webview.postMessage({type:'responsiveProbe',session,kind,themeClass});
        })().catch(reject);
        if(data.type==='responsiveError')reject(new Error(String(data.error)));
        if(data.type==='responsiveReport')resolve(data);
        // Observe protocol only. No message can dispatch a Git operation.
      });
      const name=kind==='planner'?'rebase.js':'commit.js';
      const html=kind==='planner'?plannerHtml(session,nonce,panel!.webview.cspSource,resource):commitHtml({session,nonce,cspSource:panel!.webview.cspSource,style:resource('commit.css'),script:resource(name)});
      const anchor=`<script nonce="${nonce}" src="${resource(name)}">`;
      assert.equal(html.split(anchor).length,2);panel!.webview.html=html.replace(anchor,`<script nonce="${nonce}" src="${panel!.webview.asWebviewUri(script)}"></script>${anchor}`);
    });
  } finally {
    if(timer)clearTimeout(timer);receiver?.dispose();panel?.dispose();
    assert.equal(path.dirname(root),parent);assert.ok(path.basename(root).startsWith('git-pro-responsive-'));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
}

/** Owned installed panels; synthetic input and observed host layout/themes, no Git routing. */
export async function run(): Promise<void> {
  const extension=vscode.extensions.getExtension('nhech.git-pro');assert.ok(extension);await extension.activate();
  const configuration=vscode.workspace.getConfiguration('workbench'),previousTheme=configuration.inspect<string>('colorTheme')?.globalValue,previousClose=configuration.inspect<boolean>('editor.closeEmptyGroups')?.globalValue;
  const results:Record<string,unknown>[]=[];
  try {
    await configuration.update('editor.closeEmptyGroups',false,vscode.ConfigurationTarget.Global);
    for(const [theme,themeClass] of themes){
      await configuration.update('colorTheme',theme,vscode.ConfigurationTarget.Global);
      for(const columns of [1,2,3]){
        await vscode.commands.executeCommand('vscode.setEditorLayout',{orientation:0,groups:Array.from({length:columns},()=>({}))});
        for(const kind of ['planner','composer'] as const){const report=await probe(extension,kind,themeClass);results.push({theme,columns,...report});console.log(JSON.stringify({responsiveObservation:results.at(-1)}));}
      }
    }
  } finally {
    await configuration.update('colorTheme',previousTheme,vscode.ConfigurationTarget.Global);
    await configuration.update('editor.closeEmptyGroups',previousClose,vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('vscode.setEditorLayout',{orientation:0,groups:[{}]});
    if(process.env.GIT_PRO_RESPONSIVE_OUTPUT)await writeFile(process.env.GIT_PRO_RESPONSIVE_OUTPUT,JSON.stringify({version:vscode.version,platform:process.platform,extensionPath:extension.extensionPath,results,note:'Real installed CSS/JS and production HTML, actual editor widths and built-in theme classes. Synthetic events; no physical keyboard, screen-reader speech, screenshots, Changes probe, or full accessibility certification.'},null,2)+'\n');
  }
  assert.equal(results.length,24);assert.ok(results.every(result=>Array.isArray(result.failures)&&result.failures.length===0),'Responsive checks failed; preserve raw observations.');
  const widths=results.map(result=>Number(result.width));assert.ok(Math.min(...widths)<650&&Math.max(...widths)>650,'Both real responsive breakpoint sides must be observed.');
  console.log('Installed responsive planner/composer DOM checks passed.');
}
