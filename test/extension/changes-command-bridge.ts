import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { advancedFixture } from '../fixtures/advanced-fixture';
import { ChangesProvider } from '../../src/views/changes/changes.provider';
import { ChangesPanel } from '../../src/views/changes/changes-panel';
import type { ExtensionDiagnostics } from '../../src/extension';
import type { GitExtension } from '../../src/types/git';

interface Row {key:string;kind:string;group?:string;label:string}
interface State {type:string;session:string;rows:Row[];total:number}
const viewId='gitProFixture.changesCommandBridge';
const driver=`(() => {
  const bridge=acquireVsCodeApi(),session=document.body.dataset.session;let captured=0,running=false;
  window.acquireVsCodeApi=()=>({getState:()=>bridge.getState(),setState:value=>bridge.setState(value),postMessage:value=>{if(++captured>150)throw Error('Message bound');bridge.postMessage(value);}});
  const settle=()=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Two-frame DOM settle exceeded 5 seconds; visibility='+document.visibilityState)),5000);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve();}));}),row=key=>document.querySelector('[data-key="'+key+'"]');
  window.addEventListener('message',async event=>{
    const data=event.data;if(data?.session!==session)return;
    if(data.type==='state'){try{await settle();if(document.querySelectorAll('#rows [data-key]').length)bridge.postMessage({type:'bridgeReady',session,total:data.total});}catch(error){bridge.postMessage({type:'bridgeTrace',session,step:'state-settle-failure',error:String(error)});}return;}
    if(data.type!=='bridgeProbe'||running)return;running=true;const checks=[];
    const trace=step=>bridge.postMessage({type:'bridgeTrace',session,id:data.id,step,visibility:document.visibilityState});trace('probe-received');
    const check=(name,value)=>{checks.push({name,passed:Boolean(value)});if(!value)throw Error(name);};
    try{
      await settle();trace('initial-settle');const nodes=data.keys.map(row);check('current-dom-rows',nodes.length>0&&nodes.every(Boolean));
      if(data.mode==='selection'){
        nodes[0].click();for(const node of nodes.slice(1))node.dispatchEvent(new MouseEvent('click',{ctrlKey:true,bubbles:true}));await settle();trace('selection-settle');
        check('selected-row-count',document.querySelectorAll('[aria-selected=true]').length===nodes.length);
        const button=document.querySelector('#selection-actions [data-action="'+data.action+'"]');check('enabled-selection-action',button&&!button.disabled);button.click();
      }else{
        const target=nodes[0];target.dispatchEvent(new MouseEvent('contextmenu',{clientX:innerWidth-1,clientY:innerHeight-1,bubbles:true,cancelable:true}));trace('menu-dispatched');await settle();trace('menu-settle');
        const menu=document.querySelector('.context-menu');check('semantic-context-menu',menu?.getAttribute('role')==='menu');
        const rect=menu.getBoundingClientRect();check('menu-in-viewport',rect.left>=0&&rect.top>=0&&rect.right<=innerWidth&&rect.bottom<=innerHeight);
        const button=[...menu.children].find(node=>node.textContent===data.label);check('enabled-context-action',button&&!button.disabled);button.click();
      }
      bridge.postMessage({type:'bridgeReport',session,id:data.id,checks,width:innerWidth,height:innerHeight,captured});
    }catch(error){bridge.postMessage({type:'bridgeFailure',session,id:data.id,error:String(error),checks});}finally{running=false;}
  });
})();`;
async function until(predicate:()=>boolean,label:string):Promise<void>{for(let n=0;n<400;n++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('Command bridge wait exceeded 20 seconds: '+label);}

export async function run():Promise<void>{
  assert.equal(process.platform,'linux');const originalFolders=vscode.workspace.workspaceFolders;assert.equal(originalFolders?.length,1);assert.ok(vscode.workspace.workspaceFile);
  const extension=vscode.extensions.getExtension<ExtensionDiagnostics>('nhech.git-pro');assert.ok(extension);const api=await extension.activate();assert.ok(api);
  const originalId=api.activeRepository();assert.ok(originalId);const builtin=vscode.extensions.getExtension<GitExtension>('vscode.git');assert.ok(builtin);const gitApi=(await builtin.activate()).getAPI(1);
  const f=await advancedFixture(path.join(extension.extensionPath,'media/helpers/preserve-editor.cjs'),true);
  const parent=await realpath(tmpdir()),root=await realpath(await mkdtemp(path.join(parent,'git-pro-command-bridge-'))),script=vscode.Uri.file(path.join(root,'probe.js'));
  const provider=new ChangesProvider(f.registry),panel=new ChangesPanel({extensionUri:extension.extensionUri} as vscode.ExtensionContext,f.registry,provider),config=vscode.workspace.getConfiguration('gitPro'),previousGroup=config.inspect<string>('changes.groupBy')?.globalValue;
  const subscriptions:vscode.Disposable[]=[],requests:Record<string,unknown>[]=[],states:Record<string,unknown>[]=[],reports:Record<string,unknown>[]=[],checks:{name:string;passed:boolean}[]=[],errors:Record<string,unknown>[]=[],traces:Record<string,unknown>[]=[],messageTypes:string[]=[],pending=new Map<number,{resolve:(value:Record<string,unknown>)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  let view:vscode.WebviewView|undefined,state:State|undefined,messages=0,busyCompleted=0,busy=false,added=false,failure:string|undefined,rendererReady=false;
  const check=(name:string,value:unknown)=>{checks.push({name,passed:Boolean(value)});assert.ok(value,name);};
  const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex'),files=['README.md','unrelated.txt','src/one.ts','src/two.ts','notes.txt'];
  let baseline:{head:string;refs:string;indexEntries:string;workingContents:Record<string,string>;protectedBlobs:Record<string,string>;originalWorkspaceStatus:string}|undefined;
  const workingHashes=async()=>Object.fromEntries(await Promise.all(files.map(async file=>[file,hash(await readFile(path.join(f.root,file)))])));
  const originalStatus=()=>f.git(['status','--porcelain=v2','-z'],originalFolders![0]!.uri.fsPath);
  const blob=(file:string)=>f.git(['show',':'+file]);
  try{
    await writeFile(script.fsPath,driver);await mkdir(path.join(f.root,'src'));
    await f.commit('README.md','README baseline\n','Baseline README');await f.commit('unrelated.txt','unrelated baseline\n','Baseline unrelated');await f.commit('src/one.ts','one baseline\n','Baseline one');await f.commit('src/two.ts','two baseline\n','Baseline two');
    await writeFile(path.join(f.root,'README.md'),'README staged\n');await writeFile(path.join(f.root,'unrelated.txt'),'unrelated staged\n');f.git(['add','--','README.md','unrelated.txt']);
    await writeFile(path.join(f.root,'README.md'),'README working\n');await writeFile(path.join(f.root,'src/one.ts'),'one working\n');await writeFile(path.join(f.root,'src/two.ts'),'two working\n');await writeFile(path.join(f.root,'notes.txt'),'notes untracked\n');await f.registry.refresh(f.id);
    baseline={head:f.git(['rev-parse','HEAD']),refs:f.git(['show-ref']),indexEntries:f.git(['ls-files','--stage','-z']),workingContents:await workingHashes(),protectedBlobs:{'README.md':blob('README.md'),'unrelated.txt':blob('unrelated.txt')},originalWorkspaceStatus:originalStatus()};
    check('workspace-folder-add',vscode.workspace.updateWorkspaceFolders(1,0,{uri:vscode.Uri.file(f.root),name:'Bridge fixture'}));added=true;await until(()=>vscode.workspace.workspaceFolders?.length===2,'folder added');check('builtin-repository-open',await gitApi.openRepository(vscode.Uri.file(f.root)));await until(()=>api.repositories()===2,'installed registry discovery');
    await vscode.commands.executeCommand('gitPro.selectRepository',f.id);await vscode.commands.executeCommand('gitPro.refresh');await until(()=>api.activeRepository()===f.id&&api.activeSnapshot()?.changes.length===6,'production active fixture');
    await config.update('changes.groupBy','status',vscode.ConfigurationTarget.Global);
    subscriptions.push(vscode.window.registerWebviewViewProvider(viewId,{resolveWebviewView(actual){
      view=actual;const real=actual.webview;
      const facade={get options(){return real.options;},set options(value:vscode.WebviewOptions){real.options={...value,localResourceRoots:[...(value.localResourceRoots??[]),vscode.Uri.file(root)]};},cspSource:real.cspSource,asWebviewUri:(uri:vscode.Uri)=>real.asWebviewUri(uri),get html(){return real.html;},set html(html:string){const nonce=/<script nonce="([a-f0-9]+)"/.exec(html)?.[1];assert.ok(nonce);const anchor='<script nonce="'+nonce+'"';assert.equal(html.split(anchor).length,2);real.html=html.replace(anchor,'<script nonce="'+nonce+'" src="'+real.asWebviewUri(script)+'"></script>'+anchor);},postMessage:(data:Record<string,unknown>)=>{if(data.type==='state')state=data as unknown as State;if(data.type==='busy'){busy=data.busy===true;if(!busy)busyCompleted++;}if(data.type==='error')errors.push(data);return real.postMessage(data);},onDidReceiveMessage:(listener:(value:unknown)=>unknown)=>real.onDidReceiveMessage((raw:unknown)=>{
        assert.ok(++messages<=300);if(!raw||typeof raw!=='object')return;const data=raw as Record<string,unknown>;messageTypes.push(String(data.type));
        if(data.type==='bridgeReady'){rendererReady=data.session===state?.session&&data.total===6;return;}
        if(data.type==='bridgeTrace'){traces.push(data);console.log(JSON.stringify(data));return;}
        if(data.type==='bridgeReport'||data.type==='bridgeFailure'){const entry=pending.get(Number(data.id));if(entry){clearTimeout(entry.timer);pending.delete(Number(data.id));if(data.type==='bridgeFailure')entry.reject(new Error(JSON.stringify(data)));else entry.resolve(data);}return;}
        if(data.type==='action'){assert.ok(['stage','unstage','stageAll'].includes(String(data.action)));requests.push(data);}
        return listener(raw);
      })};panel.resolveWebviewView({webview:facade,onDidDispose:actual.onDidDispose} as unknown as vscode.WebviewView);
    }},{webviewOptions:{retainContextWhenHidden:false}}));
    await vscode.commands.executeCommand(viewId+'.focus');await until(()=>Boolean(view?.visible&&state?.total===6&&rendererReady),'fixture sidebar rendered acknowledgement');
    const find=(kind:string,group:string,label:string)=>{const row=state?.rows.find(row=>row.kind===kind&&row.group===group&&row.label===label);assert.ok(row,'Current row: '+kind+'/'+group+'/'+label);return row.key;};
    async function perform(name:string,action:string,keys:string[],label:string,expected:string[],mode='menu'){
      assert.ok(state&&view);const id=reports.length+1,beforeRequests=requests.length,beforeBusy=busyCompleted;
      const report=await new Promise<Record<string,unknown>>((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('DOM action probe exceeded 30 seconds'));},30_000);pending.set(id,{resolve,reject,timer});void view!.webview.postMessage({type:'bridgeProbe',session:state!.session,id,action,keys,label,mode}).then(sent=>{if(!sent){clearTimeout(timer);pending.delete(id);reject(new Error('Probe not delivered'));}});});reports.push({name,action,mode,...report});
      await until(()=>requests.length===beforeRequests+1&&busyCompleted>beforeBusy&&!busy,'actual command completion: '+name);check('no-provider-error:'+name,errors.length===0);
      const request=requests.at(-1)!;check('request-action:'+name,request.action===action&&!('path' in request)&&request.session===state!.session);assert.deepEqual(request.keys,keys);check('known-row-keys:'+name,true);
      await vscode.commands.executeCommand('gitPro.refresh');await f.registry.refresh(f.id);const actual=f.registry.store.get(f.id)!.changes.map(c=>c.group+':'+c.path).sort();assert.deepEqual(actual,expected.slice().sort());check('actual-git-status:'+name,true);
      await until(()=>api.activeSnapshot()?.changes.map(c=>c.group+':'+c.path).sort().join('|')===actual.join('|')&&state?.rows.filter(row=>row.kind==='file').map(row=>row.group+':'+row.label).sort().join('|')===actual.join('|'),'both provider states: '+name);check('both-providers-current:'+name,true);
      check('head-preserved:'+name,f.git(['rev-parse','HEAD'])===baseline!.head);check('refs-preserved:'+name,f.git(['show-ref'])===baseline!.refs);
      assert.deepEqual(await workingHashes(),baseline!.workingContents);check('working-content-preserved:'+name,true);
      for(const file of ['README.md','unrelated.txt'])check('protected-index:'+name+':'+file,blob(file)===baseline!.protectedBlobs[file]);
      check('original-workspace-preserved:'+name,originalStatus()===baseline!.originalWorkspaceStatus);
      const targets=['src/one.ts','src/two.ts','notes.txt'];for(const file of targets){if(expected.includes('staged:'+file))check('staged-blob:'+name+':'+file,blob(file)===await readFile(path.join(f.root,file),'utf8'));else if(file!=='notes.txt')check('unstaged-index-head:'+name+':'+file,blob(file)===f.git(['show','HEAD:'+file]));else check('untracked-index-absent:'+name,f.git(['ls-files','--','notes.txt'])==='');}
      states.push({name,changes:actual,indexEntries:f.git(['ls-files','--stage','-z']),productionCounts:api.viewItemCounts(),fixtureTotal:state!.total,workingHashes:await workingHashes(),protectedBlobs:{'README.md':blob('README.md'),'unrelated.txt':blob('unrelated.txt')}});console.log(JSON.stringify({bridgeTransition:name,requests:requests.length,busyCompleted,changes:actual}));
    }
    const protectedChanges=['staged:README.md','working:README.md','staged:unrelated.txt'];
    const expected=(one:string,two:string,notes:string)=>[...protectedChanges,one+':src/one.ts',two+':src/two.ts',notes+':notes.txt'];
    await perform('row Stage','stage',[find('file','working','src/one.ts')],'Stage',expected('staged','working','untracked'));
    await perform('row Unstage','unstage',[find('file','staged','src/one.ts')],'Unstage',expected('working','working','untracked'));
    await perform('selection Stage','stage',[find('file','working','src/one.ts'),find('file','working','src/two.ts')],'',expected('staged','staged','untracked'),'selection');
    await perform('selection Unstage','unstage',[find('file','staged','src/one.ts'),find('file','staged','src/two.ts')],'',expected('working','working','untracked'),'selection');
    await config.update('changes.groupBy','folder',vscode.ConfigurationTarget.Global);await until(()=>Boolean(state?.rows.some(row=>row.kind==='folder'&&row.group==='working')),'folder mode');
    await perform('folder Stage','stage',[find('folder','working','src')],'Stage Folder',expected('staged','staged','untracked'));
    await perform('folder Unstage','unstage',[find('folder','staged','src')],'Unstage Folder',expected('working','working','untracked'));
    await config.update('changes.groupBy','status',vscode.ConfigurationTarget.Global);await until(()=>Boolean(state&&!state.rows.some(row=>row.kind==='folder')),'status mode');
    await perform('untracked row Stage','stage',[find('file','untracked','notes.txt')],'Stage',expected('working','working','staged'));
    await perform('added row Unstage','unstage',[find('file','staged','notes.txt')],'Unstage',expected('working','working','untracked'));
    await perform('Untracked group Stage','stageAll',[find('group','untracked','Untracked')],'Stage Untracked',expected('working','working','staged'));
    await perform('group result Unstage','unstage',[find('file','staged','notes.txt')],'Unstage',expected('working','working','untracked'));
    check('final-semantic-index-equals-baseline',f.git(['ls-files','--stage','-z'])===baseline.indexEntries);check('ten-real-commands',requests.length===10&&busyCompleted===10&&errors.length===0);
  }catch(error){failure=String(error);throw error;}finally{
    if(process.env.GIT_PRO_CHANGES_BRIDGE_OUTPUT)await writeFile(process.env.GIT_PRO_CHANGES_BRIDGE_OUTPUT,JSON.stringify({version:vscode.version,platform:process.platform,reports,requests,states,checks,errors,traces,messageTypes,rendererReady,messages,busyCompleted,baseline,failure,cleanupPending:true},null,2)+'\n');
    for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(new Error('Fixture disposed'));}pending.clear();for(const item of subscriptions)item.dispose();panel.dispose();provider.dispose();
    await config.update('changes.groupBy',previousGroup,vscode.ConfigurationTarget.Global);await vscode.commands.executeCommand('gitPro.selectRepository',originalId);
    if(added){const index=vscode.workspace.workspaceFolders?.findIndex(folder=>folder.uri.fsPath===f.root)??-1;assert.ok(index>0);check('workspace-folder-remove',vscode.workspace.updateWorkspaceFolders(index,1));await until(()=>vscode.workspace.workspaceFolders?.length===1&&api.repositories()===1,'workspace restored');added=false;}
    check('original-repository-restored',api.activeRepository()===originalId);
    if(process.env.GIT_PRO_CHANGES_BRIDGE_OUTPUT)await writeFile(process.env.GIT_PRO_CHANGES_BRIDGE_OUTPUT,JSON.stringify({version:vscode.version,platform:process.platform,reports,requests,states,checks,errors,traces,messageTypes,rendererReady,messages,busyCompleted,baseline,failure,workspaceRestored:true,settingsRestored:true,note:'Fixture-contributed real sidebar using compiled production provider/panel source and exact installed media, trusted nonce/probe adapter, ready/select/actions routed to production receive/run and original installed Stage/Unstage command handlers. Real disposable Git index outcomes. No original installed view renderer instance, physical input, destructive confirmation, screenshots, speech, remote writes or source-repository changes.'},null,2)+'\n');
    await f.close();assert.equal(path.dirname(root),parent);assert.ok(path.basename(root).startsWith('git-pro-command-bridge-'));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
  assert.equal(reports.length,10);console.log(JSON.stringify({bridgeChecks:checks.length,domChecks:reports.reduce((n,r)=>n+(r.checks as unknown[]).length,0),passed:true}));
}
