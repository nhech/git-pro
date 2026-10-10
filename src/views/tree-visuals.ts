import type { ChangeGroup, FileChange } from '../git/git-parser';

export interface TreeVisual {
  readonly icon: string;
  readonly color: string;
}

export const changeGroupVisual: Readonly<Record<ChangeGroup, TreeVisual>> = {
  staged: { icon: 'git-commit', color: 'charts.green' },
  working: { icon: 'diff-modified', color: 'charts.orange' },
  untracked: { icon: 'new-file', color: 'charts.green' },
  conflicts: { icon: 'warning', color: 'charts.red' },
};

export function changeFileVisual(change: Pick<FileChange, 'group' | 'status'>): TreeVisual {
  if (change.group === 'conflicts') return changeGroupVisual.conflicts;
  if (change.group === 'untracked' || change.status === '?') return changeGroupVisual.untracked;
  if (change.status.includes('D')) return { icon: 'diff-removed', color: 'charts.red' };
  if (change.status.includes('R')) return { icon: 'diff-renamed', color: 'charts.blue' };
  if (change.status.includes('A')) return { icon: 'diff-added', color: 'charts.green' };
  if (change.status.includes('C')) return { icon: 'copy', color: 'charts.purple' };
  if (change.status.includes('T')) return { icon: 'symbol-property', color: 'charts.purple' };
  return changeGroupVisual.working;
}

export function changeStatusLabel(change: Pick<FileChange, 'group' | 'status'>): string {
  if (change.group === 'conflicts') return 'Conflict';
  if (change.group === 'untracked' || change.status === '?') return 'Untracked';
  const labels: Readonly<Record<string, string>> = {
    A: 'Added', C: 'Copied', D: 'Deleted', M: 'Modified', R: 'Renamed', T: 'Type changed', U: 'Conflict',
  };
  return labels[change.status] ?? `Git status ${change.status}`;
}

export function branchVisual(input: { readonly remote: boolean; readonly current: boolean }): TreeVisual {
  if (input.remote) return { icon: 'cloud', color: 'charts.blue' };
  if (input.current) return { icon: 'git-branch', color: 'charts.green' };
  return { icon: 'git-branch', color: 'charts.purple' };
}

export type RepositoryToolGroup = 'Stashes' | 'Tags' | 'Remotes' | 'Worktrees';

export const repositoryToolVisual: Readonly<Record<RepositoryToolGroup, TreeVisual>> = {
  Stashes: { icon: 'archive', color: 'charts.orange' },
  Tags: { icon: 'tag', color: 'charts.yellow' },
  Remotes: { icon: 'cloud', color: 'charts.blue' },
  Worktrees: { icon: 'repo', color: 'charts.purple' },
};

export function repositoryVisual(active: boolean): TreeVisual {
  return active ? { icon: 'check', color: 'charts.green' } : { icon: 'repo', color: 'descriptionForeground' };
}
