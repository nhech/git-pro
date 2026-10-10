import { validateOid } from '../../security/refs';
export type AdvancedMutation = { kind: 'merge'; oid: string; strategy: 'ff' | 'ff-only' | 'no-ff' | 'squash' } |
  { kind: 'rebase'; oid: string } | {kind:'interactiveRebase';base:string} | {kind:'amendStopped';message?:string} |
  { kind: 'cherryPick' | 'revert'; oids: readonly string[]; parent?: number } |
  { kind: 'reset'; oid: string; mode: 'soft' | 'mixed' | 'hard' | 'keep' } |
  { kind: 'operationControl'; operation: 'merging' | 'rebasing' | 'cherry-picking' | 'reverting'; action: 'continue' | 'abort' | 'skip' };
export function buildAdvancedMutation(command: AdvancedMutation): string[] {
  const prefix = ['--literal-pathspecs', '--no-pager', '-c', 'color.ui=false'];
  switch (command.kind) {
    case 'merge': {
      if (!['ff','ff-only','no-ff','squash'].includes(command.strategy)) throw new Error('Invalid merge strategy.');
      return [...prefix,'merge',`--${command.strategy}`,'--no-autostash','--no-edit',validateOid(command.oid)];
    }
    case 'rebase': return [...prefix,'-c','rebase.updateRefs=false','rebase','--no-autostash',validateOid(command.oid)];
    case 'interactiveRebase': return [...prefix,'-c','rebase.updateRefs=false','-c','rebase.autoSquash=false','-c','rebase.abbreviateCommands=false','-c','rebase.instructionFormat=%s','rebase','--interactive','--no-autostash','--no-autosquash',validateOid(command.base)];
    case 'amendStopped': {
      if(command.message!==undefined&&(!command.message.trim()||command.message.length>65536||command.message.includes('\0')))throw new Error('Invalid amend message.');
      return [...prefix,'commit','--amend',...(command.message!==undefined?['-m',command.message]:['--no-edit'])];
    }
    case 'cherryPick': case 'revert': {
      if (!command.oids.length || command.oids.length>100 || new Set(command.oids).size!==command.oids.length) throw new Error('Choose 1–100 distinct commits in application order.');
      if (command.parent !== undefined && (!Number.isInteger(command.parent) || command.parent<1 || command.parent>128 || command.oids.length!==1)) throw new Error('Merge parent requires a single commit and a valid parent number.');
      return [...prefix,command.kind==='cherryPick'?'cherry-pick':'revert',...(command.kind==='revert'?['--no-edit']:[]),...(command.parent!==undefined?['-m',String(command.parent)]:[]),...command.oids.map(validateOid)];
    }
    case 'reset': {
      if (!['soft','mixed','hard','keep'].includes(command.mode)) throw new Error('Invalid reset mode.');
      return [...prefix,'reset',`--${command.mode}`,validateOid(command.oid)];
    }
    case 'operationControl': {
      if (!['continue','abort','skip'].includes(command.action)) throw new Error('Invalid operation control.');
      if (command.operation==='merging') {
        if (command.action==='skip') throw new Error('Merge cannot skip.');
        return [...prefix,...(command.action==='continue'?['commit','--no-edit']:['merge','--abort'])];
      }
      const name = {rebasing:'rebase','cherry-picking':'cherry-pick',reverting:'revert'}[command.operation];
      if (!name) throw new Error('Unsupported operation.');
      return [...prefix,'-c','rebase.updateRefs=false',name,`--${command.action}`];
    }
  }
}
