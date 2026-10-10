import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import {createServer} from 'node:http';
import {writeFile,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {advancedFixture} from '../fixtures/advanced-fixture';
import {gitExecutable} from '../fixtures/repository-fixture';
import {configureFixtureSigning} from '../fixtures/signing-fixture';
import {GitExecutor} from '../../src/git/git-executor';
import {GitFailure} from '../../src/git/git-error-parser';
import {recoveryFor} from '../../src/utils/recovery';

test('real loopback credential helper succeeds with terminal prompts disabled; missing/rejected auth stays safe',async()=>{
  const f=await advancedFixture();const log:string[]=[];let server:ReturnType<typeof createServer>|undefined,executor:GitExecutor|undefined;
  try{
    const oid=await f.commit('file.txt','base\n','HTTP fixture');
    // Empty local helper resets inherited helpers; no user credential store/askpass.
    f.git(['config','credential.helper','']);f.git(['config','core.askPass','']);
    const env={...f.env,GIT_ASKPASS:'',SSH_ASKPASS:'',GIT_TRACE:'0',GIT_TRACE_CURL:'0',GIT_TRACE2:'0',GIT_TRACE2_EVENT:'0',GIT_TRACE2_PERF:'0',HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',http_proxy:'',https_proxy:'',all_proxy:'',NO_PROXY:'127.0.0.1'};
    executor=new GitExecutor(gitExecutable,f.policy,{info:value=>log.push(value),error:value=>log.push(value)},undefined,env);
    const secret='FIXTURE_AUTH_SECRET',user='fixture-user';let authorizedRequests=0,rejectedRequests=0;
    const advertised=spawnSync(gitExecutable,['upload-pack','--stateless-rpc','--advertise-refs',f.root],{env:f.env,windowsHide:true});assert.equal(advertised.status,0);
    server=createServer((request,response)=>{
      if(request.headers.authorization!==`Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`){rejectedRequests++;response.writeHead(401,{'WWW-Authenticate':'Basic realm="Git Pro fixture"'});response.end();return;}
      authorizedRequests++;response.writeHead(200,{'Content-Type':'application/x-git-upload-pack-advertisement'});response.end(Buffer.concat([Buffer.from('001e# service=git-upload-pack\n0000'),advertised.stdout]));
    });
    await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(0,'127.0.0.1',resolve);});
    const address=server.address();assert.ok(address&&typeof address==='object');const url=`http://127.0.0.1:${address.port}/fixture.git`;
    const refs=f.git(['for-each-ref','--format=%(refname) %(objectname)']),index=f.git(['ls-files','--stage']);
    await assert.rejects(executor.read(f.root,{kind:'remoteRef',url,branch:'main'}),error=>error instanceof GitFailure&&error.kind==='auth'&&/credential helper/.test(recoveryFor(error).message));
    const helper=path.join(f.parent,'credential helper.cjs'),trace=path.join(f.parent,'helper-actions.jsonl');
    const configure=async(password:string)=>{
      await writeFile(helper,`const fs=require('node:fs');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{const action=process.argv[2];fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({action,prompt:process.env.GIT_TERMINAL_PROMPT})+'\\n');if(action==='get')process.stdout.write(${JSON.stringify(`username=${user}\npassword=${password}\n\n`)});});`);
      const quote=(value:string)=>`'${value.replace(/\\/g,'/').replace(/'/g,`'"'"'`)}'`;
      f.git(['config','--add','credential.helper',`!${quote(process.execPath)} ${quote(helper)}`]);
    };
    await configure(secret);
    const result=await executor.read(f.root,{kind:'remoteRef',url,branch:'main'});assert.equal(result.stdout.toString().split('\t')[0],oid);assert.ok(authorizedRequests>0);
    const actions=(await readFile(trace,'utf8')).trim().split('\n').map(line=>JSON.parse(line) as {action:string;prompt:string});assert.ok(actions.some(action=>action.action==='get'));assert.ok(actions.every(action=>action.prompt==='0'));
    // Replacing the owned helper's output exercises rejected credentials too.
    f.git(['config','--unset-all','credential.helper']);f.git(['config','credential.helper','']);await configure('REJECTED_FIXTURE_SECRET');
    await assert.rejects(executor.read(f.root,{kind:'remoteRef',url,branch:'main'}),error=>error instanceof GitFailure&&error.kind==='auth');
    assert.ok(rejectedRequests>0);assert.ok((await readFile(trace,'utf8')).includes('erase'));
    assert.equal(log.join('\n').includes(secret),false);assert.equal(log.join('\n').includes('REJECTED_FIXTURE_SECRET'),false);
    assert.equal(f.git(['rev-parse','HEAD']).trim(),oid);assert.equal(f.git(['for-each-ref','--format=%(refname) %(objectname)']),refs);assert.equal(f.git(['ls-files','--stage']),index);
  }finally{executor?.dispose();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));await f.close();}
});

test('real SSH signed commit verifies; unavailable signing key preserves HEAD, index and signing requirement',async()=>{
  const f=await advancedFixture();try{
    await f.commit('signed.txt','base\n','base');const signing=await configureFixtureSigning(f.root,f.parent,args=>f.git(args),f.env);
    await writeFile(path.join(f.root,'signed.txt'),'signed\n');f.git(['add','signed.txt']);
    await f.executor.mutate(f.root,{kind:'commitFile',paths:['signed.txt'],message:'SSH signed fixture'});
    const signed=f.git(['rev-parse','HEAD']).trim();assert.match(f.git(['cat-file','commit',signed]),/BEGIN SSH SIGNATURE/);f.git(['verify-commit',signed]);
    await writeFile(path.join(f.root,'signed.txt'),'next staged\n');f.git(['add','signed.txt']);const index=f.git(['ls-files','--stage']);
    f.git(['config','user.signingkey',signing.key+'-missing']);
    await assert.rejects(f.executor.mutate(f.root,{kind:'commitFile',paths:['signed.txt'],message:'must fail signing'}),error=>error instanceof GitFailure&&error.kind==='signing'&&/will not disable signing/.test(recoveryFor(error).message));
    assert.equal(f.git(['rev-parse','HEAD']).trim(),signed);assert.equal(f.git(['ls-files','--stage']),index);assert.equal(f.git(['config','commit.gpgsign']).trim(),'true');assert.equal(await readFile(path.join(f.root,'signed.txt'),'utf8'),'next staged\n');
  }finally{await f.close();}
});
