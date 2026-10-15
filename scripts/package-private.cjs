const fs=require('node:fs/promises');
const path=require('node:path');
const {createVSIX}=require('@vscode/vsce');
const {packageLinks}=require('./package-links.cjs');
(async()=>{
  const cwd=path.resolve(__dirname,'..'),manifest=JSON.parse(await fs.readFile(path.join(cwd,'package.json'),'utf8'));
  if(manifest.private!==true||manifest.name!=='git-pro'||manifest.license!=='MIT'||!/^\d+\.\d+\.\d+$/.test(manifest.version)||!(await fs.readFile(path.join(cwd,'LICENSE'),'utf8')).startsWith('MIT License\n\nCopyright (c) 2026 longtd\n'))throw new Error('Private package metadata or license is invalid.');
  const directory=path.join(cwd,'artifacts');await fs.mkdir(directory,{recursive:true});if((await fs.lstat(directory)).isSymbolicLink())throw new Error('Package output cannot be a symlink.');
  // The screenshots are not in the package; the README links to them at this commit, as the public candidate does.
  const {baseContentUrl,baseImagesUrl}=packageLinks(cwd);
  await createVSIX({cwd,packagePath:path.join(directory,`git-pro-${manifest.version}.vsix`),dependencies:false,rewriteRelativeLinks:true,baseContentUrl,baseImagesUrl});
})().catch(error=>{console.error(error.message);process.exitCode=1;});
