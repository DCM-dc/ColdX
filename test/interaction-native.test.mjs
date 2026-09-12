import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve, sep } from 'node:path';
import { nativeImport, nativeRuntime } from './native-helpers.mjs';

export async function interactionRuntime(t, toolsMode, standing = false) {
  assert.ok(existsSync(new URL('../plugin/interaction-host.mjs', import.meta.url)), 'native interaction plugin must exist');
  const ctx = await nativeRuntime();
  t.after(() => ctx.fiber.dispose());
  for (const name of ['dsh-session', 'dsh-agent', 'dsh-llm', 'dsh-agent-loop', 'dsh-user-questions', 'dsh-session-projection']) {
    const mod = await nativeImport(`@deepseek-ai/${name}`);
    await ctx.plugin(mod.default ?? mod, {});
  }
  const { agent } = await ctx.agents.create({ sessionId: 'session-interaction-owner' });
  const { agent: other } = await ctx.agents.create({ sessionId: 'session-interaction-other' });
  if (toolsMode) agent.ctx.tools.presentAs(toolsMode);
  let pluginCtx = agent.ctx;
  if (standing) {
    const { createScope, bindScopeParent } = await nativeImport('@deepseek-ai/dsh-scope');
    const key = { agentPreset: 'coldx-native-fixture' };
    pluginCtx = createScope(ctx, key).ctx;
    bindScopeParent(agent, key);
  }
  const plugin = await pluginCtx.plugin(await import('../plugin/interaction-host.mjs'));
  return { ctx, agent, other, plugin };
}

test('native interaction uses owner-bound reconnectable questions and returns stable IDs once', { timeout: 10_000 }, async t => {
  const { ctx, agent, other, plugin } = await interactionRuntime(t);
  const { createApiProxy } = await nativeImport('@deepseek-ai/dsh-host-apiproxy');
  const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture' }), cwd: process.cwd() });
  const streamControllers = [];
  t.after(() => streamControllers.forEach(c => c.abort()));
  async function pending() {
    const stream = new AbortController(); streamControllers.push(stream);
    for await (const item of api.events.mux({ rpcId: 'interaction-fixture', payload: {} }, stream.signal)) {
      if (item.payload.type === 'question/requested') return item;
    }
  }
  const input = { title: '配色', question: '你喜欢哪一种？', options: [{ id: 'blue', label: '冰蓝' }, { id: 'orange', label: '暖橙' }] };
  const abort = new AbortController();
  const run = (id, args = input) => ctx.tools.execute({ name: 'coldx_interact', callId: id, arguments: args, agent, signal: abort.signal });
  assert.equal(ctx.tools.get('coldx_interact', other), undefined);
  const { agent: child } = await agent.ctx.agents.create({ sessionId: 'session-interaction-child' });
  await child.ctx.plugin(await import('../plugin/interaction-host.mjs'));
  const delegated = await ctx.tools.execute({ name: 'coldx_interact', callId: 'child-choice', arguments: input, agent: child, signal: abort.signal });
  assert.equal(delegated.isError, true, 'even a child-mounted tool cannot collect decisions from an owned child');
  assert.match(delegated.content[0].text, /exact live root Agent/);
  const execution = run('interaction-one');
  const frame = await pending();
  assert.equal((await pending()).rpcId, frame.rpcId, 'browser reconnect keeps the native pending request');
  assert.equal(frame.payload.questions[0].id, 'coldx-interaction:interaction-one:1');
  const response = { type: 'client-response', rpcId: frame.rpcId, result: { ok: true, value: {
    sessionId: agent.id, answer: { answers: [{ id: frame.payload.questions[0].id, selected: ['冰蓝'] }] },
  } } };
  assert.deepEqual(await api.respond({ ...response, result: { ok: true, value: { ...response.result.value, sessionId: other.id } } }), { accepted: false, reason: 'bad-response' });
  assert.deepEqual(await api.respond(response), { accepted: true });
  const result = await execution;
  assert.equal(result.isError, false);
  assert.deepEqual(result.value, { interactionId: 'interaction-one', status: 'selected', selectedIds: ['blue'], selectedLabels: ['冰蓝'], custom: '' });
  assert.deepEqual(result.meta.coldxInteraction, result.value);
  assert.deepEqual(await api.respond(response), { accepted: false, reason: 'not-pending' });
  const finish = await ctx.tools.execute({ name: 'coldx_finish', callId: 'finish-one', arguments: { summary: '已完成配色。' }, agent, signal: abort.signal });
  assert.equal(finish.value.status, 'completed');
  assert.equal(finish.concludesTurn, true, 'completion closes through the native tool boundary');
  assert.equal(finish.additionalContexts, undefined, 'completion must not request another model step');
  const cancelled = run('interaction-cancel');
  const cancelFrame = await pending();
  abort.abort();
  assert.equal((await cancelled).isError, true);
  assert.deepEqual(await api.respond({ ...response, rpcId: cancelFrame.rpcId }), { accepted: false, reason: 'not-pending' });
  const disposed = ctx.tools.execute({ name: 'coldx_interact', callId: 'interaction-dispose', arguments: input, agent, signal: new AbortController().signal });
  await pending();
  await plugin.dispose();
  assert.equal((await disposed).value.status, 'interrupted');
  assert.equal(ctx.tools.get('coldx_interact', agent), undefined);
});

test('standing preset scope admits its live root through native dispatch while rejecting children and unrelated roots', { timeout: 10_000 }, async t => {
  const { ctx, agent, other } = await interactionRuntime(t, undefined, true);
  const { scopeOf, bindScopeParent } = await nativeImport('@deepseek-ai/dsh-scope');
  const { scopeParentOf } = await nativeImport('@deepseek-ai/dsh-scope');
  const preset = scopeParentOf(scopeOf(agent.ctx));
  assert.notEqual(preset, agent, 'native presets use a standing composition, not an Agent scope');
  const { agent: second } = await ctx.agents.create({ sessionId: 'session-standing-second' });
  bindScopeParent(second, preset);
  const { agent: child } = await agent.ctx.agents.create({ sessionId: 'session-standing-child' });
  bindScopeParent(child, preset);
  ctx.userQuestions.registerProvider({ async ask(request) {
    assert.ok([agent, second].includes(request.agent));
    return { answers: [{ id: request.questions[0].id, selected: ['冰蓝'] }] };
  } });
  const call = (name, agent, arguments_) => ctx.tools.execute({ name, callId: `${name}-${agent.id}`, arguments: arguments_, agent, signal: new AbortController().signal });
  const input = { title: '配色', question: '请选择', options: [{ id: 'blue', label: '冰蓝' }] };
  for (const root of [agent, second]) {
    const selected = await call('coldx_interact', root, input);
    assert.equal(selected.isError, false, JSON.stringify(selected.content));
    assert.deepEqual(selected.value.selectedIds, ['blue']);
    assert.equal((await call('coldx_finish', root, { summary: '已完成' })).value.status, 'completed');
  }
  assert.equal(ctx.tools.get('coldx_interact', other), undefined);
  assert.equal((await call('coldx_interact', other, input)).isError, true);
  assert.equal((await call('coldx_interact', child, input)).isError, true);
  assert.equal((await call('coldx_finish', child, { summary: '不得收取决策' })).isError, true);
  assert.equal((await call('coldx_finish', { id: agent.id }, { summary: '伪造身份' })).isError, true);
});

test('real AgentPresets loader shares the ColdX composition across root sessions and native Code Mode', { timeout: 10_000 }, async t => {
  const ctx = await nativeRuntime();
  const workRoot = fileURLToPath(new URL('../work/', import.meta.url));
  await mkdir(workRoot, { recursive: true });
  const fixtureRoot = await mkdtemp(join(workRoot, 'interaction-preset-'));
  t.after(async () => {
    await ctx.fiber.dispose();
    assert.ok(resolve(fixtureRoot).startsWith(resolve(workRoot) + sep));
    await rm(fixtureRoot, { recursive: true, force: true });
  });
  const presetDir = join(fixtureRoot, 'coldx'); await mkdir(presetDir);
  await writeFile(join(presetDir, 'agent.cordis.yml'), JSON.stringify([
    { id: 'coldx', name: new URL('../plugin/host.mjs', import.meta.url).href },
  ]));
  for (const name of ['dsh-session', 'dsh-agent', 'dsh-llm', 'dsh-agent-loop', 'dsh-user-questions', 'dsh-session-projection', 'dsh-code-runtime-worker-thread']) {
    const mod = await nativeImport(`@deepseek-ai/${name}`); await ctx.plugin(mod.default ?? mod, {});
  }
  const { Loader } = await nativeImport('@deepseek-ai/cordis-plugin-loader');
  await ctx.plugin(Loader, { baseUrl: pathToFileURL(fixtureRoot + sep).href });
  const presets = await nativeImport('@deepseek-ai/dsh-agent-presets');
  await ctx.plugin(presets.default, { default: 'coldx', roots: [{ path: fixtureRoot, trust: 'system' }], includeUserRoot: false });
  const create = (id, source = ctx) => source.agents.create({ sessionId: id, agentOptions: { provider: 'preset-fixture', model: id }, setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'coldx'); } });
  const { agent: a } = await create('session-real-preset-a');
  const { agent: b } = await create('session-real-preset-b');
  const { scopeParentOf } = await nativeImport('@deepseek-ai/dsh-scope');
  assert.equal(scopeParentOf(a), scopeParentOf(b));
  assert.equal(scopeParentOf(a), await ctx.agentPresets.standingKeyFor('coldx'));
  ctx.userQuestions.registerProvider({ async ask(request) {
    return { answers: [{ id: request.questions[0].id, selected: ['冰蓝'] }] };
  } });
  const input = { title: '真实预设', question: '选一个', options: [{ id: 'blue', label: '冰蓝' }] };
  const invoke = (agent, name, arguments_) => ctx.tools.execute({ name, callId: `real-${agent.id}-${name}`, arguments: arguments_, agent, signal: new AbortController().signal });
  assert.equal((await invoke(a, 'coldx_interact', input)).value.status, 'selected');
  b.ctx.tools.presentAs('code');
  const coded = await invoke(b, 'run_code', { description: '原生预设代码模式验证', code: `const choice = await tools.coldx_interact(${JSON.stringify(input)}); await tools.coldx_finish({summary:"已完成选择"}); return choice;` });
  assert.equal(coded.isError, false, JSON.stringify(coded.content));
  const { agent: child } = await create('session-real-preset-child', a.ctx);
  assert.equal((await invoke(child, 'coldx_interact', input)).isError, true);
  const { LlmAdapter, createUserMessage } = await nativeImport('@deepseek-ai/dsh-llm');
  const requests = new Map();
  class PresetFixtureAdapter extends LlmAdapter {
    async *stream(request) {
      requests.set(request.model, (requests.get(request.model) ?? 0) + 1);
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Fixture response without a declaration.' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['preset-fixture'], new PresetFixtureAdapter());
  await Promise.all([a, b, child].map(async agent => {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Fixture only.' }] }));
    await agent.whenIdle();
  }));
  assert.equal(requests.get(a.id), 1, 'a normal root response completes without a hidden correction');
  assert.equal(requests.get(b.id), 1, 'another root also completes in one model request');
  assert.equal(requests.get(child.id), 1, 'owned children keep the same native completion behavior');
});
