import { decode } from '../history/history-parser';
import { validateOid } from '../../security/refs';
export interface Stash {selector:string;oid:string;subject:string;timestamp:number}
export interface Tag {name:string;oid:string;target:string;annotated:boolean}
export interface Worktree {path:string;head?:string;branch?:string;locked:boolean;prunable:boolean;bare:boolean}
export function parseStashes(buffer:Buffer):Stash[]{
  if(!buffer.length)return[];if(buffer.at(-1)!==0)throw new Error('Truncated stash records.');const fields=decode(buffer).slice(0,-1).split('\0');if(fields.length%4)throw new Error('Invalid stash framing.');
  const result:Stash[]=[];for(let i=0;i<fields.length;i+=4){const selector=fields[i]!,time=fields[i+3]!;if(!/^stash@\{\d+\}$/.test(selector)||!/^\d+$/.test(time)||!Number.isSafeInteger(Number(time)))throw new Error('Invalid stash metadata.');result.push({selector,oid:validateOid(fields[i+1]!),subject:fields[i+2]!,timestamp:Number(time)});}return result;
}
export function parseTags(buffer:Buffer):Tag[]{
  const fields=decode(buffer).split('\0');const result:Tag[]=[];
  for(let i=0;i<fields.length-1;i+=4){const ref=fields[i]!.replace(/^\n/,''),oid=fields[i+1],target=fields[i+2],type=fields[i+3];if(!ref.startsWith('refs/tags/')||!oid||target===undefined||!['commit','tag','tree','blob'].includes(type??''))throw new Error('Unsupported tag records.');result.push({name:ref.slice(10),oid:validateOid(oid),target:validateOid(target||oid),annotated:type==='tag'});}
  if(fields.at(-1)?.trim())throw new Error('Truncated tag records.');return result;
}
export function parseWorktrees(buffer:Buffer):Worktree[]{
  if(buffer.length&&buffer.at(-1)!==0)throw new Error('Truncated worktree records.');const result:Worktree[]=[];let current:Worktree|undefined;
  for(const field of decode(buffer).split('\0')){if(!field){if(current){result.push(current);current=undefined;}continue;}if(field.startsWith('worktree ')){if(current)throw new Error('Malformed worktree boundary.');current={path:field.slice(9),locked:false,prunable:false,bare:false};continue;}if(!current)throw new Error('Missing worktree path.');if(field.startsWith('HEAD '))current.head=validateOid(field.slice(5));else if(field.startsWith('branch '))current.branch=field.slice(7);else if(field==='bare')current.bare=true;else if(field==='locked'||field.startsWith('locked '))current.locked=true;else if(field==='prunable'||field.startsWith('prunable '))current.prunable=true;else if(field!=='detached')throw new Error('Unsupported worktree metadata.');}
  return result;
}
