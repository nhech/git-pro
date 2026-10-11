import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchVisual, changeFileVisual, changeGroupVisual, changeStatusLabel, conflictKindLabels, repositoryToolVisual, repositoryVisual } from '../../src/views/tree-visuals';

test('change tree uses distinct vivid theme colors and semantic icon per Git status', () => {
  assert.equal(changeGroupVisual.staged.color, 'charts.green');
  assert.deepEqual(changeFileVisual({ group: 'untracked', status: '?' }), { icon: 'new-file', color: 'charts.green' });
  assert.deepEqual(changeFileVisual({ group: 'working', status: 'M' }), { icon: 'diff-modified', color: 'charts.orange' });
  assert.deepEqual(changeFileVisual({ group: 'staged', status: 'A' }), { icon: 'diff-added', color: 'charts.green' });
  assert.deepEqual(changeFileVisual({ group: 'staged', status: 'D' }), { icon: 'diff-removed', color: 'charts.red' });
  assert.deepEqual(changeFileVisual({ group: 'staged', status: 'R' }), { icon: 'diff-renamed', color: 'charts.blue' });
  assert.deepEqual(changeFileVisual({ group: 'staged', status: 'C' }), { icon: 'copy', color: 'charts.purple' });
  assert.deepEqual(changeFileVisual({ group: 'working', status: 'T' }), { icon: 'symbol-property', color: 'charts.purple' });
  assert.deepEqual(changeFileVisual({ group: 'conflicts', status: 'UU' }), changeGroupVisual.conflicts);
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
  assert.deepEqual(changeFileVisual({ group: 'conflicts', status: 'DU' }), changeGroupVisual.conflicts, 'every kind keeps the conflict colour and icon');
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
