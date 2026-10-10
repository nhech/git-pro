import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { boundedFile } from '../../src/utils/bounded-file';
import { detectOperation } from '../../src/state/operation-state';

async function owned(check: (root: string) => Promise<void>): Promise<void> {
  const temporary = await realpath(tmpdir());
  const root = await realpath(await mkdtemp(path.join(temporary, 'git-pro-bounds-')));
  try { await check(root); }
  finally {
    assert.equal(path.dirname(root), temporary);
    assert.ok(path.basename(root).startsWith('git-pro-bounds-'));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test('bounded regular reads preserve bytes and enforce the exact limit', async () => owned(async root => {
  const file = path.join(root, 'file');
  await writeFile(file, Buffer.alloc(0));
  assert.deepEqual(await boundedFile(file, 8), Buffer.alloc(0));
  const bytes = Buffer.from([0, 255, 10, 13, 65, 66, 67, 68]);
  await writeFile(file, bytes);
  assert.deepEqual(await boundedFile(file, 8), bytes);
  await writeFile(file, Buffer.concat([bytes, Buffer.from([69])]));
  await assert.rejects(boundedFile(file, 8), /safe preview limit/);
  await assert.rejects(boundedFile(root, 8));
}));

test('sequencer detection retains normal todo semantics, missing-file behavior and precedence', async () => owned(async root => {
  assert.equal(await detectOperation(root), 'idle');
  const directory = path.join(root, 'sequencer');
  await mkdir(directory);
  assert.equal(await detectOperation(root), 'unknown-sequencer');
  const todo = path.join(directory, 'todo');
  await writeFile(todo, `pick ${'a'.repeat(40)} subject\n`);
  assert.equal(await detectOperation(root), 'cherry-picking');
  await writeFile(todo, `revert ${'b'.repeat(40)} subject\n`);
  assert.equal(await detectOperation(root), 'reverting');
  await writeFile(todo, '# no supported action\n');
  assert.equal(await detectOperation(root), 'unknown-sequencer');
  await writeFile(path.join(root, 'MERGE_HEAD'), 'c'.repeat(40));
  assert.equal(await detectOperation(root), 'merging');
  await mkdir(path.join(root, 'rebase-merge'));
  assert.equal(await detectOperation(root), 'rebasing');
}));

test('sequencer todo accepts the 1 MiB bound and rejects larger or nonregular files', async () => owned(async root => {
  const directory = path.join(root, 'sequencer');
  await mkdir(directory);
  const todo = path.join(directory, 'todo');
  const content = Buffer.alloc(1024 * 1024, 35);
  content.write(`pick ${'d'.repeat(40)} subject\n`);
  await writeFile(todo, content);
  assert.equal(await detectOperation(root), 'cherry-picking');
  await writeFile(todo, Buffer.concat([content, Buffer.from('#')]));
  await assert.rejects(detectOperation(root), /safe preview limit/);
  await rm(todo);
  await mkdir(todo);
  await assert.rejects(detectOperation(root));
}));
