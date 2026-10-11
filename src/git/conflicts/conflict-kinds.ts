import type { GitOperation } from '../../state/operation-state';
import type { ConflictCode, ConflictKind, GitSideRef, SideMap, SideStatus, SidesFor, StagePresence } from './conflict-contract';
import type { IndexEntry } from './index-parser';

const ours: GitSideRef = Object.freeze({ stage: 2, flag: 'ours' }), theirs: GitSideRef = Object.freeze({ stage: 3, flag: 'theirs' });
const usual: SideMap = Object.freeze({ yours: ours, theirs }), rebase: SideMap = Object.freeze({ yours: theirs, theirs: ours });
/**
 * D3/N3, the only place Yours and Theirs meet Git stages. Yours is the user's work: during a rebase (either backend) that is the commit being replayed,
 * Git `--theirs`; in every other operation, including idle stash and squash conflicts, it is the checked-out side, Git `--ours`. `operation` must be the one that
 * owns the conflicts (detectConflictOperation, as every snapshot and summary reads it): a cherry-pick, revert, merge or stash apply run at a rebase stop is not the rebase.
 */
export const sidesFor: SidesFor = (operation: GitOperation) => operation === 'rebasing' ? rebase : usual;
const codes: ReadonlySet<string> = new Set(['UU', 'AA', 'DU', 'UD', 'AU', 'UA', 'DD']);
export function isConflictCode(value: string): value is ConflictCode { return codes.has(value); }
/** Git names X for `--ours` and Y for `--theirs`; read through sidesFor, a rebase's DU (deleted by Git's "us", the upstream) is deleted by Theirs. */
export function conflictKind(code: ConflictCode, operation: GitOperation): ConflictKind {
  if (code === 'UU') return 'bothModified'; if (code === 'AA') return 'bothAdded'; if (code === 'DD') return 'bothDeleted';
  const gitUs = code === 'DU' || code === 'AU', yoursIsGitUs = sidesFor(operation).yours.flag === 'ours';
  const byYours = gitUs === yoursIsGitUs;
  return code[0] === 'D' || code[1] === 'D' ? byYours ? 'deletedByUs' : 'deletedByThem' : byYours ? 'addedByUs' : 'addedByThem';
}
export function stagePresence(entries: readonly Pick<IndexEntry, 'stage'>[]): StagePresence {
  return Object.freeze({ base: entries.some(entry => entry.stage === 1), ours: entries.some(entry => entry.stage === 2), theirs: entries.some(entry => entry.stage === 3) });
}
export function sidePresent(stages: StagePresence, side: GitSideRef): boolean { return side.stage === 2 ? stages.ours : stages.theirs; }
/** Base and side → modified, side only → added, base only → deleted, neither → absent (the other side of AU/UA). */
export function sideStatus(stages: StagePresence, side: GitSideRef): SideStatus {
  return sidePresent(stages, side) ? stages.base ? 'modified' : 'added' : stages.base ? 'deleted' : 'absent';
}
