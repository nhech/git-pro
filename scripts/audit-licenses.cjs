const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const lock=JSON.parse(fs.readFileSync('package-lock.json','utf8'));
const manifest=JSON.parse(fs.readFileSync('package.json','utf8'));
const licenses={},unknown=[],licenseTextEvidence=[],uninspectedLicenseTexts=[];let count=0;
const modulesRoot=fs.realpathSync('node_modules');
for(const [location,entry] of Object.entries(lock.packages)){
  if(!location.startsWith('node_modules/')||!entry.version)continue;
  let license=entry.license;
  if(!license){try{license=JSON.parse(fs.readFileSync(path.join(location,'package.json'),'utf8')).license;}catch{/* Optional platform packages may be absent. */}}
  if(typeof license!=='string'){unknown.push({package:location,version:entry.version});continue;}
  licenses[license]=(licenses[license]||0)+1;count++;
  const reference=/^SEE LICENSE IN ([A-Za-z0-9_.-]+)$/.exec(license);
  if(reference){
    const item={package:location,version:entry.version,license},file=path.join(location,reference[1]);
    if(!fs.existsSync(path.join(location,'package.json'))){uninspectedLicenseTexts.push({...item,reason:'Optional platform package is not installed on this host.'});continue;}
    try{
      const canonical=fs.realpathSync(file),relative=path.relative(modulesRoot,canonical),info=fs.lstatSync(file);
      if(relative.startsWith('..')||path.isAbsolute(relative)||!info.isFile()||info.isSymbolicLink()||info.size>1024*1024)throw new Error('License file is outside the bounded installed dependency scope.');
      const bytes=fs.readFileSync(file);if(bytes.length>1024*1024)throw new Error('License file grew beyond the audit limit.');
      licenseTextEvidence.push({...item,file:file.replace(/\\/g,'/'),bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),header:bytes.toString('utf8').split(/\r?\n/).slice(0,2).join(' / ').slice(0,300)});
    }catch(error){uninspectedLicenseTexts.push({...item,reason:String(error)});}
  }
}
const report={projectLicense:manifest.license??'UNSPECIFIED',runtimeDependencies:[...new Set([...Object.keys(manifest.dependencies??{}),...Object.keys(manifest.optionalDependencies??{})])],bundledThirdPartyNotice:'Microsoft Git API declarations: MIT attribution retained',developmentPackages:count,developmentLicenses:licenses,unknown,licenseTextEvidence,uninspectedLicenseTexts,scope:'Declaration inventory plus bounded SEE LICENSE file evidence; not full legal/release clearance. Signing tools remain development-only and are excluded from the private VSIX.'};
fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/dependency-licenses.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
