import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeImport, nativeRuntime } from './native-helpers.mjs';

const text = value => ({ type: 'text', text: value });

async function runtime(t, id = 'no-forced-output', provider = 'fixture') {
  const ctx = await nativeRuntime();
  t.after(() => ctx.fiber.dispose());
  for (const name of ['dsh-session', 'dsh-agent', 'dsh-llm', 'dsh-agent-loop', 'dsh-llm-retry', 'dsh-user-questions', 'dsh-session-projection']) {
    const mod = await nativeImport(`@deepseek-ai/${name}`);
    await ctx.plugin(mod.default ?? mod, {});
  }
  const { agent } = await ctx.agents.create({
    sessionId: `session-${id}`,
    agentOptions: { provider, model: id },
  });
  await agent.ctx.plugin(await import('../plugin/host.mjs'));
  return { ctx, agent, provider };
}

test('ordinary native stop is accepted without ColdX correction injections', { timeout: 10_000 }, async t => {
  const { ctx, agent, provider } = await runtime(t, 'native-stop');
  const { LlmAdapter, createUserMessage } = await nativeImport('@deepseek-ai/dsh-llm');
  let requests = 0;
  class FixtureAdapter extends LlmAdapter {
    async *stream() {
      requests += 1;
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: text('这里是直接、完整的答案。') };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter([provider], new FixtureAdapter());
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [text('比较三个方案，然后直接给结论。')] }));
  await agent.whenIdle();

  assert.equal(requests, 1, 'ColdX must not turn one model response into correction retries');
  const injected = agent.session.events.filter(event => event.type === 'user/message'
    && event.data.source?.kind === 'plugin' && event.data.source.plugin.startsWith('coldx-'));
  assert.deepEqual(injected, [], 'ColdX must not append a hidden correction prompt after a normal stop');
  assert.equal(agent.session.events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed');
  const flow = ctx.sessionProjections.snapshot(agent.session).values['coldx.flow'];
  assert.equal(flow.phase, 'completed', 'normal native completion must not be labelled interrupted');
  assert.equal(flow.completion, null, 'a normal answer does not invent a typed completion card');
});

test('the full ColdX host strips a DeepSeek private tail marker without retrying the model', { timeout: 10_000 }, async t => {
  const { ctx, agent, provider } = await runtime(t, 'native-stop-marker', 'deepseek-official');
  const { LlmAdapter, createUserMessage } = await nativeImport('@deepseek-ai/dsh-llm');
  const visible = '这里是保留的正常最终正文。';
  let requests = 0;
  class FixtureAdapter extends LlmAdapter {
    async *stream() {
      requests += 1;
      const value = `${visible}\n<|DS2_AGENT_DONE|>`;
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: value };
      yield { type: 'block-end', index: 0, block: text(value) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter([provider], new FixtureAdapter());
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [text('直接给出最终结论。')] }));
  await agent.whenIdle();

  assert.equal(requests, 1);
  const assistant = agent.session.events.filter(event => event.type === 'assistant/message');
  assert.equal(JSON.stringify(assistant).includes('DS2_AGENT_DONE'), false);
  assert.equal(JSON.stringify(assistant).includes(visible), true);
  assert.equal(agent.session.events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed');
  const flow = ctx.sessionProjections.snapshot(agent.session).values['coldx.flow'];
  assert.equal(flow.phase, 'completed');
  assert.equal(flow.completion, null);
});

test('coldx_finish is optional, accepts page-worthy work, and concludes without a follow-up prompt', async t => {
  const { ctx, agent } = await runtime(t, 'optional-finish');
  const result = await ctx.tools.execute({
    name: 'coldx_finish', callId: 'finish-direct',
    arguments: { summary: '三个方案已经比较，建议选择可回滚方案。' },
    agent, signal: new AbortController().signal,
  });

  assert.equal(result.isError, false);
  assert.equal(result.value.status, 'completed');
  assert.equal(result.concludesTurn, true, 'finish must use the native turn boundary directly');
  assert.equal(result.additionalContexts, undefined, 'finish must not inject a second final-answer request');
});
