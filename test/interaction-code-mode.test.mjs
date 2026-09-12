import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeImport } from './native-helpers.mjs';

test('real Code Mode interaction returns multiple stable IDs, finishes and cancels natively', { timeout: 10_000 }, async t => {
  const { Context } = await nativeImport('@deepseek-ai/cordis');
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  for (const [name, config] of [
    ['dsh-system-prompt', {}], ['dsh-tools', { mode: 'code' }], ['dsh-code-runtime-worker-thread', { maxWallMs: 8_000 }],
    ['dsh-session', {}], ['dsh-agent', {}], ['dsh-llm', {}], ['dsh-agent-loop', {}], ['dsh-user-questions', {}], ['dsh-session-projection', {}],
  ]) { const mod = await nativeImport(`@deepseek-ai/${name}`); await ctx.plugin(mod.default ?? mod, config); }
  const { agent } = await ctx.agents.create({ sessionId: 'session-code-interaction' });
  await agent.ctx.plugin(await import('../plugin/interaction-host.mjs'));
  let cancelNext = false;
  let pending;
  ctx.userQuestions.registerProvider({ async ask(request) {
    assert.equal(request.agent, agent);
    assert.equal(request.questions[0].multiSelect, true);
    assert.equal(ctx.sessionProjections.snapshot(agent.session).values['coldx.flow'].phase, 'waiting');
    if (cancelNext) return new Promise((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(new Error('fixture aborted')), { once: true });
      pending();
    });
    return { answers: [{ id: request.questions[0].id, selected: ['暖橙', '冰蓝'], custom: '浅一些' }] };
  } });
  const args = { description: '原生决策fixture', code: 'const result=await tools.coldx_interact({title:"组合",question:"选择颜色",options:[{id:"blue",label:"冰蓝"},{id:"orange",label:"暖橙"}],multiSelect:true});await tools.coldx_finish({summary:"已选择"});return result;' };
  const { createToolResultMessage } = await nativeImport('@deepseek-ai/dsh-llm');
  const run = async (id, turn, signal) => {
    agent.session.append('turn/start', { turn });
    const seq = agent.session.append('tool/call', { turn, step: 1, name: 'run_code', callId: id, arguments: JSON.stringify(args) }).seq;
    const result = await ctx.tools.execute({ name: 'run_code', callId: id, arguments: args, agent, signal });
    agent.session.append('tool/result', { turn, step: 1, ...(result.error ? { error: result.error.info } : {}),
      message: createToolResultMessage({ callId: id, content: result.content, isError: result.isError }),
    }, { surfaceOp: 'append', sourceEventSeqs: [seq] });
    return result;
  };
  const result = await run('code-choice', 1, new AbortController().signal);
  assert.equal(result.isError, false, JSON.stringify(result.content));
  const flow = ctx.sessionProjections.snapshot(agent.session).values['coldx.flow'];
  assert.equal(flow.phase, 'completed');
  assert.deepEqual(flow.interactions[0].selectedIds, ['orange', 'blue']);
  assert.equal(flow.interactions[0].custom, '浅一些');
  assert.ok(agent.session.events.some(e => e.type === 'tool/code-dispatch' && e.data.name === 'coldx_finish' && !e.data.isError));
  agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  cancelNext = true;
  const ready = new Promise(resolve => { pending = resolve; });
  const abort = new AbortController();
  const cancelled = run('code-cancel', 2, abort.signal);
  await ready; abort.abort();
  assert.equal((await cancelled).isError, true);
  agent.session.append('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } });
  const stopped = ctx.sessionProjections.snapshot(agent.session).values['coldx.flow'];
  assert.equal(stopped.phase, 'cancelled');
  assert.equal(stopped.interactions.at(-1).status, 'cancelled');
  assert.equal(stopped.completion, null);
});
