import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { detectConflictOperation, detectOperation, gitPseudoRefs, readPseudoRef, type PseudoRef } from '../../src/state/operation-state';
import { GitFailure } from '../../src/git/git-error-parser';
import type { ReadCommand } from '../../src/git/command-builders';

const oid = (digit: string) => digit.repeat(40);
/** A bare git dir with metadata files, and `refs` answering as Git would for a reftable repository while recording what it was asked. */
async function gitDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'git-pro-operation-'));
  const put = async (name: string, value = '') => { await mkdir(path.dirname(path.join(dir, name)), { recursive: true }); await writeFile(path.join(dir, name), value); };
  const table = new Map<PseudoRef, string>(), asked: PseudoRef[] = [];
  const refs = async (name: PseudoRef) => { asked.push(name); return table.get(name); };
  return { dir, put, table, asked, refs, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('pseudo-refs are asked of Git through the executor\'s ref read: a ref that does not resolve is absent, every other failure throws', async () => {
  const calls: unknown[][] = [], answers: Record<string, () => Buffer> = {
    REBASE_HEAD: () => Buffer.from(`${oid('a')}\n`), REVERT_HEAD: () => Buffer.from('not an object id\n'),
    CHERRY_PICK_HEAD: () => { throw new GitFailure('unknown', 'fatal: Needed a single revision', 128); } };
  const executor = { read: async (root: string, command: ReadCommand, options?: { signal?: AbortSignal }) => {
    calls.push([root, command, options]); const name = (command as { ref: string }).ref;
    return { stdout: answers[name]!(), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
  } };
  const signal = new AbortController().signal, refs = gitPseudoRefs(executor, '/repo', signal);
  assert.equal(await refs('REBASE_HEAD'), oid('a'));
  assert.deepEqual(calls[0], ['/repo', { kind: 'ref', ref: 'REBASE_HEAD' }, { signal }], 'the executor\'s own recipe, environment and trust checks');
  assert.equal(await refs('CHERRY_PICK_HEAD'), undefined);
  assert.equal(await refs('REVERT_HEAD'), '', 'an answer that is no object ID is still evidence that the ref exists');
  for (const failure of [new GitFailure('timeout', 'Git read timed out', null), new GitFailure('repository', 'fatal: not a git repository', 128), new GitFailure('cancelled', 'cancelled')]) {
    answers.REBASE_HEAD = () => { throw failure; };
    await assert.rejects(refs('REBASE_HEAD'), (error: unknown) => error === failure, failure.kind);
  }
});

test('a reftable repository asks Git for REBASE_HEAD, CHERRY_PICK_HEAD and REVERT_HEAD; the files backend and an idle repository start no Git process', async () => {
  const g = await gitDir();
  try {
    await g.put('MERGE_MSG', 'picked\n');
    assert.equal(await detectOperation(g.dir, g.refs), 'idle'); assert.deepEqual(g.asked, [], 'no reftable directory: the files backend has nothing to ask');
    await mkdir(path.join(g.dir, 'reftable'));
    // A single cherry-pick or revert that stops leaves only MERGE_MSG beside the tables.
    assert.equal(await detectOperation(g.dir, g.refs), 'idle'); assert.deepEqual(g.asked, ['CHERRY_PICK_HEAD', 'REVERT_HEAD']);
    g.table.set('CHERRY_PICK_HEAD', oid('b'));
    assert.equal(await detectConflictOperation(g.dir, true, { refs: g.refs }), 'cherry-picking');
    assert.equal(await detectConflictOperation(g.dir, true), 'idle', 'without Git the stop reads as idle: no Continue, Skip or Abort');
    g.table.clear(); g.table.set('REVERT_HEAD', oid('c'));
    assert.equal(await detectConflictOperation(g.dir, true, { refs: g.refs }), 'reverting');
    g.table.clear(); await rm(path.join(g.dir, 'MERGE_MSG')); g.asked.length = 0;
    assert.equal(await detectOperation(g.dir, g.refs), 'idle'); assert.deepEqual(g.asked, [], 'no stop, no MERGE_MSG: nothing to ask');
    // A rebase step that stopped on conflicts: REBASE_HEAD names the replayed commit, so Yours stays that commit (Git --theirs).
    await g.put('rebase-merge/done', `pick ${oid('d')} mine\n`); await g.put('MERGE_MSG', 'mine\n'); g.table.set('REBASE_HEAD', oid('d'));
    assert.equal(await detectConflictOperation(g.dir, true, { refs: g.refs }), 'rebasing');
    assert.equal(await detectConflictOperation(g.dir, true), 'idle', 'without Git the rebase\'s own conflicts read as idle, which swaps Yours and Theirs');
    assert.equal(await readPseudoRef(g.dir, 'REBASE_HEAD', g.refs), oid('d'));
    g.table.set('CHERRY_PICK_HEAD', oid('e')); assert.equal(await detectConflictOperation(g.dir, true, { refs: g.refs }), 'cherry-picking', 'another commit picked at the stop');
    g.table.set('CHERRY_PICK_HEAD', oid('d')); assert.equal(await detectConflictOperation(g.dir, true, { refs: g.refs }), 'rebasing', 'the same commit is the rebase step');
    g.table.set('REVERT_HEAD', oid('f')); assert.equal(await detectConflictOperation(g.dir, true, { refs: g.refs }), 'reverting');
    // A file is read first: Git is asked only when the file is missing.
    await g.put('REBASE_HEAD', `${oid('9')}\n`); g.asked.length = 0;
    assert.equal(await readPseudoRef(g.dir, 'REBASE_HEAD', g.refs), oid('9')); assert.deepEqual(g.asked, []);
  } finally { await g.cleanup(); }
});

test('at a rebase stop committed by hand, a later merge or stash apply owns the conflicts; a rebase -r merge step stays the rebase', async () => {
  const g = await gitDir();
  try {
    await g.put('rebase-merge/done', `pick ${oid('a')} mine\n`); await g.put('REBASE_HEAD', `${oid('a')}\n`);
    assert.equal(await detectConflictOperation(g.dir, true), 'rebasing', 'the rebase step\'s own conflicts');
    await g.put('MERGE_HEAD', `${oid('b')}\n`);
    assert.equal(await detectConflictOperation(g.dir, true), 'merging', 'git commit, then git merge: the last done step is a pick');
    for (const step of [`merge -C ${oid('c')} topic # Merge topic`, `m -C ${oid('c')} topic`, 'merge topic']) {
      await g.put('rebase-merge/done', `pick ${oid('a')} mine\n${step}\n`);
      assert.equal(await detectConflictOperation(g.dir, true), 'rebasing', step);
    }
    await rm(path.join(g.dir, 'rebase-merge', 'done')); assert.equal(await detectConflictOperation(g.dir, true), 'rebasing', 'no done list: unchanged');
    await rm(path.join(g.dir, 'rebase-merge'), { recursive: true }); await g.put('rebase-apply/rebasing');
    assert.equal(await detectConflictOperation(g.dir, true), 'merging', 'the apply backend has no merge steps');
    await rm(path.join(g.dir, 'MERGE_HEAD'));
    let read = 0; const stash = (found: boolean) => async () => { read++; return found; };
    assert.equal(await detectConflictOperation(g.dir, true, { stashMarkers: stash(true) }), 'idle', 'resolutions staged, then git stash apply: Yours is HEAD');
    assert.equal(await detectConflictOperation(g.dir, true, { stashMarkers: stash(false) }), 'rebasing');
    assert.equal(await detectConflictOperation(g.dir, false, { stashMarkers: stash(true) }), 'rebasing', 'no conflicts: no file is read'); assert.equal(read, 2);
    assert.equal(await detectConflictOperation(g.dir, true), 'rebasing', 'without the evidence the earlier answer stands');
  } finally { await g.cleanup(); }
});

test('only the "Conflicts:" block Git appended is removed from a prepared merge message, in any comment character', async () => {
  const { withoutConflictsHint } = await import('../../src/git/conflicts/operation-context');
  assert.equal(withoutConflictsHint("Merge branch 'x'\n\n# Conflicts:\n#\ta.txt\n#\tb c.txt\n"), "Merge branch 'x'");
  assert.equal(withoutConflictsHint("Merge branch 'x'\n\n; Conflicts:\n;\ta.txt\n"), "Merge branch 'x'", 'core.commentChar can be anything');
  assert.equal(withoutConflictsHint('#123 merge x\n\n#45 also fixes this\n\n# Conflicts:\n#\ta.txt\n'), '#123 merge x\n\n#45 also fixes this', 'a "#" line the user wrote stays');
  assert.equal(withoutConflictsHint('#123 merge x\n'), '#123 merge x');
  assert.equal(withoutConflictsHint('Conflicts: are fine to mention\n'), 'Conflicts: are fine to mention', 'the word alone is not the block');
  assert.equal(withoutConflictsHint("Merge\n\n# Conflicts:\n#\ta.txt\nnot part of the block\n"), "Merge\n\n# Conflicts:\n#\ta.txt\nnot part of the block", 'a block followed by more text is left alone');
});
