import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { watchWindow } from './offline-watch.mjs';
test('continuous watcher detects writer during a long pending operation and latches failure', async () => {
  let scans = 0, invalidations = 0;
  const watcher = watchWindow(async () => { if (++scans === 3) throw new Error('writer appeared'); }, async () => { invalidations++; }, 1);
  const result = await watcher.failed;
  assert.match(result.message, /writer/); await assert.rejects(watcher.check(), /writer/);
  await watcher.stop(); assert.equal(invalidations, 1);
});
test('concurrent boundary and background observations share a single census', async () => {
  let active = 0, maximum = 0;
  const watcher = watchWindow(async () => { maximum = Math.max(maximum, ++active); await delay(5); active--; return { ok: true }; }, async () => {}, 50);
  await Promise.all([watcher.check(), watcher.check(), watcher.check()]);
  await watcher.stop(); assert.equal(maximum, 1);
});
