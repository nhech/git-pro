import * as path from 'node:path';
export function validateRemoteUrl(value:string):string{
  if(!value||value.length>4096||/[\x00-\x1f\x7f]/.test(value)||value.trim()!==value||value.startsWith('-')||value.includes('::'))throw new Error('Unsupported remote URL. Use HTTPS, SSH or an explicit local remote.');
  if(path.isAbsolute(value))return value;
  if(/^[^/@:]+@[^/:]+:.+$/.test(value)||/^[A-Za-z0-9.-]+:.+$/.test(value)&&!/^\w+:\/\//.test(value))return value;
  let url:URL;try{url=new URL(value);}catch{throw new Error('Invalid remote URL.');}
  if(!['http:','https:','ssh:','git:','file:'].includes(url.protocol)||url.hash)throw new Error('Unsupported remote transport.');
  return value;
}
