import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { advancedFixture } from '../fixtures/advanced-fixture';
import { InteractiveService, type RebaseJobInfo, type RebaseJournal } from '../../src/git/rebase/interactive.service';
import type { RebaseStep } from '../../src/git/rebase/rebase-plan';
import { writeFile } from 'node:fs/promises';
async function setup(){
  const f=await advancedFixture(),jobs=new Map<string,RebaseJobInfo>();const journal:RebaseJournal={get:async id=>jobs.get(id),put:async(id,job)=>{if(job)jobs.set(id,job);else jobs.delete(id);}};
  const editor={node:process.execPath,helper:path.resolve('media/helpers/rebase-editor.cjs')},storage=path.join(f.parent,"interactive jobs' directory with spaces");
  const interactive=new InteractiveService(f.advanced,storage,editor,journal);f.advanced.setEditorJobs(interactive);
  const root=await f.commit('base.txt','base\n','root'),a=await f.commit('a.txt','a\n','first'),b=await f.commit('b.txt','b\n','second'),c=await f.commit('c.txt','c\n','third');
  return {...f,interactive,jobs,journal,editor,storage,root,a,b,c};
}
test('owned interactive editors reorder/reword/squash/fixup/drop without evaluating messages',async()=>{
  for(const action of ['reorder','reword','squash','fixup','drop'] as const){const f=await setup();try{
    const preview=await f.interactive.preview(f.id,f.root),steps:RebaseStep[]=preview.commits.map(commit=>({oid:commit.oid,action:'pick'}));
    if(action==='reorder')steps.reverse();
    if(action==='reword')steps[1]={oid:f.b,action:'reword',message:'Reword $(do-not-run) `literal`\n\nBody is plain data.'};
    if(action==='squash'||action==='fixup')steps[1]={oid:f.b,action};
    if(action==='drop')steps[1]={oid:f.b,action:'drop'};
    await f.interactive.execute(preview,steps);assert.equal((await f.advanced.snapshot(f.id)).operation,'idle');assert.equal(f.jobs.size,0);
    const subjects=f.git(['log','--reverse','--format=%s',`${f.root}..HEAD`]).trim().split('\n');
    if(action==='reorder')assert.deepEqual(subjects,['third','second','first']);
    if(action==='reword')assert.deepEqual(subjects,['first','Reword $(do-not-run) `literal`','third']);
    if(action==='squash'||action==='fixup'||action==='drop')assert.deepEqual(subjects,['first','third']);
    assert.equal(f.git(['ls-tree','--name-only','HEAD']).includes('b.txt'),action!=='drop');
  }finally{await f.close();}}
});
test('interactive edit stop preserves owned job after recreation and resumes future reword; invalid plans reject',async()=>{
  const f=await setup();try{
    const preview=await f.interactive.preview(f.id,f.root);await assert.rejects(f.interactive.execute(preview,[{oid:f.a,action:'fixup'},{oid:f.b,action:'pick'},{oid:f.c,action:'pick'}]),/earlier/);
    await f.interactive.execute(preview,[{oid:f.a,action:'edit'},{oid:f.b,action:'reword',message:'After restart'},{oid:f.c,action:'pick'}]);assert.equal((await f.advanced.snapshot(f.id)).operation,'rebasing');assert.equal(f.jobs.size,1);
    const restarted=new InteractiveService(f.advanced,f.storage,f.editor,f.journal);f.advanced.setEditorJobs(restarted);
    const repo=f.gitService.repository(f.id);await writeFile(path.join(repo.root,'edited.txt'),'edited during stop\n');await f.advanced.stageEdit(await f.advanced.snapshot(f.id),['edited.txt']);await f.advanced.amendEdit(await f.advanced.snapshot(f.id),'First edited\n\nMultiline body');
    await f.advanced.control(await f.advanced.snapshot(f.id),'continue');assert.equal((await f.advanced.snapshot(f.id)).operation,'idle');assert.equal(f.jobs.size,0);assert.match(f.git(['log','--format=%s',`${f.root}..HEAD`]),/After restart/);
    assert.match(f.git(['show', 'HEAD~2:edited.txt']),/edited during stop/);assert.match(f.git(['log','--format=%B',`${f.root}..HEAD`]),/Multiline body/);
    f.git(['checkout','-b','side',f.root]);await f.commit('side.txt','side\n','side');f.git(['checkout','main']);f.git(['merge','--no-ff','--no-edit','side']);await assert.rejects(f.interactive.preview(f.id,f.root),/linear/);
  }finally{await f.close();}
});

test('interactive preview bounds display metadata without rewriting full subjects; oversized messages leave Git unchanged',async()=>{
  const f=await setup();try{
    const messageFile=path.join(f.parent,'fixture-message.txt'),subject='Long subject '.repeat(250).trim();await writeFile(messageFile,subject+'\n\nOriginal body\n');f.git(['commit','--allow-empty','-F',messageFile]);
    const preview=await f.interactive.preview(f.id,f.root);assert.equal(preview.commits.at(-1)!.subject.length,500);
    await f.interactive.execute(preview,preview.commits.map(commit=>({oid:commit.oid,action:'pick'})));assert.equal(f.git(['log','-1','--format=%s']).trim(),subject);assert.equal(f.jobs.size,0);
    await writeFile(messageFile,'Oversized metadata\n\n'+'x'.repeat(1024*1024));f.git(['commit','--allow-empty','-F',messageFile]);const head=f.git(['rev-parse','HEAD']).trim();
    await assert.rejects(f.interactive.preview(f.id,f.root),/output exceeded/);assert.equal(f.git(['rev-parse','HEAD']).trim(),head);assert.equal(f.git(['status','--porcelain']).trim(),'');assert.equal(f.jobs.size,0);
  }finally{await f.close();}
});
test('interactive preview reads every message of the range with one Git process, keeping first-line subjects',async()=>{
  const f=await setup();try{
    for(let index=0;index<12;index++)await f.commit(`bulk-${index}.txt`,`${index}\n`,`bulk ${index}`);
    const messageFile=path.join(f.parent,'wrapped-message.txt');await writeFile(messageFile,'First line\nsecond line of the same paragraph\n\nBody text\n');f.git(['commit','--allow-empty','-F',messageFile]);
    const kinds:string[]=[],original=f.executor.read.bind(f.executor);
    f.executor.read=((root:string,command:{kind:string},options?:never)=>{kinds.push(command.kind);return original(root,command as never,options);}) as typeof f.executor.read;
    const preview=await f.interactive.preview(f.id,f.root);
    const expected=f.git(['log','--reverse','--format=%H%x09%s',`${f.root}..HEAD`]).trim().split('\n').map(line=>line.split('\t'));
    assert.equal(preview.commits.length,16);
    assert.deepEqual(preview.commits.slice(0,-1).map(commit=>[commit.oid,commit.subject]),expected.slice(0,-1));
    assert.equal(preview.commits.at(-1)!.subject,'First line','subjects stay the first line, not the joined paragraph');
    assert.equal(kinds.filter(kind=>kind==='rangeMessages').length,1);assert.equal(kinds.filter(kind=>kind==='commitMessage').length,0,'no per-commit message reads');
  }finally{await f.close();}
});
test('owned editors work when core.commentChar is not "#" and keep "#" lines of a reworded message',async()=>{
  const f=await setup();try{
    f.git(['config','core.commentChar',';']);
    const preview=await f.interactive.preview(f.id,f.root),steps:RebaseStep[]=preview.commits.map(commit=>({oid:commit.oid,action:'pick'}));
    steps.reverse();steps[1]={oid:f.b,action:'reword',message:'Fix #123\n\n#456 stays because ; is the comment character.'};
    await f.interactive.execute(preview,steps);assert.equal((await f.advanced.snapshot(f.id)).operation,'idle');
    assert.deepEqual(f.git(['log','--reverse','--format=%s',`${f.root}..HEAD`]).trim().split('\n'),['third','Fix #123','first']);
    assert.match(f.git(['log','-1','--format=%B',`HEAD~1`]),/#456 stays/);
  }finally{await f.close();}
});
