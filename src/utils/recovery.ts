import { GitFailure, classifyGitDiagnostic } from '../git/git-error-parser';
import { redact } from '../security/redaction';
export interface Recovery {message:string;diagnostic:string;label:string;command:string}
/** Recovery buttons navigate or read; they never retry a mutation. */
export function recoveryFor(error:unknown):Recovery{
  const details=error&&typeof error==='object'?error as {message?:unknown;gitErrorCode?:unknown;stderr?:unknown;gitCommand?:unknown;exitCode?:unknown}:undefined;
  const gitDiagnostic=error instanceof GitFailure||details&&['gitErrorCode','stderr','gitCommand','exitCode'].some(key=>key in details);
  // Public Git errors stringify stdout/command payloads. Keep only message and
  // bounded stderr for diagnostics/classification, never that serialized payload.
  const original=redact(gitDiagnostic?(typeof details?.message==='string'?details.message:'Git failed.'):String(error)).slice(0,2000);
  const diagnostic=redact(`${original}${typeof details?.stderr==='string'?'\n'+details.stderr.slice(0,8192):''}`).slice(0,2000);
  const kind=error instanceof GitFailure?error.kind:details?.gitErrorCode==='AuthenticationFailed'?'auth':classifyGitDiagnostic(`${original}\n${typeof details?.stderr==='string'?details.stderr.slice(0,8192):''}`);
  const summaries:Partial<Record<NonNullable<typeof kind>,string>>={
    auth:'Git authentication failed.',signing:'Commit signing failed.',locked:'Git is busy with another operation.',
    repository:'Git repository is unavailable.',conflict:'Git reported unresolved conflicts.',
    cancelled:'Git operation was canceled.',timeout:'Git operation timed out.',
    'output-limit':'Git output exceeded the limit.'
  };
  const summary=summaries[kind??'unknown']??(gitDiagnostic?'Git could not complete the operation.':original);
  const guidance:Partial<Record<NonNullable<typeof kind>,string>>={
    auth:'Check repository access and your configured Git credential helper or SSH agent, then retry explicitly. Git Pro does not collect credentials.',
    signing:'Check your configured signing key, signer and agent or pinentry. Refresh and review Git state before retrying; Git Pro will not disable signing or automatically retry the commit.',
    locked:'Finish the other Git operation. Git Pro will not remove lock files.',
    repository:'Open the repository in a trusted filesystem workspace and refresh.',
    conflict:'Review conflicts and stage resolutions before continuing. A failed stash pop retains its stash.',
    cancelled:'Git state may have changed before cancellation. Refresh and inspect before retrying.',
    timeout:'Git state may have changed before timeout. Refresh and inspect before retrying.',
    'output-limit':'Narrow the query or use native Git for oversized data.'
  };
  const result:Recovery=kind==='conflict'?{message:`${summary}\n${guidance.conflict}`,diagnostic,label:'Review Changes',command:'gitPro.changes.focus'}:
    kind==='cancelled'||kind==='timeout'||kind==='repository'?{message:`${summary}\n${guidance[kind]}`,diagnostic,label:'Refresh Git State',command:'gitPro.refresh'}:
    {message:guidance[kind??'unknown']?`${summary}\n${guidance[kind??'unknown']}`:summary,diagnostic,label:'Show Output',command:'gitPro.showOutput'};
  // A later batch failed after earlier ones took effect: a generic Git summary alone would hide that the state changed.
  const partial=(details as {partial?:{applied?:unknown;total?:unknown}}|undefined)?.partial;
  if(!partial||!Number.isInteger(partial.applied)||!Number.isInteger(partial.total))return result;
  const note=`Batches 1-${String(partial.applied)} of ${String(partial.total)} were already applied; refresh and review before retrying.`;
  return {...result,message:result.message.includes(note)?result.message:`${result.message}\n${note}`,...(result.command==='gitPro.showOutput'?{label:'Refresh Git State',command:'gitPro.refresh'}:{})};
}
