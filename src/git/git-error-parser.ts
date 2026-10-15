import { statSync } from 'node:fs';
import { redact } from '../security/redaction';
export type FailureKind = 'conflict' | 'auth' | 'signing' | 'locked' | 'repository' | 'cancelled' | 'timeout' | 'output-limit' | 'unknown';
/** Earlier, independent batches of a multi-batch mutation that took effect before a later batch failed. */
export interface PartialApplication { readonly applied: number; readonly total: number }
/** `lockFile`: the index lock that the Git process Git Pro stopped (timeout, cancel, output limit) left behind. Git Pro never removes it. */
export class GitFailure extends Error {
  constructor(readonly kind: FailureKind, message: string, readonly exitCode: number | null = null, readonly partial?: PartialApplication, readonly lockFile?: string) {
    super(redact(message)); this.name = 'GitFailure';
  }
}
/** A later group of a split mutation failed after earlier groups took effect: the error says so, whatever stopped it. */
export function partiallyApplied(error: unknown, applied: number, total: number): Error {
  const note = `\nBatches 1-${applied} of ${total} were already applied; refresh and review before retrying.`, partial = { applied, total };
  if (error instanceof GitFailure) return new GitFailure(error.kind, `${error.message}${note}`, error.exitCode, partial, error.lockFile);
  return Object.assign(new Error(`${error instanceof Error ? error.message : String(error)}${note}`, { cause: error }), { partial });
}
/**
 * Git's own conflict wording (merge, rebase, cherry-pick, revert, stash apply, and commands refused on an unmerged index). A bare
 * "conflict" or "unmerged" is not enough: hook output, branch names and paths such as src/conflicts/ contain those words too.
 */
const conflictDiagnostic = new RegExp([
  String.raw`^CONFLICT \(`, String.raw`\bMerge conflict in `, String.raw`\bAutomatic merge failed\b`, String.raw`\berror: could not (?:apply|revert) [0-9a-f]{4,}\.\.\.`, String.raw`\bResolve all conflicts manually\b`, String.raw`\b[Aa]fter resolving the conflicts, mark\b`,
  String.raw`\byou have unmerged (?:files|paths)\b`, String.raw`\bExiting because of an unresolved conflict\b`, String.raw`^error: path .*?is unmerged\b`,
  String.raw`: needs merge$`, String.raw`\byou need to resolve your current index first\b`, String.raw`\bYou must edit all merge conflicts\b`, String.raw`^Applied patch to .* with conflicts\.`
].join('|'), 'm');
export function classifyGitDiagnostic(diagnostic:string):FailureKind {
  const stderr=diagnostic.slice(0,8192);
  return /authentication failed|permission denied \([^)]*\bpublickey\b[^)]*\)|could not read (?:username|password).*?(?:terminal prompts disabled|no such device or address)|requested URL returned error: (?:401|403)/i.test(stderr) ? 'auth' :
    /(?:gpg|ssh-keygen) failed to sign|failed to sign (?:the data|the commit)|user\.signingkey needs to be set for ssh signing/i.test(stderr)||(/could(?: not|n't) (?:load|read) (?:public |private )?key/i.test(stderr)&&/failed to write commit object|signing|signature/i.test(stderr)) ? 'signing' :
    /index\.lock|another git process/i.test(stderr) ? 'locked' :
      /not a git repository|dubious ownership|unsafe repository/i.test(stderr) ? 'repository' :
        conflictDiagnostic.test(stderr.replace(/\r\n?/g, '\n')) ? 'conflict' : 'unknown';
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
/**
 * Lock files left by Git processes that Git Pro stopped, by file identity: a lock that another process creates later at the same path is a different file and
 * keeps Git's own "another operation" reading. For wording only; Git Pro never removes lock files.
 */
const stoppedLocks = new Map<string, string>();
function lockIdentity(file: string): string | undefined {
  try { const info = statSync(file, { bigint: true }); return info.isFile() ? `${info.dev}:${info.ino}:${info.mtimeNs}` : undefined; } catch { return undefined; }
}
export function noteStoppedLock(file: string): void {
  for (const [identity, known] of stoppedLocks) if (lockIdentity(known) !== identity) stoppedLocks.delete(identity);
  const identity = lockIdentity(file);
  if (identity) stoppedLocks.set(identity, file);
}
/** The lock file a Git diagnostic names ("Unable to create '…/index.lock': File exists.") when it is still the one a process Git Pro stopped left behind. */
export function stoppedLockIn(diagnostic: string): string | undefined {
  if (!stoppedLocks.size) return undefined;
  for (const match of diagnostic.slice(0, 8192).matchAll(/'([^'\r\n]+\.lock)'/g)) {
    const identity = lockIdentity(match[1]!), file = identity === undefined ? undefined : stoppedLocks.get(identity);
    if (file) return file;
  }
  return undefined;
}
