import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoveryFor } from '../../src/utils/recovery';

test("Git Pro's own error messages are shown as written, without the JavaScript \"Error: \" prefix", () => {
  assert.equal(recoveryFor(new Error('Stage changes first. Git Pro never automatically stages files during commit.')).message, 'Stage changes first. Git Pro never automatically stages files during commit.');
  assert.equal(recoveryFor(new TypeError('Select between 1 and 5000 files.')).message, 'Select between 1 and 5000 files.');
  assert.equal(recoveryFor('plain text failure').message, 'plain text failure', 'a thrown string is shown as is');
});
