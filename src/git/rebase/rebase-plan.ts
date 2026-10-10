import { validateOid } from '../../security/refs';
export type RebaseAction='pick'|'reword'|'edit'|'squash'|'fixup'|'drop';
export interface RebaseStep {oid:string;action:RebaseAction;message?:string}
export interface LinearCommit {oid:string;parent:string;subject:string}
export function validateRebasePlan(commits:readonly LinearCommit[],steps:readonly RebaseStep[]):void{
  if(!commits.length||commits.length>200||steps.length!==commits.length)throw new Error('Rebase planner supports 1–200 linear commits.');
  const expected=new Set(commits.map(commit=>validateOid(commit.oid))),seen=new Set<string>();let kept=false,messageBytes=0;
  for(const step of steps){validateOid(step.oid);if(!expected.has(step.oid)||seen.has(step.oid)||!['pick','reword','edit','squash','fixup','drop'].includes(step.action))throw new Error('Plan must contain each reviewed commit exactly once and an allowed action.');seen.add(step.oid);
    if((step.action==='squash'||step.action==='fixup')&&!kept)throw new Error('Squash/fixup needs an earlier retained commit.');
    if(step.action==='reword'&&(!step.message?.trim()||step.message.includes('\0')||step.message.length>65536))throw new Error('Reword needs a non-empty bounded commit message.');
    if(step.action==='reword'){messageBytes+=Buffer.byteLength(JSON.stringify(step.message),'utf8');if(messageBytes>900*1024)throw new Error('Combined reword messages exceed the owned editor plan limit.');}
    if(step.action!=='drop')kept=true;
  }
}
