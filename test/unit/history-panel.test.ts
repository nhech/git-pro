import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as path from 'node:path';

const oid=(index:number)=>String(index).padStart(40,'0');
const commit=(index:number)=>({oid:oid(index),parents:[oid(index+1),oid(index+2)],author:'Fixture',email:'test@example.invalid',timestamp:1700000000,subject:`Commit ${index}`});
for(const total of [2000,2001])test(`History distinguishes exact ${total}-commit end from the load bound and restores/resets its reason`,async()=>{
  const all=Array.from({length:total},(_,index)=>commit(index+1));
  const read=(offset:number,size:number)=>({commits:all.slice(offset,offset+size),offset,nextOffset:Math.min(total,offset+size),hasMore:offset+size<total});
  const h=harness({pin:async()=>({tips:[oid(1)],filters:{}}),checkPinnedQuery:()=>undefined,page:async(_query:unknown,offset:number,_signal:unknown,size:number)=>read(offset,size),window:async(_query:unknown,offset:number,_signal:unknown,capacity:number)=>read(offset,capacity)},async()=>undefined,'');
  await h.send({type:'ready'});assert.equal(h.last('page')?.limitReached,false);
  for(let loaded=50;loaded<=2000;loaded+=25)await h.send({type:'more'});
  assert.equal((h.last('page')?.commits as unknown[]).length,2000);assert.equal(h.last('page')?.hasMore,false);assert.equal(h.last('page')?.limitReached,total===2001);
  await h.send({type:'ready'});assert.equal(h.last('page')?.limitReached,total===2001);
  await h.send({type:'query',ref:'HEAD',path:'',text:'',author:'',from:'',to:''});assert.equal((h.last('page')?.commits as unknown[]).length,25);assert.equal(h.last('page')?.limitReached,false);h.host.dispose();
});
function harness(history:Record<string,unknown>,executeCommand=async()=>undefined,filePath:string|undefined='new.txt'){
  const file=path.resolve(__dirname,'../../src/webviews/graph/history-panel.js'),load=createRequire(file),exports:Record<string,unknown>={};
  const sent:Record<string,unknown>[]=[],disposable={dispose:()=>undefined};
  let receive:(value:unknown)=>Promise<void>=async()=>undefined,onDispose=()=>undefined;
  const panel={webview:{html:'',cspSource:'owned:',asWebviewUri:(uri:unknown)=>String(uri),postMessage:async(value:Record<string,unknown>)=>{sent.push(value);return true;},onDidReceiveMessage:(callback:typeof receive)=>{receive=callback;return disposable;}},onDidDispose:(callback:typeof onDispose)=>{onDispose=callback;return disposable;},dispose:()=>onDispose()};
  const settings={pageSize:25},clipboard:string[]=[];
  const vscode={window:{createWebviewPanel:()=>panel},commands:{executeCommand},ViewColumn:{Active:1},Uri:{file:(value:string)=>value,joinPath:(_root:unknown,...parts:string[])=>parts.join('/')},workspace:{getConfiguration:()=>({get:()=>settings.pageSize})},env:{clipboard:{writeText:async(value:string)=>{clipboard.push(value);}}}};
  runInNewContext(readFileSync(file,'utf8'),{exports,AbortController,require:(name:string)=>name==='vscode'?vscode:load(name)});
  type Host={open(repo:string,file?:string):void;dispose():void;activePanelCount:number};
  const Constructor=exports.HistoryPanel as new(context:unknown,history:unknown,revisions:unknown)=>Host;
  const host=new Constructor({extensionUri:'owned'},{root:()=>'.',...history},{add:()=> 'owned revision'});host.open('repo',filePath);
  const session=/data-session="([^"]+)"/.exec(panel.webview.html)![1]!;
  return {host,sent,settings,clipboard,send:(value:Record<string,unknown>)=>receive({session,...value}),last:(type:string)=>sent.slice().reverse().find(value=>value.type===type)};
}

test('History renderer readiness preserves pinned file cursor, merge-parent details and explicit refresh semantics',async()=>{
  let pins=0,reads=0,detailsReads=0;
  const queries:{tips:string[];filters:Record<string,unknown>}[]=[],pageQueries:unknown[]=[];
  const continuation={tips:[oid(1)],filters:{path:'new.txt',follow:true}};
  const h=harness({pin:async(_id:string,_ref:string,filters:Record<string,unknown>)=>{pins++;const query={tips:[oid(pins)],filters};queries.push(query);return query;},filePage:async(query:unknown,offset:number)=>{reads++;pageQueries.push(query);return {commits:[commit(offset+1)],nextOffset:offset+1,hasMore:true,nextPath:'new.txt',nextQuery:continuation,paths:[{oid:oid(offset+1),path:'old.txt'}],scanned:8};},details:async(_id:string,id:string,parent:number)=>{detailsReads++;return {commit:commit(Number(id)),parent:oid(parent+2),files:[],stats:[],refs:[],message:'Pinned details'};}});
  await h.send({type:'ready'});await h.send({type:'select',oid:oid(1),parent:1});await h.send({type:'ready'});
  assert.equal(pins,1);assert.equal(reads,1);assert.equal(detailsReads,1);assert.equal(h.last('details')?.parentIndex,1);assert.equal(h.last('details')?.historicalPath,'old.txt');assert.equal(h.last('selection')?.oid,oid(1));
  await h.send({type:'more'});assert.equal(pageQueries[1],continuation);assert.equal((h.last('page')?.commits as unknown[]).length,2);
  await h.send({type:'ready'});assert.equal(reads,2);assert.equal(pins,1);assert.equal((h.last('page')?.tips as string[])[0],oid(1));
  const before=h.sent.length;await h.send({type:'query',ref:'topic',path:'new.txt',text:'needle',author:'author',from:'2026-01-01',to:'2026-10-06'});
  assert.equal(pins,2);assert.equal(reads,3);assert.equal(pageQueries[2],queries[1]);assert.equal(h.last('page')?.ref,'topic');assert.equal((h.last('page')?.filters as {author:string}).author,'author');
  await h.send({type:'ready'});assert.equal(pins,2);assert.equal(h.sent.slice(before).some(value=>value.type==='details'),false);
  await h.send({type:'ready',session:'expired'});assert.match(String(h.last('error')?.message),/expired/);assert.equal(pins,2);
  h.host.dispose();assert.equal(h.host.activePanelCount,0);const count=h.sent.length;await h.send({type:'ready'});assert.equal(h.sent.length,count);
});

test('ordinary History keeps first page fresh, consumes on-demand snapshot and drops it on refresh/disposal',async()=>{
  let pins=0,reads=0,windows=0,checks=0;const h=harness({pin:async()=>({tips:[oid(++pins)],filters:{}}),page:async(_q:unknown,offset:number)=>{reads++;return{commits:Array.from({length:25},(_,i)=>commit(offset+i+1)),offset,nextOffset:offset+25,hasMore:true};},checkPinnedQuery:()=>{checks++;},window:async(_q:unknown,offset:number,_signal:AbortSignal,capacity:number,fallbackSize:number)=>{assert.equal(capacity,500);assert.equal(fallbackSize,25);windows++;return{commits:Array.from({length:100},(_,i)=>commit(offset+i+1)),offset,nextOffset:offset+100,hasMore:true};}},async()=>undefined,'');
  await h.send({type:'ready'});assert.equal(reads,1);assert.equal(windows,0);assert.equal((h.last('page')?.commits as unknown[]).length,25);
  await h.send({type:'more'});await h.send({type:'more'});assert.equal(windows,1);assert.equal(reads,1);assert.equal(checks,3);assert.equal((h.last('page')?.commits as unknown[]).length,75);
  await h.send({type:'ready'});assert.equal(windows,1);await h.send({type:'query',ref:'topic',path:'',text:'',author:'',from:'',to:''});assert.equal(pins,2);assert.equal(reads,2);await h.send({type:'more'});assert.equal(windows,2);assert.equal((h.last('page')?.commits as unknown[]).length,50);
  h.host.dispose();const before=h.sent.length;await h.send({type:'more'});assert.equal(h.sent.length,before);assert.equal(h.host.activePanelCount,0);
});

test('late ordinary History window cannot install data after query replacement',async()=>{
  let entered!:()=>void,resolveWindow!:(value:unknown)=>void,pins=0;const started=new Promise<void>(r=>{entered=r;}),oldWindow=new Promise(r=>{resolveWindow=r;});
  const h=harness({pin:async()=>({tips:[oid(++pins)],filters:{}}),page:async()=>({commits:[commit(1)],offset:0,nextOffset:1,hasMore:true}),checkPinnedQuery:()=>undefined,window:async()=>{entered();return oldWindow;}},async()=>undefined,'');
  await h.send({type:'ready'});const old=h.send({type:'more'});await started;await h.send({type:'query',ref:'topic',path:'',text:'',author:'',from:'',to:''});resolveWindow({commits:[commit(999)],offset:1,nextOffset:2,hasMore:false});await old;assert.equal(pins,2);assert.equal((h.last('page')?.commits as {oid:string}[]).some(c=>c.oid===oid(999)),false);h.host.dispose();
});

test('Readiness while a native diff is opening releases busy state when that diff completes',async()=>{
  let opened!:()=>void,finish!:()=>void;
  const opening=new Promise<void>(resolve=>{opened=resolve;}),completion=new Promise<undefined>(resolve=>{finish=()=>resolve(undefined);});
  const h=harness({pin:async()=>({tips:[oid(1)],filters:{path:'new.txt',follow:true}}),filePage:async(query:unknown)=>({commits:[commit(1)],nextOffset:1,hasMore:false,nextPath:'new.txt',nextQuery:query,paths:[],scanned:1}),details:async()=>({commit:commit(1),parent:oid(2),files:[{status:'M',path:'new.txt'}],stats:[],refs:[],message:'Details'}),revision:async()=>Buffer.from('before'),workingRevision:async()=>Buffer.from('after')},async()=>{opened();return completion;});
  await h.send({type:'ready'});await h.send({type:'select',oid:oid(1),parent:0});
  const diff=h.send({type:'workingDiff',index:0});await opening;await h.send({type:'ready'});
  assert.equal(h.last('busy')?.busy,true);finish();await diff;assert.equal(h.last('busy')?.busy,false);assert.equal(h.last('selection')?.oid,oid(1));h.host.dispose();
});

test('History readiness replays adjacent comparison page without resolving refs or reading again',async()=>{
  let compares=0,pages=0;
  const result={from:oid(1),to:oid(2),files:[],stats:[],leftCommits:[commit(1)],rightCommits:[commit(2)],leftOffset:0,rightOffset:0,leftCount:50,rightCount:1};
  const h=harness({pin:async()=>({tips:[oid(1)],filters:{path:'new.txt',follow:true}}),filePage:async(query:unknown)=>({commits:[commit(1)],nextOffset:1,hasMore:false,nextPath:'new.txt',nextQuery:query,paths:[],scanned:1}),compare:async()=>{compares++;return result;},comparisonPage:async()=>{pages++;return [commit(26)];}});
  await h.send({type:'ready'});await h.send({type:'compare',from:'left',to:'right'});await h.send({type:'comparePage',side:'left',offset:25});await h.send({type:'ready'});
  assert.equal(compares,1);assert.equal(pages,1);const restored=h.last('comparison')?.result as typeof result;assert.equal(restored.leftOffset,25);assert.equal(restored.leftCommits[0]?.oid,oid(26));assert.equal(restored.from,oid(1));
  assert.equal((h.last('comparison')?.inputs as {from:string;to:string}).from,'left');assert.equal((h.last('comparison')?.inputs as {from:string;to:string}).to,'right');
  h.host.dispose();
});

test('Recreated History renderer resumes cancelled initial page using its existing pin',async()=>{
  let pins=0,reads=0,entered!:()=>void;
  const firstStarted=new Promise<void>(resolve=>{entered=resolve;});
  const h=harness({pin:async()=>{pins++;return {tips:[oid(1)],filters:{path:'new.txt',follow:true}};},filePage:async(query:unknown,_offset:number,_path:string,signal:AbortSignal)=>{reads++;if(reads===1){entered();await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('Cancelled')),{once:true}));}return {commits:[commit(1)],nextOffset:1,hasMore:false,nextPath:'new.txt',nextQuery:query,paths:[],scanned:1};}});
  const initial=h.send({type:'ready'});await firstStarted;await h.send({type:'ready'});await initial;
  assert.equal(pins,1);assert.equal(reads,2);assert.equal((h.last('page')?.commits as unknown[]).length,1);assert.equal(h.last('error'),undefined);h.host.dispose();
});

test('ordinary first-page acquisition starts before readiness, stays bounded and posts only after ready',async()=>{
  let entered!:()=>void,finish!:(value:unknown)=>void,reads=0,checks=0;
  const started=new Promise<void>(resolve=>{entered=resolve;}),pending=new Promise(resolve=>{finish=resolve;});
  const h=harness({pin:async()=>({tips:[oid(1)],filters:{}}),page:async(_q:unknown,offset:number,_signal:AbortSignal,size:number)=>{reads++;assert.equal(offset,0);assert.equal(size,25);entered();return pending;},checkPinnedQuery:()=>{checks++;}},async()=>undefined,'');
  await started;assert.equal(h.sent.length,0);const ready=h.send({type:'ready'});
  finish({commits:[commit(1)],offset:0,nextOffset:1,hasMore:false});await ready;
  assert.equal(reads,1);assert.equal(checks,1);assert.equal((h.last('page')?.commits as unknown[]).length,1);await h.send({type:'ready'});assert.equal(reads,1);h.host.dispose();
});

test('new query cancels an unfinished initial acquisition and ignores its late success',async()=>{
  let entered!:()=>void,finish!:(value:unknown)=>void,initialSignal!:AbortSignal,pins=0;
  const started=new Promise<void>(resolve=>{entered=resolve;}),pending=new Promise(resolve=>{finish=resolve;});
  const h=harness({pin:async()=>({tips:[oid(++pins)],filters:{}}),page:async(q:{tips:string[]},_offset:number,signal:AbortSignal)=>{if(q.tips[0]===oid(1)){initialSignal=signal;entered();return pending;}return {commits:[commit(2)],offset:0,nextOffset:1,hasMore:false};},checkPinnedQuery:()=>undefined},async()=>undefined,'');
  await started;const old=h.send({type:'ready'});await h.send({type:'query',ref:'topic',path:'',text:'',author:'',from:'',to:''});assert.equal(initialSignal.aborted,true);
  finish({commits:[commit(999)],offset:0,nextOffset:1,hasMore:false});await old;assert.equal((h.last('page')?.commits as {oid:string}[])[0]?.oid,oid(2));assert.equal(h.last('error'),undefined);h.host.dispose();
});

test('disposing before renderer readiness cancels owned acquisition without posting data',async()=>{
  let entered!:()=>void,signal!:AbortSignal;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const h=harness({pin:async()=>({tips:[oid(1)],filters:{}}),page:async(_q:unknown,_offset:number,s:AbortSignal)=>{signal=s;entered();return new Promise((_resolve,reject)=>s.addEventListener('abort',()=>reject(Error('Cancelled initial acquisition')),{once:true}));}},async()=>undefined,'');
  await started;h.host.dispose();assert.equal(signal.aborted,true);await h.send({type:'ready'});assert.equal(h.sent.length,0);assert.equal(h.host.activePanelCount,0);
});

test('initial acquisition errors surface on ready and explicit refresh retries safely',async()=>{
  let pins=0;
  const h=harness({pin:async()=>{if(++pins===1)throw Error('First pin failed');return {tips:[oid(2)],filters:{}};},page:async()=>({commits:[commit(2)],offset:0,nextOffset:1,hasMore:false})},async()=>undefined,'');
  await h.send({type:'ready'});assert.match(String(h.last('error')?.message),/First pin failed/);assert.equal(h.last('busy')?.busy,false);
  await h.send({type:'query',ref:'HEAD',path:'',text:'',author:'',from:'',to:''});assert.equal(pins,2);assert.equal((h.last('page')?.commits as {oid:string}[])[0]?.oid,oid(2));h.host.dispose();
});

test('page-size changes during webview startup discard old-size acquisition',async()=>{
  let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),sizes:number[]=[];
  const h=harness({pin:async()=>({tips:[oid(1)],filters:{}}),page:async(_q:unknown,_offset:number,_signal:AbortSignal,size:number)=>{sizes.push(size);entered();return {commits:Array.from({length:size},(_,i)=>commit(i+1)),offset:0,nextOffset:size,hasMore:true};}},async()=>undefined,'');
  await started;h.settings.pageSize=50;await h.send({type:'ready'});assert.deepEqual(sizes,[25,50]);assert.equal((h.last('page')?.commits as unknown[]).length,50);h.host.dispose();
});

test('History cancel clears a replacement before its pin finishes and rejects late success/error',async()=>{
  for(const failure of [false,true]){
    let pins=0,entered!:()=>void,finish!:(value:unknown)=>void,reject!:(error:Error)=>void,pendingSignal:AbortSignal|undefined;
    const started=new Promise<void>(resolve=>{entered=resolve;});
    const pending=new Promise((resolve,rejection)=>{finish=resolve;reject=rejection;});
    const h=harness({pin:async(_id:string,_ref:string,filters:unknown,signal:AbortSignal)=>{pins++;if(pins===2){pendingSignal=signal;entered();return pending;}return {tips:[oid(pins)],filters};},filePage:async(query:unknown)=>({commits:[commit(pins)],nextOffset:1,hasMore:false,nextPath:'new.txt',nextQuery:query,paths:[],scanned:1})});
    await h.send({type:'ready'});const before=h.sent.length;
    const replacement=h.send({type:'query',ref:'topic',path:'new.txt',text:'',author:'',from:'',to:''});await started;
    assert.equal(h.sent.slice(before).some(value=>value.type==='reset'),true,'Old rows disappear before resolving the replacement pin');
    const foreign=h.sent.length;await h.send({type:'cancel',session:'expired'});assert.equal(pendingSignal!.aborted,false);assert.equal(h.sent.slice(foreign).some(value=>value.type==='reset'),false);
    await h.send({type:'cancel'});assert.equal(pendingSignal!.aborted,true);assert.equal(h.last('busy')?.busy,false);assert.match(String(h.last('cancelled')?.message),/Git may still be stopping/);
    const cleared=h.sent.length;if(failure)reject(new Error('Late error'));else finish({tips:[oid(99)],filters:{path:'new.txt',follow:true}});await replacement;
    assert.equal(h.sent.length,cleared,'Neither late success nor failure can repaint or unlock');await h.send({type:'cancel'});assert.equal(h.sent.length,cleared,'Idle cancel is idempotent');h.host.dispose();
  }
});

test('History cancelled page cannot publish data or clear the busy state of its successor',async()=>{
  let pins=0,entered!:()=>void,finish!:(value:unknown)=>void,signal:AbortSignal|undefined,releasePin!:(value:unknown)=>void,nextEntered!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;}),nextStarted=new Promise<void>(resolve=>{nextEntered=resolve;}),pending=new Promise(resolve=>{finish=resolve;}),nextPin=new Promise(resolve=>{releasePin=resolve;});
  const h=harness({pin:async(_id:string,_ref:string,filters:unknown)=>{pins++;if(pins===2){nextEntered();return nextPin;}return{tips:[oid(pins)],filters};},filePage:async(query:unknown,_offset:number,_path:string,readSignal:AbortSignal)=>{if(pins===1){signal=readSignal;entered();return pending;}return{commits:[commit(2)],nextOffset:1,hasMore:false,nextPath:'new.txt',nextQuery:query,paths:[],scanned:1};}});
  const initial=h.send({type:'ready'});await started;
  const cancellation=h.send({type:'cancel'});const replacement=h.send({type:'query',ref:'topic',path:'new.txt',text:'',author:'',from:'',to:''});await nextStarted;await cancellation;
  assert.equal(signal!.aborted,true);assert.equal(h.last('busy')?.busy,true);assert.equal(h.last('cancelled'),undefined,'Old cancel must not post guidance over a newer query');
  const count=h.sent.length;finish({commits:[commit(999)],nextOffset:1,hasMore:false,nextPath:'new.txt',paths:[],scanned:1});await initial;assert.equal(h.sent.length,count);
  releasePin({tips:[oid(2)],filters:{path:'new.txt',follow:true}});await replacement;assert.equal((h.last('page')?.commits as {oid:string}[])[0]!.oid,oid(2));assert.equal(h.last('busy')?.busy,false);h.host.dispose();
});

test('History native diff explicitly disables cancel and keeps ownership until opening finishes',async()=>{
  let opened!:()=>void,finish!:()=>void;
  const started=new Promise<void>(resolve=>{opened=resolve;}),pending=new Promise<undefined>(resolve=>{finish=()=>resolve(undefined);});
  const h=harness({pin:async()=>({tips:[oid(1)],filters:{path:'new.txt',follow:true}}),filePage:async(query:unknown)=>({commits:[commit(1)],nextOffset:1,hasMore:false,nextPath:'new.txt',nextQuery:query,paths:[],scanned:1}),details:async()=>({commit:commit(1),parent:oid(2),files:[{status:'M',path:'new.txt'}],stats:[],refs:[],message:'Details'}),revision:async()=>Buffer.from('before'),workingRevision:async()=>Buffer.from('after')},async()=>{opened();return pending;});
  await h.send({type:'ready'});await h.send({type:'select',oid:oid(1),parent:0});const diff=h.send({type:'workingDiff',index:0});await started;
  assert.equal(h.last('busy')?.canCancel,false);const before=h.sent.length;await h.send({type:'cancel'});assert.equal(h.sent.slice(before).some(value=>value.type==='reset'||value.type==='cancelled'),false);assert.equal(h.last('busy')?.busy,true);assert.match(String(h.last('error')?.message),/cannot be cancelled/);
  finish();await diff;assert.equal(h.last('busy')?.busy,false);h.host.dispose();
});

test('History cancels startup acquisition without consuming its late page and can refresh afterward',async()=>{
  let pins=0,entered!:()=>void,finish!:(value:unknown)=>void,signal:AbortSignal|undefined;
  const started=new Promise<void>(resolve=>{entered=resolve;}),pending=new Promise(resolve=>{finish=resolve;});
  const h=harness({pin:async(_id:string,_ref:string,_filters:unknown,readSignal:AbortSignal)=>{pins++;if(pins===1){signal=readSignal;entered();return pending;}return{tips:[oid(2)],filters:{}};},page:async(query:{tips:string[]})=>({commits:[commit(Number(query.tips[0]))],offset:0,nextOffset:1,hasMore:false}),checkPinnedQuery:()=>undefined},async()=>undefined,'');
  await started;await h.send({type:'cancel'});assert.equal(signal!.aborted,true);assert.equal(h.last('page'),undefined);finish({tips:[oid(99)],filters:{}});await h.send({type:'ready'});
  assert.equal(pins,2);assert.equal((h.last('page')?.commits as {oid:string}[])[0]!.oid,oid(2));h.host.dispose();
});

test('History copy actions read only what they copy',async()=>{
  let detailsReads=0;const messages:string[]=[];
  const h=harness({pin:async()=>({tips:[oid(1)],filters:{}}),checkPinnedQuery:()=>undefined,page:async()=>({commits:[commit(1)],offset:0,nextOffset:1,hasMore:false}),
    details:async()=>{detailsReads++;throw new Error('Copying must not build the five-read details view.');},message:async(_id:string,hash:string)=>{messages.push(hash);return `Message of ${hash.slice(-2)}\n\nBody`;}},async()=>undefined,'');
  try{
    await h.send({type:'ready'});
    await h.send({type:'copy',oid:oid(1),field:'message'});await h.send({type:'copy',oid:oid(1),field:'hash'});
    assert.deepEqual(h.clipboard,['Message of 01\n\nBody',oid(1)]);assert.deepEqual(messages,[oid(1)]);assert.equal(detailsReads,0);
    await h.send({type:'copy',oid:oid(2),field:'message'});assert.equal(h.clipboard.length,2,'only a loaded commit can be copied');assert.match(String(h.last('error')?.message),/loaded commit/);
  }finally{h.host.dispose();}
});

test('History details do not wait for or fail on containing refs',async()=>{
  const lookups:{oid:string;resolve:(refs:string[])=>void;reject:(error:Error)=>void;signal:AbortSignal}[]=[];
  const h=harness({pin:async()=>({tips:[oid(1)],filters:{}}),checkPinnedQuery:()=>undefined,page:async()=>({commits:[commit(1),commit(2)],offset:0,nextOffset:2,hasMore:false}),
    details:async(_id:string,hash:string)=>({commit:{...commit(Number(hash.slice(-2))),oid:hash},parent:undefined,message:'subject',files:[],stats:[]}),
    containingRefs:(_id:string,hash:string,signal:AbortSignal)=>new Promise<string[]>((resolve,reject)=>lookups.push({oid:hash,resolve,reject,signal}))},async()=>undefined,'');
  const settle=()=>new Promise(resolve=>setImmediate(resolve));
  try{
    await h.send({type:'ready'});await h.send({type:'select',oid:oid(1),parent:0});await settle();
    assert.equal((h.last('details')?.details as Record<string,unknown>).refs,undefined,'details are posted before the refs lookup finishes');
    assert.equal(h.last('busy')?.busy,false,'the slow lookup does not keep the panel busy');assert.equal(lookups.length,1);
    lookups[0]!.reject(new Error('Git read timed out after 15000 ms.'));await settle();
    assert.deepEqual({oid:h.last('refs')?.oid,error:h.last('refs')?.refsError},{oid:oid(1),error:'Git read timed out after 15000 ms.'});
    assert.equal(h.last('error'),undefined,'a failed lookup is not a details error');
    // A recreated renderer gets the stored details with the outcome.
    const before=h.sent.length;await h.send({type:'ready'});
    assert.equal((h.sent.slice(before).find(value=>value.type==='details')?.details as Record<string,unknown>).refsError,'Git read timed out after 15000 ms.');
    // Selecting another commit leaves the older lookup's result unposted.
    await h.send({type:'select',oid:oid(2),parent:0});await settle();assert.equal(lookups.length,2);
    await h.send({type:'select',oid:oid(1),parent:0});await settle();assert.equal(lookups.length,3);assert.ok(lookups[1]!.signal.aborted,'a newer selection stops the older lookup');
    const posted=h.sent.filter(value=>value.type==='refs').length;lookups[1]!.resolve(['refs/heads/stale']);await settle();assert.equal(h.sent.filter(value=>value.type==='refs').length,posted);
    lookups[2]!.resolve(['refs/heads/main']);await settle();assert.deepEqual({oid:h.last('refs')?.oid,refs:h.last('refs')?.refs},{oid:oid(1),refs:['refs/heads/main']});
  }finally{h.host.dispose();}
});
