import * as path from 'node:path';
import {tmpdir} from 'node:os';
import {realpath,readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {containsPath} from '../../src/security/paths';

/** Real ephemeral signing material; never reads user keys or config. */
export async function configureFixtureSigning(root:string,parent:string,git:(args:string[])=>string,env:NodeJS.ProcessEnv){
  const canonical=await realpath(parent);
  if(!containsPath(await realpath(tmpdir()),canonical)||!/^git-pro-(?:test|host)-/.test(path.basename(canonical))||!containsPath(canonical,await realpath(root)))throw new Error('Signing fixture must be inside an owned temporary repository.');
  const found=spawnSync(process.platform==='win32'?'where.exe':'which',['ssh-keygen'],{encoding:'utf8',windowsHide:true});
  if(found.status!==0)throw new Error('SSH signing fixture requires ssh-keygen.');
  const executable=found.stdout.trim().split(/\r?\n/)[0]!;
  const key=path.join(canonical,'fixture signing key'),allowed=path.join(canonical,'fixture allowed signers');
  const generated=spawnSync(executable,['-q','-t','ed25519','-N','','-C','git-pro-fixture','-f',key],{env,encoding:'utf8',windowsHide:true,timeout:10000});
  if(generated.status!==0)throw new Error('Ephemeral SSH key generation failed.');
  const publicKey=(await readFile(key+'.pub','utf8')).trim();
  await writeFile(allowed,`fixture@example.invalid ${publicKey}\n`);
  for(const [name,value] of [['gpg.format','ssh'],['gpg.ssh.program',executable.replace(/\\/g,'/')],['user.signingkey',key.replace(/\\/g,'/')],['gpg.ssh.allowedSignersFile',allowed.replace(/\\/g,'/')],['commit.gpgsign','true']])git(['config',name!,value!]);
  return {key,allowed,executable};
}
