import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conflictKind, isConflictCode, sidePresent, sideStatus, sidesFor, stagePresence } from '../../src/git/conflicts/conflict-kinds';
import { countConflictBlocks } from '../../src/git/conflicts/text-conflicts';
import type { ConflictCode } from '../../src/git/conflicts/conflict-contract';
import type { GitOperation } from '../../src/state/operation-state';

const operations: GitOperation[] = ['idle', 'merging', 'rebasing', 'cherry-picking', 'reverting', 'bisecting', 'applying-mail', 'unknown-sequencer'];
/** The index stages Git leaves for each XY code: 1 base, 2 `--ours`, 3 `--theirs`. */
const stagesOf: Record<ConflictCode, (1 | 2 | 3)[]> = { UU: [1, 2, 3], AA: [2, 3], DU: [1, 3], UD: [1, 2], AU: [2], UA: [3], DD: [1] };

test('sidesFor swaps Yours and Theirs only during a rebase, and every map is frozen', () => {
  for (const operation of operations) {
    const sides = sidesFor(operation), rebasing = operation === 'rebasing';
    assert.deepEqual(sides, rebasing ? { yours: { stage: 3, flag: 'theirs' }, theirs: { stage: 2, flag: 'ours' } } : { yours: { stage: 2, flag: 'ours' }, theirs: { stage: 3, flag: 'theirs' } }, operation);
    assert.ok(Object.isFrozen(sides) && Object.isFrozen(sides.yours) && Object.isFrozen(sides.theirs));
    assert.notEqual(sides.yours.stage, sides.theirs.stage); assert.notEqual(sides.yours.flag, sides.theirs.flag);
  }
});

test('all seven XY codes map to WebStorm kinds, swapped for a rebase', () => {
  const merge: Record<ConflictCode, string> = { UU: 'bothModified', AA: 'bothAdded', DD: 'bothDeleted', DU: 'deletedByUs', UD: 'deletedByThem', AU: 'addedByUs', UA: 'addedByThem' };
  const rebase: Record<ConflictCode, string> = { UU: 'bothModified', AA: 'bothAdded', DD: 'bothDeleted', DU: 'deletedByThem', UD: 'deletedByUs', AU: 'addedByThem', UA: 'addedByUs' };
  for (const code of Object.keys(stagesOf) as ConflictCode[]) {
    assert.ok(isConflictCode(code));
    for (const operation of operations) assert.equal(conflictKind(code, operation), (operation === 'rebasing' ? rebase : merge)[code], `${code} ${operation}`);
  }
  for (const value of ['MM', 'M', 'uu', '', 'U', 'DA']) assert.equal(isConflictCode(value), false, value);
});

test('side status comes from stage presence through sidesFor and agrees with the kind', () => {
  const merge: Record<ConflictCode, [string, string]> = { UU: ['modified', 'modified'], AA: ['added', 'added'], DU: ['deleted', 'modified'], UD: ['modified', 'deleted'], AU: ['added', 'absent'], UA: ['absent', 'added'], DD: ['deleted', 'deleted'] };
  for (const operation of operations) for (const [code, stages] of Object.entries(stagesOf) as [ConflictCode, (1 | 2 | 3)[]][]) {
    const presence = stagePresence(stages.map(stage => ({ stage }))), sides = sidesFor(operation);
    const yours = sideStatus(presence, sides.yours), theirs = sideStatus(presence, sides.theirs);
    const expected = merge[code], swapped = operation === 'rebasing';
    assert.deepEqual([yours, theirs], swapped ? [expected[1], expected[0]] : expected, `${code} ${operation}`);
    // The kind and the columns must tell the same story, or Accept would contradict the row it acts on.
    const kind = conflictKind(code, operation);
    if (kind === 'deletedByUs') assert.deepEqual([yours, theirs], ['deleted', 'modified']);
    if (kind === 'deletedByThem') assert.deepEqual([yours, theirs], ['modified', 'deleted']);
    if (kind === 'addedByUs') assert.deepEqual([yours, theirs], ['added', 'absent']);
    if (kind === 'addedByThem') assert.deepEqual([yours, theirs], ['absent', 'added']);
    // Accepting a side whose stage is absent is a deletion (`rm`), never a restore of a missing version.
    assert.equal(sidePresent(presence, sides.yours), yours === 'modified' || yours === 'added');
  }
  assert.ok(Object.isFrozen(stagePresence([{ stage: 1 }])));
  assert.deepEqual(stagePresence([{ stage: 0 }]), { base: false, ours: false, theirs: false });
});

test('conflict block counts are display only and null when the markers do not parse by the Accept Both rules', () => {
  const block = '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature\n';
  assert.equal(countConflictBlocks('plain\ntext\n'), 0);
  assert.equal(countConflictBlocks(`a\n${block}b\n${block}`), 2);
  assert.equal(countConflictBlocks('<<<<<<< ours\r\nx\r\n||||||| base\r\ny\r\n=======\r\nz\r\n>>>>>>> theirs\r\n'), 1, 'diff3 and CRLF');
  assert.equal(countConflictBlocks('<<<<<<<< HEAD\nours\n========\ntheirs\n>>>>>>>> feature\n'), null, 'conflict-marker-size 8: markers present, not counted');
  assert.equal(countConflictBlocks('<<<<<<< HEAD\nours\n=======\ntheirs\n'), null, 'unterminated block');
  assert.equal(countConflictBlocks(`Title\n=======\n${block}`), null, 'a stray separator');
  assert.equal(countConflictBlocks('<<<<<<< a\n<<<<<<< b\n=======\n>>>>>>> b\n=======\n>>>>>>> a\n'), null, 'nested blocks');
});
