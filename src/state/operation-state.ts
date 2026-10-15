import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { boundedFile } from '../utils/bounded-file';
import { GitFailure } from '../git/git-error-parser';
import type { ExecutionResult, ReadOptions } from '../git/git-executor';
import type { ReadCommand } from '../git/command-builders';
export type GitOperation = 'idle' | 'merging' | 'rebasing' | 'cherry-picking' | 'reverting' | 'bisecting' | 'applying-mail' | 'unknown-sequencer';
/** Operation pseudo-refs that the reftable backend (Git 2.45+) keeps in its tables instead of files. MERGE_HEAD stays a file in both backends. */
export type PseudoRef = 'REBASE_HEAD' | 'CHERRY_PICK_HEAD' | 'REVERT_HEAD';
/** The commit a pseudo-ref names, asked of Git: undefined when it does not resolve, '' when Git answered something that is not an object ID. */
export type PseudoRefs = (name: PseudoRef) => Promise<string | undefined>;
/** `refs` lets a reftable repository answer for its pseudo-refs; `stashMarkers` tells whether the conflicted files carry a stash apply's label (stashLabel). */
export interface ConflictEvidence { readonly refs?: PseudoRefs; readonly stashMarkers?: () => Promise<boolean> }
async function exists(file: string): Promise<boolean> {
  try { await stat(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
/** PseudoRefs through the executor's `ref` read (its environment, trust and timeouts): Git's "Needed a single revision" is an absent ref, every other failure throws. */
export function gitPseudoRefs(executor: { read(root: string, command: ReadCommand, options?: ReadOptions): Promise<ExecutionResult> }, root: string, signal?: AbortSignal): PseudoRefs {
  return async name => {
    try {
      const value = (await executor.read(root, { kind: 'ref', ref: name }, signal ? { signal } : {})).stdout.toString('latin1').trim();
      return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) ? value : '';
    } catch (error) {
      if (error instanceof GitFailure && error.exitCode === 128 && /Needed a single revision/.test(error.message)) return undefined;
      throw error;
    }
  };
}
/** The reftable backend leaves a `reftable` directory in every git dir, a linked worktree's included; the files backend never creates one. */
const reftable = (gitDir: string) => exists(path.join(gitDir, 'reftable'));
export async function detectOperation(gitDir: string, refs?: PseudoRefs): Promise<GitOperation> {
  if (await exists(path.join(gitDir, 'rebase-merge'))) return 'rebasing';
  if (await exists(path.join(gitDir, 'rebase-apply'))) {
    return await exists(path.join(gitDir, 'rebase-apply', 'rebasing')) ? 'rebasing' : 'applying-mail';
  }
  if (await exists(path.join(gitDir, 'MERGE_HEAD'))) return 'merging';
  if (await exists(path.join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-picking';
  if (await exists(path.join(gitDir, 'REVERT_HEAD'))) return 'reverting';
  // Every cherry-pick or revert stop also leaves MERGE_MSG, so only a reftable repository stopped in one pays for asking Git.
  if (refs && await exists(path.join(gitDir, 'MERGE_MSG')) && await reftable(gitDir)) {
    if (await refs('CHERRY_PICK_HEAD') !== undefined) return 'cherry-picking';
    if (await refs('REVERT_HEAD') !== undefined) return 'reverting';
  }
  if (await exists(path.join(gitDir, 'sequencer'))) {
    try {
      const todo = (await boundedFile(path.join(gitDir, 'sequencer', 'todo'), 1024 * 1024)).toString('utf8');
      if (/^pick /m.test(todo)) return 'cherry-picking';
      if (/^revert /m.test(todo)) return 'reverting';
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return 'unknown-sequencer';
  }
  if (await exists(path.join(gitDir, 'BISECT_LOG'))) return 'bisecting';
  return 'idle';
}
/**
 * First line of a pseudo-ref: undefined when it is absent, '' when it cannot be read (still evidence that it exists). In a reftable repository the ref is no
 * file, so `refs` (Git) answers; without `refs` such a repository reads as if the ref were absent.
 */
export async function readPseudoRef(gitDir: string, name: PseudoRef, refs?: PseudoRefs): Promise<string | undefined> {
  try { return (await boundedFile(path.join(gitDir, name), 4096)).toString('latin1').split(/\r?\n/)[0]!.trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return '';
    return refs && await reftable(gitDir) ? refs(name) : undefined;
  }
}
/** The last step the rebase ran is a `merge` (rebase -r), whose own conflicts write MERGE_HEAD. The apply backend has no merge steps; a missing or unreadable list keeps the rebase. */
async function mergeStep(gitDir: string): Promise<boolean> {
  if (!await exists(path.join(gitDir, 'rebase-merge'))) return false;
  try { return /^m(?:erge)? /.test(await lastDoneStep(gitDir)); }
  catch { return true; }
}
/** The last step the rebase ran is a `squash` or `fixup` (long or abbreviated); an unreadable list counts as no. */
async function squashStep(gitDir: string): Promise<boolean> {
  try { return /^(?:s|squash|f|fixup)(?:\s|$)/.test(await lastDoneStep(gitDir)); }
  catch { return false; }
}
async function lastDoneStep(gitDir: string): Promise<string> {
  return (await boundedFile(path.join(gitDir, 'rebase-merge', 'done'), 1024 * 1024)).toString('latin1').split(/\r?\n/).filter(line => line && !line.startsWith('#')).at(-1) ?? '';
}
/**
 * The operation whose sides the index conflicts follow, for Yours/Theirs (sidesFor), labels and Continue/Skip/Abort. It is detectOperation's answer except
 * inside a rebase that stopped and then ran another command: Git writes REBASE_HEAD for every conflicting rebase step in both backends (and a
 * CHERRY_PICK_HEAD, if any, names that same commit), an `edit` stop leaves rebase-merge/amend, and break and exec stops delete REBASE_HEAD. A cherry-pick,
 * revert, merge or stash apply run at such a stop owns its conflicts, and its stage 2 (`--ours`) is HEAD, the user's own work. Without a marker of its own
 * (a stash apply) the conflicts read as idle ones. REBASE_HEAD also stays when the user commits a resolved step by hand: a merge then is told apart from a
 * rebase -r `merge` step (which keeps REBASE_HEAD and no amend file) by the last done step, and a stash apply by its marker label.
 * Callers that need the bare rebase state (the owned rebase journal, the daily guard) keep detectOperation.
 */
export async function detectConflictOperation(gitDir: string, conflicts: boolean | (() => boolean), evidence: ConflictEvidence = {}): Promise<GitOperation> {
  const operation = await detectOperation(gitDir, evidence.refs);
  if (operation !== 'rebasing') return operation;
  if (await readPseudoRef(gitDir, 'REVERT_HEAD', evidence.refs) !== undefined) return 'reverting';
  // A squash or fixup that conflicts leaves `amend` too (it amends the commit before it), so the file alone does not say the user stopped the rebase on purpose.
  const replayed = await readPseudoRef(gitDir, 'REBASE_HEAD', evidence.refs), stopped = replayed === undefined || (await exists(path.join(gitDir, 'rebase-merge', 'amend')) && !await squashStep(gitDir));
  const picked = await readPseudoRef(gitDir, 'CHERRY_PICK_HEAD', evidence.refs);
  if (picked !== undefined && (stopped || picked !== replayed)) return 'cherry-picking';
  if (await exists(path.join(gitDir, 'MERGE_HEAD'))) return stopped || !await mergeStep(gitDir) ? 'merging' : operation;
  const conflicted = () => typeof conflicts === 'function' ? conflicts() : conflicts;
  if (stopped) return conflicted() ? 'idle' : operation;
  return evidence.stashMarkers && conflicted() && await evidence.stashMarkers() ? 'idle' : operation;
}
/** A rebase directory exists: with detectConflictOperation answering another operation, that rebase is paused underneath it. */
export async function rebasePaused(gitDir: string): Promise<boolean> {
  return await exists(path.join(gitDir, 'rebase-merge')) || await exists(path.join(gitDir, 'rebase-apply', 'rebasing'));
}
