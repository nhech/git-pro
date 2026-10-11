import { redact } from '../security/redaction';
export type FailureKind = 'conflict' | 'auth' | 'signing' | 'locked' | 'repository' | 'cancelled' | 'timeout' | 'output-limit' | 'unknown';
/** Earlier, independent batches of a multi-batch mutation that took effect before a later batch failed. */
export interface PartialApplication { readonly applied: number; readonly total: number }
export class GitFailure extends Error {
  constructor(readonly kind: FailureKind, message: string, readonly exitCode: number | null = null, readonly partial?: PartialApplication) {
    super(redact(message)); this.name = 'GitFailure';
  }
}
/** A later group of a split mutation failed after earlier groups took effect: the error says so, whatever stopped it. */
export function partiallyApplied(error: unknown, applied: number, total: number): Error {
  const note = `\nBatches 1-${applied} of ${total} were already applied; refresh and review before retrying.`, partial = { applied, total };
  if (error instanceof GitFailure) return new GitFailure(error.kind, `${error.message}${note}`, error.exitCode, partial);
  return Object.assign(new Error(`${error instanceof Error ? error.message : String(error)}${note}`, { cause: error }), { partial });
}
export function classifyGitDiagnostic(diagnostic:string):FailureKind {
  const stderr=diagnostic.slice(0,8192);
  return /authentication failed|permission denied \([^)]*\bpublickey\b[^)]*\)|could not read (?:username|password).*?(?:terminal prompts disabled|no such device or address)|requested URL returned error: (?:401|403)/i.test(stderr) ? 'auth' :
    /(?:gpg|ssh-keygen) failed to sign|failed to sign (?:the data|the commit)|user\.signingkey needs to be set for ssh signing/i.test(stderr)||(/could(?: not|n't) (?:load|read) (?:public |private )?key/i.test(stderr)&&/failed to write commit object|signing|signature/i.test(stderr)) ? 'signing' :
    /index\.lock|another git process/i.test(stderr) ? 'locked' :
      /not a git repository|dubious ownership|unsafe repository/i.test(stderr) ? 'repository' :
        /conflict|unmerged/i.test(stderr) ? 'conflict' : 'unknown';
}
export function parseGitError(stderr: string, exitCode: number | null): GitFailure {
  return new GitFailure(classifyGitDiagnostic(stderr), stderr.trim().slice(0, 2000) || `Git exited with code ${exitCode}.`, exitCode);
}
/** Mutations that stop on merge conflicts. `git merge` (so also a squash merge and a pull that merges) and `git stash apply` print their conflicts to stdout only. */
const mergeFamily: ReadonlySet<string> = new Set(['merge', 'integrate', 'stashApply', 'cherryPick', 'revert', 'rebase', 'interactiveRebase', 'operationControl']);
/**
 * A failed mutation. Exit 1 with a `CONFLICT (` line in a merge-family kind's stdout is a conflict whatever stderr says (often nothing). The whole captured
 * stdout is scanned: Git prints an `Auto-merging` line for every content-merged path first, so the first conflict can come long after any prefix. Stdout never
 * becomes the message, which is stderr or the conflict count.
 */
export function parseMutationError(kind: string, stdout: Buffer, stderr: string, exitCode: number | null): GitFailure {
  if (exitCode === 1 && mergeFamily.has(kind)) {
    const count = stdout.toString('latin1').match(/^CONFLICT \(/gm)?.length ?? 0;
    if (count) return new GitFailure('conflict', stderr.trim().slice(0, 2000) || `Git stopped with ${count} ${count === 1 ? 'conflict' : 'conflicts'}.`, exitCode);
  }
  return parseGitError(stderr, exitCode);
}
