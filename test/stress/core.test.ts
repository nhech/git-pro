import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { advancedFixture } from '../fixtures/advanced-fixture';
import { gitExecutable } from '../fixtures/repository-fixture';
import { HistoryService, type HistoryPage } from '../../src/git/history/history.service';
import { PathPolicy } from '../../src/security/paths';
import { parseStatus } from '../../src/git/git-parser';
import { Emitter } from '../../src/utils/events';
test('isolated 100k commits, 10k refs, 5k files, 10 roots and event storm', {timeout:300_000},async()=>{
  const f=await advancedFixture();const events:Emitter<void>[]=[];let history:HistoryService|undefined;
  try{
    const chunks=['blob\nmark :100001\ndata 5\nbase\n\n'];
    for(let i=1;i<=100000;i++)chunks.push(`commit refs/heads/main\nmark :${i}\ncommitter Stress <stress@example.invalid> ${1700000000+i} +0000\ndata 7\ncommit\n\n${i>1?`from :${i-1}\n`:'M 100644 :100001 file.txt\n'}\n`);
    chunks.push('done\n');const imported=spawnSync(gitExecutable,['fast-import','--quiet'],{cwd:f.root,env:f.env,input:chunks.join(''),encoding:'utf8',windowsHide:true,maxBuffer:1024*1024});assert.equal(imported.status,0,imported.stderr);f.git(['reset','--hard']);
    const tip=f.git(['rev-parse','HEAD']).trim(),refs=['start'];for(let i=0;i<9999;i++)refs.push(`create refs/heads/stress-${String(i).padStart(5,'0')} ${tip}`);refs.push('prepare','commit','');
    const created=spawnSync(gitExecutable,['update-ref','--stdin'],{cwd:f.root,env:f.env,input:refs.join('\n'),encoding:'utf8',windowsHide:true});assert.equal(created.status,0,created.stderr);
    history=new HistoryService(f.registry,f.executor,new PathPolicy(()=>[f.parent],()=>true));const timings:number[]=[];
    for(let i=0;i<6;i++){const start=performance.now(),query=await history.pin(f.id);const page:HistoryPage=await history.page(query);timings.push(performance.now()-start);assert.equal(page.commits.length,100);assert.equal(page.commits[0]!.oid,tip);}
    const branchStart=performance.now(),branches=await f.gitService.branchSearchSnapshot(f.id),branchMs=performance.now()-branchStart;assert.equal(branches.length,10000);const cachedStart=performance.now();const matches=(await f.gitService.branchSearchSnapshot(f.id)).filter(branch=>branch.name.includes('09998')).slice(0,200);const cachedSearchMs=performance.now()-cachedStart;assert.equal(matches.length,1);
    for(let start=0;start<5000;start+=100)await Promise.all(Array.from({length:100},(_,index)=>writeFile(path.join(f.root,`changed-${start+index}.txt`),'changed\n')));
    const statusStart=performance.now(),status=parseStatus((await f.executor.read(f.root,{kind:'status'})).stdout),statusMs=performance.now()-statusStart;assert.equal(status.changes.length,5000);
    const handles=[{root:f.root,onDidChange:f.event.event}];for(let i=1;i<10;i++){const root=path.join(f.parent,`root-${i}`);await mkdir(root);f.git(['init','-b','main'],root);const event=new Emitter<void>();events.push(event);handles.push({root,onDidChange:event.event});}
    await f.registry.sync(handles);assert.equal(f.registry.list().length,10);
    let reads=0;const original=f.executor.read.bind(f.executor);f.executor.read=async(root,command,options)=>{if(root===f.root&&command.kind==='status')reads++;return original(root,command,options);};
    for(let i=0;i<500;i++)f.event.fire();await new Promise(resolve=>setTimeout(resolve,1000));assert.ok(reads>=1&&reads<=3,`Storm generated ${reads} status probes`);assert.equal(f.registry.store.get(f.id)?.changes.length,5000);
    const sorted=timings.slice(1).sort((a,b)=>a-b),metrics={platform:process.platform,node:process.version,git:f.git(['--version']).trim(),cpu:cpus()[0]?.model,commits:100000,refs:10000,files:5000,roots:10,firstPageColdMs:timings[0],firstPageWarmP50Ms:sorted[2],firstPageWarmP95Ms:sorted[4],branchReadParseMs:branchMs,cachedBranchSearchMs:cachedSearchMs,statusReadParseMs:statusMs,eventStormProbes:reads,rssBytes:process.memoryUsage().rss};
    await mkdir(path.resolve('artifacts'),{recursive:true});await writeFile(path.resolve('artifacts/stress-core.json'),JSON.stringify(metrics,null,2)+'\n');console.log(JSON.stringify(metrics));
  }finally{history?.dispose();for(const event of events)event.dispose();await f.close();}
});
