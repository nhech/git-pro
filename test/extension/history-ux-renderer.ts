import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { historyHtml } from '../../src/webviews/graph/history-html';
import { layoutGraph } from '../../src/webviews/graph/graph-layout';
import { recordHostMetric } from './host-metrics';

const expectedChecks = [
  'filter-disclosure-form-association', 'selection-guidance-and-load-boundary', 'metadata-width-and-full-label', 'dense-graph-desktop-reserve',
  'graph-first-and-last-selection', 'local-middle-and-final-page-focus',
  'working-path-and-index', 'local-first-page-focus', 'deliberately-moved-focus',
  'busy-session-focus', 'comparison-layout-focus',
  'async-side-page-focus-and-file-retention', 'details-heading-focus', 'semantic-labels',
];

const driver = `(() => {
  const bridge=acquireVsCodeApi(),session=document.body.dataset.session,captured=[],checks=[];
  const api={getState:()=>bridge.getState(),setState:value=>bridge.setState(value),postMessage:value=>{if(captured.length>=100)throw new Error('Fixture message bound exceeded');captured.push(value);bridge.postMessage(value);}};
  try{window.acquireVsCodeApi=()=>api;}catch{bridge.postMessage({type:'uxProbeError',session,message:'Fixture API sharing unavailable'});return;}
  const assert=(condition,label)=>{if(!condition)throw new Error(label);};
  const checked=name=>checks.push({name,passed:true});
  const settle=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const post=data=>window.dispatchEvent(new MessageEvent('message',{data:{...data,session:data.session??session}}));
  const byId=id=>document.getElementById(id);
  let running=false,firstGeometry;
  window.addEventListener('message',async event=>{
    if(event.data?.type!=='page'||event.data.session!==session||running)return;running=true;
    try{
      await document.fonts.ready;await settle();
      const viewport=byId('viewport'),commits=event.data.commits,details=byId('details');
      const pagination=byId('pagination'),more=byId('more');
      const disclosure=byId('filter-disclosure'),summary=disclosure.querySelector('summary'),filters=byId('filters'),refresh=document.querySelector('.history-toolbar button');
      assert(disclosure.open&&summary.tabIndex===0&&refresh.form===filters,'Wide default filters must use native summary semantics and an associated Refresh control');
      summary.click();await settle();assert(!disclosure.open&&bridge.getState().filtersExpanded===false,'Closing Filters must retain the explicit presentation choice');
      const applied=byId('filter-summary').textContent;filters.querySelector('[name=text]').value='unsent draft';assert(byId('filter-summary').textContent===applied,'Applied summary must not claim an unsent filter');
      summary.click();await settle();assert(disclosure.open&&bridge.getState().filtersExpanded===true,'Fields must reopen through the native summary');filters.querySelector('[name=text]').value='';checked('filter-disclosure-form-association');
      const firstDate=byId('commit-0').querySelector('.commit-date');
      const rect=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom,clientWidth:el.clientWidth,scrollWidth:el.scrollWidth,clientLeft:el.clientLeft,scrollLeft:el.scrollLeft,display:getComputedStyle(el).display};};
      firstGeometry={innerWidth:window.innerWidth,innerHeight:window.innerHeight,body:rect(document.body),workspace:rect(byId('workspace')),gridTemplateColumns:getComputedStyle(byId('workspace')).gridTemplateColumns,viewport:rect(viewport),spacer:rect(byId('spacer')),row:rect(byId('commit-0')),date:rect(firstDate),author:rect(byId('commit-0').querySelector('.commit-author')),meta:rect(byId('commit-0').querySelector('.meta')),graph:rect(byId('commit-0').querySelector('svg')),rowReserve:getComputedStyle(byId('spacer')).getPropertyValue('--history-row-reserve'),spacerMinWidth:byId('spacer').style.minWidth};
      assert(viewport.scrollWidth<=viewport.clientWidth&&firstDate.getBoundingClientRect().right<=viewport.getBoundingClientRect().left+viewport.clientLeft+viewport.clientWidth-7,'First-render date must fit inside the visible viewport without stale-width horizontal overflow');
      assert(details.querySelector('.details-guidance h2')?.textContent==='Commit details','Unselected Details must retain a meaningful heading');
      assert(more.getAttribute('aria-describedby')==='pagination'&&pagination.getAttribute('aria-live')==='polite'&&pagination.textContent.includes('End of matching history.'),'An exact end must explain the unavailable Load more button');
      post({...event.data,limitReached:true});post({type:'busy',busy:true});post({type:'busy',busy:false});await settle();
      assert(pagination.textContent.includes('Load limit reached.')&&more.disabled,'A capped page must retain its reason through loading');
      post({type:'reset'});await settle();assert(details.querySelector('.details-guidance')&&pagination.hidden&&more.disabled,'Reset must restore guidance and clear a stale boundary');
      post({...event.data,commits:[],rows:[],limitReached:false});await settle();assert(pagination.textContent.includes('0 commits loaded')&&!pagination.textContent.includes('Load limit reached.'),'Empty matching history is not a load cap');
      post({...event.data,limitReached:false});await settle();checked('selection-guidance-and-load-boundary');
      const row=byId('commit-0'),author=row.querySelector('.commit-author'),date=row.querySelector('.commit-date'),meta=row.querySelector('.meta');
      assert(window.innerWidth>700&&date.getBoundingClientRect().width>0&&date.scrollWidth<=date.clientWidth&&viewport.scrollWidth<=viewport.clientWidth&&date.getBoundingClientRect().right<=viewport.getBoundingClientRect().left+viewport.clientLeft+viewport.clientWidth-7,'Complete row date must fit inside the visible desktop viewport');
      assert(author.scrollWidth>author.clientWidth&&meta.title.includes(commits[0].author)&&row.getAttribute('aria-label').includes(commits[0].author)&&row.getAttribute('aria-label').includes(date.textContent),'Ellipsized author/date must retain full tooltip and accessible metadata');
      assert(row.getBoundingClientRect().height===24,'Metadata must preserve virtual row height');checked('metadata-width-and-full-label');
      const denseRows=event.data.rows.map(r=>({...r,before:Array(160).fill('fixture'),after:Array(160).fill('fixture')}));
      post({...event.data,rows:denseRows});await settle();const dense=byId('commit-0'),denseDate=dense.querySelector('.commit-date'),graphWidth=Number(dense.querySelector('svg').getAttribute('width'));
      assert(viewport.scrollWidth>viewport.clientWidth&&byId('spacer').clientWidth>=graphWidth+400,'Dense desktop graph must retain the original metadata reserve and deliberate horizontal scrolling');
      assert(denseDate.clientWidth>0&&denseDate.scrollWidth<=denseDate.clientWidth&&denseDate.getBoundingClientRect().right<=dense.getBoundingClientRect().right-7,'Dense graph date must fit its complete scrollable row');
      post(event.data);await settle();checked('dense-graph-desktop-reserve');
      viewport.focus();await settle();assert(document.hasFocus()&&document.activeElement===viewport,'Owned Chromium document must really hold focus');
      for(const [key,index] of [['End',1999],['Home',0]]){
        viewport.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));await settle();
        const selected=byId(viewport.getAttribute('aria-activedescendant'));
        assert(selected?.getAttribute('aria-selected')==='true'&&selected.getAttribute('aria-posinset')===String(index+1),'Graph keyboard selection/active descendant mismatch');
        assert(captured.at(-1)?.type==='select'&&captured.at(-1)?.oid===commits[index].oid,'Graph must send the selected known OID');
      }
      checked('graph-first-and-last-selection');
      const files=Array.from({length:401},(_,index)=>({status:'M',path:index===400?'src/<img onerror=alert(1)>.ts':'file-'+index+'.txt'}));
      const result={from:commits[1].oid,to:commits[0].oid,files,stats:[],leftCommits:commits.slice(0,25),leftCount:40,leftOffset:0,rightCommits:[],rightCount:0,rightOffset:0};
      post({type:'comparison',result});await settle();
      const fileNav=()=>details.children[details.children.length-2],fileList=()=>details.lastElementChild;
      let previous=fileNav().children[0],next=fileNav().children[1];
      next.focus();const pageMessages=captured.length;next.click();await settle();
      assert(document.activeElement===next&&!next.disabled&&fileList().children.length===200,'Middle page must retain available Next');
      next.click();await settle();assert(next.disabled&&!previous.disabled&&document.activeElement===previous&&fileList().children.length===1,'Disabled final Next must fall back to Previous in Chromium');
      assert(captured.length===pageMessages,'Local pagination must send no Git request');checked('local-middle-and-final-page-focus');
      const working=fileList().children[0].children[1];
      assert(working.textContent==='Compare saved working file'&&working.getAttribute('aria-label')==='Compare saved working file: '+files[400].path,'Working comparison must expose a literal file-specific accessible name');
      assert(!document.querySelector('img'),'Hostile path must not create markup');working.click();
      const action=captured.at(-1);assert(action?.type==='workingDiff'&&action.index===400&&!('path' in action),'Working diff must use only the original numeric action index');checked('working-path-and-index');
      previous.click();await settle();assert(document.activeElement===previous&&!previous.disabled,'Middle page must retain Previous');
      previous.click();await settle();assert(previous.disabled&&!next.disabled&&document.activeElement===next,'Disabled first Previous must fall back to Next in Chromium');checked('local-first-page-focus');
      const zoom=byId('zoom');zoom.focus();next.click();await settle();assert(document.activeElement===zoom,'A programmatic page click must not steal deliberately moved focus');checked('deliberately-moved-focus');
      next.focus();post({type:'busy',busy:true});await settle();assert(next.disabled&&viewport.getAttribute('aria-busy')==='true','Busy must disable page controls and expose its state');
      post({type:'busy',session:'expired',busy:false});await settle();assert(next.disabled,'Expired session must not unlock busy controls');
      post({type:'busy',busy:false});await settle();assert(document.activeElement===next&&!next.disabled,'Async completion must restore the connected available page button');checked('busy-session-focus');
      const toggle=details.querySelector('[data-focus-key="comparison-layout"]');toggle.click();await settle();assert(byId('workspace').className==='split'&&document.activeElement===viewport,'Show History must focus the retained graph');
      toggle.click();await settle();assert(byId('workspace').className==='split comparing'&&document.activeElement===details.querySelector('h2'),'Expand Compare must focus its heading');checked('comparison-layout-focus');
      const sideNext=details.querySelector('[data-focus-key="compare:left:next"]');sideNext.focus();sideNext.click();assert(captured.at(-1)?.type==='comparePage'&&captured.at(-1)?.side==='left'&&captured.at(-1)?.offset===25,'Side page must send the captured bounded offset');
      post({type:'busy',busy:true});post({type:'comparison',result:{...result,leftCommits:commits.slice(25,40),leftOffset:25}});post({type:'busy',busy:false});await settle();
      previous=fileNav().children[0];next=fileNav().children[1];
      const sidePrevious=details.querySelector('[data-focus-key="compare:left:previous"]');
      assert(!sideNext.isConnected&&document.activeElement===sidePrevious&&!sidePrevious.disabled,'Rebuilt final side page must restore its available Previous button');
      assert(fileNav().children[2].textContent.includes('201–400')&&fileList().children.length===200,'Side pagination must retain the current changed-file page');checked('async-side-page-focus-and-file-retention');
      const sideCommit=details.querySelector('[data-focus-key="compare:commit:'+commits[25].oid+'"]');sideCommit.focus();sideCommit.click();post({type:'busy',busy:true});
      post({type:'details',details:{commit:commits[25],parent:commits[26].oid,refs:[],message:'Fixture details',files,stats:[]},parentIndex:0});post({type:'busy',busy:false});await settle();
      assert(document.activeElement===details.querySelector('h2')&&document.activeElement.tabIndex===-1&&!sideCommit.isConnected,'Side selection must land on the rebuilt details heading');checked('details-heading-focus');
      assert(viewport.getAttribute('role')==='listbox'&&viewport.tabIndex===0&&byId('status').getAttribute('aria-live')==='polite','Graph/status semantics must exist in the actual parsed HTML');
      for(const selector of ['#filters [name=ref]','#filters [name=text]','#compare [name=from]','#compare [name=to]'])assert(document.querySelector(selector).labels.length===1,'History/Compare fields must have a native associated label');
      checked('semantic-labels');bridge.postMessage({type:'uxRendererReport',session,checks,firstRenderGeometry:firstGeometry,documentFocused:document.hasFocus(),messageCount:captured.length,note:'Actual installed HTML/JS/CSS and Chromium DOM focus; synthetic events, not physical keyboard or screen-reader speech.'});
    }catch(error){bridge.postMessage({type:'uxProbeError',session,message:String(error),diagnostic:firstGeometry});}
  });
})();`;

/** Script and DOM validation in an owned installed webview, with no Git request routing. */
export async function verifyHistoryRendererUx(extension: vscode.Extension<unknown>): Promise<void> {
  const parent=await realpath(tmpdir()),root=await realpath(await mkdtemp(path.join(parent,'git-pro-renderer-ux-')));
  let panel:vscode.WebviewPanel|undefined,receiver:vscode.Disposable|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const script=vscode.Uri.file(path.join(root,'probe.js'));await writeFile(script.fsPath,driver);
    panel=vscode.window.createWebviewPanel('gitPro.rendererUxFixture','Git Pro: Renderer UX Check',vscode.ViewColumn.Active,
      {enableScripts:true,localResourceRoots:[vscode.Uri.joinPath(extension.extensionUri,'media'),vscode.Uri.file(root)],retainContextWhenHidden:false});
    const session=randomUUID(),nonce=randomUUID().replace(/-/g,''),resource=(name:string)=>panel!.webview.asWebviewUri(vscode.Uri.joinPath(extension.extensionUri,'media',name)).toString();
    const commits=Array.from({length:2000},(_,index)=>({oid:(index+1).toString(16).padStart(40,'0'),parents:index<1999?[(index+2).toString(16).padStart(40,'0')]:[],subject:`UX fixture commit ${index}`,author:'Fixture',email:'fixture@example.invalid',timestamp:1700000000-index}));
    commits[0]!.author='Long literal author '.repeat(20);const rows=layoutGraph(commits).rows,observed:Record<string,unknown>[]=[];
    const report=await new Promise<Record<string,unknown>>((resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error('Real webview UX fixture exceeded 45 seconds.')),45_000);
      receiver=panel!.webview.onDidReceiveMessage((message:unknown)=>{
        if(!message||typeof message!=='object')return;const item=message as Record<string,unknown>;if(item.session!==session)return;
        if(item.type==='ready')void panel!.webview.postMessage({type:'page',session,commits,rows,refs:[],tips:[commits[0]!.oid],filters:{},hasMore:false,ref:'HEAD'});
        if(item.type==='uxProbeError')void recordHostMetric({firstRenderGeometry:item.diagnostic,originalAssertionFailure:item.message}).then(()=>reject(new Error(`Renderer UX probe failed: ${String(item.message).slice(0,300)}`)),reject);
        if(['select','workingDiff','comparePage'].includes(String(item.type))){if(observed.length>=100){reject(new Error('Renderer UX message bound exceeded.'));return;}observed.push(item);}
        if(item.type==='uxRendererReport')resolve(item);
      });
      const html=historyHtml({session,nonce,cspSource:panel!.webview.cspSource,resource}),anchor=`<script nonce="${nonce}" src="${resource('history.js')}">`;
      assert.equal(html.split(anchor).length,2,'One exact production script anchor required');
      panel!.webview.html=html.replace(anchor,`<script nonce="${nonce}" src="${panel!.webview.asWebviewUri(script)}"></script>${anchor}`);
    });
    assert.ok(Array.isArray(report.checks)&&report.checks.length===expectedChecks.length);
    const checks=report.checks as {name:string;passed:boolean}[];assert.deepEqual(checks.map(check=>check.name),expectedChecks);assert.ok(checks.every(check=>check.passed===true));
    assert.equal(report.documentFocused,true);assert.ok(typeof report.messageCount==='number'&&Number.isInteger(report.messageCount)&&report.messageCount>=5&&report.messageCount<=100);
    assert.ok(observed.some(item=>item.type==='select'&&item.oid===commits[1999]!.oid));
    assert.ok(observed.some(item=>item.type==='workingDiff'&&item.index===400&&!('path' in item)));
    assert.ok(observed.some(item=>item.type==='comparePage'&&item.side==='left'&&item.offset===25));
    await recordHostMetric({historyRendererUxChecks:checks,firstRenderGeometry:report.firstRenderGeometry,documentFocused:report.documentFocused,messageCount:report.messageCount,observedReadOnlyRequests:observed.length,note:'Actual installed History HTML/JS/CSS and real Chromium DOM focus; synthetic keyboard/click events; no Git routing, physical keyboard, screen-reader speech, native screenshot or full phase certification.'});
  } finally {
    if(timer)clearTimeout(timer);receiver?.dispose();panel?.dispose();
    assert.equal(path.dirname(root),parent);assert.ok(path.basename(root).startsWith('git-pro-renderer-ux-'));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
}
