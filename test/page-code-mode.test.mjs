import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeImport } from './native-helpers.mjs';
import * as pageHost from '../plugin/page-host.mjs';

test('native Code Mode worker logs and projects a nested page tool result', { timeout: 10_000 }, async t => {
  const { Context } = await nativeImport('@deepseek-ai/cordis');
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  for (const [name, config] of [
    ['dsh-system-prompt', {}], ['dsh-tools', { mode: 'code' }],
    ['dsh-code-runtime-worker-thread', { maxWallMs: 8_000 }],
    ['dsh-session', {}], ['dsh-agent', {}], ['dsh-llm', {}], ['dsh-agent-loop', {}],
    ['dsh-user-questions', {}], ['dsh-session-projection', {}],
  ]) {
    const mod = await nativeImport(`@deepseek-ai/${name}`);
    await ctx.plugin(mod.default ?? mod, config);
  }
  const { agent } = await ctx.agents.create({ sessionId: 'session-code-page' });
  await agent.ctx.plugin(pageHost);
  let waitForAbort = false;
  let onPending;
  ctx.userQuestions.registerProvider({ async ask(request) {
    assert.equal(request.agent, agent);
    assert.equal(ctx.sessionProjections.snapshot(agent.session).values['coldx.pages'].pages.at(-1).status, 'waiting');
    if (waitForAbort) return new Promise((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(new Error('fixture question aborted')), { once: true });
      onPending();
    });
    return { answers: [{ id: request.questions[0].id, selected: [], custom: '{"color":"暖橙"}' }] };
  } });
  const prompt = await ctx.systemPrompt.assemble({ scope: agent, agent, signal: new AbortController().signal });
  assert.deepEqual(prompt.tools.map(tool => tool.name), ['run_code']);
  const args = { description: '呈现页面并读取真实用户选择', code: 'return await tools.coldx_present_page({title:"选择",html:"<button>暖橙</button>"});' };
  agent.session.append('tool/call', { turn: 1, step: 1, callId: 'outer-page-code', name: 'run_code', arguments: JSON.stringify(args) });
  const result = await ctx.tools.execute({ callId: 'outer-page-code', name: 'run_code', arguments: args, agent, signal: new AbortController().signal });
  assert.equal(result.isError, false, JSON.stringify(result.content));
  const started = agent.session.events.find(event => event.type === 'tool/code-dispatch-start');
  const ended = agent.session.events.find(event => event.type === 'tool/code-dispatch');
  assert.equal(started.data.name, 'coldx_present_page');
  assert.equal(ended.data.subCallId, started.data.subCallId);
  const page = ctx.sessionProjections.snapshot(agent.session).values['coldx.pages'].pages[0];
  assert.equal(page.pageId, started.data.subCallId);
  assert.equal(page.status, 'selected');
  assert.deepEqual(page.value, { color: '暖橙' });
  waitForAbort = true;
  const ready = new Promise(resolve => { onPending = resolve; });
  const abort = new AbortController();
  const cancelSeq = agent.session.append('tool/call', { turn: 2, step: 1, callId: 'outer-page-cancel', name: 'run_code', arguments: JSON.stringify(args) }).seq;
  const cancelled = ctx.tools.execute({ callId: 'outer-page-cancel', name: 'run_code', arguments: args, agent, signal: abort.signal });
  await ready;
  abort.abort();
  const cancelResult = await cancelled;
  assert.equal(cancelResult.isError, true);
  const { createToolResultMessage } = await nativeImport('@deepseek-ai/dsh-llm');
  agent.session.append('tool/result', {
    turn: 2, step: 1, error: cancelResult.error.info,
    message: createToolResultMessage({ callId: 'outer-page-cancel', content: cancelResult.content, isError: true }),
  }, { surfaceOp: 'append', sourceEventSeqs: [cancelSeq] });
  agent.session.append('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } });
  const cancelEvent = agent.session.events.filter(event => event.type === 'tool/code-dispatch').at(-1);
  const cancelledPage = ctx.sessionProjections.snapshot(agent.session).values['coldx.pages'].pages.at(-1);
  assert.equal(cancelledPage.status, 'cancelled', JSON.stringify({ child: cancelEvent.data, outerError: cancelResult.error?.info, root: cancelledPage.rootCallId }));
});
