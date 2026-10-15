import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoveryFor } from '../../src/utils/recovery';

test("Git Pro's own error messages are shown as written, without the JavaScript \"Error: \" prefix", () => {
  assert.equal(recoveryFor(new Error('Stage changes first. Git Pro never automatically stages files during commit.')).message, 'Stage changes first. Git Pro never automatically stages files during commit.');
  assert.equal(recoveryFor(new TypeError('Select between 1 and 5000 files.')).message, 'Select between 1 and 5000 files.');
  assert.equal(recoveryFor('plain text failure').message, 'plain text failure', 'a thrown string is shown as is');
});

test("a file path that happens to contain the word conflict does not turn Git Pro's own error into a conflict", () => {
  for (const message of ['src/conflicts/panel.ts was added with "git add -N", so Git has no copy of its content.', 'db/unmerged-migrations/001.sql is a repository of its own that this repository does not track yet.']) {
    assert.equal(recoveryFor(new Error(message)).command, 'gitPro.showOutput', message);
  }
  // Git Pro's own conflict guards still lead to the Conflicts tab, by their wording or by the DailyError code.
  assert.equal(recoveryFor(new Error('Resolve and stage all conflicts before continuing.')).command, 'gitPro.conflicts.open');
  assert.equal(recoveryFor(new Error('Conflict markers remain in a.txt. Review the file before marking resolved.')).command, 'gitPro.conflicts.open');
  assert.equal(recoveryFor(Object.assign(new Error('Resolve the conflicts in the selected files first.'), { code: 'conflict' })).command, 'gitPro.conflicts.open');
});
