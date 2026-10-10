import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fixture } from '../fixtures/repository-fixture';

test('owned interactive rebase journal resumes future reword across two independent core processes',{timeout:30_000},async()=>{
  const f=await fixture();try{
    await writeFile(path.join(f.root,'base.txt'),'base\n');f.git(['add','.']);f.git(['commit','-m','base']);const base=f.git(['rev-parse','HEAD']).trim();
    for(const name of ['first','second']){await writeFile(path.join(f.root,`${name}.txt`),`${name}\n`);f.git(['add','.']);f.git(['commit','-m',name]);}
    const worker=path.resolve(__dirname,'../fixtures/rebase-restart-worker.js'),run=(mode:string)=>{const result=spawnSync(process.execPath,[worker,mode,f.root,base],{cwd:path.resolve('.'),env:f.env,encoding:'utf8',windowsHide:true,shell:false,timeout:20_000,maxBuffer:1024*1024});assert.equal(result.status,0,`${result.error??''}\n${result.stderr}`);return result.stdout;};
    const seed=run('seed');assert.match(seed,/Fixture seed passed/);assert.ok(Object.keys(JSON.parse(await readFile(path.join(f.parent,'restart-journal.json'),'utf8')) as object).length);
    const resume=run('resume');assert.match(resume,/Fixture resume passed/);assert.notEqual(/process (\d+)/.exec(seed)?.[1],/process (\d+)/.exec(resume)?.[1]);
    assert.match(f.git(['log','-1','--format=%B']),/Reword after real process restart\n\nFuture message body/);assert.deepEqual(JSON.parse(await readFile(path.join(f.parent,'restart-journal.json'),'utf8')),{});
    assert.deepEqual(f.git(['ls-tree','--name-only','HEAD']).trim().split('\n'),['base.txt','first.txt','second.txt']);
  }finally{await f.cleanup();}
});

test('reordered interactive conflicts resume and retain future reword across independent core processes',{timeout:45_000},async()=>{
  const f=await fixture();try{
    await writeFile(path.join(f.root,'file.txt'),'base\n');f.git(['add','.']);f.git(['commit','-m','base']);const base=f.git(['rev-parse','HEAD']).trim();
    for(const value of ['first','second']){await writeFile(path.join(f.root,'file.txt'),`${value}\n`);f.git(['add','.']);f.git(['commit','-m',value]);}
    await writeFile(path.join(f.root,'future.txt'),'future\n');f.git(['add','.']);f.git(['commit','-m','future']);
    const worker=path.resolve(__dirname,'../fixtures/rebase-restart-worker.js'),run=(mode:string)=>{const result=spawnSync(process.execPath,[worker,mode,f.root,base],{cwd:path.resolve('.'),env:f.env,encoding:'utf8',windowsHide:true,shell:false,timeout:30_000,maxBuffer:1024*1024});assert.equal(result.status,0,`${result.error??''}\n${result.stderr}`);return result.stdout;};
    const seed=run('seed-conflict');assert.ok(Object.keys(JSON.parse(await readFile(path.join(f.parent,'restart-journal.json'),'utf8')) as object).length);
    const resume=run('resume-conflict');assert.notEqual(/process (\d+)/.exec(seed)?.[1],/process (\d+)/.exec(resume)?.[1]);
    assert.equal(await readFile(path.join(f.root,'file.txt'),'utf8'),'first\n');assert.equal(await readFile(path.join(f.root,'future.txt'),'utf8'),'future\n');
    assert.match(f.git(['log','-1','--format=%B']),/Reword after conflict process restart\n\nPersisted future message/);assert.deepEqual(JSON.parse(await readFile(path.join(f.parent,'restart-journal.json'),'utf8')),{});
    assert.equal(f.git(['rev-list','--count',`${base}..HEAD`]).trim(),'3');assert.equal(f.git(['status','--porcelain']).trim(),'');
  }finally{await f.cleanup();}
});
