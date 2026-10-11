import * as vscode from 'vscode';
import type { ConflictBatch, ConflictRow, ConflictSide, ConflictsApi, OperationSide, OperationSummary } from '../../git/conflicts/conflict-contract';
import type { GitOperation } from '../../state/operation-state';
import type { ToolsService } from '../../git/tools/tools.service';
import { kindLabels, type CompareAction } from './conflicts-protocol';
import { refuseUnsaved } from '../../editor/open-files';
import { redact } from '../../security/redaction';

export interface ConflictActionDeps {
  readonly api: Pick<ConflictsApi, 'previewBatch' | 'acceptSide' | 'markResolved' | 'stageBlobs'>;
  readonly authorize: (repositoryId: string, file: string) => Promise<string>;
  readonly root: (repositoryId: string) => string;
  readonly revisions: { add(content: Buffer, label: string): vscode.Uri };
  readonly tools: Pick<ToolsService, 'preview' | 'execute'>;
  readonly summary: (repositoryId: string) => Promise<OperationSummary | undefined>;
  readonly checkTrust: () => void;
  /** The N2 confirmation. Host checks answer it without a native modal; everything else uses the modal warning. */
  readonly confirm?: (message: string, detail: string, action: string) => Promise<boolean>;
}
const files = (count: number) => `${count} ${count === 1 ? 'file' : 'files'}`;
const listed = (rows: readonly Pick<ConflictRow, 'path'>[]) => [...rows.slice(0, 20).map(row => row.path), ...(rows.length > 20 ? [`…and ${rows.length - 20} more`] : [])];
/** Modify/delete and add/rename rows: the working file is just the side Git kept, so staging it would choose that side silently, as for binary files (N13). */
const oneSidedReason = (row: Pick<ConflictRow, 'path' | 'kind'>) => `${redact(row.path)} is ${kindLabels[row.kind].toLowerCase()}: Mark Resolved would keep only the version Git left in the working tree. Choose Accept Yours or Accept Theirs.`;
const sideName = (side: OperationSide | undefined, fallback: string) => [side?.ref, side?.oid?.slice(0, 7)].filter(Boolean).join(' · ') || fallback;
/** What each side is in this operation, the words the N2 modal shows next to the Git flag. */
function role(operation: GitOperation | undefined, side: ConflictSide, summary: OperationSummary | undefined): string {
  if (operation === 'rebasing') return side === 'yours' ? 'the commit being rebased' : 'the upstream plus commits already rebased';
  if (side === 'yours') return operation === 'idle' ? 'the checked-out version' : 'the checked-out branch';
  if (operation === 'merging') return 'the branch being merged';
  if (operation === 'cherry-picking') return 'the commit being cherry-picked';
  if (operation === 'reverting') return 'the content before the reverted commit';
  const source = summary?.source?.kind;
  return source === 'squash' ? 'the squash-merged branch' : source ? 'the stashed changes' : 'the other side';
}

/** Conflicts-tab actions shared with the editor-title and Changes-view commands, so every caller gets the same N2 modal and N12 refusal. */
export class ConflictActions {
  constructor(private readonly deps: ConflictActionDeps) {}
  private async confirm(message: string, detail: string, action: string): Promise<boolean> {
    if (this.deps.confirm) return this.deps.confirm(message, detail, action);
    return await vscode.window.showWarningMessage(message, { modal: true, detail }, action) === action;
  }
  /** N12: Accept and Mark Resolved read and write the file on disk, so they never run under unsaved edits or an open merge editor of that file, under any path of it. */
  async guard(repositoryId: string, paths: readonly string[]): Promise<void> {
    const files: { absolute: string; path: string }[] = [];
    for (const file of paths) files.push({ absolute: await this.deps.authorize(repositoryId, file), path: file });
    await refuseUnsaved(files);
  }
  /**
   * Labels for the modal that describe the reviewed batch: a summary read for an earlier state (the tab's, before a reload or after a failed one) would name the
   * old operation's sides next to the new mapping, so only one with the batch's operation and HEAD is used; otherwise the sides keep generic names.
   */
  private async labels(repositoryId: string, batch: ConflictBatch, summary: OperationSummary | undefined): Promise<OperationSummary | undefined> {
    const matches = (value: OperationSummary | undefined) => value !== undefined && value.operation === batch.snapshot.operation && value.head === batch.snapshot.head;
    const fresh = await this.deps.summary(repositoryId).catch(() => undefined);
    return matches(fresh) ? fresh : matches(summary) ? summary : undefined;
  }
  /**
   * Owner decision Q2: one modal (N2), then restore and stage, or `rm` where the side has no file, in one guarded run. The modal names the repository, the operation,
   * the side and its Git flag, the files (deletions listed apart) and that edits are replaced. Resolves false when the user cancels.
   */
  async accept(repositoryId: string, paths: readonly string[], side: ConflictSide, summary?: OperationSummary): Promise<boolean> {
    this.deps.checkTrust();
    const batch = await this.deps.api.previewBatch(repositoryId, paths), targets = batch.rows.map(row => row.path);
    await this.guard(repositoryId, targets);
    const known = await this.labels(repositoryId, batch, summary), label = side === 'yours' ? 'Yours' : 'Theirs', action = `Accept ${label}`;
    const removed = batch.rows.filter(row => row[side] === 'deleted' || row[side] === 'absent'), kept = batch.rows.filter(row => !removed.includes(row));
    const detail = [this.deps.root(repositoryId), known?.title ?? 'Unresolved conflicts',
      `${label} = ${sideName(known?.[side], side === 'yours' ? 'your version' : 'their version')} (${role(batch.snapshot.operation, side, known)}) → git --${batch.sides[side].flag}`,
      ...(kept.length ? ['', `Replaces ${kept.length === 1 ? 'the working file' : 'each working file'}, including any edits you made, with ${label} and stages it:`, ...listed(kept)] : []),
      ...(removed.length ? ['', `Deletes ${removed.length === 1 ? 'this file' : 'these files'} and stages the deletion, because ${label} has no file:`, ...listed(removed)] : [])].join('\n');
    if (!await this.confirm(`${action} for ${files(batch.rows.length)}?`, redact(detail), action)) return false;
    // The modal can stay open while an editor changes; check again right before Git writes.
    await this.guard(repositoryId, targets);
    await this.deps.api.acceptSide(batch, side);
    return true;
  }
  /** Stages reviewed text files with no marker lines; ConflictsApi refuses the whole batch again on the fresh snapshot (N13, N14). */
  async markResolved(repositoryId: string, paths: readonly string[]): Promise<void> {
    this.deps.checkTrust();
    const batch = await this.deps.api.previewBatch(repositoryId, paths);
    const binary = batch.rows.find(row => row.binary), missing = batch.rows.find(row => !row.workingFile), marked = batch.rows.find(row => row.markers?.present !== false);
    const oneSided = batch.rows.find(row => row.kind !== 'bothModified' && row.kind !== 'bothAdded');
    if (binary) throw new Error(`${redact(binary.path)} is binary. Choose Accept Yours or Accept Theirs.`);
    if (missing) throw new Error(`${redact(missing.path)} has no working file. Choose Accept Yours or Accept Theirs.`);
    if (oneSided) throw new Error(oneSidedReason(oneSided));
    if (marked) throw new Error(`Conflict markers remain in ${redact(marked.path)}. Use Merge… or edit the file, then Mark Resolved.`);
    await this.guard(repositoryId, batch.rows.map(row => row.path));
    await this.deps.api.markResolved(batch);
  }
  /** Read-only text compares of the stage blobs, sides mapped through `sidesFor` (D3). */
  async compare(repositoryId: string, file: string, action: CompareAction, summary?: OperationSummary): Promise<void> {
    const blobs = await this.deps.api.stageBlobs(repositoryId, file), known = summary ?? await this.deps.summary(repositoryId).catch(() => undefined);
    const yours = blobs.sides.yours.stage === 2 ? blobs.ours : blobs.theirs, theirs = blobs.sides.theirs.stage === 2 ? blobs.ours : blobs.theirs;
    const named = (side: ConflictSide) => { const value = known?.[side], ref = value?.ref ?? value?.oid?.slice(0, 7); return `${side === 'yours' ? 'Yours' : 'Theirs'}${ref ? ` (${ref})` : ''}`; };
    const [left, right, title] = action === 'compareBaseYours' ? [blobs.base, yours, `Base ↔ ${named('yours')}`] : action === 'compareBaseTheirs' ? [blobs.base, theirs, `Base ↔ ${named('theirs')}`] : [yours, theirs, `${named('yours')} ↔ ${named('theirs')}`];
    await vscode.commands.executeCommand('vscode.diff', this.deps.revisions.add(left, file), this.deps.revisions.add(right, file), redact(`${file}: ${title}`));
  }
  async openFile(repositoryId: string, file: string): Promise<void> {
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(await this.deps.authorize(repositoryId, file)));
  }
  /** §3.2 Finish: offered only after a Git Pro Pop stopped on conflicts. ToolsService refuses while conflicts or an operation remain and re-checks the stash identity. */
  async dropStash(repositoryId: string, stash: { readonly selector: string; readonly oid: string }): Promise<boolean> {
    this.deps.checkTrust();
    const preview = await this.deps.tools.preview(repositoryId, { kind: 'stashDrop', selector: stash.selector, expected: stash.oid });
    const detail = redact(`${this.deps.root(repositoryId)}\n${stash.selector} · ${stash.oid}\nGit kept this stash when applying it stopped on conflicts. Dropping it deletes it.`);
    if (!await this.confirm(`Drop ${stash.selector}?`, detail, 'Drop Stash')) return false;
    await this.deps.tools.execute(preview);
    return true;
  }
}
