import type * as vscode from 'vscode';
import type { ChangedFile, FileStat, HistoryCommit } from '../../git/history/history-parser';
import type { DailyPreview } from '../../git/git.service';
import type { FeatureDeps } from '../../conflicts/surfaces';

/** Shared Compare contracts (design §4). Types only: WP4 implements the service and the tab, WP5 the entry points. */
export type CompareFilesMode = 'fork' | 'tips';
/** WP4's Compare tab. Refs are validated, resolved and pinned to OIDs before the tab shows; the same (repository, left OID, right OID) reveals the existing tab. */
export interface CompareSurface {
  openRefs(repositoryId: string, leftRef: string, rightRef: string): Promise<void>;
  /** Working-tree mode (§3.8): the ref against the working tree, with an editable working side and Get from Branch. */
  openWorktree(repositoryId: string, ref: string): Promise<void>;
}
/** Exported by WP4 as `createCompareSurface` from src/webviews/compare/compare-panel.ts; WP5's `registerCompare` calls it, sets `deps.surfaces.compare` and owns the disposal. It also registers the `git-pro-blob:` provider. */
export type CreateCompareSurface = (context: vscode.ExtensionContext, deps: FeatureDeps) => CompareSurface & vscode.Disposable;
export interface PinnedRef { readonly name: string; readonly oid: string }
/** `merge-base --all`: the first base and whether there were more; `oid` null for unrelated histories, or, with `shallow`, in a shallow clone whose boundary may hide the base. */
export interface MergeBase { readonly oid: string | null; readonly multiple: boolean; readonly shallow?: true }
export interface CompareFiles {
  readonly scope: 'fork' | 'tips' | 'commit' | 'worktree';
  /** OID the files are diffed from (merge base, left tip, commit parent or branch) and to; `to` is undefined for the working tree. */
  readonly from: string | undefined; readonly to: string | undefined;
  readonly files: readonly ChangedFile[]; readonly stats: readonly FileStat[];
  /** The listing hit the output limit, or (note `nonUtf8Path`) named a path that is not UTF-8: commits still show, files are not listed. */
  readonly omitted: boolean;
  /** Since-fork fell back or chose: several merge bases (first used), none (tip to tip), or none found in a shallow clone (tip to tip); or why the files are omitted. */
  readonly note?: 'multipleMergeBases' | 'noCommonAncestor' | 'shallowHistory' | 'nonUtf8Path';
}
export interface SideCommits { readonly count: number; readonly offset: number; readonly commits: readonly HistoryCommit[] }
export interface RefComparison {
  readonly repositoryId: string; readonly left: PinnedRef; readonly right: PinnedRef; readonly fork: MergeBase;
  /** "Commits in left, not in right" and the reverse, first page of 25. */
  readonly leftOnly: SideCommits; readonly rightOnly: SideCommits;
  readonly files: CompareFiles;
}
/** Methods WP4 adds to HistoryService (`HistoryService implements CompareService`). Every OID argument is a pin from an earlier result. */
export interface CompareService {
  compareRefs(repositoryId: string, leftRef: string, rightRef: string, mode: CompareFilesMode, signal?: AbortSignal): Promise<RefComparison>;
  mergeBase(repositoryId: string, left: string, right: string, signal?: AbortSignal): Promise<MergeBase>;
  comparisonFiles(repositoryId: string, left: string, right: string, mode: CompareFilesMode, signal?: AbortSignal): Promise<CompareFiles>;
  /** `git diff <oid>` against the working tree: tracked files, staged plus unstaged. */
  worktreeFiles(repositoryId: string, oid: string, signal?: AbortSignal): Promise<CompareFiles>;
  comparisonPage(repositoryId: string, tip: string, exclude: string, offset: number, signal?: AbortSignal): Promise<HistoryCommit[]>;
}
/** WP1 adds this public method to GitService (§3.8): `restore --source=<oid> --worktree` for exactly `preview.paths`, inside GitService.run (idle state, coordinator lock, working-content fingerprint, refresh). */
export interface RestoreFromSource { restoreFromSource(preview: DailyPreview, oid: string): Promise<void> }
