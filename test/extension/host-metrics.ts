import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

/** Optional durable observations for the isolated host harness, never product code. */
export async function recordHostMetric(record: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify(record) + '\n';
  const output = process.env.GIT_PRO_HOST_METRICS_OUTPUT;
  if (output) {
    const parent = await realpath(path.dirname(output)), temp = await realpath(tmpdir());
    assert.equal(path.dirname(parent), temp);
    assert.match(path.basename(parent), /^git-pro-host-/);
    assert.equal(path.resolve(output), path.join(parent, 'host-metrics.json'));
    assert.ok(Buffer.byteLength(line) <= 64 * 1024);
    const file = await open(output, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      const stat = await file.stat();
      assert.ok(stat.isFile() && stat.size + Buffer.byteLength(line) <= 128 * 1024);
      await file.writeFile(line, 'utf8');
    } finally { await file.close(); }
  }
  console.log(line.trimEnd());
}
