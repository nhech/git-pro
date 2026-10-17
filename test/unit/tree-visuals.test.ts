import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchVisual, changeGroupVisual, changeStatusLabel, conflictKindLabels, repositoryToolVisual, repositoryVisual } from '../../src/views/tree-visuals';

test('the groups of the change tree have their own vivid theme colors and icons', () => {
  assert.equal(changeGroupVisual.staged.color, 'charts.green');
  assert.deepEqual(changeGroupVisual.untracked, { icon: 'new-file', color: 'charts.green' });
  assert.deepEqual(changeGroupVisual.working, { icon: 'diff-modified', color: 'charts.orange' });
  assert.deepEqual(changeGroupVisual.conflicts, { icon: 'warning', color: 'charts.red' });
});

test('change tree uses plain-language statuses while preserving unknown codes', () => {
  assert.equal(changeStatusLabel({ group: 'working', status: 'M' }), 'Modified');
  assert.equal(changeStatusLabel({ group: 'staged', status: 'A' }), 'Added');
  assert.equal(changeStatusLabel({ group: 'staged', status: 'D' }), 'Deleted');
  assert.equal(changeStatusLabel({ group: 'staged', status: 'R' }), 'Renamed');
  assert.equal(changeStatusLabel({ group: 'staged', status: 'C' }), 'Copied');
  assert.equal(changeStatusLabel({ group: 'staged', status: 'T' }), 'Type changed');
  assert.equal(changeStatusLabel({ group: 'untracked', status: '?' }), 'Untracked');
  assert.equal(changeStatusLabel({ group: 'conflicts', status: 'UU' }), 'Both modified');
  assert.equal(changeStatusLabel({ group: 'working', status: 'X' }), 'Git status X');
});

test('conflict rows name their kind in WebStorm words, with Yours and Theirs swapped during a rebase', () => {
  const merge = { UU: 'Both modified', AA: 'Both added', DU: 'Deleted by us', UD: 'Deleted by them', AU: 'Added by us', UA: 'Added by them', DD: 'Both deleted' } as const;
  for (const [code, label] of Object.entries(merge)) for (const operation of ['merging', 'cherry-picking', 'reverting', 'idle'] as const) assert.equal(changeStatusLabel({ group: 'conflicts', status: code }, operation), label, `${code} while ${operation}`);
  // A rebase replays the user's commit as Git --theirs: Git's "us" (the upstream) is Theirs.
  const rebase = { UU: 'Both modified', AA: 'Both added', DU: 'Deleted by them', UD: 'Deleted by us', AU: 'Added by them', UA: 'Added by us', DD: 'Both deleted' } as const;
  for (const [code, label] of Object.entries(rebase)) assert.equal(changeStatusLabel({ group: 'conflicts', status: code }, 'rebasing'), label, `${code} while rebasing`);
  assert.deepEqual(Object.keys(conflictKindLabels).sort(), ['addedByThem', 'addedByUs', 'bothAdded', 'bothDeleted', 'bothModified', 'deletedByThem', 'deletedByUs']);
  // Without the operation a one-sided kind is not guessed, and an unknown code stays generic.
  assert.equal(changeStatusLabel({ group: 'conflicts', status: 'DU' }), 'Conflict');
  assert.equal(changeStatusLabel({ group: 'conflicts', status: 'DD' }), 'Both deleted');
  assert.equal(changeStatusLabel({ group: 'conflicts', status: 'XY' }, 'merging'), 'Conflict');
});

test('branch, repository and repository-tool icons reinforce labels with theme colors', () => {
  assert.deepEqual(branchVisual({ remote: false, current: true }), { icon: 'git-branch', color: 'charts.green' });
  assert.deepEqual(branchVisual({ remote: false, current: false }), { icon: 'git-branch', color: 'charts.purple' });
  assert.deepEqual(branchVisual({ remote: true, current: false }), { icon: 'cloud', color: 'charts.blue' });
  assert.equal(repositoryVisual(true).icon, 'check');
  assert.equal(repositoryVisual(false).icon, 'repo');
  assert.deepEqual(Object.keys(repositoryToolVisual), ['Stashes', 'Tags', 'Remotes', 'Worktrees']);
  assert.equal(new Set(Object.values(repositoryToolVisual).map(visual => visual.icon)).size, 4);
});
