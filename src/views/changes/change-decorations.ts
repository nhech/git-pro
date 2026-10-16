import type { FileChange } from '../../git/git-parser';
import { changeStatusLabel } from '../tree-visuals';

/**
 * Rows of the Changes view carry a URI of this scheme, so the workbench draws the status letter at the far edge of the row, as Source Control does.
 * Pure (no `vscode` import): unit tests load this module as it is.
 */
export const changeScheme = 'git-pro-change';

/** What the URI of a row says about its change; the decoration is a pure function of it, so it can never be stale. */
export function changeQuery(change: Pick<FileChange, 'group' | 'status'>): string { return `g=${change.group}&s=${encodeURIComponent(change.status)}`; }

export function readChangeQuery(query: string): { readonly group: string; readonly status: string } | undefined {
  const values = new URLSearchParams(query), group = values.get('g'), status = values.get('s');
  return group === null || status === null ? undefined : { group, status };
}

/** The letter, colour and wording of one change. A decoration's badge is one or two characters, so the long wording goes in its tooltip. */
export function decorationFor(group: string, status: string): { readonly badge: string; readonly color: string; readonly label: string } {
  if (group === 'conflicts') return { badge: '!', color: 'gitDecoration.conflictingResourceForeground', label: changeStatusLabel({ group: 'conflicts', status }) };
  if (group === 'untracked' || status === '?') return { badge: 'U', color: 'gitDecoration.untrackedResourceForeground', label: 'Untracked' };
  const letter = status.replace(/[ .]/g, '').charAt(0) || 'M', staged = group === 'staged';
  const color = letter === 'A' || letter === 'C' ? 'gitDecoration.addedResourceForeground' : letter === 'D' ? (staged ? 'gitDecoration.stageDeletedResourceForeground' : 'gitDecoration.deletedResourceForeground')
    : letter === 'R' ? 'gitDecoration.renamedResourceForeground' : staged ? 'gitDecoration.stageModifiedResourceForeground' : 'gitDecoration.modifiedResourceForeground';
  return { badge: letter, color, label: changeStatusLabel({ group: group as FileChange['group'], status }) };
}
