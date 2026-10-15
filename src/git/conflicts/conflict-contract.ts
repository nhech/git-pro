import type { GitOperation } from '../../state/operation-state';
import type { AdvancedService, OperationSnapshot } from '../advanced/advanced.service';

/** Shared conflict contracts (design §4). Types only: WP1 implements them in conflicts.service.ts, conflict-kinds.ts and operation-context.ts, WP2 in the Conflicts tab and merge bridge. */

/** XY code of a porcelain v2 `u` record. */
export type ConflictCode = 'UU' | 'AA' | 'DU' | 'UD' | 'AU' | 'UA' | 'DD';
/** WebStorm point of view (D3): "us" is Yours and "them" is Theirs, so during a rebase Git's `DU` reads `deletedByThem`. */
export type ConflictKind = 'bothModified' | 'bothAdded' | 'deletedByUs' | 'deletedByThem' | 'addedByUs' | 'addedByThem' | 'bothDeleted';
/** From index stage presence: base and side → modified, side only → added, base only → deleted, neither → absent. Accepting a `deleted` or `absent` side removes the file. */
export type SideStatus = 'modified' | 'added' | 'deleted' | 'absent';
export type ConflictSide = 'yours' | 'theirs';
/** Where a WebStorm side lives in Git: stage 2 is `--ours`, stage 3 is `--theirs`. */
export interface GitSideRef { readonly stage: 2 | 3; readonly flag: 'ours' | 'theirs' }
/** Produced only by WP1's `sidesFor(operation)`: rebasing → yours = stage 3 / `--theirs`, theirs = stage 2 / `--ours`; every other operation, including idle stash and squash conflicts → yours = stage 2 / `--ours`. */
export interface SideMap { readonly yours: GitSideRef; readonly theirs: GitSideRef }
export type SidesFor = (operation: GitOperation) => SideMap;
/** Git stages 1 (base), 2 (`--ours`) and 3 (`--theirs`). */
export interface StagePresence { readonly base: boolean; readonly ours: boolean; readonly theirs: boolean }

export interface ConflictRow {
  readonly path: string; readonly code: ConflictCode; readonly kind: ConflictKind;
  readonly yours: SideStatus; readonly theirs: SideStatus; readonly stages: StagePresence;
  /** `present` is `hasConflictMarkers`, the Mark Resolved gate; `blocks` is display only and null when the blocks do not parse. Null when the file was not read: binary, unsupported, missing, or beyond the 16 MiB marker budget ("not counted"). */
  readonly markers: { readonly present: boolean; readonly blocks: number | null } | null;
  readonly binary: boolean;
  /** UU or AA, bounded regular UTF-8 text: Merge… may open it. */
  readonly mergeable: boolean;
  /** Why Git Pro leaves this row to native Git ("Use native Git: symlink"); every action is disabled. */
  readonly unsupported?: string;
  /** lstat found a regular working file; Open File is hidden otherwise. */
  readonly workingFile: boolean;
}
/** Recorded in memory by the Git Pro action that stopped on conflicts without leaving operation metadata. A Pop alone offers Drop Stash. */
export type ConflictSource = { readonly kind: 'stashPop' | 'stashApply'; readonly oid: string; readonly selector: string } | { readonly kind: 'squash'; readonly oid: string };
/** One side as the banner, the tab header and the merge-editor pane show it. Labels come from repository files (N6): validated, then `redact()` and `textContent` only. */
export interface OperationSide {
  readonly label: 'Yours' | 'Theirs'; readonly ref?: string; readonly oid?: string; readonly subject?: string;
  /** Merge-editor pane detail: the ref names, or the WebStorm rebase wording ("Rebasing 9f8e7d6 from feature", "Already rebased commits and commits from main"). */
  readonly detail: string;
}
export interface OperationSummary {
  readonly repositoryId: string; readonly operation: GitOperation;
  /** HEAD when the summary was read: with `operation` it tells whether the summary still describes a later snapshot. */
  readonly head?: string;
  /** "Merging feature into main", "Rebasing feature onto main", "Cherry-picking 9f8e7d6 onto main", "Conflicts from applying stash@{0} (stash kept)", "Squash-merging feature", "Unresolved conflicts". */
  readonly title: string;
  readonly yours: OperationSide; readonly theirs: OperationSide; readonly sides: SideMap;
  /** Rebase step from rebase-merge/msgnum and end, or rebase-apply/next and last. */
  readonly progress?: { readonly current: number; readonly total: number };
  /** Idle conflicts: the in-memory record, or `stashMarkers` when only the `>>>>>>> Stashed changes` labels identify a stash. */
  readonly source?: ConflictSource | { readonly kind: 'stashMarkers' };
  readonly conflicts: number; readonly editStop: boolean;
  readonly canContinue: boolean; readonly canSkip: boolean; readonly canAbort: boolean;
  /** Bisect, git-am or an unknown sequencer: finish in native Git. */
  readonly nativeOnly: boolean;
}
export interface OperationSummaryProvider { summary(repositoryId: string, signal?: AbortSignal): Promise<OperationSummary> }
export interface ConflictList {
  /** Every row comes from this one snapshot. */
  readonly snapshot: OperationSnapshot; readonly summary: OperationSummary;
  /** At most 5000, in path order; `truncated` when more conflicts exist. */
  readonly rows: readonly ConflictRow[]; readonly truncated: boolean;
}
/** Single-use plan for 1–100 current conflicts, read from one fresh snapshot whose fingerprint the mutation re-checks. Rows keep the request order. */
export interface ConflictBatch { readonly snapshot: OperationSnapshot; readonly sides: SideMap; readonly rows: readonly ConflictRow[] }
/** Bounded stage blobs (5 MiB each, no textconv); an absent stage is an empty Buffer. */
export interface StageBlobs { readonly path: string; readonly operation: GitOperation; readonly sides: SideMap; readonly base: Buffer; readonly ours: Buffer; readonly theirs: Buffer }
/** WP1: `ConflictsService implements ConflictsApi`. Callers show the N2 modal and the N12 dirty-buffer refusal before any mutation. */
export interface ConflictsApi {
  list(repositoryId: string, signal?: AbortSignal): Promise<ConflictList>;
  previewBatch(repositoryId: string, paths: readonly string[]): Promise<ConflictBatch>;
  /**
   * One step (owner decision Q2): per path `restore --ours|--theirs --worktree` then `add` at that side's file mode, or `rm -f` when that side has no file, all in
   * one guarded run; a failure once anything took effect (restore replaces the files one by one) reports `partiallyApplied`.
   */
  acceptSide(batch: ConflictBatch, side: ConflictSide): Promise<void>;
  /** `git add` in one guarded run after re-reading every path in the fresh snapshot; the whole batch is refused when any path has marker lines (N14) or is binary (N13). */
  markResolved(batch: ConflictBatch): Promise<void>;
  stageBlobs(repositoryId: string, path: string): Promise<StageBlobs>;
}
/** WP2's bridge to VS Code's merge editor (§3.3). Pane order (owner decision Q1): input1 (left) = Yours, input2 (right) = Theirs, mapped through `sidesFor`. */
export interface MergeBridge {
  /** Reveals a merge editor already open on this file, otherwise opens one; resolves false when nothing opened. */
  open(repositoryId: string, path: string): Promise<boolean>;
  /** A merge editor whose Result is this absolute file is open, under this path or any other path of the same file (junction, symlink, mapped drive, 8.3 name). */
  isOpen(file: string): Promise<boolean>;
}
/** `select` holds repository-relative paths (at most 100) to select once the tab has rows. */
export interface ConflictsOpenOptions { readonly select?: readonly string[]; readonly preserveFocus?: boolean }
/** One tab per repository. `open` resolves once the tab is revealed, before its rows load: the failure toast waits for it. */
export interface ConflictsSurface { open(repositoryId: string, options?: ConflictsOpenOptions): Promise<void> }
export type OperationControlAction = 'continue' | 'abort' | 'skip';
/** `mergeMessage`: a message the caller already collected, committed with `commit -m` and Git's default cleanup. Without it a merge Continue offers [Commit Merge] and [Edit Message…]. */
export interface ControlOptions { readonly mergeMessage?: string }
/** WP1 exports `confirmAndControl` with this type from src/commands/advanced.commands.ts: the §3.4 modal confirmations, then `AdvancedService.control`. Resolves false when the user cancels. */
export type ConfirmAndControl = (advanced: AdvancedService, snapshot: OperationSnapshot, action: OperationControlAction, options?: ControlOptions) => Promise<boolean>;
