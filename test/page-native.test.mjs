import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeImport, nativeRuntime } from './native-helpers.mjs';
import * as pageHost from '../plugin/page-host.mjs';

test('native page response survives reconnect, rejects wrong owners and resumes its tool exactly once', { timeout: 10_000 }, async t => {
  const ctx = await nativeRuntime();
  const streams = [];
  t.after(async () => {
    for (const controller of streams) controller.abort();
    await ctx.fiber.dispose();
  });
  for (const name of ['dsh-session', 'dsh-agent', 'dsh-llm', 'dsh-agent-loop', 'dsh-user-questions', 'dsh-session-projection']) {
    const mod = await nativeImport(`@deepseek-ai/${name}`);
    await ctx.plugin(mod.default ?? mod, {});
  }
  const { createApiProxy } = await nativeImport('@deepseek-ai/dsh-host-apiproxy');
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture' }), cwd: process.cwd(),
  });
  const { agent } = await ctx.agents.create({ sessionId: 'session-native-page-carrier' });
  const plugin = await agent.ctx.plugin(pageHost);
  const controller = new AbortController();
  const input = { title: '配色', html: '<button>暖橙</button>', script: 'window.ColdX.submit({color:"暖橙"})' };
  // The native loop normally appends this event before dispatch. This fixture
  // supplies it explicitly and never makes a model or network request.
  const callSeq = agent.session.append('tool/call', { turn: 1, step: 1, callId: 'page-carrier', name: 'coldx_present_page', arguments: JSON.stringify(input) }).seq;
  const pendingResult = ctx.tools.execute({
    callId: 'page-carrier', name: 'coldx_present_page', arguments: input, agent, signal: controller.signal,
  });
  async function requested() {
    const stream = new AbortController();
    streams.push(stream);
    for await (const item of api.events.mux({ rpcId: 'fixture-stream', payload: {} }, stream.signal)) {
      if (item.payload.type === 'question/requested') return item;
    }
    throw new Error('Missing native page question');
  }
  const first = await requested();
  const replay = await requested();
  assert.equal(first.rpcId, replay.rpcId);
  const questionId = first.payload.questions[0].id;
  assert.equal(questionId, 'coldx-page:page-carrier:1');
  assert.equal(ctx.sessionProjections.snapshot(agent.session).values['coldx.pages'].pages[0].status, 'waiting');
  const response = {
    type: 'client-response', rpcId: first.rpcId,
    result: { ok: true, value: {
      sessionId: agent.id,
      answer: { answers: [{ id: questionId, selected: [], custom: '{"color":"暖橙"}' }] },
    } },
  };
  assert.deepEqual(await api.respond({ ...response, result: { ok: true, value: { ...response.result.value, sessionId: 'session-other' } } }), { accepted: false, reason: 'bad-response' });
  assert.deepEqual(await api.respond(response), { accepted: true });
  const result = await pendingResult;
  assert.equal(result.isError, false);
  assert.deepEqual(result.value, { pageId: 'page-carrier', revision: 1, status: 'selected', value: { color: '暖橙' } });
  // Use the exact message factory and append contract used by the native
  // agent-loop scheduler, including its source-event linkage.
  const { createToolResultMessage } = await nativeImport('@deepseek-ai/dsh-llm');
  const { Session } = await nativeImport('@deepseek-ai/dsh-session');
  agent.session.append('tool/result', {
    turn: 1, step: 1, meta: result.meta,
    message: createToolResultMessage({ callId: 'page-carrier', content: result.content, isError: result.isError }),
  }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] });
  assert.equal(ctx.sessionProjections.snapshot(agent.session).values['coldx.pages'].pages[0].status, 'selected');
  const replayedSession = Session.create('session-replayed-page', agent.session.events);
  const restoredPage = ctx.sessionProjections.snapshot(replayedSession).values['coldx.pages'].pages[0];
  assert.equal(restoredPage.html, input.html);
  assert.deepEqual(restoredPage.value, { color: '暖橙' });
  assert.deepEqual(await api.respond(response), { accepted: false, reason: 'not-pending' });
  // Cancellation closes the real native carrier, not just a local UI promise.
  const cancelled = ctx.tools.execute({ callId: 'cancel-page', name: 'coldx_present_page', arguments: input, agent, signal: controller.signal });
  const cancelFrame = await requested();
  controller.abort();
  assert.equal((await cancelled).isError, true);
  assert.deepEqual(await api.respond({ ...response, rpcId: cancelFrame.rpcId }), { accepted: false, reason: 'not-pending' });
  await plugin.dispose();
  assert.equal(ctx.tools.get('coldx_present_page', agent), undefined);
});
