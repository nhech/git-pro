import type { RepositoryToolGroup } from './repository-tools-context';

/**
 * The right-click menu of the Repository Tools view: one command per choice, each naming the Quick Pick entry it stands for, so a menu choice runs the same reviewed flow
 * as picking that entry. A singular kind (`stash`) is a row of the view and a plural one (`stashes`) its group. No `vscode` import: unit tests load this module as it is.
 */
export const toolMenus = [
  ['stash.inspect', 'Inspect Files'], ['stash.apply', 'Apply'], ['stash.pop', 'Pop'], ['stash.branch', 'Create Branch'], ['stash.drop', 'Drop'],
  ['tag.message', 'View Message'], ['tag.compare', 'Compare With HEAD'], ['tag.checkout', 'Checkout Detached'], ['tag.branch', 'Create Branch'], ['tag.push', 'Push'], ['tag.deleteLocal', 'Delete Local'], ['tag.deleteRemote', 'Delete Remote'],
  ['remote.fetch', 'Fetch'], ['remote.pushBranch', 'Push Local Branch'], ['remote.upstream', 'Set Branch Upstream'], ['remote.rename', 'Rename'], ['remote.fetchUrl', 'Set Fetch URL'], ['remote.pushUrl', 'Set Push URL'], ['remote.prune', 'Prune'], ['remote.remove', 'Remove'],
  ['worktree.open', 'Open in New Window'], ['worktree.remove', 'Remove'],
  ['stashes.create', 'Create'], ['tags.create', 'Create'], ['remotes.create', 'Create'], ['worktrees.create', 'Create'], ['worktrees.prune', 'Prune']
] as const;

const rowKind: Readonly<Record<RepositoryToolGroup, string>> = { Stashes: 'stash', Tags: 'tag', Remotes: 'remote', Worktrees: 'worktree' };
/** The `viewItem` the menus above are scoped to. */
export function toolContextValue(group: RepositoryToolGroup, row: boolean): string { return row ? `gitPro.tools.row.${rowKind[group]}` : `gitPro.tools.group.${group.toLowerCase()}`; }
