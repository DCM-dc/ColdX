import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeImport, nativeRuntime } from './native-helpers.mjs';

test('lab uses native Gateway and tools, binds live Agents, honors cancellation and unloads', async t => {
  const labHost = await import('../plugin/lab-host.mjs');
  const root = await mkdtemp(join(tmpdir(), 'coldx-lab-native-'));
  const ctx = await nativeRuntime();
  t.after(() => ctx.fiber.dispose());
  for (const name of ['dsh-typert-registry', 'dsh-session', 'dsh-agent', 'dsh-llm', 'dsh-agent-loop', 'dsh-api-gateway']) {
    const mod = await nativeImport(`@deepseek-ai/${name}`);
    await ctx.plugin(mod.default ?? mod, {});
  }
  const { agent: a } = await ctx.agents.create({ sessionId: 'session-lab-a' });
  const { agent: b } = await ctx.agents.create({ sessionId: 'session-lab-b' });
  const fiber = await ctx.plugin(labHost, { labRoot: join(root, 'runtime'), outputRoot: join(root, 'outputs') });
  const invoke = (method, agent, request, signal) => ctx.typertGateway.invoke({ namespace: 'coldxLab', method, args: { agentId: agent.id, request }, signal });
  // The browser Connection strips only its correlation envelope. Exercise the
  // same payload and business response wrapper consumed by Lab.call().
  const envelope = await ctx.typertGateway.invokeRpc('coldxLab/create', { args: { agentId: a.id, request: { requestId: 'create-native' } } }, new AbortController().signal);
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  const run = envelope.value;
  assert.equal(run.files.length, 12);
  await assert.rejects(invoke('inspect', b, { runId: run.runId }), /owner/);
  await assert.rejects(invoke('create', a, { requestId: 'cancelled' }, AbortSignal.abort('cancelled')));
  await assert.rejects(ctx.typertGateway.invoke({ namespace: 'coldxLab', method: 'create', args: { agentId: 'not-an-agent', request: { requestId: 'x' } } }));
  const result = await ctx.tools.execute({ name: 'coldx_lab_apply', callId: 'native-lab-apply', agent: a, signal: new AbortController().signal,
    arguments: { runId: run.runId, requestId: 'apply-native', planId: 'mixed' } });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.value.verified, true);
  assert.equal(JSON.parse(await readFile(result.value.manifestPath, 'utf8')).files.length, 12);
  assert.equal((await invoke('inspect', a, { runId: run.runId })).versions[0].versionId, result.value.versionId);
  await assert.rejects(ctx.coldxLab.create({ id: a.id }, { requestId: 'forged' }, new AbortController().signal), /live Agent/);
  await fiber.dispose();
  assert.equal(ctx.tools.get('coldx_lab_create', a), undefined);
  await assert.rejects(invoke('inspect', a, { runId: run.runId }), /withdrawn|unavailable/);
});
