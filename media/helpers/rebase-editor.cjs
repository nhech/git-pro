const fs=require('node:fs');
const path=require('node:path');
const [jobFile,token,mode,target]=process.argv.slice(2);
const fail=()=>{throw new Error('Invalid owned rebase editor request.');};
const instruction=line=>/^[a-z]/.test(line);
const bounded=file=>{const info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.size>1024*1024)fail();return fs.readFileSync(file,'utf8');};
let checkpoint='arguments',failureCode='validation';
try{
  if(!jobFile||!target||!['sequence','message'].includes(mode))fail();
  checkpoint='job';
  const job=JSON.parse(bounded(jobFile));if(job.token!==token||!/^[a-f0-9-]{36}$/.test(token)||!Array.isArray(job.steps)||job.steps.length<1||job.steps.length>200)fail();
  checkpoint='git-directory';
  if(typeof job.gitDir!=='string'||!path.isAbsolute(job.gitDir))fail();
  const gitDir=path.resolve(job.gitDir);
  const gitDirectory=fs.lstatSync(gitDir);if(!gitDirectory.isDirectory()||gitDirectory.isSymbolicLink())fail();
  checkpoint='target';
  const resolved=path.resolve(target);
  checkpoint='relative-target';
  const relative=path.relative(gitDir,resolved).replace(/\\/g,'/');
  if(!relative||relative.startsWith('../')||path.isAbsolute(relative))fail();
  checkpoint='target-kind';
  let cursor=gitDir;
  for(const segment of path.dirname(relative).split('/')){cursor=path.join(cursor,segment);const directory=fs.lstatSync(cursor);if(!directory.isDirectory()||directory.isSymbolicLink())fail();}
  if(mode==='sequence'&&relative!=='rebase-merge/git-rebase-todo')fail();
  if(mode==='message'&&!['COMMIT_EDITMSG','rebase-merge/message','rebase-merge/message-squash'].includes(relative))fail();
  checkpoint='steps';
  const current=bounded(resolved),seen=new Set();let kept=false;
  for(const step of job.steps){if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(step.oid)||seen.has(step.oid)||!['pick','reword','edit','squash','fixup','drop'].includes(step.action))fail();seen.add(step.oid);if(['squash','fixup'].includes(step.action)&&!kept)fail();if(step.action==='reword'&&(typeof step.message!=='string'||!step.message.trim()||step.message.length>65536||step.message.includes('\0')))fail();if(step.action!=='drop')kept=true;}
  if(mode==='sequence'){
    checkpoint='sequence';
    // Instructions start with a command word; comment lines use core.commentChar, which need not be '#'.
    const original=current.split(/\r?\n/).filter(instruction).map(line=>line.split(' '));
    if(original.length!==job.steps.length||original.some(parts=>parts[0]!=='pick'||![...seen].some(oid=>oid.startsWith(parts[1]))))fail();
    fs.writeFileSync(resolved,job.steps.map(step=>`${step.action} ${step.oid}`).join('\n')+'\n');
  }else{
    checkpoint='message';
    const done=bounded(path.join(gitDir,'rebase-merge','done')).split(/\r?\n/).filter(instruction).at(-1)?.split(' ');
    if(done?.[0]==='reword'){const step=job.steps.find(step=>step.action==='reword'&&step.oid.startsWith(done[1]));if(!step)fail();fs.writeFileSync(resolved,step.message+'\n');}
  }
}catch(error){if(error&&typeof error.code==='string')failureCode=error.code;process.stderr.write(`Git Pro owned editor rejected unsupported state (${checkpoint}/${failureCode}). Resume through Git Pro or native Git.\n`);process.exitCode=1;}
