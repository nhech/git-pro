import * as vscode from 'vscode';
import { lstat } from 'node:fs/promises';
import type { FeatureDeps } from '../conflicts/surfaces';
import { decode, type ChangedFile } from '../git/history/history-parser';
import { chunkPaths } from '../git/argv-chunks';
import { parseIndex } from '../git/conflicts/index-parser';
import { refuseUnsaved } from '../editor/open-files';
import { redact } from '../security/redaction';
import { validateOid } from '../security/refs';

/** Rows of the Compare tab's working-tree mode (§3.8): `git diff <oid>`, so `originalPath` of a rename is the branch-side name and `path` the working-tree one. `name` is for display only. */
export interface GetFromBranchInput { readonly repositoryId: string; readonly oid: string; readonly name: string; readonly files: readonly ChangedFile[] }

/**
 * Get from Branch: `restore --source=<oid> --worktree` for the chosen rows after one modal. A rename row passes both of its paths, so the working-tree name is
 * removed and the branch name restored together; paths the branch lacks are deleted. Only regular files on both sides qualify, as for revisions and conflicts.
 * GitService.restoreFromSource re-checks the idle state and the reviewed working content inside its coordinator slot. Resolves false when the user cancels.
 */
export async function getFromBranch(deps: Pick<FeatureDeps, 'git' | 'executor'>, request: GetFromBranchInput): Promise<boolean> {
  const oid = validateOid(request.oid);
  if (!request.files.length || request.files.length > 100) throw new Error('Select between 1 and 100 files.');
  const repo = deps.git.repository(request.repositoryId), name = request.name;
  const paths = [...new Set(request.files.flatMap(file => file.originalPath && file.originalPath !== file.path ? [file.originalPath, file.path] : [file.path]))];
  const absent = new Set<string>(), present = new Set<string>(), targets: { absolute: string; path: string }[] = [];
  // Bounded parallelism: up to 200 paths, two short reads each.
  for (let start = 0; start < paths.length; start += 8) {
    await Promise.all(paths.slice(start, start + 8).map(async file => {
      const absolute = await deps.git.authorizePath(repo.id, file);
      const entry = decode((await deps.executor.read(repo.root, { kind: 'tree', oid, path: file }, { maxOutputBytes: 64 * 1024 })).stdout);
      if (!entry) absent.add(file);
      else if (!/^100(?:644|755) blob [a-f0-9]{40,64}\t/.test(entry)) throw new Error(`Use native Git for ${redact(file)}: it is a symlink, submodule or folder in ${redact(name)}.`);
      const info = await lstat(absolute).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error(`Use native Git for ${redact(file)}: it is a symlink, submodule or folder in the working tree.`);
      if (info) present.add(file);
      targets.push({ absolute, path: file });
    }));
  }
  // `git diff <oid>` lists a path the index does not track as the branch's file even when an untracked or ignored file of that name is on disk. Restoring would
  // overwrite it, and Git keeps no copy of it; GitService.restoreFromSource refuses that again under its lock, this only keeps the modal from offering it.
  const tracked = new Set<string>();
  for (const group of chunkPaths([...present])) for (const entry of parseIndex((await deps.executor.read(repo.root, { kind: 'index', paths: group })).stdout)) tracked.add(entry.path);
  const untracked = paths.filter(file => present.has(file) && !tracked.has(file));
  if (untracked.length) throw new Error(`${redact(untracked[0]!)} is not tracked by Git${untracked.length > 1 ? ` (and ${untracked.length - 1} more)` : ''}. Get from Branch would overwrite it, and Git keeps no copy to restore it from. Move or delete it first.`);
  if (deps.git.repository(request.repositoryId) !== repo) throw new Error('Repository changed. Review Get from Branch again.');
  // Idle state, authorised files of this repository, and a fingerprint of their working content that the restore re-checks.
  const preview = await deps.git.preview(repo.id, paths);
  if (preview.status.changes.some(change => change.group === 'conflicts')) throw new Error('Resolve the current conflicts before getting files from a branch.');
  // N12: Git reads and writes these files on disk, so never under an unsaved editor or an open merge editor of any of them.
  await refuseUnsaved(targets);
  const restored = paths.filter(file => !absent.has(file)), removed = paths.filter(file => absent.has(file));
  const list = (values: readonly string[]) => `${values.slice(0, 20).join('\n')}${values.length > 20 ? `\n… and ${values.length - 20} more` : ''}`;
  const detail = redact(`Repository: ${repo.root}\nFrom: ${name} · ${oid.slice(0, 12)}\nLocal edits to these files are replaced. The index is not changed.` +
    `${restored.length ? `\n\nReplaced with the ${name} version (${restored.length}):\n${list(restored)}` : ''}${removed.length ? `\n\nDeleted, because ${name} does not have them (${removed.length}):\n${list(removed)}` : ''}`);
  const subject = paths.length === 1 ? paths[0]! : `${paths.length} files`;
  if (await vscode.window.showWarningMessage(redact(`Get ${subject} from ${name}?`), { modal: true, detail }, 'Get from Branch') !== 'Get from Branch') return false;
  // The modal can stay open while an editor changes; check again right before Git writes.
  await refuseUnsaved(targets);
  await deps.git.restoreFromSource(preview, oid);
  return true;
}
