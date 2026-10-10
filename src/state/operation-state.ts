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
