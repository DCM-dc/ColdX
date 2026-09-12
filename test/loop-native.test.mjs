import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeImport, nativeRuntime } from './native-helpers.mjs';

async function bounded(promise, label, milliseconds = 3000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds} ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function setup(t) {
  const fixture = await import('../examples/loop-native.mjs').catch(() => ({}));
  assert.equal(typeof fixture.startHostLoop, 'function', 'the host-owned native workflow fixture exists');
  const ctx = await nativeRuntime();
  t.after(() => bounded(ctx.fiber.dispose(), 'host disposal'));
  for (const name of ['dsh-session', 'dsh-agent', 'dsh-llm', 'dsh-agent-loop', 'dsh-subagent', 'dsh-subagent-spawn-in-process', 'dsh-workflow-worker-thread']) {
    const plugin = await nativeImport(`@deepseek-ai/${name}`);
    await ctx.plugin(plugin.default ?? plugin, name === 'dsh-workflow-worker-thread' ? { disposeGraceMs: 80 } : {});
  }
  const parent = await ctx.agents.create({ sessionId: `coldx-loop-${t.name.includes('cancel') ? 'cancel' : 'complete'}` });
  return { ctx, parent: parent.agent, startHostLoop: fixture.startHostLoop };
}

// Catches a broken workflow request, lost lifecycle events, or a script that
// merely announces completion without actually processing its finite batches.
test('native host workflow completes finite work and reports observable progress', { timeout: 10000 }, async t => {
  const { ctx, parent, startHostLoop } = await setup(t);
  const phases = [];
  const logs = [];
  const ends = [];
  ctx.on('workflow/phase', (_info, title) => phases.push(title));
  ctx.on('workflow/log', (_info, message) => logs.push(message));
  ctx.on('workflow/end', (_info, result) => ends.push(result.stopReason));
  const run = startHostLoop(ctx, parent, { iterations: 3, sliceMs: 1 });
  t.after(() => bounded(run.dispose(), 'finite worker fallback cleanup'));
  const result = await bounded(run.result, 'finite workflow result');
  assert.equal(result.stopReason, 'completed', result.error);
  assert.deepEqual(result.value, { iterations: 3, total: 6 });
  assert.equal(result.agentsStarted, 0, 'this deterministic task does not call a model');
  assert.deepEqual(phases, ['Process batches']);
  assert.deepEqual(logs, ['batch 1/3', 'batch 2/3', 'batch 3/3']);
  assert.deepEqual(ends, ['completed']);
  await bounded(run.dispose(), 'completed worker disposal');
});

// Catches cancellation that changes a status without stopping work, and a
// dropped host-disposal hook that leaves the native worker alive.
test('native host workflow can be cancelled and host disposal releases active work', { timeout: 10000 }, async t => {
  const { ctx, parent, startHostLoop } = await setup(t);
  const logs = [];
  const ended = [];
  const progress = Promise.withResolvers();
  ctx.on('workflow/log', (info, message) => {
    logs.push({ id: info.id, message });
    progress.resolve(info.id);
  });
  ctx.on('workflow/end', (info, result) => ended.push({ id: info.id, reason: result.stopReason }));
  const run = startHostLoop(ctx, parent, { iterations: 200, sliceMs: 10 });
  t.after(() => bounded(run.dispose(), 'cancelled worker fallback cleanup'));
  assert.equal(await bounded(progress.promise, 'first worker progress'), run.id);
  run.cancel('user stopped the ongoing task');
  const result = await bounded(run.result, 'cancelled workflow result');
  assert.equal(result.stopReason, 'cancelled');
  await bounded(run.dispose(), 'cancelled worker disposal');
  const stoppedCount = logs.length;
  assert.ok(stoppedCount > 0 && stoppedCount < 200, 'cancellation stopped finite work before completion');
  await delay(40);
  assert.equal(logs.length, stoppedCount, 'the disposed worker emits no further work');
  assert.deepEqual(ended.filter(event => event.id === run.id), [{ id: run.id, reason: 'cancelled' }]);

  const activeProgress = Promise.withResolvers();
  ctx.on('workflow/log', info => {
    if (info.id === active.id) activeProgress.resolve();
  });
  const active = startHostLoop(ctx, parent, { iterations: 200, sliceMs: 10 });
  t.after(() => bounded(active.dispose(), 'active worker fallback cleanup'));
  await bounded(activeProgress.promise, 'progress before host disposal');
  await bounded(ctx.fiber.dispose(), 'host disposal with an active workflow');
  assert.equal((await bounded(active.result, 'disposed workflow result')).stopReason, 'cancelled');
  await bounded(active.dispose(), 'idempotent disposed worker cleanup');
  const afterDispose = logs.length;
  await delay(40);
  assert.equal(logs.length, afterDispose, 'host teardown left no emitting worker');
});
