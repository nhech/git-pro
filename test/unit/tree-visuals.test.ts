import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchVisual, changeFileVisual, changeGroupVisual, changeStatusLabel, repositoryToolVisual, repositoryVisual } from '../../src/views/tree-visuals';

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
  assert.equal(changeStatusLabel({ group: 'conflicts', status: 'UU' }), 'Conflict');
  assert.equal(changeStatusLabel({ group: 'working', status: 'X' }), 'Git status X');
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
