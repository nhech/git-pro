import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conflictsAutoOpen, createSurfaces, isConflictFailure, openConflictsAfterFailure } from '../../src/conflicts/surfaces';
import { GitFailure } from '../../src/git/git-error-parser';

test('conflict auto-open reveals the Conflicts tab only for a Git conflict failure in a repository that has conflicts, unless disabled', async () => {
  assert.deepEqual(['gitPro', 'always', 'never', 'sometimes', undefined, 1].map(conflictsAutoOpen), ['gitPro', 'always', 'never', 'gitPro', 'gitPro', 'gitPro']);
  assert.equal(isConflictFailure(new GitFailure('conflict', 'CONFLICT (content): Merge conflict in a.txt', 1)), true);
  assert.equal(isConflictFailure(new GitFailure('unknown', 'Git exited with code 1.', 1)), false);
  assert.equal(isConflictFailure(new Error('Resolve and stage all conflicts before continuing.')), false, 'a guard message is not a Git failure');
  assert.equal(isConflictFailure({ message: 'Failed to execute git', stderr: 'error: could not apply 1a2b3c4... CONFLICT (content)', gitErrorCode: 'Conflict' }), true, 'built-in Git API errors classify like recoveryFor');
  assert.equal(isConflictFailure({ message: 'Failed to execute git', stderr: 'conflict', gitErrorCode: 'AuthenticationFailed' }), false);
  assert.equal(isConflictFailure(undefined), false);

  const surfaces = createSurfaces(), opened: unknown[][] = [];
  const conflict = new GitFailure('conflict', 'CONFLICT (content): Merge conflict in a.txt', 1);
  const request = { error: conflict, repositoryId: 'repo', conflicts: 2, mode: 'gitPro' as const };
  assert.equal(await openConflictsAfterFailure(surfaces, request), false, 'nothing to open before the Conflicts feature registers');
  surfaces.conflicts = { open: async (...args: unknown[]) => { opened.push(args); } };
  for (const refused of [{ mode: 'never' as const }, { conflicts: 0 }, { repositoryId: undefined }, { error: new GitFailure('locked', 'index.lock', 128) }])
    assert.equal(await openConflictsAfterFailure(surfaces, { ...request, ...refused }), false, JSON.stringify(refused));
  assert.deepEqual(opened, []);
  assert.equal(await openConflictsAfterFailure(surfaces, request), true);
  assert.equal(await openConflictsAfterFailure(surfaces, { ...request, mode: 'always' }), true);
  assert.deepEqual(opened, [['repo'], ['repo']], 'focuses the tab of the failed repository; no selection or preserveFocus');
  surfaces.conflicts = { open: async () => { throw new Error('panel failed'); } };
  await assert.rejects(openConflictsAfterFailure(surfaces, request), /panel failed/, 'the caller logs a failed open');
  assert.equal(surfaces.conflictSources.size, 0);
});
