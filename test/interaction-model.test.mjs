import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { nativeImport } from './native-helpers.mjs';

test('flow tracks native decisions, finish boundaries, Code Mode ordering and replay', async t => {
  assert.ok(existsSync(new URL('../plugin/interaction-model.mjs', import.meta.url)), 'flow projection must exist');
  const { interactionProjection: projection } = await import('../plugin/interaction-model.mjs');
  const { Context } = await nativeImport('@deepseek-ai/cordis');
  const { default: Sessions, Session } = await nativeImport('@deepseek-ai/dsh-session');
  const { default: Projections } = await nativeImport('@deepseek-ai/dsh-session-projection');
  const { createToolResultMessage } = await nativeImport('@deepseek-ai/dsh-llm');
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  await ctx.plugin(Sessions); await ctx.plugin(Projections);
  await ctx.plugin({ inject: ['sessionProjections'], apply(c) { c.sessionProjections.register(projection); } });
  const session = ctx.sessions.create('session-flow');
  const view = target => ctx.sessionProjections.snapshot(target).values['coldx.flow'];
  const input = { title: '配色', question: '选一种颜色', options: [{ id: 'blue', label: '冰蓝' }] };
  const call = (name, id, args, turn = 1) => session.append('tool/call', { turn, step: 1, callId: id, name, arguments: JSON.stringify(args) });
  const result = (id, value, isError = false) => session.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId: id, content: [{ type: 'text', text: JSON.stringify(value) }], isError }),
  }, { surfaceOp: 'append' });
  session.append('turn/start', { turn: 1 });
  const started = call('coldx_interact', 'choose', input);
  assert.equal(view(session).phase, 'waiting');
  assert.equal(view(session).interactions[0].sequence, started.seq);
  assert.deepEqual(view(session).activity, [{ id: 'choose', name: 'coldx_interact', sequence: started.seq, status: 'waiting' }]);
  result('choose', { interactionId: 'choose', status: 'selected', selectedIds: ['blue'], selectedLabels: ['冰蓝'], custom: '' });
  assert.equal(view(session).phase, 'working');
  assert.equal(view(session).interactions[0].status, 'selected');
  assert.equal(view(session).activity[0].status, 'completed');
  call('run_code', 'root-code', {});
  session.append('tool/code-dispatch-start', { rootCallId: 'root-code', subCallId: 'finish', name: 'coldx_finish', arguments: { summary: '完成' } });
  const finished = session.append('tool/code-dispatch', { rootCallId: 'root-code', subCallId: 'finish', name: 'coldx_finish', isError: false,
    content: [{ type: 'text', text: JSON.stringify({ completionId: 'finish', status: 'completed', summary: '完成' }) }] });
  result('root-code', { ok: true });
  assert.equal(view(session).phase, 'completed');
  assert.equal(view(session).completion.sequence, finished.seq);
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  assert.deepEqual(view(Session.create('session-flow-replay', session.events)), view(session));
  projection.stateSchema.parse(ctx.sessionProjections.checkpoint(session)['coldx.flow'].val);

  session.append('turn/start', { turn: 2 });
  call('coldx_finish', 'finish-two', { summary: 'done' }, 2);
  result('finish-two', { completionId: 'finish-two', status: 'completed', summary: 'done' });
  assert.equal(view(session).phase, 'completed');
  call('read_file', 'new-work', {}, 2);
  assert.equal(view(session).completion, null, 'business work invalidates a previous finish');
  result('new-work', 'read');
  assert.deepEqual(view(session).activity.map(item => [item.name, item.status]), [['coldx_finish', 'completed'], ['read_file', 'completed']]);
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
  assert.equal(view(session).phase, 'completed', 'native completed is sufficient without a typed completion declaration');
  assert.equal(view(session).completion, null, 'native completion does not invent a typed result card');

  session.append('turn/start', { turn: 3 });
  call('coldx_finish', 'racing-finish', { summary: 'done' }, 3);
  call('read_file', 'racing-work', {}, 3);
  result('racing-finish', { completionId: 'racing-finish', status: 'completed', summary: 'done' });
  result('racing-work', 'read');
  assert.equal(view(session).completion, null, 'a stale concurrent finish cannot cover newer work');
  call('coldx_interact', 'cancel-choice', input, 3);
  session.append('turn/end', { turn: 3, reason: { kind: 'aborted', reason: { kind: 'user' } } });
  assert.equal(view(session).phase, 'cancelled');
  assert.equal(view(session).interactions.at(-1).status, 'cancelled');
  session.append('turn/start', { turn: 4 });
  call('coldx_interact', 'restart-choice', input, 4);
  session.append('session/end-seed', {});
  assert.equal(view(session).phase, 'interrupted');
  assert.equal(view(session).interactions.at(-1).status, 'interrupted');
});
