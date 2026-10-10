import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Limiter } from '../../src/utils/limiter';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('limiter never exceeds its bound and starts queued work in order', async () => {
  const limiter = new Limiter(2); const started: number[] = []; let running = 0, peak = 0;
  const gates: (() => void)[] = [];
  const job = (id: number) => limiter.run(async () => {
    started.push(id); running++; peak = Math.max(peak, running);
    await new Promise<void>(resolve => gates.push(resolve));
    running--; return id;
  });
  const all = [1, 2, 3, 4, 5].map(job);
  await tick(); assert.deepEqual(started, [1, 2]); assert.equal(limiter.running, 2); assert.equal(limiter.queued, 3);
  gates.shift()!(); await tick(); assert.deepEqual(started, [1, 2, 3]);
  gates.shift()!(); gates.shift()!(); await tick(); assert.deepEqual(started, [1, 2, 3, 4, 5]);
  while (gates.length) { gates.shift()!(); await tick(); }
  assert.deepEqual(await Promise.all(all), [1, 2, 3, 4, 5]); assert.equal(peak, 2);
  assert.equal(limiter.running, 0); assert.equal(limiter.queued, 0);
});

test('a failed job releases its slot to the next waiter', async () => {
  const limiter = new Limiter(1); const order: string[] = [];
  const failing = limiter.run(async () => { order.push('first'); throw new Error('expected'); });
  const next = limiter.run(async () => { order.push('second'); return 2; });
  await assert.rejects(failing, /expected/); assert.equal(await next, 2); assert.deepEqual(order, ['first', 'second']);
  assert.equal(limiter.running, 0);
});

test('queued work can be cancelled without consuming a slot, and already-aborted work never starts', async () => {
  const limiter = new Limiter(1); let release!: () => void; let started = 0;
  const holder = limiter.run(() => new Promise<void>(resolve => { release = resolve; }));
  const controller = new AbortController();
  const queued = limiter.run(async () => { started++; }, controller.signal);
  await tick(); assert.equal(limiter.queued, 1);
  controller.abort(); await assert.rejects(queued, /Cancelled/); assert.equal(limiter.queued, 0); assert.equal(started, 0);
  await assert.rejects(limiter.run(async () => { started++; }, controller.signal), /Cancelled/); assert.equal(started, 0);
  const follower = limiter.run(async () => 'follower'); release(); await holder;
  assert.equal(await follower, 'follower'); assert.equal(limiter.running, 0);
});

test('limiter rejects invalid bounds', () => {
  for (const bound of [0, -1, 1.5, Number.NaN]) assert.throws(() => new Limiter(bound));
});
