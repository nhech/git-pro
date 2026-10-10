const fs=require('node:fs/promises');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {createVSIX}=require('@vscode/vsce');
(async()=>{
  const cwd=path.resolve(__dirname,'..'),manifest=JSON.parse(await fs.readFile(path.join(cwd,'package.json'),'utf8'));
  const license=await fs.readFile(path.join(cwd,'LICENSE'),'utf8');
  if(manifest.private!==true||manifest.name!=='git-pro'||manifest.license!=='MIT'||!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(manifest.version)||!license.startsWith('MIT License\n\nCopyright (c) 2026 longtd\n'))throw new Error('Public-candidate package metadata or license is invalid.');
  const directory=path.join(cwd,'artifacts');await fs.mkdir(directory,{recursive:true});if((await fs.lstat(directory)).isSymbolicLink())throw new Error('Package output cannot be a symlink.');
  const output=path.join(directory,`git-pro-${manifest.version}-public-candidate.vsix`);
  await createVSIX({cwd,packagePath:output,dependencies:false,rewriteRelativeLinks:true,
    baseContentUrl:'https://github.com/nhech/git-pro/blob/main',baseImagesUrl:'https://raw.githubusercontent.com/nhech/git-pro/main'});
  const verification=spawnSync(process.execPath,[path.join(cwd,'scripts','verify-package.cjs'),output],{cwd,stdio:'inherit',windowsHide:true});
  if(verification.error)throw verification.error;if(verification.status!==0)throw new Error(`Package verification failed (${verification.status??verification.signal}).`);
})().catch(error=>{console.error(error.message);process.exitCode=1;});
