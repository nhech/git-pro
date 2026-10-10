import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoveryFor } from '../../src/utils/recovery';
import { GitFailure, classifyGitDiagnostic, type FailureKind } from '../../src/git/git-error-parser';
test('failure recovery is redacted and never retries a mutation or removes a lock',()=>{
  const kinds:FailureKind[]=['auth','signing','conflict','cancelled','timeout','repository','locked','output-limit','unknown'];
  for(const kind of kinds){const result=recoveryFor(new GitFailure(kind,'https://user:PRIVATE_SENTINEL@example.test/repo?%74oken=TOKEN_SENTINEL'));
    assert.equal(result.message.includes('PRIVATE_SENTINEL'),false);assert.equal(result.message.includes('TOKEN_SENTINEL'),false);
    assert.ok(['gitPro.refresh','gitPro.changes.focus','gitPro.showOutput'].includes(result.command));
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
  const conflict=recoveryFor(new GitFailure('conflict','conflict',1,{applied:2,total:3}));assert.match(conflict.message,note);assert.equal(conflict.command,'gitPro.changes.focus');
  const other=recoveryFor(Object.assign(new Error('Workspace trust was revoked.\nBatches 1-2 of 3 were already applied; refresh and review before retrying.'),{partial:{applied:2,total:3}}));
  assert.equal(other.message.match(/already applied/g)?.length,1,'the note is not repeated');assert.equal(other.command,'gitPro.refresh');
  assert.doesNotMatch(recoveryFor(new GitFailure('unknown','fatal')).message,/already applied/);
});
