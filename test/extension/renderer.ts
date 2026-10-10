import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { historyHtml } from '../../src/webviews/graph/history-html';
import { layoutGraph } from '../../src/webviews/graph/graph-layout';
import { recordHostMetric } from './host-metrics';

const probe = `(() => {
  const bridge = acquireVsCodeApi();
  try { window.acquireVsCodeApi = () => bridge; } catch { bridge.postMessage({type:'probeError',message:'Fixture API sharing unavailable'}); return; }
  const viewport = document.getElementById('viewport'), samples = [], longTasks = [];
  const register = viewport.addEventListener.bind(viewport);
  viewport.addEventListener = (type, listener, options) => register(type, type !== 'scroll' ? listener : function(event) {
    const start = performance.now(); listener.call(this,event); document.getElementById('rows').getBoundingClientRect();
    const end = performance.now(); if(samples.length<300) samples.push({ms:end-start,rows:document.getElementById('rows').children.length});
    performance.measure('git-pro-scroll-layout',{start,end});
  },options);
  let observer; try { observer=new PerformanceObserver(list=>{for(const item of list.getEntries())if(longTasks.length<100)longTasks.push(item.duration);}); observer.observe({type:'longtask',buffered:false}); } catch { /* Long-task support is reported separately. */ }
  let running=false;
  window.addEventListener('message',async event=>{
    if(event.data?.type!=='page'||running)return;running=true;
    try {
      await document.fonts.ready; await new Promise(resolve=>setTimeout(resolve,300));
      for(let index=0;index<100;index++){
        viewport.scrollTop=((index*37)%1980)*40;viewport.dispatchEvent(new Event('scroll'));
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      observer?.disconnect();
      bridge.postMessage({type:'rendererReport',samples,longTasks,longTaskObserver:Boolean(observer),viewportHeight:viewport.clientHeight,userTimingEntries:performance.getEntriesByName('git-pro-scroll-layout').length});
    } catch(error) { observer?.disconnect();bridge.postMessage({type:'probeError',message:String(error)}); }
  });
})();`;

/** A real installed renderer workload; does not authorize any Git operation. */
export async function measureHistoryRenderer(extension: vscode.Extension<unknown>): Promise<void> {
  const parent = await realpath(tmpdir()), root = await realpath(await mkdtemp(path.join(parent,'git-pro-renderer-')));
  let panel:vscode.WebviewPanel|undefined, receiver:vscode.Disposable|undefined, timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const script=vscode.Uri.file(path.join(root,'probe.js'));await writeFile(script.fsPath,probe);
    panel=vscode.window.createWebviewPanel('gitPro.rendererFixture','Git Pro: Renderer Measurement',vscode.ViewColumn.Active,
      {enableScripts:true,localResourceRoots:[vscode.Uri.joinPath(extension.extensionUri,'media'),vscode.Uri.file(root)],retainContextWhenHidden:false});
    const session=randomUUID(),nonce=randomUUID().replace(/-/g,''),resource=(name:string)=>panel!.webview.asWebviewUri(vscode.Uri.joinPath(extension.extensionUri,'media',name)).toString();
    const commits=Array.from({length:2000},(_,index)=>({oid:(index+1).toString(16).padStart(40,'0'),parents:index<1999?[(index+2).toString(16).padStart(40,'0')]:[],subject:`Renderer fixture commit ${index}`,author:'Fixture',email:'fixture@example.invalid',timestamp:1700000000-index}));
    const rows=layoutGraph(commits).rows,refs=Array.from({length:128},(_,index)=>({name:`refs/heads/fixture-${index}`,oid:commits[index*13]!.oid}));
    const report=await new Promise<Record<string,unknown>>((resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error('Real webview renderer measurement exceeded 45 seconds.')),45_000);
      receiver=panel!.webview.onDidReceiveMessage((message:unknown)=>{
        if(!message||typeof message!=='object')return;const item=message as Record<string,unknown>;
        if(item.type==='ready'&&item.session===session)void panel!.webview.postMessage({type:'page',session,commits,rows,refs,tips:[commits[0]!.oid],filters:{},hasMore:false,ref:'HEAD'});
        if(item.type==='probeError')reject(new Error(`Renderer probe failed: ${String(item.message).slice(0,200)}`));
        if(item.type==='rendererReport')resolve(item);
      });
      const html=historyHtml({session,nonce,cspSource:panel!.webview.cspSource,resource});
      panel!.webview.html=html.replace(`<script nonce="${nonce}" src="${resource('history.js')}">`,`<script nonce="${nonce}" src="${panel!.webview.asWebviewUri(script)}"></script><script nonce="${nonce}" src="${resource('history.js')}">`);
    });
    assert.ok(Array.isArray(report.samples)&&report.samples.length>=100&&report.samples.length<=300,'Bounded real scroll samples required');
    const samples=report.samples as {ms:number;rows:number}[];
    for(const sample of samples)assert.ok(Number.isFinite(sample.ms)&&sample.ms>=0&&Number.isInteger(sample.rows)&&sample.rows>0&&sample.rows<300,'Renderer samples exceed timing/DOM bounds');
    const timings=samples.map(sample=>sample.ms).sort((a,b)=>a-b),p50=timings[Math.floor(timings.length*0.5)]!,p95=timings[Math.floor(timings.length*0.95)]!;
    assert.ok(Array.isArray(report.longTasks)&&report.longTasks.length<=100&&report.longTasks.every(item=>typeof item==='number'&&Number.isFinite(item)&&item>=0));
    assert.ok(typeof report.viewportHeight==='number'&&report.viewportHeight>0&&report.viewportHeight<=10000);
    assert.ok(typeof report.userTimingEntries==='number'&&Number.isInteger(report.userTimingEntries)&&report.userTimingEntries>=100&&report.userTimingEntries<=600);
    assert.equal(typeof report.longTaskObserver,'boolean');
    await recordHostMetric({historyRendererCommits:2000,selectedRefs:128,samples:samples.length,p50Ms:p50,p95Ms:p95,maxMs:timings.at(-1),maxMountedRows:Math.max(...samples.map(sample=>sample.rows)),viewportHeight:report.viewportHeight,userTimingEntries:report.userTimingEntries,longTaskObserver:report.longTaskObserver,longTasks:report.longTasks,note:'Real installed History JS/CSS in an owned VS Code webview; synthetic supported data; scroll callback plus forced layout, not GPU paint or physical frame delivery.'});
    assert.ok(p50<16,`Typical scroll callback plus layout exceeds 16 ms: ${p50}`);
  } finally {
    if(timer)clearTimeout(timer);receiver?.dispose();panel?.dispose();
    assert.equal(path.dirname(root),parent);assert.ok(path.basename(root).startsWith('git-pro-renderer-'));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
}
