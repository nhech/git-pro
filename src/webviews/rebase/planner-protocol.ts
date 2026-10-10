import { validateOid } from '../../security/refs';
import type { RebaseAction } from '../../git/rebase/rebase-plan';
export type PlannerRequest = {session:string;revision:number} & (
  {type:'ready'|'review'|'cancel'|'native'} |
  {type:'action';oid:string;action:RebaseAction} |
  {type:'message';oid:string} |
  {type:'move';oid:string;target:string} |
  {type:'step';oid:string;direction:'up'|'down'});
export function parsePlannerRequest(value:unknown):PlannerRequest {
  if(!value||typeof value!=='object')throw new Error('Invalid planner request.');
  const item=value as Record<string,unknown>;
  if(typeof item.session!=='string'||item.session.length>100||!Number.isSafeInteger(item.revision)||(item.revision as number)<0)throw new Error('Invalid planner session/revision.');
  const base={session:item.session,revision:item.revision as number};
  if(['ready','review','cancel','native'].includes(String(item.type)))return {...base,type:item.type as 'ready'|'review'|'cancel'|'native'};
  if(typeof item.oid!=='string')throw new Error('Select a captured commit.');const oid=validateOid(item.oid);
  if(item.type==='message')return {...base,type:'message',oid};
  if(item.type==='move'&&typeof item.target==='string')return {...base,type:'move',oid,target:validateOid(item.target)};
  if(item.type==='step'&&(item.direction==='up'||item.direction==='down'))return {...base,type:'step',oid,direction:item.direction};
  if(item.type==='action'&&['pick','reword','edit','squash','fixup','drop'].includes(String(item.action)))return {...base,type:'action',oid,action:item.action as RebaseAction};
  throw new Error('Unsupported planner action.');
}
