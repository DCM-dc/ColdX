import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { nativeImport } from './native-helpers.mjs';

test('script-only pages receive an empty DOM root while explicit HTML stays strict', async () => {
  const { normalizePageInput } = await import('../plugin/page-input.mjs');
  const { pageProjection } = await import('../plugin/page-model.mjs');
  const script = 'const button = document.createElement("button"); button.textContent = "选择"; document.getElementById("coldx-root").append(button);';
  const args = { title: 'DOM 页面', script };
  const page = normalizePageInput(args);
  assert.equal(page.html, '<div id="coldx-root"></div>');
  assert.equal(page.script, script);
  for (const empty of [undefined, '', ' \n ']) {
    assert.throws(() => normalizePageInput({ title: '无内容', ...(empty === undefined ? {} : { script: empty }) }));
  }
  assert.throws(() => normalizePageInput({ ...args, html: '{"div":"bad"}' }), /real HTML/);
  assert.throws(() => normalizePageInput({ ...args, html: '<p>ok</p>', htmlBase64: 'PHA+b2s8L3A+' }), /exactly one/);
  const state = pageProjection.apply(pageProjection.init(), { type: 'tool/call', data: {
    turn: 1, step: 1, callId: 'script-page', name: 'coldx_present_page', arguments: JSON.stringify(args),
  } });
  assert.equal(state.pages[0].html, page.html);
});

test('pages fold native tool logs, selections, cancellation and restart boundaries', async () => {
  assert.ok(existsSync(new URL('../plugin/page-model.mjs', import.meta.url)), 'native page projection must exist');
  const { pageProjection } = await import('../plugin/page-model.mjs');
  const { normalizePageInput } = await import('../plugin/page-input.mjs');
  for (const htmlBase64 of ['<p>bad</p>', 'YQ', '/w==', 'AB==']) {
    assert.throws(() => normalizePageInput({ title: '编码', htmlBase64 }), /Base64|UTF-8/);
  }
  assert.throws(() => normalizePageInput({ title: 'x'.repeat(201), html: '<p>ok</p>' }), /title/);
  assert.throws(() => normalizePageInput({ title: 'ok', html: '<p>ok</p>', css: ' '.repeat(200001) }), /css/);
  const event = (type, data, seq = 0) => ({ type, data, seq, time: 1000 + seq });
  const args = { title: '配色', html: '<button>暖橙</button>', script: '', css: '' };
  const call = event('tool/call', { name: 'coldx_present_page', callId: 'call-page-1', arguments: JSON.stringify(args), turn: 1, step: 1 });
  const empty = pageProjection.init();
  assert.equal(pageProjection.apply(empty, event('turn/start', { turn: 1 })).currentTurn, 1);
  for (const badHtml of ['{"div":{"button":{"_text":"暖橙"}}}', '&lt;button&gt;暖橙&lt;/button&gt;', 'plain prose']) {
    assert.equal(pageProjection.apply(empty, event('tool/call', { ...call.data, arguments: JSON.stringify({ ...args, html: badHtml }) })), empty, 'invalid markup must never become a waiting page');
  }
  const encoded = pageProjection.apply(empty, event('tool/call', { ...call.data, arguments: JSON.stringify({ title: '编码页', htmlBase64: Buffer.from(args.html, 'utf8').toString('base64') }) }));
  assert.equal(encoded.pages[0].html, args.html);
  let state = pageProjection.apply(empty, call);
  assert.equal(state.activePageId, 'call-page-1');
  assert.equal(state.pages[0].status, 'waiting');
  assert.equal(state.pages[0].questionId, 'coldx-page:call-page-1:1');
  assert.equal(state.pages[0].html, args.html);
  state = pageProjection.apply(state, event('tool/result', {
    message: { source: { callId: 'call-page-1' }, content: [{ type: 'tool-result', isError: false, content: [] }] },
    meta: { coldxPage: { pageId: 'call-page-1', revision: 1, status: 'selected', value: { color: '暖橙' } } },
  }, 1));
  assert.deepEqual(state.pages[0].value, { color: '暖橙' });
  assert.equal(state.pages[0].status, 'selected');
  const next = pageProjection.apply(state, event('tool/code-dispatch-start', {
    name: 'coldx_present_page', subCallId: 'call-code-2', arguments: args,
  }, 2));
  assert.equal(next.pages[1].status, 'waiting');
  const restarted = pageProjection.apply(next, event('session/end-seed', {}, 3));
  assert.equal(restarted.pages[0].status, 'selected');
  assert.equal(restarted.pages[1].status, 'interrupted');
  const cancelled = pageProjection.apply(next, event('tool/result', {
    message: { source: { callId: 'call-code-2' }, content: [{ type: 'tool-result', isError: true, content: [] }] },
    error: { code: 'ABORTED', name: 'HarnessError' },
  }, 3));
  assert.equal(cancelled.pages[1].status, 'cancelled');
  const abortedTurn = pageProjection.apply(next, event('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 3));
  assert.equal(abortedTurn.pages[1].status, 'cancelled');
  const codeResult = pageProjection.apply(next, event('tool/code-dispatch', {
    name: 'coldx_present_page', subCallId: 'call-code-2', isError: false,
    content: [{ type: 'text', text: JSON.stringify({ pageId: 'call-code-2', revision: 1, status: 'selected', value: [1, 2] }) }],
  }, 3));
  assert.deepEqual(codeResult.pages[1].value, [1, 2]);
  pageProjection.stateSchema.parse(codeResult);
});

test('page projection uses the real registry and known native event persistence only', async t => {
  assert.ok(existsSync(new URL('../plugin/page-model.mjs', import.meta.url)), 'native page projection must exist');
  const { pageProjection } = await import('../plugin/page-model.mjs');
  const { Context } = await nativeImport('@deepseek-ai/cordis');
  const { default: Projections } = await nativeImport('@deepseek-ai/dsh-session-projection');
  const { Session } = await nativeImport('@deepseek-ai/dsh-session');
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(Projections);
  const domain = await ctx.plugin({ inject: ['sessionProjections'], apply(c) { c.sessionProjections.register(pageProjection); } });
  const session = Session.create('session-pages');
  session.append('tool/call', { turn: 1, step: 1, callId: 'native-page', name: 'coldx_present_page', arguments: JSON.stringify({ title: '结果', html: '<p>完成</p>', waitForInput: false }) });
  const first = ctx.sessionProjections.snapshot(session).values['coldx.pages'];
  assert.equal(first.pages[0].status, 'displayed');
  const restored = Session.create('session-pages-restored', session.events);
  const after = ctx.sessionProjections.snapshot(restored).values['coldx.pages'];
  assert.equal(after.pages[0].html, '<p>完成</p>');
  assert.deepEqual(session.events.map(e => e.type), ['tool/call']);
  await domain.dispose();
  assert.equal(ctx.sessionProjections.snapshot(session).values['coldx.pages'], undefined);
});

test('completed native turns derive a read-only result from real post-selection prose and replay it', async t => {
  const { pageProjection } = await import('../plugin/page-model.mjs');
  const { Session, default: Sessions } = await nativeImport('@deepseek-ai/dsh-session');
  const { createAssistantMessage, createToolResultMessage, createUserMessage } = await nativeImport('@deepseek-ai/dsh-llm');
  const { Context } = await nativeImport('@deepseek-ai/cordis');
  const { default: Projections } = await nativeImport('@deepseek-ai/dsh-session-projection');
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(Sessions);
  await ctx.plugin(Projections);
  await ctx.plugin({ inject: ['sessionProjections'], apply(c) { c.sessionProjections.register(pageProjection); } });
  const source = '已选择冰蓝。\n<script>这只是原文</script>\n建议使用浅灰背景。';
  const session = ctx.sessions.create('session-result-fixture');
  function start(target, turn, userText = '帮我选一种颜色。') {
    target.append('turn/start', { turn });
    target.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: userText }] }), { surfaceOp: 'append' });
  }
  function page(target, turn, status = 'selected', id = `page-${turn}`) {
    target.append('tool/call', { turn, step: 1, callId: id, name: 'coldx_present_page', arguments: JSON.stringify({
      title: '配色', html: '<p>冰蓝</p>', waitForInput: status !== 'displayed',
    }) });
    if (status === 'waiting') return;
    const value = { pageId: id, revision: 1, status, value: status === 'selected' ? '冰蓝' : null };
    target.append('tool/result', { turn, step: 1, message: createToolResultMessage({
      callId: id, content: [{ type: 'text', text: JSON.stringify(value) }], isError: false,
    }), meta: { coldxPage: value } }, { surfaceOp: 'append' });
  }
  function answer(target, turn, text = source, interrupted = false) {
    target.append('assistant/message', { turn, step: 2, message: createAssistantMessage({
      source: { provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text }],
    }), ...(interrupted ? { interrupted } : {}) }, { surfaceOp: 'append' });
  }
  const end = (target, turn, kind = 'completed') => target.append('turn/end', { turn, reason: { kind } });
  const view = target => ctx.sessionProjections.snapshot(target).values['coldx.pages'];
  start(session, 1);
  page(session, 1);
  answer(session, 1);
  assert.equal(view(session).pages.length, 1, 'streaming prose is not a final result');
  end(session, 1);
  const completed = view(session);
  const result = completed.pages[1];
  assert.ok(result, 'a completed post-selection answer becomes a second page');
  assert.equal(result.resultText, source);
  assert.equal(result.status, 'displayed');
  assert.equal(result.waitForInput, false);
  assert.equal(completed.activePageId, result.pageId);
  assert.ok(result.html.includes('&lt;script&gt;'));
  assert.ok(!result.html.includes('<script>'));
  assert.equal(session.events.filter(e => e.type === 'tool/call').length, 1, 'derived pages never fabricate tool events');
  pageProjection.stateSchema.parse(ctx.sessionProjections.checkpoint(session)['coldx.pages'].val);
  const replay = Session.create('session-result-replay', session.events);
  assert.deepEqual(view(replay), completed);
  end(session, 1);
  assert.equal(view(session).pages.length, 2, 'repeated end events cannot duplicate the stable derived page');
  start(session, 2);
  answer(session, 2, '普通简答。');
  end(session, 2);
  assert.equal(view(session).pages.length, 2, 'a later turn does not reuse the previous selection');
  start(session, 3);
  page(session, 3);
  answer(session, 3, '第三轮结果。');
  end(session, 3);
  assert.equal(view(session).pages.length, 4);
  assert.notEqual(view(session).pages[3].pageId, result.pageId);

  const code = ctx.sessions.create('session-result-code-mode');
  start(code, 1);
  code.append('tool/call', { turn: 1, step: 1, callId: 'code-root', name: 'run_code', arguments: '{}' });
  code.append('tool/code-dispatch-start', { rootCallId: 'code-root', subCallId: 'code-page', name: 'coldx_present_page',
    arguments: { title: 'Code Mode 配色', html: '<p>冰蓝</p>' } });
  code.append('tool/code-dispatch', { rootCallId: 'code-root', subCallId: 'code-page', name: 'coldx_present_page', isError: false,
    content: [{ type: 'text', text: JSON.stringify({ pageId: 'code-page', revision: 1, status: 'selected', value: '冰蓝' }) }] });
  answer(code, 1);
  end(code, 1);
  assert.equal(view(code).pages[1].resultText, source, 'Code Mode selection also derives a result from the real final answer');

  for (const scenario of ['aborted', 'max-tokens', 'waiting', 'no-page', 'text-only', 'constrained-text', 'displayed', 'interrupted-answer', 'answer-before-selection']) {
    const target = ctx.sessions.create(`session-result-${scenario}`);
    start(target, 1, scenario === 'text-only' ? '只输出文字，不需要交互式页面。'
      : scenario === 'constrained-text' ? '用三句话回答。' : undefined);
    if (scenario === 'answer-before-selection') answer(target, 1);
    if (scenario !== 'no-page') page(target, 1, scenario === 'waiting' ? 'waiting' : 'selected');
    if (scenario === 'displayed') page(target, 1, 'displayed', 'explicit-result');
    if (scenario !== 'answer-before-selection') answer(target, 1, source, scenario === 'interrupted-answer');
    end(target, 1, ['aborted', 'max-tokens'].includes(scenario) ? scenario : 'completed');
    assert.ok(view(target).pages.every(item => item.resultText === undefined), scenario);
  }
});
