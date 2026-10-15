import { validateOid } from '../../security/refs';
import { rebaseCommentChars } from '../advanced/advanced-builders';
export type RebaseAction='pick'|'reword'|'edit'|'squash'|'fixup'|'drop';
export interface RebaseStep {oid:string;action:RebaseAction;message?:string}
export interface LinearCommit {oid:string;parent:string;subject:string}
/**
 * The comment character the rebase runs with, so Git's cleanup of an edited message cannot delete a reworded line such as "#42 hotfix" (it removes lines that
 * start with the comment character, '#' by default). The first character no reworded line starts with; undefined when nothing is reworded and Git's own setting stands.
 */
export function rebaseCommentChar(steps:readonly RebaseStep[],keptStarts:ReadonlySet<string>=new Set()):string|undefined{
  const messages=steps.flatMap(step=>step.action==='reword'&&step.message!==undefined?[step.message]:[]);
  if(!messages.length)return undefined;
  // The messages of the other commits go through the same cleanup when they are squashed or stop on a conflict, so their line starts count too.
  const starts=new Set([...keptStarts,...messages.flatMap(message=>message.split(/\r?\n/).map(line=>line.trimStart()[0]??''))]);
  const chosen=rebaseCommentChars.find(char=>!starts.has(char));
  if(chosen===undefined)throw new Error('The reworded messages have lines starting with every character Git Pro can use for comments. Reword these commits in native Git.');
  return chosen;
}
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
/** The command that continues a Git Pro rebase from a terminal with the same comment character the plan used; every shell takes the single-quoted form (a quote itself needs double quotes). */
export function nativeContinueCommand(commentChar:string):string{
  return commentChar==="'"?'git -c "core.commentChar=\'" rebase --continue':`git -c 'core.commentChar=${commentChar}' rebase --continue`;
}
