import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestScheduler } from '../lib/kernel/scheduler.mjs';

test('kernel bounds active requests, removes aborted waiters and releases exactly once', async () => {
  const s = new RequestScheduler({ limit: 4 });
  const leases = await Promise.all([0,1,2,3].map(owner => s.acquire({ owner: String(owner) })));
  const abort = new AbortController();
  const fifth = s.acquire({ owner: 'fifth', signal: abort.signal });
  assert.equal(s.snapshot().active, 4); assert.equal(s.snapshot().queued, 1);
  const rejected = assert.rejects(fifth, /cancelled/); abort.abort(new Error('cancelled')); await rejected;
  assert.equal(s.snapshot().queued, 0);
  leases[0](); leases[0](); assert.equal(s.snapshot().active, 3);
  leases.slice(1).forEach(release => release()); assert.equal(s.snapshot().active, 0);
});

test('interactive requests get priority but a queued child cannot starve', async () => {
  const s = new RequestScheduler({ limit: 1 }); const initial = await s.acquire({ owner: 'hold' });
  const order = [];
  const tasks = [['child','normal'], ...[1,2,3,4,5].map(n => ['root'+n,'interactive'])].map(async ([owner,priority]) => {
    const release = await s.acquire({ owner, priority }); order.push(owner); release();
  });
  initial(); await Promise.all(tasks);
  assert.deepEqual(order, ['root1','root2','root3','child','root4','root5']);
});

test('queue overflow and disposal are explicit and never admit an extra request', async () => {
  const s = new RequestScheduler({ limit: 1, maxQueued: 1 }); const release = await s.acquire({owner:'active'});
  const pending = s.acquire({owner:'waiting'});
  await assert.rejects(s.acquire({owner:'overflow'}), /queue is full/);
  const disposed = assert.rejects(pending, /closed/); s.dispose(); await disposed;
  await assert.rejects(s.acquire({owner:'later'}), /closed/);
  release(); assert.equal(s.snapshot().active, 0);
});

test('an already aborted signal and invalid configuration never acquire capacity', async () => {
  const s = new RequestScheduler(); const abort = new AbortController(); abort.abort();
  await assert.rejects(s.acquire({owner:'a',signal:abort.signal})); assert.equal(s.snapshot().active,0);
  assert.throws(()=>new RequestScheduler({limit:0}), /limit/);
  assert.throws(()=>new RequestScheduler({maxQueued:Infinity}), /queue/);
});
