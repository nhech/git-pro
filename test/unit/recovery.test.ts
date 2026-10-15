import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { recoveryFor } from '../../src/utils/recovery';
import { GitFailure, classifyGitDiagnostic, noteStoppedLock, parseGitError, partiallyApplied, type FailureKind } from '../../src/git/git-error-parser';
test('failure recovery is redacted and never retries a mutation or removes a lock',()=>{
  const kinds:FailureKind[]=['auth','signing','conflict','cancelled','timeout','repository','locked','output-limit','unknown'];
  for(const kind of kinds){const result=recoveryFor(new GitFailure(kind,'https://user:PRIVATE_SENTINEL@example.test/repo?%74oken=TOKEN_SENTINEL'));
    assert.equal(result.message.includes('PRIVATE_SENTINEL'),false);assert.equal(result.message.includes('TOKEN_SENTINEL'),false);
    assert.ok(['gitPro.refresh','gitPro.conflicts.open','gitPro.showOutput'].includes(result.command));
  }
  assert.match(recoveryFor(new GitFailure('locked','busy')).message,/will not remove lock files/);
  assert.match(recoveryFor(new GitFailure('timeout','expired')).message,/state may have changed/);
});
test('credential/signing recovery recognizes bounded real diagnostics and leaves TLS/filesystem errors distinct',()=>{
  for(const text of ["fatal: could not read Username for 'http://localhost': terminal prompts disabled",'Permission denied (publickey,password).','fatal: Authentication failed','The requested URL returned error: 403'])assert.equal(classifyGitDiagnostic(text),'auth');
  for(const text of ['error: gpg failed to sign the data','error: Could not load public key\nfatal: failed to write commit object','user.signingkey needs to be set for ssh signing'])assert.equal(classifyGitDiagnostic(text),'signing');
  for(const text of ['SSL certificate problem: unable to get local issuer certificate','Host key verification failed','Permission denied opening file','Could not read private key: TLS client certificate'])assert.equal(classifyGitDiagnostic(text),'unknown');
  assert.match(recoveryFor(Object.assign(new Error('Git failed'),{gitErrorCode:'AuthenticationFailed'})).message,/credential helper/);
  const signing=recoveryFor(Object.assign(new Error('Git failed'),{stderr:'gpg failed to sign the data\npassword=PRIVATE_SENTINEL'}));assert.match(signing.message,/will not disable signing/);assert.equal(signing.message.includes('PRIVATE_SENTINEL'),false);assert.equal(signing.command,'gitPro.showOutput');
  assert.equal(classifyGitDiagnostic('x'.repeat(8192)+'Authentication failed'),'unknown');
});

test('recovery UI uses concise summaries for actual Git API serialization without displaying diagnostic payloads',()=>{
  const diagnostic="error: Couldn't load public key C:/KEY_PATH_SENTINEL: No such file or directory\nfatal: failed to write commit object";
  const api=Object.assign(new Error('Failed to execute git'),{exitCode:128,gitCommand:'-c',stdout:'ARBITRARY_OUTPUT_SENTINEL',stderr:diagnostic,toString():string{return `Failed to execute git ${JSON.stringify({exitCode:this.exitCode,gitCommand:this.gitCommand,stdout:this.stdout,stderr:this.stderr})}`;}});
  const signing=recoveryFor(api);assert.match(signing.message,/^Commit signing failed\./);assert.match(signing.message,/will not disable signing/);assert.equal(signing.command,'gitPro.showOutput');
  assert.match(signing.diagnostic,/KEY_PATH_SENTINEL/);assert.ok(signing.diagnostic.length<=2000);assert.equal(signing.diagnostic.includes('ARBITRARY_OUTPUT_SENTINEL'),false);assert.equal(signing.diagnostic.includes('"gitCommand"'),false);
  const secret=recoveryFor(Object.assign(new Error('Git failed'),{stderr:'gpg failed to sign the data\npassword=PRIVATE_SENTINEL'}));assert.match(secret.diagnostic,/gpg failed/);assert.equal(secret.diagnostic.includes('PRIVATE_SENTINEL'),false);
  for(const sentinel of ['KEY_PATH_SENTINEL','ARBITRARY_OUTPUT_SENTINEL','"exitCode"','"gitCommand"','"stdout"','"stderr"'])assert.equal(signing.message.includes(sentinel),false,'Diagnostic payload must stay out of the product message: '+sentinel);
  assert.match(recoveryFor({...api,gitErrorCode:'AuthenticationFailed'}).message,/^Git authentication failed\./);
  const unknown=recoveryFor({...api,stderr:'Unrecognized fixture diagnostic',toString:()=>'{"stdout":"ARBITRARY_OUTPUT_SENTINEL"}'});assert.match(unknown.message,/^Git could not complete the operation\./);assert.equal(unknown.message.includes('ARBITRARY_OUTPUT_SENTINEL'),false);
  assert.match(recoveryFor({...api,stderr:'Unrecognized fixture diagnostic',stdout:'Authentication failed',toString:()=>'{"stdout":"Authentication failed"}'}).message,/^Git could not complete the operation\./,'Arbitrary stdout must not classify a failure.');
  const ordinary=recoveryFor(new Error('Select files from one repository.'));assert.match(ordinary.message,/Select files from one repository/,'Ordinary validation keeps its actionable detail.');
  assert.match(recoveryFor(new GitFailure('conflict','FILE_SENTINEL conflict')).message,/^Git reported unresolved conflicts\./);assert.equal(recoveryFor(new GitFailure('conflict','FILE_SENTINEL conflict')).message.includes('FILE_SENTINEL'),false);
});
test('a failure after earlier batches applied says so in the message and offers a refresh',()=>{
  const note=/Batches 1-2 of 3 were already applied; refresh and review before retrying\./;
  const git=recoveryFor(new GitFailure('unknown','fatal: unable to write new index file\nBatches 1-2 of 3 were already applied; refresh and review before retrying.',128,{applied:2,total:3}));
  assert.match(git.message,/^Git could not complete the operation\./);assert.match(git.message,note);assert.equal(git.command,'gitPro.refresh');
  const conflict=recoveryFor(new GitFailure('conflict','conflict',1,{applied:2,total:3}));assert.match(conflict.message,note);assert.equal(conflict.command,'gitPro.conflicts.open');
  const other=recoveryFor(Object.assign(new Error('Workspace trust was revoked.\nBatches 1-2 of 3 were already applied; refresh and review before retrying.'),{partial:{applied:2,total:3}}));
  assert.equal(other.message.match(/already applied/g)?.length,1,'the note is not repeated');assert.equal(other.command,'gitPro.refresh');
  assert.doesNotMatch(recoveryFor(new GitFailure('unknown','fatal')).message,/already applied/);
});
test('a conflict failure offers Resolve Conflicts…, which only opens the Conflicts tab; other failures keep their recovery',()=>{
  for(const error of [new GitFailure('conflict','Git stopped with 2 conflicts.',1),Object.assign(new Error('Failed to execute git'),{stderr:'error: could not apply 1a2b3c4... CONFLICT (content)',exitCode:1})]){
    const result=recoveryFor(error);assert.equal(result.label,'Resolve Conflicts…');assert.equal(result.command,'gitPro.conflicts.open');assert.match(result.message,/^Git reported unresolved conflicts\.\nReview conflicts and stage resolutions/);
  }
  assert.equal(recoveryFor(new GitFailure('unknown','Git exited with code 1.',1)).command,'gitPro.showOutput','an unclassified merge failure is not sent to Conflicts');
  for(const text of ['Conflict markers remain in src/app.ts. Review the file before marking resolved.','Resolve and stage all conflicts before continuing.']){
    const guard=recoveryFor(new Error(text));assert.ok(guard.message.endsWith(text),'Git Pro guard text is not replaced by the generic Git summary');assert.doesNotMatch(guard.message,/Git reported/);assert.equal(guard.command,'gitPro.conflicts.open');
  }
  assert.equal(recoveryFor(new Error('Conflict in https://user:PRIVATE_SENTINEL@example.test/x')).message.includes('PRIVATE_SENTINEL'),false);
});
test('only Git\'s own conflict wording is a conflict: hook output, branch names and paths that mention conflicts stay plain Git failures',()=>{
  for(const text of ['eslint: src/conflicts/panel.ts:3 no-unused-vars',"Preparing worktree (new branch 'fix-merge-conflict-ui')\nfatal: a branch named 'fix-merge-conflict-ui' already exists",
    "Check for merge conflicts....Failed\nsrc/a.ts:3: Merge conflict string '<<<<<<< ' found",'note: CONFLICT (content) mentioned mid-line','2 unmerged migrations in db/conflict-resolution/','Could not apply 1a2b3c4... hook failed']){
    assert.equal(classifyGitDiagnostic(text),'unknown',text);
    for(const error of [parseGitError(text,1),Object.assign(new Error('Failed to execute git'),{stderr:text,exitCode:1})]){
      const result=recoveryFor(error);assert.equal(result.label,'Show Output',text);assert.equal(result.command,'gitPro.showOutput');assert.doesNotMatch(result.message,/conflicts/);assert.ok(result.diagnostic.includes(text.split('\n')[0]!),'the real error stays in the diagnostic Show Output reveals');
    }
  }
  for(const text of ['CONFLICT (content): Merge conflict in a.txt','Automatic merge failed; fix conflicts and then commit the result.','Rebasing (1/1)\rerror: could not apply 1a2b3c4... feature','error: could not revert 1a2b3c4... main',
    'error: Committing is not possible because you have unmerged files.\nfatal: Exiting because of an unresolved conflict.',"error: path 'src/a b.txt' is unmerged",'a.txt: needs merge\r\nerror: you need to resolve your current index first',
    'You must edit all merge conflicts and then\nmark them as resolved using git add',"Applied patch to 'a.txt' with conflicts.",'hint: after resolving the conflicts, mark the corrected paths'])
    assert.equal(classifyGitDiagnostic(text),'conflict',text);
});
test('a lock left by a Git process that Git Pro stopped is named with what to do instead of "another operation"; Git Pro never removes it',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'git-pro-lock-')),lock=path.join(dir,'index.lock'),remove=/Check that no Git process is still running, then delete that file yourself\. Git Pro will not remove lock files\./;
  try{
    for(const kind of ['timeout','cancelled','output-limit'] as const){
      const result=recoveryFor(new GitFailure(kind,'stopped',null,undefined,lock));
      assert.match(result.message,/\nGit Pro stopped the Git process, and it left the lock file /,kind);assert.ok(result.message.includes(lock));assert.match(result.message,remove);
    }
    assert.match(recoveryFor(new GitFailure('timeout','stopped',null,undefined,lock)).message,/state may have changed/);assert.equal(recoveryFor(new GitFailure('timeout','stopped',null,undefined,lock)).command,'gitPro.refresh');
    assert.doesNotMatch(recoveryFor(new GitFailure('timeout','stopped')).message,/lock file/);
    assert.equal((partiallyApplied(new GitFailure('timeout','stopped',null,undefined,lock),1,2) as GitFailure).lockFile,lock);
    await writeFile(lock,'');
    const stderr=`fatal: Unable to create '${lock.replace(/\\/g,'/')}': File exists.\n\nAnother git process seems to be running in this repository, e.g.\nan editor opened by 'git commit'.`;
    const errors=()=>[parseGitError(stderr,128),Object.assign(new Error('Failed to execute git'),{stderr,exitCode:128})];
    for(const error of errors())assert.match(recoveryFor(error).message,/^Git is busy with another operation\.\nFinish the other Git operation\./,'a lock Git Pro did not leave');
    noteStoppedLock(lock);
    for(const error of errors()){const message=recoveryFor(error).message;assert.ok(message.startsWith(`A Git process that Git Pro stopped earlier left the lock file ${lock}.\n`),message);assert.match(message,remove);assert.doesNotMatch(message,/another operation/);}
    // Removed by the user, then taken by another process: a different file, so Git's own reading again.
    await rm(lock);await new Promise(resolve=>setTimeout(resolve,20));await writeFile(lock,'other');
    for(const error of errors())assert.match(recoveryFor(error).message,/^Git is busy with another operation\./);
  }finally{await rm(dir,{recursive:true,force:true});}
});
