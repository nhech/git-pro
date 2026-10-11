import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { boundedFile } from '../utils/bounded-file';
export type GitOperation = 'idle' | 'merging' | 'rebasing' | 'cherry-picking' | 'reverting' | 'bisecting' | 'applying-mail' | 'unknown-sequencer';
async function exists(file: string): Promise<boolean> {
  try { await stat(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
export async function detectOperation(gitDir: string): Promise<GitOperation> {
  if (await exists(path.join(gitDir, 'rebase-merge'))) return 'rebasing';
  if (await exists(path.join(gitDir, 'rebase-apply'))) {
    return await exists(path.join(gitDir, 'rebase-apply', 'rebasing')) ? 'rebasing' : 'applying-mail';
  }
  if (await exists(path.join(gitDir, 'MERGE_HEAD'))) return 'merging';
  if (await exists(path.join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-picking';
  if (await exists(path.join(gitDir, 'REVERT_HEAD'))) return 'reverting';
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
/** First line of a pseudo-ref file: undefined when it is absent, '' when it cannot be read (still evidence that it exists). */
async function marker(file: string): Promise<string | undefined> {
  try { return (await boundedFile(file, 4096)).toString('latin1').split(/\r?\n/)[0]!.trim(); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : ''; }
}
/**
 * The operation whose sides the index conflicts follow, for Yours/Theirs (sidesFor), labels and Continue/Skip/Abort. It is detectOperation's answer except
 * inside a rebase that stopped cleanly and then ran another command: Git writes REBASE_HEAD for every conflicting rebase step in both backends (and a
 * CHERRY_PICK_HEAD, if any, names that same commit), an `edit` stop leaves rebase-merge/amend, and break and exec stops delete REBASE_HEAD. A cherry-pick,
 * revert, merge or stash apply run at such a stop owns its conflicts, and its stage 2 (`--ours`) is HEAD, the user's own work. Without a marker of its own
 * (a stash apply) the conflicts read as idle ones. A rebase's own `merge` step (rebase -r) keeps REBASE_HEAD and no amend file, so it stays a rebase.
 * Callers that need the bare rebase state (the owned rebase journal, the daily guard) keep detectOperation.
 */
export async function detectConflictOperation(gitDir: string, conflicts: boolean | (() => boolean)): Promise<GitOperation> {
  const operation = await detectOperation(gitDir);
  if (operation !== 'rebasing') return operation;
  if (await exists(path.join(gitDir, 'REVERT_HEAD'))) return 'reverting';
  const replayed = await marker(path.join(gitDir, 'REBASE_HEAD')), stopped = replayed === undefined || await exists(path.join(gitDir, 'rebase-merge', 'amend'));
  const picked = await marker(path.join(gitDir, 'CHERRY_PICK_HEAD'));
  if (picked !== undefined && (stopped || picked !== replayed)) return 'cherry-picking';
  if (!stopped) return operation;
  if (await exists(path.join(gitDir, 'MERGE_HEAD'))) return 'merging';
  return (typeof conflicts === 'function' ? conflicts() : conflicts) ? 'idle' : operation;
}
/** A rebase directory exists: with detectConflictOperation answering another operation, that rebase is paused underneath it. */
export async function rebasePaused(gitDir: string): Promise<boolean> {
  return await exists(path.join(gitDir, 'rebase-merge')) || await exists(path.join(gitDir, 'rebase-apply', 'rebasing'));
}
