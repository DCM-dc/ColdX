import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeRuntime } from './native-helpers.mjs';

function source(multiplier) {
  return `return { apply(ctx) {
    harness.registerTool(ctx, harness.defineTool({
      name: 'coldx_test_scale', description: 'Scale an input',
      parameters: { value: { type: 'number', required: true } },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args) { return { result: args.value * ${multiplier} }; }
    }));
    harness.handle('scale', args => ({ result: args.value * ${multiplier} }));
  } };`;
}

test('native Cordis tools define, call, update, stop and remove a real dynamic plugin', async t => {
  const ctx = await nativeRuntime();
  t.after(() => ctx.fiber.dispose());
  const agent = { id: 'coldx-lifecycle-test' };
  const exec = { agent, signal: new AbortController().signal };
  const call = (name, args) => ctx.tools.get(name).execute(args, exec);
  const initial = await call('cordis_define', {
    plugin: { kind: 'new', idPrefix: 'coldx' }, name: 'Scale', purpose: 'Verify native runtime lifecycle', code: { host: source(2) },
  });
  assert.equal(ctx.tools.get('coldx_test_scale'), undefined, 'define must not run code');
  const first = await call('cordis_run', { ...initial, mode: 'run' });
  assert.equal(first.status, 'running');
  assert.deepEqual(await ctx.tools.get('coldx_test_scale').execute({ value: 4 }, exec), { result: 8 });
  assert.deepEqual(await ctx.dynamicCordisRunner.invoke(initial.pluginId, first.pluginRunId, 'scale', { value: 4 }), { ok: true, value: { result: 8 } });

  const next = await call('cordis_define', {
    plugin: { kind: 'existing', pluginId: initial.pluginId }, name: 'Scale v2', purpose: 'Update the existing capability', code: { host: source(3) },
  });
  assert.equal(next.pluginId, initial.pluginId);
  assert.notEqual(next.packageId, initial.packageId);
  const second = await call('cordis_run', { ...next, mode: 'update' });
  assert.equal(second.status, 'running');
  assert.deepEqual(await ctx.tools.get('coldx_test_scale').execute({ value: 4 }, exec), { result: 12 });
  assert.equal((await ctx.dynamicCordisRunner.invoke(initial.pluginId, first.pluginRunId, 'scale', { value: 4 })).code, 'stale-run');
  assert.equal(ctx.dynamicCordisRunner.inspectPackage(agent, initial.pluginId, initial.packageId).code.host, source(2));

  await call('cordis_stop', { pluginId: initial.pluginId });
  assert.equal(ctx.tools.get('coldx_test_scale'), undefined);
  assert.equal((await ctx.dynamicCordisRunner.invoke(initial.pluginId, second.pluginRunId, 'scale', { value: 4 })).code, 'plugin-not-running');
  assert.equal(ctx.dynamicCordisRunner.inspectPlugin(agent, initial.pluginId).packages.length, 2);
  await call('cordis_undefine', { pluginId: initial.pluginId });
  assert.deepEqual(ctx.dynamicCordisRunner.listPlugins(agent), []);
});

test('native runner enforces owner identity and rejects activation after cancellation', async t => {
  const ctx = await nativeRuntime();
  t.after(() => ctx.fiber.dispose());
  const owner = { id: 'owner' };
  const pkg = ctx.dynamicCordisRunner.define({ sessionId: owner.id, plugin: { kind: 'new', idPrefix: 'owner' }, name: 'Owned plugin', purpose: 'Ownership test', code: { host: source(2) } });
  const denied = await ctx.dynamicCordisRunner.run({ id: 'other-session' }, pkg.pluginId, pkg.packageId, 'run');
  assert.equal(denied.ok, false);
  const controller = new AbortController();
  controller.abort();
  const cancelled = await ctx.dynamicCordisRunner.run(owner, pkg.pluginId, pkg.packageId, 'run', controller.signal);
  assert.equal(cancelled.reason, 'cancelled');
  assert.equal(ctx.tools.get('coldx_test_scale'), undefined);
});
