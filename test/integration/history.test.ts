import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fixture, gitExecutable } from '../fixtures/repository-fixture';
import { PathPolicy } from '../../src/security/paths';
import { GitExecutor } from '../../src/git/git-executor';
import { RepositoryRegistry } from '../../src/repositories/repository-registry';
import { RepositoryStore } from '../../src/state/repository-store';
import { Emitter } from '../../src/utils/events';
import { silentLogger } from '../../src/utils/logging';
import { HistoryService } from '../../src/git/history/history.service';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseHistory } from '../../src/git/history/history-parser';
import { GitFailure } from '../../src/git/git-error-parser';

async function historyFixture(isolatedHistoryExecutor=false) {
  const f = await fixture(); let trusted=true;const policy = new PathPolicy(() => [f.parent], () => trusted);
  const executor = new GitExecutor(gitExecutable, policy, silentLogger, undefined, f.env);
  const store = new RepositoryStore(); const registry = new RepositoryRegistry(policy, executor, store, silentLogger, 60_000);
  const event = new Emitter<void>(); await registry.sync([{ root: f.root, onDidChange: event.event }]);
  const historyExecutor=isolatedHistoryExecutor?new GitExecutor(gitExecutable,policy,silentLogger,undefined,f.env):executor;
  const service = new HistoryService(registry, historyExecutor, policy); const id = registry.active!.id;
  const commit = async (name: string, content: string, message: string) => { await writeFile(path.join(f.root, name), content); f.git(['add', '--', name]); f.git(['commit', '-m', message]); return f.git(['rev-parse', 'HEAD']).trim(); };
  const close = async () => { service.dispose(); registry.dispose(); historyExecutor.dispose(); executor.dispose(); event.dispose(); store.dispose(); await f.cleanup(); };
  return { ...f, service, id, registry, executor:historyExecutor, event, commit, close,setTrusted:(value:boolean)=>{trusted=value;} };
}
async function seedPrefetchFixture(f:Awaited<ReturnType<typeof historyFixture>>,subjectBytes=0,skewedDates=false){
 const input:string[]=[];for(let i=1;i<=600;i++){
  const subject=subjectBytes?'s'.repeat(subjectBytes):i===300?'café':`commit ${i}`;
  const timestamp=1700000000+(skewedDates&&i%2?600-i:i);
  input.push(`commit refs/heads/main\nmark :${i}\ncommitter Fixture <fixture@example.invalid> ${timestamp} +0000\ndata ${Buffer.byteLength(subject)}\n${subject}\n${i>1?`from :${i-1}\n`:''}\n`);
 }input.push('done\n');const seeded=spawnSync(gitExecutable,['fast-import','--quiet'],{cwd:f.root,env:f.env,input:input.join(''),windowsHide:true,shell:false,timeout:20000});assert.equal(seeded.status,0,seeded.stderr?.toString());
}

test('verified linear first page equals topo metadata with skewed dates and excludes filters, multiple refs and offsets',async()=>{
  const f=await historyFixture(true);try{
    await seedPrefetchFixture(f,0,true);f.git(['reset','--hard','HEAD']);
    const q=await f.service.pin(f.id),read=f.executor.read.bind(f.executor),expected=parseHistory((await read(f.root,{kind:'history',tips:q.tips,offset:0,limit:101})).stdout),kinds:string[]=[];
    f.executor.read=async(root,c,o)=>{kinds.push(c.kind);return read(root,c,o);};
    const first=await f.service.page(q);assert.deepEqual(first.commits,expected.slice(0,100));assert.equal(first.hasMore,true);assert.equal(first.nextOffset,100);assert.deepEqual(kinds,['historyLinearPrefix']);
    const filtered=await f.service.pin(f.id,'HEAD',{author:'Fixture'});kinds.length=0;assert.deepEqual((await f.service.page(filtered)).commits,first.commits);assert.deepEqual(kinds,['history']);
    const multi=await f.service.pin(f.id,'HEAD\nmain');kinds.length=0;assert.deepEqual((await f.service.page(multi)).commits,first.commits);assert.deepEqual(kinds,['history']);
    kinds.length=0;const later=await f.service.page(q,100);assert.equal(later.commits.length,100);assert.deepEqual(kinds,['history']);
    const pinned=q.tips[0];await f.commit('new.txt','new','outside pin');kinds.length=0;assert.equal((await f.service.page(q)).commits[0]!.oid,pinned);assert.deepEqual(kinds,['historyLinearPrefix']);
  }finally{await f.close();}
});

test('merge prefixes retain exact topo order while a merge beyond the verified displayed boundary remains lazy',async()=>{
  const f=await historyFixture(true);try{
    await f.commit('base.txt','base','base');f.git(['checkout','-b','feature']);await f.commit('side.txt','side','side');f.git(['checkout','main']);await f.commit('main.txt','main','main');f.git(['merge','--no-ff','--no-edit','feature']);
    const merge=f.git(['rev-parse','HEAD']).trim(),read=f.executor.read.bind(f.executor),q=await f.service.pin(f.id),expected=parseHistory((await read(f.root,{kind:'history',tips:q.tips,offset:0,limit:101})).stdout),kinds:string[]=[];
    f.executor.read=async(root,c,o)=>{kinds.push(c.kind);return read(root,c,o);};assert.deepEqual((await f.service.page(q)).commits,expected);assert.deepEqual(kinds,['historyLinearPrefix','history']);
    for(let n=0;n<3;n++)await f.commit('after.txt',String(n),'after '+n);
    const after=await f.service.pin(f.id);kinds.length=0;const page=await f.service.page(after,0,undefined,3);assert.equal(page.commits.length,3);assert.equal(page.commits[2]!.parents[0],merge);assert.equal(page.hasMore,true);assert.deepEqual(kinds,['historyLinearPrefix']);
    kinds.length=0;const withMerge=await f.service.page(after,0,undefined,4);assert.equal(withMerge.commits[3]!.oid,merge);assert.equal(withMerge.commits[3]!.parents.length,2);assert.deepEqual(kinds,['historyLinearPrefix','history']);
  }finally{await f.close();}
});

test('linear prefix cannot publish after abort, revoked trust or repository removal',async()=>{
  const f=await historyFixture(true);try{
    await f.commit('tracked.txt','one','first');const read=f.executor.read.bind(f.executor);
    for(const transition of ['abort','trust','close'] as const){
      f.executor.read=read;f.setTrusted(true);await f.registry.sync([{root:f.root,onDidChange:f.event.event}]);const q=await f.service.pin(f.id),controller=new AbortController();
      f.executor.read=async(root,c,o)=>{const result=await read(root,c,o);if(c.kind==='historyLinearPrefix'){if(transition==='abort')controller.abort();else if(transition==='trust')f.setTrusted(false);else await f.registry.sync([]);}return result;};
      await assert.rejects(f.service.page(q,0,controller.signal),transition==='abort'?/cancelled/:transition==='trust'?/trusted/:/no longer open/);
    }
  }finally{f.setTrusted(true);await f.close();}
});

test('unusable speculative metadata falls back while original page failures and read interruption remain errors',async()=>{
  const f=await historyFixture(true);try{
    await f.commit('tracked.txt','one','first');const read=f.executor.read.bind(f.executor),q=await f.service.pin(f.id),expected=parseHistory((await read(f.root,{kind:'history',tips:q.tips,offset:0,limit:101})).stdout),kinds:string[]=[];
    for(const failure of ['malformed','utf8','output-limit'] as const){
      kinds.length=0;f.executor.read=async(root,c,o)=>{kinds.push(c.kind);if(c.kind==='historyLinearPrefix'&&failure==='output-limit')throw new GitFailure('output-limit','Speculative output exceeded the bound.');const result=await read(root,c,o);return c.kind==='historyLinearPrefix'?{...result,stdout:failure==='malformed'?Buffer.from('truncated'):Buffer.from([0xff])}:result;};
      assert.deepEqual((await f.service.page(q)).commits,expected);assert.deepEqual(kinds,['historyLinearPrefix','history']);
    }
    kinds.length=0;f.executor.read=async(root,c,o)=>{kinds.push(c.kind);const result=await read(root,c,o);return {...result,stdout:Buffer.from('truncated')};};
    await assert.rejects(f.service.page(q),/Truncated/);assert.deepEqual(kinds,['historyLinearPrefix','history'],'The original requested page still rejects malformed metadata');
    for(const kind of ['timeout','cancelled','repository'] as const){
      kinds.length=0;const failure=new GitFailure(kind,'Read failed.');f.executor.read=async()=>{kinds.push('historyLinearPrefix');throw failure;};
      await assert.rejects(f.service.page(q),error=>error===failure);assert.deepEqual(kinds,['historyLinearPrefix']);
    }
    for(const transition of ['abort','trust','close'] as const){
      f.executor.read=read;f.setTrusted(true);await f.registry.sync([{root:f.root,onDidChange:f.event.event}]);const owned=await f.service.pin(f.id),controller=new AbortController();kinds.length=0;
      f.executor.read=async()=>{kinds.push('historyLinearPrefix');if(transition==='abort')controller.abort();else if(transition==='trust')f.setTrusted(false);else await f.registry.sync([]);throw new GitFailure('output-limit','Speculative output exceeded the bound.');};
      await assert.rejects(f.service.page(owned,0,controller.signal),transition==='abort'?/cancelled/:transition==='trust'?/trusted/:/no longer open/);assert.deepEqual(kinds,['historyLinearPrefix']);
    }
  }finally{f.setTrusted(true);await f.close();}
});

test('fresh History pins avoid status scans for committed, detached, named and multiple refs',async()=>{
  const f=await historyFixture(true);try{
    const first=await f.commit('tracked.txt','one','first'),read=f.executor.read.bind(f.executor),kinds:string[]=[];
    f.executor.read=async(root,c,o)=>{kinds.push(c.kind);return read(root,c,o);};
    assert.deepEqual((await f.service.pin(f.id)).tips,[first]);assert.deepEqual(kinds,['historyHead']);
    f.git(['branch','topic']);kinds.length=0;assert.deepEqual((await f.service.pin(f.id,'topic')).tips,[first]);assert.deepEqual(kinds,['ref']);
    kinds.length=0;const multi=await f.service.pin(f.id,'HEAD\ntopic');assert.deepEqual(multi.tips,[first]);assert.deepEqual(kinds,['ref','ref']);assert.equal(multi.refs?.length,2);
    const second=await f.commit('tracked.txt','two','second');kinds.length=0;assert.deepEqual((await f.service.pin(f.id)).tips,[second]);assert.deepEqual(kinds,['historyHead']);
    f.git(['checkout','--detach',first]);kinds.length=0;assert.deepEqual((await f.service.pin(f.id)).tips,[first]);assert.deepEqual(kinds,['historyHead']);
  }finally{await f.close();}
});

test('unborn History requires explicit porcelain initial evidence and handles a concurrently created HEAD',async()=>{
  const f=await historyFixture(true);try{
    const read=f.executor.read.bind(f.executor),kinds:string[]=[];
    f.executor.read=async(root,c,o)=>{kinds.push(c.kind);return read(root,c,o);};
    assert.deepEqual((await f.service.pin(f.id)).tips,[]);assert.deepEqual(kinds,['historyHead','status']);
    let created:string|undefined;f.executor.read=async(root,c,o)=>{const result=await read(root,c,o);if(c.kind==='historyHead'&&!result.stdout.length)created=await f.commit('new.txt','new','concurrent');return result;};
    assert.deepEqual((await f.service.pin(f.id)).tips,[created]);assert.ok(created);
  }finally{await f.close();}
});

test('History HEAD errors remain errors instead of silently becoming an unborn page',async()=>{
  const f=await historyFixture();try{
    await f.commit('tracked.txt','one','first');const head=path.join(f.registry.active!.gitDir,'HEAD');
    await writeFile(head,'malformed HEAD\n');await assert.rejects(f.service.pin(f.id));
    await writeFile(head,'f'.repeat(40)+'\n');await assert.rejects(f.service.pin(f.id));
    await writeFile(head,'ref: refs/heads/main\n');assert.equal((await f.service.pin(f.id)).tips.length,1);
    const read=f.executor.read.bind(f.executor);f.executor.read=async(root,c,o)=>c.kind==='status'?{stdout:Buffer.from('# branch.head main\0'),stderr:Buffer.alloc(0),exitCode:0,durationMs:0}:c.kind==='historyHead'?{stdout:Buffer.alloc(0),stderr:Buffer.alloc(0),exitCode:1,durationMs:0}:read(root,c,o);
    await assert.rejects(f.service.pin(f.id),/Unable to resolve/);
  }finally{await f.close();}
});

test('fresh HEAD pin cannot publish after cancellation, trust loss or repository removal',async()=>{
  const f=await historyFixture();try{
    await f.commit('tracked.txt','one','first');const read=f.executor.read.bind(f.executor);
    for(const transition of ['abort','trust','close'] as const){
      f.executor.read=read;f.setTrusted(true);await f.registry.sync([{root:f.root,onDidChange:f.event.event}]);const controller=new AbortController();
      f.executor.read=async(root,c,o)=>{const result=await read(root,c,o);if(c.kind==='historyHead'){if(transition==='abort')controller.abort();else if(transition==='trust')f.setTrusted(false);else await f.registry.sync([]);}return result;};
      await assert.rejects(f.service.pin(f.id,'HEAD',{},controller.signal),transition==='abort'?/cancelled/:transition==='trust'?/trusted/:/no longer open/);
    }
    f.executor.read=read;f.setTrusted(true);
  }finally{f.setTrusted(true);await f.close();}
});

test('prefetched non-UTF8 metadata defers to an ordinary page without hiding requested-page errors',async()=>{
 // Its own executor: the registry's watcher-driven status read after seeding must not land among the recorded History reads.
 const f=await historyFixture(true);try{
  await seedPrefetchFixture(f);f.git(['config','i18n.logOutputEncoding','ISO-8859-1']);const q=await f.service.pin(f.id),read=f.executor.read.bind(f.executor),kinds:string[]=[];
  f.executor.read=async(root,c,o)=>{kinds.push(c.kind);return read(root,c,o);};
  const expected=await f.service.page(q,0);kinds.length=0;const actual=await f.service.window(q,0);assert.deepEqual(actual,expected);assert.deepEqual(kinds,['historyWindow','historyLinearPrefix']);assert.equal(actual.commits.length,100);assert.equal(actual.nextOffset,100);assert.equal(actual.hasMore,true);
  assert.deepEqual(await f.service.window(q,100),await f.service.page(q,100));
  const small=await f.service.window(q,274,undefined,25);assert.deepEqual(small,await f.service.page(q,274,undefined,25));assert.equal(small.commits.length,25);
  assert.deepEqual(await f.service.window(q,175,undefined,150),await f.service.page(q,175));
  assert.deepEqual(await f.service.window(q,250,undefined,500,25),await f.service.page(q,250,undefined,25));
  assert.deepEqual(await f.service.window(q,274,undefined,500,25),await f.service.page(q,274,undefined,25));
  await assert.rejects(f.service.window(q,275,undefined,500,25),TypeError);
  await assert.rejects(f.service.window(q,0,undefined,500,0),/Invalid/);await assert.rejects(f.service.window(q,0,undefined,500,101),/Invalid/);
  await assert.rejects(f.service.window(q,275,undefined,25),TypeError); // Preserve the25-row page's lookahead error too.
  await assert.rejects(f.service.window(q,200),TypeError); // Bad metadata is the ordinary100-row page's lookahead.
  await assert.rejects(f.service.window(q,300),TypeError); // Bad metadata is requested, not merely prefetched.
  f.git(['config','i18n.logOutputEncoding','UTF-8']);kinds.length=0;const valid=await f.service.window(q,0);assert.equal(valid.commits.length,500);assert.deepEqual(kinds,['historyWindow']);assert.equal(valid.commits[300]!.subject,'café');
 }finally{await f.close();}
});

for(const failure of ['metadata','output-limit'] as const)test(`History ${failure} fallback rechecks abort, trust and repository after the smaller read`,async()=>{
 const f=await historyFixture();try{
  await seedPrefetchFixture(f,failure==='output-limit'?12000:0);if(failure==='metadata')f.git(['config','i18n.logOutputEncoding','ISO-8859-1']);const read=f.executor.read.bind(f.executor);
  for(const transition of ['abort','trust','close'] as const){
   f.executor.read=read;f.setTrusted(true);await f.registry.sync([{root:f.root,onDidChange:f.event.event}]);const q=await f.service.pin(f.id),controller=new AbortController();let smallReads=0,windowFailures=0;
   f.executor.read=async(root,c,o)=>{
    let result;try{result=await read(root,c,o);}catch(error){if(c.kind==='historyWindow'&&(error as {kind?:string}).kind==='output-limit')windowFailures++;throw error;}
    if(c.kind==='history'||c.kind==='historyLinearPrefix'){smallReads++;if(transition==='abort')controller.abort();else if(transition==='trust')f.setTrusted(false);else await f.registry.sync([]);}return result;
   };
   await assert.rejects(f.service.window(q,0,controller.signal),transition==='abort'?/cancelled/:transition==='trust'?/trusted/:/no longer open/);assert.equal(smallReads,1);assert.equal(windowFailures,failure==='output-limit'?1:0);
  }
  f.executor.read=read;f.setTrusted(true);
 }finally{f.setTrusted(true);await f.close();}
});

test('on-demand History window is bounded and fresh after replace/config/shallow/graft changes',async()=>{
 const f=await historyFixture();try{
  const root=await f.commit('a.txt','a','root'),middle=await f.commit('a.txt','b','middle');await f.commit('a.txt','c','tip');const q=await f.service.pin(f.id);
  const fresh=async()=>{const w=await f.service.window(q,0,undefined,500);assert.deepEqual(w.commits,parseHistory((await f.executor.read(f.root,{kind:'history',tips:q.tips,offset:0,limit:101,filters:q.filters})).stdout));return w;};
  await fresh();f.git(['checkout','-b','replacement',root]);const replacement=await f.commit('r.txt','r','replacement subject');f.git(['checkout','main']);f.git(['replace',middle,replacement]);assert.ok((await fresh()).commits.some(c=>c.subject==='replacement subject'));f.git(['pack-refs','--all']);await fresh();f.git(['replace','-d',middle]);await fresh();f.git(['config','log.showSignature','true']);await fresh();
  const {unlink,mkdir}=await import('node:fs/promises'),common=f.registry.active!.commonDir,shallow=path.join(common,'shallow'),grafts=path.join(common,'info','grafts');await writeFile(shallow,middle+'\n');assert.equal((await fresh()).commits.length,2);await unlink(shallow);await mkdir(path.dirname(grafts),{recursive:true});await writeFile(grafts,middle+'\n');assert.equal((await fresh()).commits.length,2);await unlink(grafts);assert.equal((await fresh()).commits.length,3);
  const small=await f.service.window(q,1,undefined,1);assert.equal(small.commits.length,1);assert.equal(small.hasMore,true);assert.equal(small.nextOffset,2);await assert.rejects(f.service.window(q,-1));await assert.rejects(f.service.window(q,0,undefined,501));await assert.rejects(f.service.window({...q},0),/expired/);await assert.rejects(f.service.window(await f.service.pin(f.id,'HEAD',{path:'a.txt',follow:true}),0));const controller=new AbortController();controller.abort();await assert.rejects(f.service.window(q,0,controller.signal),/cancelled/);await f.registry.sync([]);await assert.rejects(f.service.window(q,0),/no longer open/);
 }finally{await f.close();}
});
test('pinned paginated history excludes new commits and literal filters preserve topology', async () => {
  const f = await historyFixture();
  try {
    assert.equal((await f.service.page(await f.service.pin(f.id))).commits.length, 0);
    const root = await f.commit('日本語 [1].txt', 'one\n', 'root [literal]');
    const middle = await f.commit('日本語 [1].txt', 'one\ntwo\n', 'middle');
    const tip = await f.commit('other.txt', 'three\n', 'tip'); const query = await f.service.pin(f.id);
    const first = await f.service.page(query, 0, undefined, 2); assert.equal(first.hasMore, true); assert.deepEqual(first.commits.map(c => c.oid), [tip, middle]);
    await f.commit('new.txt', 'new\n', 'new outside snapshot');
    const next = await f.service.page(query, first.nextOffset, undefined, 2); assert.deepEqual(next.commits.map(c => c.oid), [root]); assert.equal(next.hasMore, false);
    const filtered = await f.service.page(await f.service.pin(f.id, 'HEAD', { text: '[literal]', path: '日本語 [1].txt', author: 'Fixture' }));
    assert.deepEqual(filtered.commits.map(c => c.oid), [root]);
    const controller = new AbortController(); controller.abort(); await assert.rejects(f.service.page(query, 0, controller.signal), /cancelled/);
  } finally { await f.close(); }
});
test('merge details select parent; root/binary/rename comparisons retain exact outcomes', async () => {
  const f = await historyFixture();
  try {
    const root = await f.commit('old file.txt', 'first\nsecond\n', 'root');
    const rootDetails = await f.service.details(f.id, root); assert.equal(rootDetails.parent, undefined); assert.equal(rootDetails.files[0]?.path, 'old file.txt');
    f.git(['checkout', '-b', 'feature']); const feature = await f.commit('feature.txt', 'feature\n', 'feature');
    f.git(['checkout', 'main']); const main = await f.commit('main.txt', 'main\n', 'main');
    const sides=await f.service.compare(f.id,'main','feature');assert.equal(sides.leftCount,1);assert.equal(sides.rightCount,1);assert.deepEqual(sides.leftCommits.map(commit=>commit.oid),[main]);assert.deepEqual(sides.rightCommits.map(commit=>commit.oid),[feature]);
    const equal=await f.service.compare(f.id,main,main);assert.equal(equal.leftCount,0);assert.equal(equal.rightCount,0);assert.equal(equal.files.length,0);
    f.git(['merge', '--no-ff', '--no-edit', 'feature']); const merge = f.git(['rev-parse', 'HEAD']).trim();
    const first = await f.service.details(f.id, merge, 0); const second = await f.service.details(f.id, merge, 1);
    assert.equal(first.parent, main); assert.equal(second.parent, feature); assert.equal(first.files[0]?.path, 'feature.txt'); assert.equal(second.files[0]?.path, 'main.txt');
    await assert.rejects(f.service.details(f.id, merge, 2), /parent/);
    f.git(['mv', 'old file.txt', 'new file.txt']); await writeFile(path.join(f.root, 'binary.bin'), Buffer.from([0, 1, 2])); f.git(['add', '--', 'binary.bin']); f.git(['commit', '-m', 'rename + binary']);
    const result = await f.service.compare(f.id, merge, 'HEAD');
    assert.equal(result.files.find(file => file.path === 'new file.txt')?.originalPath, 'old file.txt');
    assert.equal(result.stats.find(file => file.path === 'binary.bin')?.added, null);
    const refs = await f.service.containingRefs(f.id, root); assert.ok(refs.includes('refs/heads/main'));
  } finally { await f.close(); }
});
test('single-commit Details metadata preserves merge, replace and shallow semantics without stale caching',async()=>{
  const f=await historyFixture();try{
    const root=await f.commit('file.txt','base\n','root 日本語\n\nbody'),normal=await f.commit('file.txt','base\nnext\n','ordinary');
    const compare=async(oid:string)=>{const old=await f.executor.read(f.root,{kind:'history',tips:[oid],offset:0,limit:1}),next=await f.executor.read(f.root,{kind:'commitMetadata',oid});assert.deepEqual(next.stdout,old.stdout);};
    await compare(root);await compare(normal);f.git(['checkout','-b','side']);const side=await f.commit('side.txt','side\n','side');f.git(['checkout','main']);const main=await f.commit('main.txt','main\n','main');f.git(['merge','--no-ff','--no-edit','side']);const merge=f.git(['rev-parse','HEAD']).trim();await compare(merge);
    assert.equal((await f.service.details(f.id,merge,0)).parent,main);assert.equal((await f.service.details(f.id,merge,1)).parent,side);
    f.git(['checkout','-b','replacement',root]);const replacement=await f.commit('replacement.txt','replacement\n','replacement subject');f.git(['checkout','main']);f.git(['replace',normal,replacement]);await compare(normal);assert.equal((await f.service.details(f.id,normal)).commit.subject,'replacement subject');f.git(['replace','-d',normal]);assert.equal((await f.service.details(f.id,normal)).commit.subject,'ordinary');
    const shallow=path.join(f.parent,'shallow with spaces');f.git(['clone','--no-local','--depth=1','--branch','main',pathToFileURL(f.root).href,shallow],f.parent);assert.equal(f.git(['rev-parse','--is-shallow-repository'],shallow).trim(),'true');
    await f.registry.sync([{root:shallow,onDidChange:f.event.event}]);const shallowId=f.registry.active!.id;const old=await f.executor.read(shallow,{kind:'history',tips:[merge],offset:0,limit:1}),next=await f.executor.read(shallow,{kind:'commitMetadata',oid:merge});assert.deepEqual(next.stdout,old.stdout);assert.equal((await f.service.details(shallowId,merge)).parent,undefined);
    const controller=new AbortController();controller.abort();await assert.rejects(f.service.details(shallowId,merge,0,controller.signal),/cancelled/);
    const blob=f.git(['rev-parse',merge+':file.txt'],shallow).trim();await assert.rejects(f.service.details(shallowId,blob));await assert.rejects(f.service.details(shallowId,'HEAD'));
    await f.registry.sync([]);await assert.rejects(f.service.details(shallowId,merge),/no longer open/);
  }finally{await f.close();}
});
test('active-line blame distinguishes committed and working text; closed repo rejects reads', async () => {
  const f = await historyFixture();
  try {
    const oid = await f.commit('file.txt', 'one\ntwo\n', 'root'); const line = await f.service.blame(f.id, 'file.txt', 1); assert.equal(line.oid, oid); assert.equal(line.content, 'one');
    await writeFile(path.join(f.root, 'file.txt'), 'changed\ntwo\n'); const working = await f.service.blame(f.id, 'file.txt', 1); assert.equal(working.uncommitted, true);
    assert.equal((await f.service.workingRevision(f.id,'file.txt')).toString(),'changed\ntwo\n');assert.equal((await f.service.workingRevision(f.id,'deleted.txt')).length,0);
    await assert.rejects(f.service.workingRevision(f.id,'.git/config'),/metadata/);await writeFile(path.join(f.root,'binary.bin'),Buffer.from([0,1]));await assert.rejects(f.service.workingRevision(f.id,'binary.bin'),/Binary/);
    await assert.rejects(f.service.blame(f.id, '../outside', 1), /Invalid/);
    const query = await f.service.pin(f.id); await f.registry.sync([]); await assert.rejects(f.service.page(query), /no longer open/);
    await assert.rejects(f.service.workingRevision(f.id,'file.txt'),/no longer open/);
  } finally { await f.close(); }
});

test('comparison pages traverse pinned unique commits without following moved refs',{timeout:60_000},async()=>{
  const f=await historyFixture();try{
    await f.commit('file.txt','base\n','base');const base=f.git(['rev-parse','HEAD']).trim(),baseTimestamp=Number(f.git(['show','-s','--format=%ct',base]).trim());assert.ok(Number.isSafeInteger(baseTimestamp));
    // Batch fixture construction: the assertions still exercise real pinned comparison reads.
    const imported:string[]=[];for(let index=0;index<57;index++){
      const content=`${index}\n`,message=`unique ${index}`;
      imported.push(`blob\nmark :${index+58}\ndata ${Buffer.byteLength(content)}\n${content}\ncommit refs/heads/main\nmark :${index+1}\ncommitter Fixture <fixture@example.invalid> ${baseTimestamp+index+1} +0000\ndata ${Buffer.byteLength(message)}\n${message}\nfrom ${index===0?base:`:${index}`}\nM 100644 :${index+58} file.txt\n\n`);
    }
    imported.push('done\n');const seeded=spawnSync(gitExecutable,['fast-import','--quiet'],{cwd:f.root,env:f.env,input:imported.join(''),encoding:'utf8',windowsHide:true,shell:false,timeout:20_000});assert.equal(seeded.status,0,`${seeded.error??''}\n${seeded.stderr}`);f.git(['reset','--hard']);
    const expected=f.git(['rev-list',`${base}..HEAD`]).trim().split('\n');assert.equal(expected.length,57);assert.equal(f.git(['log','-1','--format=%s']).trim(),'unique 56');assert.equal(f.git(['show',`${expected.at(-1)}:file.txt`]),'0\n');
    const comparison=await f.service.compare(f.id,'main',base);assert.equal(comparison.leftCount,57);assert.equal(comparison.leftCommits.length,25);assert.equal(comparison.rightCount,0);
    await f.commit('file.txt','outside\n','outside pinned side');
    const second=await f.service.comparisonPage(f.id,comparison.from,comparison.to,25),last=await f.service.comparisonPage(f.id,comparison.from,comparison.to,50);
    assert.deepEqual([...comparison.leftCommits,...second,...last].map(commit=>commit.oid),expected);assert.equal(last.length,7);assert.equal(new Set(expected).size,57);
    assert.equal((await f.service.comparisonPage(f.id,comparison.to,comparison.from,0)).length,0);await assert.rejects(f.service.comparisonPage(f.id,comparison.from,comparison.to,-25),/Invalid/);
  }finally{await f.close();}
});
test('comparison counts and pinned pages agree when descendants predate their ancestor by years',async()=>{
  const f=await historyFixture();try{
    const input=['blob\nmark :500\ndata 5\nbase\n\ncommit refs/heads/main\nmark :1\ncommitter Fixture <fixture@example.invalid> 1900000000 +0000\ndata 4\nbase\nM 100644 :500 file.txt\n\n'];
    for(let index=0;index<57;index++){const content=`${index}\n`,message=`skew ${index}`;input.push(`blob\nmark :${501+index}\ndata ${Buffer.byteLength(content)}\n${content}\ncommit refs/heads/main\nmark :${index+2}\ncommitter Fixture <fixture@example.invalid> ${1700000000+index} +0000\ndata ${Buffer.byteLength(message)}\n${message}\nfrom :${index+1}\nM 100644 :${501+index} file.txt\n\n`);}
    input.push('done\n');const imported=spawnSync(gitExecutable,['fast-import','--quiet'],{cwd:f.root,env:f.env,input:input.join(''),encoding:'utf8',windowsHide:true,shell:false,timeout:20_000});assert.equal(imported.status,0,`${imported.error??''}\n${imported.stderr}`);f.git(['reset','--hard']);
    const tip=f.git(['rev-parse','HEAD']).trim(),base=f.git(['rev-parse','HEAD~57']).trim(),expected=f.git(['rev-list','--topo-order',tip]).trim().split('\n').filter(oid=>oid!==base);assert.equal(expected.length,57);
    const result=await f.service.compare(f.id,tip,base);assert.equal(result.leftCount,57);assert.equal(result.rightCount,0);assert.deepEqual(result.rightCommits,[]);assert.equal(result.leftCommits.length,25);
    await f.commit('file.txt','moved\n','outside pinned skew comparison');const middle=await f.service.comparisonPage(f.id,result.from,result.to,25),last=await f.service.comparisonPage(f.id,result.from,result.to,50);
    assert.deepEqual([...result.leftCommits,...middle,...last].map(commit=>commit.oid),expected);assert.equal(last.length,7);assert.equal(new Set(expected).size,57);
    const reverse=await f.service.compare(f.id,base,tip);assert.equal(reverse.leftCount,0);assert.deepEqual(reverse.leftCommits,[]);assert.equal(reverse.rightCount,57);assert.deepEqual(reverse.rightCommits.map(commit=>commit.oid),expected.slice(0,25));
    assert.deepEqual(await f.service.comparisonPage(f.id,base,tip,0),[]);const equal=await f.service.compare(f.id,tip,tip);assert.equal(equal.leftCount,0);assert.equal(equal.rightCount,0);assert.deepEqual(equal.leftCommits,[]);assert.deepEqual(equal.rightCommits,[]);
  }finally{await f.close();}
});
test('file history follows exact rename paths across pages and revision reads preserve both sides', async () => {
  const f = await historyFixture();
  try {
    const root = await f.commit('old.txt', 'first\nsecond\n', 'root');
    f.git(['mv', 'old.txt', 'new.txt']); f.git(['commit', '-m', 'rename']); const rename = f.git(['rev-parse', 'HEAD']).trim();
    const tip = await f.commit('new.txt', 'first\nsecond\nthird\n', 'edit');
    const query = await f.service.pin(f.id, 'HEAD', {path:'new.txt',follow:true});
    const first = await f.service.filePage(query, 0, 'new.txt', undefined, 2);
    assert.deepEqual(first.paths, [{oid:tip,path:'new.txt'},{oid:rename,path:'new.txt'}]); assert.equal(first.nextPath,'new.txt');
    const second = await f.service.filePage(first.nextQuery, first.nextOffset, first.nextPath, undefined, 2);
    assert.deepEqual(second.paths,[{oid:root,path:'old.txt'}]);
    assert.equal((await f.service.revision(f.id,root,'old.txt')).toString(),'first\nsecond\n');
    assert.equal((await f.service.revision(f.id,tip,'new.txt')).toString(),'first\nsecond\nthird\n');
    assert.equal((await f.service.revision(f.id,root,'new.txt')).length,0);
    await assert.rejects(f.service.revision(f.id,root,'../outside'),/Invalid/);
    await f.commit('binary.bin', '\0binary', 'binary'); await assert.rejects(f.service.revision(f.id,f.git(['rev-parse','HEAD']).trim(),'binary.bin'),/Binary/);
  } finally { await f.close(); }
});

test('file history filters preserve old paths across hidden renames and search full message bodies',async()=>{
  const f=await historyFixture();try{
    const root=await f.commit('old [1].txt','one\n','root\n\nkeep in body');f.git(['mv','old [1].txt','new [1].txt']);f.git(['commit','-m','hidden rename']);
    const tip=await f.commit('new [1].txt','one\ntwo\n','keep tip'),query=await f.service.pin(f.id,'HEAD',{path:'new [1].txt',follow:true,text:'keep',author:'Fixture'});
    const first=await f.service.filePage(query,0,'new [1].txt',undefined,1);assert.deepEqual(first.paths,[{oid:tip,path:'new [1].txt'}]);assert.equal(first.hasMore,true);
    const second=await f.service.filePage(first.nextQuery,first.nextOffset,first.nextPath,undefined,1);assert.deepEqual(second.paths,[{oid:root,path:'old [1].txt'}]);assert.equal(second.hasMore,false);assert.equal((await f.service.revision(f.id,root,second.paths[0]!.path)).toString(),'one\n');
    const missing=await f.service.pin(f.id,'HEAD',{path:'new [1].txt',follow:true,text:'absent'});const none=await f.service.filePage(missing,0,'new [1].txt');assert.equal(none.commits.length,0);assert.equal(none.hasMore,false);
    const dated=await f.service.pin(f.id,'HEAD',{path:'new [1].txt',follow:true,from:'2099-01-01'});assert.equal((await f.service.filePage(dated,0,'new [1].txt')).commits.length,0);
  }finally{await f.close();}
});

test('all-parent file cursor preserves merge resolution, sibling pages and child-before-shared-root order',async()=>{
  const f=await historyFixture();try{
    const root=await f.commit('file.txt','base\n','base');f.git(['checkout','-b','feature']);const feature=await f.commit('file.txt','feature\n','feature');f.git(['checkout','main']);const main=await f.commit('file.txt','main\n','main');
    assert.throws(()=>f.git(['merge','--no-ff','--no-edit','feature']));await writeFile(path.join(f.root,'file.txt'),'resolved\n');f.git(['add','.']);f.git(['commit','-m','merge resolved']);const merge=f.git(['rev-parse','HEAD']).trim();
    let query=await f.service.pin(f.id,'HEAD',{path:'file.txt',follow:true}),offset=0,file='file.txt';const seen:string[]=[];
    for(let page=0;page<4;page++){const result=await f.service.filePage(query,offset,file,undefined,1);seen.push(...result.commits.map(commit=>commit.oid));if(!result.hasMore)break;query=result.nextQuery;offset=result.nextOffset;file=result.nextPath;}
    assert.equal(seen[0],merge);assert.equal(seen.at(-1),root);assert.deepEqual(new Set(seen),new Set([merge,main,feature,root]));assert.equal(seen.length,4);assert.equal((await f.service.revision(f.id,merge,'file.txt')).toString(),'resolved\n');
  }finally{await f.close();}
});

test('all-parent rename lineage pins both branches, filters after traversal and rejects forged/stale continuations',async()=>{
  const f=await historyFixture();try{
    const content=Array.from({length:120},(_,index)=>`line ${index}\n`).join(''),root=await f.commit('old [1].txt',content,'root\n\nkeep body');
    f.git(['checkout','-b','feature']);const side=await f.commit('old [1].txt',content.replace('line 100\n','side edit\n'),'side edit');f.git(['checkout','main']);f.git(['mv','old [1].txt','new [1].txt']);f.git(['commit','-m','hidden rename']);const rename=f.git(['rev-parse','HEAD']).trim();f.git(['merge','--no-ff','--no-edit','feature']);const merge=f.git(['rev-parse','HEAD']).trim();
    const initial=await f.service.pin(f.id,'HEAD',{path:'new [1].txt',follow:true});let query=initial,offset=0;const paths:{oid:string;path:string}[]=[];
    await f.commit('outside.txt','outside\n','outside pinned query');
    for(let index=0;index<5;index++){const page=await f.service.filePage(query,offset,'new [1].txt',undefined,1);paths.push(...page.paths);if(!page.hasMore)break;query=page.nextQuery;offset=page.nextOffset;}
    assert.deepEqual(new Set(paths.map(item=>item.oid)),new Set([merge,rename,side,root]));assert.equal(paths.at(-1)!.oid,root);assert.equal(paths.find(item=>item.oid===side)!.path,'old [1].txt');assert.equal(paths.length,4);
    const filtered=await f.service.pin(f.id,merge,{path:'new [1].txt',follow:true,text:'keep body',author:'Fixture'});assert.deepEqual((await f.service.filePage(filtered,0,'new [1].txt')).paths,[{oid:root,path:'old [1].txt'}]);
    await assert.rejects(f.service.filePage({...initial},0,'new [1].txt'),/not owned/);await assert.rejects(f.service.filePage(initial,1,'new [1].txt'),/offset changed/);await assert.rejects(f.service.filePage(initial,0,'old [1].txt'),/path changed/);
    const controller=new AbortController();controller.abort();await assert.rejects(f.service.filePage(initial,0,'new [1].txt',controller.signal),/cancelled/);assert.equal((await f.service.filePage(initial,0,'new [1].txt',undefined,1)).commits[0]!.oid,merge);
    await f.registry.sync([]);await assert.rejects(f.service.filePage(query,offset,'new [1].txt'),/no longer open/);
  }finally{await f.close();}
});

test('divergent parent rename sources with skewed dates converge once; add/delete stops file ancestry',async()=>{
  const f=await historyFixture();try{
    const content=Array.from({length:120},(_,index)=>`line ${index}\n`).join(''),root=await f.commit('old.txt',content,'root');Object.assign(f.env,{GIT_COMMITTER_DATE:'2020-01-01T00:00:00+00:00',GIT_AUTHOR_DATE:'2020-01-01T00:00:00+00:00'});
    f.git(['checkout','-b','left']);f.git(['mv','old.txt','left.txt']);f.git(['commit','-m','left rename']);const left=f.git(['rev-parse','HEAD']).trim();f.git(['checkout','-b','right',root]);f.git(['mv','old.txt','right.txt']);f.git(['commit','-m','right rename']);const right=f.git(['rev-parse','HEAD']).trim();f.git(['checkout','left']);assert.throws(()=>f.git(['merge','--no-ff','--no-edit','right']));f.git(['rm','-f','--','old.txt','left.txt','right.txt']);await writeFile(path.join(f.root,'merged.txt'),content);f.git(['add','--','merged.txt']);f.git(['commit','-m','merge names']);const merge=f.git(['rev-parse','HEAD']).trim();
    let query=await f.service.pin(f.id,'HEAD',{path:'merged.txt',follow:true}),offset=0;const paths:{oid:string;path:string}[]=[];
    for(let index=0;index<5;index++){const page=await f.service.filePage(query,offset,'merged.txt',undefined,1);paths.push(...page.paths);if(!page.hasMore)break;query=page.nextQuery;offset=page.nextOffset;}
    assert.equal(paths.at(-1)!.oid,root);assert.deepEqual(new Set(paths.map(item=>item.oid)),new Set([merge,left,right,root]));assert.equal(paths.find(item=>item.oid===left)!.path,'left.txt');assert.equal(paths.find(item=>item.oid===right)!.path,'right.txt');assert.equal(paths.length,4);
    const add=await f.commit('boundary.txt','one\n','add'),edit=await f.commit('boundary.txt','two\n','edit');f.git(['rm','--','boundary.txt']);f.git(['commit','-m','delete']);const deleted=f.git(['rev-parse','HEAD']).trim();
    const boundary=await f.service.filePage(await f.service.pin(f.id,'HEAD',{path:'boundary.txt',follow:true}),0,'boundary.txt');assert.deepEqual(boundary.commits.map(item=>item.oid),[deleted,edit,add]);assert.equal(boundary.hasMore,false);
  }finally{await f.close();}
});
test('active-line blame never runs the repository textconv program', async () => {
  const f = await historyFixture();
  try {
    const marker = path.join(f.parent, 'textconv-ran.txt').replace(/\\/g, '/');
    await writeFile(path.join(f.root, '.gitattributes'), '*.txt diff=probe\n'); await f.commit('file.txt', 'one\ntwo\n', 'root');
    f.git(['config', 'diff.probe.textconv', `sh -c 'echo ran >> "${marker}"; cat "$1"' -`]);
    await writeFile(path.join(f.root, 'file.txt'), 'one\nTWO\n');
    assert.equal((await f.service.blame(f.id, 'file.txt', 1)).content, 'one');
    assert.equal(await readFile(marker, 'utf8').catch(() => ''), '', 'the textconv program did not run');
  } finally { await f.close(); }
});
test('commit details too large to list keep metadata and say what was left out', async () => {
  const f = await historyFixture();
  try {
    const oid = await f.commit('file.txt', 'one\n', 'root'), read = f.executor.read.bind(f.executor);
    f.executor.read = async (root, command, options) => {
      if (command.kind === 'changedFiles' || command.kind === 'commitMessage') throw new GitFailure('output-limit', 'Git output exceeded the safe limit.');
      return read(root, command, options);
    };
    const details = await f.service.details(f.id, oid);
    assert.deepEqual({ message: details.message, files: details.files, stats: details.stats, filesOmitted: details.filesOmitted, messageOmitted: details.messageOmitted }, { message: 'root', files: [], stats: [], filesOmitted: true, messageOmitted: true });
    f.executor.read = async (root, command, options) => { if (command.kind === 'numstat') throw new GitFailure('timeout', 'Git read timed out.'); return read(root, command, options); };
    await assert.rejects(f.service.details(f.id, oid), /timed out/, 'other failures remain errors');
  } finally { await f.close(); }
});
