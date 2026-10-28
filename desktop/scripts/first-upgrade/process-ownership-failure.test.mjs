import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { createProcessOwnership } from './process-ownership.mjs';

function fixture(inspect, pid = 23456) {
  const original = childProcess.spawn;
  const child = new EventEmitter(); child.pid = pid; child.stdin = new PassThrough();
  const bytes = []; child.stdin.on('data', chunk => bytes.push(chunk));
  childProcess.spawn = () => child;
  const ownership = createProcessOwnership({ inspect }); ownership.install();
  return { child, ownership, bytes, spawn: () => ownership.run('approved-synthetic-failure', () => childProcess.spawn('/usr/bin/true', [])),
    close() { ownership.restore(); childProcess.spawn = original; syncBuiltinESMExports(); child.stdin.destroy(); } };
}

test('inspection failure closes gate and handles later child/stdin errors without replacing original failure', async () => {
  const original = new Error('synthetic attestation timeout');
  const f = fixture(() => { throw original; });
  try {
    assert.throws(f.spawn, error => error === original);
    assert.equal(f.child.stdin.writableEnded, true);
    assert.equal(Buffer.concat(f.bytes).length, 0, 'no go token may be written');
    await Promise.resolve();
    for (let i = 0; i < 2; i++) {
      assert.doesNotThrow(() => f.child.stdin.emit('error', Object.assign(new Error('late EPIPE'), { code: 'EPIPE' })));
      assert.doesNotThrow(() => f.child.emit('error', new Error('late child error')));
    }
  } finally { f.close(); }
});

test('invalid PID failure is protected before inspection starts', () => {
  let inspected = false;
  const f = fixture(() => { inspected = true; }, undefined);
  f.child.pid = undefined;
  try {
    assert.throws(f.spawn, /failed to spawn/); assert.equal(inspected, false);
    assert.equal(f.child.stdin.writableEnded, true);
    assert.doesNotThrow(() => f.child.stdin.emit('error', new Error('late pipe failure')));
  } finally { f.close(); }
});

test('synchronous cleanup failure cannot mask attestation failure or leave late errors unhandled', () => {
  const original = new Error('original inspection failure');
  const f = fixture(() => { throw original; });
  f.child.stdin.end = () => { throw new Error('cleanup write failure'); };
  try {
    assert.throws(f.spawn, error => error === original);
    assert.equal(f.child.stdin.destroyed, true, 'failed end falls back to destroying the pipe');
    assert.equal(Buffer.concat(f.bytes).length, 0);
    assert.doesNotThrow(() => f.child.stdin.emit('error', new Error('later pipe failure')));
  } finally { f.close(); }
});
