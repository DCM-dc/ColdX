import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeRuntime } from './native-helpers.mjs';
import { createDecisionStudio } from '../examples/decision-studio.mjs';

test('Decision Studio crosses the actual DSH dynamic host bridge into an owner-scoped tool result', async (t) => {
  const ctx = await nativeRuntime();
  t.after(() => ctx.fiber.dispose());
  const agent = { id: 'coldx-decision-native' };
  const example = createDecisionStudio(agent.id);
  const exec = { agent, signal: new AbortController().signal };
  const call = (name, args) => ctx.tools.get(name).execute(args, exec);
  // Browser loading is exercised in the app; this test runs its unmodified host
  // half against the real pinned framework and package-private invocation path.
  const pkg = await call('cordis_define', { plugin: example.plugin, name: example.name, purpose: example.purpose, code: { host: example.code.host } });
  const run = await call('cordis_run', { ...pkg, mode: 'run' });
  assert.equal(run.status, 'running');
  const pending = call(example.toolName, {});
  const submitted = await ctx.dynamicCordisRunner.invoke(pkg.pluginId, run.pluginRunId, 'commit', { speed: 33, quality: 88, budget: 61 });
  assert.equal(submitted.ok, true);
  assert.equal(submitted.value.accepted, true);
  assert.deepEqual(await pending, { status: 'selected', speed: 33, quality: 88, budget: 61 });
  // A reloaded page or another client cannot rewrite the result the task
  // already consumed. Retrying the same confirmation is safe and idempotent.
  const duplicate = await ctx.dynamicCordisRunner.invoke(pkg.pluginId, run.pluginRunId, 'commit', { speed: 33, quality: 88, budget: 61 });
  assert.deepEqual(duplicate, submitted);
  const conflict = await ctx.dynamicCordisRunner.invoke(pkg.pluginId, run.pluginRunId, 'commit', { speed: 99, quality: 10, budget: 20 });
  assert.equal(conflict.ok, true, 'transport succeeds while the application rejects the conflicting action');
  assert.equal(conflict.value.accepted, false);
  assert.equal(conflict.value.code, 'selection-locked');
  assert.match(conflict.value.message, /已确认/);
  assert.deepEqual(conflict.value.selection, submitted.value.selection);
  assert.deepEqual(await call(example.toolName, {}), submitted.value.selection);
  await call('cordis_stop', { pluginId: pkg.pluginId });
  assert.equal(ctx.tools.get(example.toolName), undefined);
  assert.equal((await ctx.dynamicCordisRunner.invoke(pkg.pluginId, run.pluginRunId, 'commit', { speed: 1, quality: 1, budget: 1 })).code, 'plugin-not-running');
});
