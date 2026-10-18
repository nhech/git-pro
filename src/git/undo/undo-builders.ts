import { validateOid } from '../../security/refs';

/**
 * The Git commands behind the safety copies Git Pro keeps before it throws something away. A copy is a commit (`git stash create` writes one for the tracked changes without touching the
 * working tree, the index or the stash list) or an old commit, kept alive by a ref of Git Pro's own under `refs/gitpro/undo/`, so `git gc` leaves it alone until Git Pro lets it go.
 */
export type UndoMutation = { kind: 'undoSnapshot' } | { kind: 'undoKeep'; name: string; oid: string } | { kind: 'undoDrop'; name: string };

/** `<milliseconds>-<kind>` and, when two copies share a millisecond, `-<n>`. */
export const undoNamePattern = /^\d{10,15}-(?:discard|reset|push)(?:-\d{1,3})?$/;
function undoName(value: string): string {
  if (typeof value !== 'string' || !undoNamePattern.test(value)) throw new Error('Invalid safety copy name.');
  return value;
}
export function buildUndoMutation(command: UndoMutation): string[] {
  const prefix = ['--literal-pathspecs', '--no-pager', '-c', 'color.ui=false'];
  switch (command.kind) {
    // Prints the commit's ID, or nothing when no tracked file differs from HEAD.
    case 'undoSnapshot': return [...prefix, 'stash', 'create', 'Git Pro safety copy'];
    case 'undoKeep': return [...prefix, 'update-ref', '-m', 'Git Pro safety copy', `refs/gitpro/undo/${undoName(command.name)}`, validateOid(command.oid)];
    case 'undoDrop': return [...prefix, 'update-ref', '-d', `refs/gitpro/undo/${undoName(command.name)}`];
  }
}
