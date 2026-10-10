import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { advancedFixture } from '../fixtures/advanced-fixture';
import { ChangesProvider } from '../../src/views/changes/changes.provider';
import { ChangesPanel } from '../../src/views/changes/changes-panel';

const viewId='gitProFixture.changesSidebar';
const themes=[['Default Dark Modern','vscode-dark'],['Default Light Modern','vscode-light'],['Default High Contrast','vscode-high-contrast'],['Default High Contrast Light','vscode-high-contrast-light']] as const;
const driver=`(() => {
  const bridge=acquireVsCodeApi(),session=document.body.dataset.session,boot=crypto.randomUUID();let state,captured=0,running=false;
  window.acquireVsCodeApi=()=>({getState:()=>bridge.getState(),setState:value=>bridge.setState(value),postMessage:value=>{if(++captured>100)throw Error('Message bound');bridge.postMessage(value);}});
  const settle=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))),key=(node,key,extra={})=>node.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra}));
  window.addEventListener('message',async event=>{
    const data=event.data;if(data?.session!==session)return;if(data.type==='state'){state=data;return;}
    if(data.type!=='sidebarProbe'||running)return;running=true;const checks=[],failures=[],geometry=[],outlines=[];
    const check=(name,value)=>{checks.push({name,passed:Boolean(value)});if(!value)failures.push(name);};
    const row=id=>document.querySelector('[data-key="'+id+'"]'),menu=()=>document.querySelector('.context-menu');
    const bound=()=>{const rect=menu().getBoundingClientRect();geometry.push({kind:'menu',left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom});check('menu-bounds',rect.left>=0&&rect.top>=0&&rect.right<=innerWidth&&rect.bottom<=innerHeight);};
    try{
      await document.fonts.ready;for(let n=0;n<150&&!document.body.classList.contains(data.themeClass);n++)await settle();await settle();
      check('host-theme',document.body.classList.contains(data.themeClass));check('real-state',state?.repository==='repository'&&state.total===4);
      check('sidebar-viewport',innerWidth>150&&innerWidth<500&&innerHeight>100);
      check('tree-name',document.getElementById('rows').getAttribute('aria-label')==='repository changes');
      const files=state.rows.filter(item=>item.kind==='file');check('four-provider-files',files.length===4);check('folder-mode',state.rows.some(item=>item.kind==='folder')===data.folder);
      for(const item of state.rows){const node=row(item.key);check('provider-row:'+item.kind+':'+item.key,node?.getAttribute('role')==='treeitem'&&node.getAttribute('aria-level')===String(item.depth+1));}
      for(const item of files){const node=row(item.key),badge=node.querySelector('.status'),name=node.querySelector('.name'),rect=node.getBoundingClientRect(),b=badge.getBoundingClientRect(),label=name.getBoundingClientRect();
        check('literal-label:'+item.key,name.textContent===item.label&&!node.querySelector('img'));
        check('right-status:'+item.key,b.right>=rect.right-7&&b.right<=rect.right&&label.right<=b.left&&badge.textContent===item.status&&node.getAttribute('aria-label').includes(item.status));
        check('decorative-icon:'+item.key,node.querySelector('.marker').getAttribute('aria-hidden')==='true'&&Boolean(node.querySelector('.marker').textContent));
      }
      for(const selector of ['body','header','.toolbar','.entry','.entry-main'])for(const node of document.querySelectorAll(selector)){geometry.push({kind:selector,client:node.clientWidth,scroll:node.scrollWidth});check('overflow:'+selector,node.scrollWidth<=node.clientWidth+1);}
      check('document-overflow',document.documentElement.scrollWidth<=innerWidth+1);
      const item=files.find(item=>item.group==='working'&&item.label.includes('<img')),target=row(item.key);target.click();await settle();
      check('working-selection',!document.getElementById('selection-actions').hidden&&!document.querySelector('#selection-actions [data-action=stage]').disabled&&document.querySelector('#selection-actions [data-action=unstage]').disabled);
      for(const node of [target,...document.querySelectorAll('.toolbar button')]){node.focus();const s=getComputedStyle(node);outlines.push({width:s.outlineWidth,offset:s.outlineOffset,style:s.outlineStyle,focused:document.activeElement===node});check('focus:'+node.className+':'+node.dataset.action,node.matches(':focus-visible')&&s.outlineStyle!=='none'&&parseFloat(s.outlineWidth)>=2&&parseFloat(s.outlineOffset)>=2);}
      target.dispatchEvent(new MouseEvent('contextmenu',{clientX:innerWidth-1,clientY:innerHeight-1,bubbles:true,cancelable:true}));await settle();bound();
      check('menu-actions',[...menu().children].map(node=>node.textContent).join('|')==='Diff|Stage|Discard|File History|Copy Relative Path');
      const first=menu().firstElementChild,s=getComputedStyle(first);check('menu-focus',document.activeElement===first&&first.matches(':focus-visible')&&parseFloat(s.outlineWidth)>=2&&parseFloat(s.outlineOffset)>=2);
      key(menu(),'End');check('menu-end',document.activeElement===menu().lastElementChild);key(menu(),'Home');check('menu-home',document.activeElement===first);key(menu(),'Escape');check('escape-restores-row',!menu()&&document.activeElement===target);
      key(target,'F10',{shiftKey:true});await settle();bound();key(menu(),'Escape');
      key(target,'ContextMenu');await settle();menu().lastElementChild.click();await settle();check('copy-restores-row',!menu()&&document.activeElement===target);
      bridge.postMessage({type:'sidebarReport',session,id:data.id,boot,checks,failures,geometry,outlines,width:innerWidth,height:innerHeight,bodyClasses:document.body.className,fileKeys:files.map(item=>item.key),selectedKey:item.key,captured});
    }catch(error){bridge.postMessage({type:'sidebarError',session,id:data.id,error:String(error),checks,failures,geometry});}finally{running=false;}
  });
  bridge.postMessage({type:'sidebarBoot',session,boot});
})();`;

async function until(predicate:()=>boolean,label:string):Promise<void>{
  for(let n=0;n<300;n++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('Sidebar wait exceeded 15 seconds: '+label);
}

export async function run():Promise<void>{
  assert.equal(process.platform,'linux','This owned sidebar fixture uses Linux literal filenames.');
  const extension=vscode.extensions.getExtension('nhech.git-pro');assert.ok(extension);await extension.activate();
  const f=await advancedFixture(path.join(extension.extensionPath,'media/helpers/preserve-editor.cjs'),true);
  const parent=await realpath(tmpdir()),root=await realpath(await mkdtemp(path.join(parent,'git-pro-sidebar-'))),script=vscode.Uri.file(path.join(root,'probe.js'));
  const provider=new ChangesProvider(f.registry),panel=new ChangesPanel({extensionUri:extension.extensionUri} as vscode.ExtensionContext,f.registry,provider);
  const workbench=vscode.workspace.getConfiguration('workbench'),gitConfig=vscode.workspace.getConfiguration('gitPro'),previousTheme=workbench.inspect<string>('colorTheme')?.globalValue,previousGroup=gitConfig.inspect<string>('changes.groupBy')?.globalValue;
  const reports:Record<string,unknown>[]=[],actions:Record<string,unknown>[]=[],boots:Record<string,unknown>[]=[],visibility:boolean[]=[],subscriptions:vscode.Disposable[]=[],pending=new Map<number,{resolve:(value:Record<string,unknown>)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  let view:vscode.WebviewView|undefined,state:Record<string,unknown>|undefined,resolves=0,messageCount=0,readyCount=0,baseline:Record<string,string>|undefined,final:Record<string,string>|undefined;
  const fingerprint=async()=>({head:f.git(['rev-parse','HEAD']),refs:f.git(['show-ref']),index:createHash('sha256').update(await readFile(path.join(f.root,'.git/index'))).digest('hex'),status:f.git(['status','--porcelain=v2','-z']),working:f.git(['diff','--binary']),staged:f.git(['diff','--cached','--binary'])});
  try{
    await writeFile(script.fsPath,driver);await mkdir(path.join(f.root,'src'));
    const filename='src/'+ 'long-'.repeat(25)+'<img onerror=alert(1)>.ts';
    await f.commit('README.md','baseline\n','Baseline README');await f.commit(filename,'baseline\n','Baseline source');
    await writeFile(path.join(f.root,'README.md'),'staged\n');f.git(['add','--','README.md']);await writeFile(path.join(f.root,'README.md'),'working\n');await writeFile(path.join(f.root,filename),'changed\n');await writeFile(path.join(f.root,'notes.txt'),'untracked\n');
    await f.registry.refresh(f.id);assert.equal(f.registry.store.get(f.id)?.changes.length,4);baseline=await fingerprint();
    subscriptions.push(vscode.window.registerWebviewViewProvider(viewId,{resolveWebviewView(actual){
      view=actual;resolves++;subscriptions.push(actual.onDidChangeVisibility(()=>visibility.push(actual.visible)));
      const real=actual.webview;
      // Transparent fixture instrumentation: real host state and ready/select flow;
      // renderer action requests are deliberately never delivered to production run.
      const facade={get options(){return real.options;},set options(value:vscode.WebviewOptions){real.options={...value,localResourceRoots:[...(value.localResourceRoots??[]),vscode.Uri.file(root)]};},cspSource:real.cspSource,asWebviewUri:(uri:vscode.Uri)=>real.asWebviewUri(uri),get html(){return real.html;},set html(html:string){const nonce=/<script nonce="([a-f0-9]+)"/.exec(html)?.[1];assert.ok(nonce);const anchor='<script nonce="'+nonce+'"';assert.equal(html.split(anchor).length,2);real.html=html.replace(anchor,'<script nonce="'+nonce+'" src="'+real.asWebviewUri(script)+'"></script>'+anchor);},postMessage:(data:Record<string,unknown>)=>{if(data.type==='state')state=data;return real.postMessage(data);},onDidReceiveMessage:(listener:(value:unknown)=>unknown)=>real.onDidReceiveMessage((raw:unknown)=>{
        assert.ok(++messageCount<=200);if(!raw||typeof raw!=='object')return;const data=raw as Record<string,unknown>;
        if(data.type==='sidebarBoot'){boots.push(data);return;}if(data.type==='sidebarReport'||data.type==='sidebarError'){const entry=pending.get(Number(data.id));if(entry){clearTimeout(entry.timer);pending.delete(Number(data.id));if(data.type==='sidebarError')entry.reject(new Error(JSON.stringify(data)));else entry.resolve(data);}return;}
        if(data.type==='action'){actions.push(data);return;}if(data.type==='ready')readyCount++;
        return listener(raw);
      })};
      panel.resolveWebviewView({webview:facade,onDidDispose:actual.onDidDispose} as unknown as vscode.WebviewView);
    }},{webviewOptions:{retainContextWhenHidden:false}}));
    const commands=await vscode.commands.getCommands();assert.ok(commands.includes(viewId+'.focus'));assert.ok(commands.includes('workbench.action.toggleSidebarVisibility'));
    await vscode.commands.executeCommand(viewId+'.focus');await until(()=>Boolean(view?.visible&&state?.total===4&&boots.length),'initial resolve/state');
    const rowKey=(data:string[])=>createHash('sha256').update(JSON.stringify(data)).digest('base64url');
    async function probe(themeClass:string,folder:boolean,lifecycle=false){
      await until(()=>Boolean(state&&Array.isArray(state.rows)&&state.rows.some(row=>(row as {kind:string}).kind==='folder')===folder),'grouping state');
      const id=reports.length+1,beforeActions=actions.length;
      const report=await new Promise<Record<string,unknown>>((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Sidebar probe exceeded 30 seconds'));},30_000);pending.set(id,{resolve,reject,timer});void view!.webview.postMessage({type:'sidebarProbe',session:state!.session,id,themeClass,folder}).then(sent=>{if(!sent){clearTimeout(timer);pending.delete(id);reject(new Error('Sidebar message not delivered'));}});});
      reports.push({...report,folder,lifecycle,visible:view!.visible,resolveCount:resolves});
      await until(()=>panel.selection.some(node=>node.kind==='file'&&rowKey([node.repositoryId,'file',node.change.group,node.change.path])===report.selectedKey),'production host selection');
      assert.equal(actions.length,beforeActions+1);const request=actions.at(-1)!;assert.equal(request.action,'copyPath');assert.equal(request.key,report.selectedKey);assert.deepEqual(request.keys,[report.selectedKey]);assert.ok(!('path' in request));
      assert.equal(request.key,rowKey([f.id,'file','working',filename]));
      console.log(JSON.stringify({sidebarObservation:reports.at(-1)}));
    }
    for(const [theme,themeClass] of themes){await workbench.update('colorTheme',theme,vscode.ConfigurationTarget.Global);for(const group of ['status','folder']){await gitConfig.update('changes.groupBy',group,vscode.ConfigurationTarget.Global);await probe(themeClass,group==='folder');}}
    const bootCount=boots.length,readyBefore=readyCount;
    await vscode.commands.executeCommand('workbench.action.toggleSidebarVisibility');await until(()=>view?.visible===false,'hidden');
    await new Promise(resolve=>setTimeout(resolve,300));view!.show(false);
    await until(()=>Boolean(view?.visible&&boots.length>bootCount&&readyCount>readyBefore),'content restored without retainContextWhenHidden');
    await probe(themes[3][1],true,true);assert.ok(visibility.includes(false)&&visibility.includes(true));final=await fingerprint();assert.deepEqual(final,baseline);
  }finally{
    for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(new Error('Fixture disposed'));}pending.clear();
    for(const item of subscriptions)item.dispose();panel.dispose();provider.dispose();
    await workbench.update('colorTheme',previousTheme,vscode.ConfigurationTarget.Global);await gitConfig.update('changes.groupBy',previousGroup,vscode.ConfigurationTarget.Global);
    if(process.env.GIT_PRO_SIDEBAR_OUTPUT)await writeFile(process.env.GIT_PRO_SIDEBAR_OUTPUT,JSON.stringify({version:vscode.version,platform:process.platform,extensionPath:extension.extensionPath,reports,actions,boots,visibility,resolves,readyCount,messageCount,baseline,final,note:'Actual fixture-contributed sidebar, production ChangesPanel/ChangesProvider/RepositoryRegistry source with exact installed media. Test-only nonce/message adapter. Ready/select reach host; every action blocked. No installed gitPro.changes registration, physical keyboard, native screenshots, speech or mutation routing claim.'},null,2)+'\n');
    await f.close();assert.equal(path.dirname(root),parent);assert.ok(path.basename(root).startsWith('git-pro-sidebar-'));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
  assert.equal(reports.length,9);assert.ok(reports.every(report=>Array.isArray(report.failures)&&report.failures.length===0),'Sidebar DOM checks failed; preserve raw observations.');
}
