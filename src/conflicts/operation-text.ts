import type { GitOperation } from '../state/operation-state';
import type { OperationSummary } from '../git/conflicts/conflict-contract';

/** Shared wording for the Changes banner, the status bar, the operation menu and the watcher toast (§3.4). Pure: no vscode import, so vm-loaded tests require it as is. */
export type ControllableOperation = 'merging' | 'rebasing' | 'cherry-picking' | 'reverting';
export const controllable = (operation: GitOperation): operation is ControllableOperation => operation === 'merging' || operation === 'rebasing' || operation === 'cherry-picking' || operation === 'reverting';
const nouns: Readonly<Record<GitOperation, string>> = { idle: 'Conflict resolution', merging: 'Merge', rebasing: 'Rebase', 'cherry-picking': 'Cherry-pick', reverting: 'Revert', bisecting: 'Bisect', 'applying-mail': 'git am', 'unknown-sequencer': 'Git sequence' };
export const operationNoun = (operation: GitOperation): string => nouns[operation];
export const conflictCount = (count: number): string => `${count} ${count === 1 ? 'conflict' : 'conflicts'}`;
export const continueLabel = (operation: ControllableOperation): string => `Continue ${nouns[operation]}…`;
export const skipLabel = (operation: ControllableOperation): string => operation === 'rebasing' ? 'Skip Commit…' : 'Skip…';
/** Bisect, git-am and unknown sequencers have no Git Pro controls; a summary may also say so. */
export const nativeOnly = (operation: GitOperation, summary?: OperationSummary): boolean => operation === 'bisecting' || operation === 'applying-mail' || operation === 'unknown-sequencer' || summary !== undefined && summary.operation === operation && summary.nativeOnly;
/** The summary's title only when it describes the same operation: a summary computed before a refresh must not relabel the new state. */
export function operationTitle(operation: GitOperation, summary?: OperationSummary): string {
  if (summary && summary.operation === operation && summary.title) return summary.title;
  return operation === 'idle' ? 'Unresolved conflicts' : `${nouns[operation]} in progress`;
}
export type BannerActionId = 'resolve' | 'continue' | 'skip' | 'abort' | 'amend' | 'sourceControl';
/** `disabled` is the reason shown as the tooltip; the button stays focusable with aria-disabled. */
export interface BannerAction { readonly id: BannerActionId; readonly label: string; readonly title: string; readonly primary?: true; readonly disabled?: string }
export interface OperationBanner { readonly operation: GitOperation; readonly name: string; readonly icon: string; readonly text: string; readonly actions: readonly BannerAction[] }
/** Rebase step and the commit being replayed (Yours during a rebase, D3), as "3/7 · 9f8e7d6 Add login". */
function rebaseStep(summary: OperationSummary | undefined, operation: GitOperation): string[] {
  if (summary === undefined || summary.operation !== operation) return [];
  const parts = summary.progress ? [`${summary.progress.current}/${summary.progress.total}`] : [];
  if (operation === 'rebasing' && summary.yours.oid) parts.push(`${summary.yours.oid.slice(0, 7)}${summary.yours.subject ? ` ${summary.yours.subject.slice(0, 72)}` : ''}`);
  return parts;
}
/** §3.4 table. `conflicts` comes from the same status snapshot as the rows, never from the summary, so the banner and the list always agree. */
export function operationBanner(operation: GitOperation, conflicts: number, summary?: OperationSummary): OperationBanner | undefined {
  const current = summary !== undefined && summary.operation === operation ? summary : undefined;
  const resolve: BannerAction = { id: 'resolve', label: 'Resolve…', title: 'Open the Conflicts tab', primary: true };
  if (nativeOnly(operation, current)) {
    return { operation, name: `${nouns[operation]} in progress`, icon: 'info', text: [`${nouns[operation]} in progress — finish in native Git`, ...(conflicts ? [conflictCount(conflicts)] : [])].join(' · '),
      actions: [{ id: 'sourceControl', label: 'Open Source Control', title: 'Finish this operation in Source Control or a terminal' }] };
  }
  // Idle: only conflicts left by a stash apply, a squash merge or the terminal earn a banner.
  if (!controllable(operation)) return conflicts > 0 ? { operation, name: 'Unresolved conflicts', icon: 'warning', text: `${operationTitle(operation, current)} · ${conflictCount(conflicts)}`, actions: [resolve] } : undefined;
  const editStop = Boolean(current?.editStop) && conflicts < 1, canContinue = current ? current.canContinue : true, canSkip = current ? current.canSkip : operation !== 'merging', canAbort = current ? current.canAbort : true;
  const state = conflicts ? conflictCount(conflicts) : editStop ? 'stopped to edit this commit' : 'all conflicts resolved';
  const blocked = conflicts ? 'Resolve and stage all conflicts first' : canContinue ? undefined : `Git Pro cannot continue this ${nouns[operation].toLowerCase()}; use native Git`;
  const actions: BannerAction[] = [
    ...(conflicts ? [resolve] : []),
    { id: 'continue', label: continueLabel(operation), title: blocked ?? (operation === 'merging' ? 'Commit the merge' : `Continue the ${nouns[operation].toLowerCase()}`), ...(blocked ? { disabled: blocked } : conflicts ? {} : { primary: true as const }) },
    ...(editStop ? [{ id: 'amend' as const, label: 'Amend…', title: 'Amend the stopped commit with the staged changes' }] : []),
    ...(canSkip && operation !== 'merging' && !editStop ? [{ id: 'skip' as const, label: skipLabel(operation), title: operation === 'rebasing' ? 'Skip the commit being replayed' : 'Skip the current commit' }] : []),
    ...(canAbort ? [{ id: 'abort' as const, label: 'Abort…', title: `Abort the ${nouns[operation].toLowerCase()} and return to the original state` }] : [])
  ];
  return { operation, name: `${nouns[operation]} in progress`, icon: conflicts ? 'warning' : editStop ? 'edit' : 'pass', text: [operationTitle(operation, current), ...rebaseStep(current, operation), state].join(' · '), actions };
}
/** Status bar and menu line: "Merging feature into main · 3 conflicted files". */
export function operationStatus(operation: GitOperation, conflicts: number, summary?: OperationSummary): string {
  const files = `${conflicts} conflicted ${conflicts === 1 ? 'file' : 'files'}`;
  // The plain wording here: a summary's title for these states already says "finish in native Git".
  if (nativeOnly(operation, summary)) return [`${nouns[operation]} in progress — finish in native Git`, ...(conflicts ? [files] : [])].join(' · ');
  return [operationTitle(operation, summary), ...rebaseStep(summary, operation), conflicts ? files : controllable(operation) ? 'all conflicts resolved' : 'no conflicts'].join(' · ');
}
