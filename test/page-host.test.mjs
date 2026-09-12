import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { nativeRuntime, nativeImport } from './native-helpers.mjs';

test('native page tool waits for its owner, returns JSON and disposes pending work', async t => {
  assert.ok(existsSync(new URL('../plugin/page-host.mjs', import.meta.url)), 'native page tool must exist');
  const host = await import('../plugin/page-host.mjs');
  const ctx = await nativeRuntime();
  t.after(() => ctx.fiber.dispose());
  for (const name of ['dsh-session', 'dsh-agent', 'dsh-llm', 'dsh-agent-loop', 'dsh-user-questions']) {
    const mod = await nativeImport(`@deepseek-ai/${name}`);
    await ctx.plugin(mod.default ?? mod, {});
  }
  const { agent } = await ctx.agents.create({ sessionId: 'session-page-owner' });
  const { agent: other } = await ctx.agents.create({ sessionId: 'session-page-other' });
  const requests = [];
  ctx.userQuestions.registerProvider({ ask(request) {
    return new Promise((resolve, reject) => {
      const abort = () => { const error = new Error('aborted'); error.code = 'ASK_ABORTED'; reject(error); };
      request.signal.addEventListener('abort', abort, { once: true });
      requests.push({ ...request, answer(value) {
        request.signal.removeEventListener('abort', abort);
        resolve({ answers: [{ id: request.questions[0].id, selected: [], custom: JSON.stringify(value) }] });
      } });
    });
  } });
  const fiber = await agent.ctx.plugin(host);
  assert.equal(ctx.tools.get('coldx_present_page', other), undefined, 'a scoped page tool stays within its Agent scope');
  const retainedDefinition = ctx.tools.get('coldx_present_page', agent);
  assert.match(retainedDefinition.description, /three or more options[^.]+multiple dimensions[^.]+strong candidates[^.]+even without an explicit page request/i);
  assert.doesNotMatch(retainedDefinition.description, /generated page is required|must first have/i);
  const controller = new AbortController();
  const run = (id, options = {}) => ctx.tools.execute({
    name: 'coldx_present_page', callId: id, agent,
    arguments: { title: '色彩', html: '<button>暖橙</button>', ...options }, signal: controller.signal,
  });
  const waiting = run('call-page-native');
  await new Promise(setImmediate);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].agent, agent);
  assert.equal(requests[0].questions[0].id, 'coldx-page:call-page-native:1');
  requests[0].answer({ color: '暖橙' });
  const result = await waiting;
  assert.equal(result.isError, false);
  assert.deepEqual(result.value, { pageId: 'call-page-native', revision: 1, status: 'selected', value: { color: '暖橙' } });
  assert.deepEqual(result.meta.coldxPage, result.value);
  const displayed = await run('call-display', { waitForInput: false });
  assert.equal(displayed.value.status, 'displayed');
  assert.equal(requests.length, 1);
  const malformedPending = run('call-malformed', { html: '{"div":{"_text":"坏参数"}}' });
  await new Promise(setImmediate);
  assert.equal(requests.length, 1, 'invalid markup must not open a native question wait');
  const malformed = await malformedPending;
  assert.equal(malformed.isError, true);
  assert.match(malformed.content[0].text, /UTF-8 Base64/);
  assert.equal(requests.length, 1, 'invalid markup must not open a native question wait');
  const both = await run('call-both', { htmlBase64: Buffer.from('<p>两种输入</p>').toString('base64') });
  assert.equal(both.isError, true);
  const encoded = await ctx.tools.execute({
    name: 'coldx_present_page', callId: 'encoded-page', agent, signal: controller.signal,
    arguments: { title: '编码页面', htmlBase64: Buffer.from('<p>暖橙</p>', 'utf8').toString('base64'), waitForInput: false },
  });
  assert.equal(encoded.isError, false);
  assert.equal(encoded.value.status, 'displayed');
  const pendingOnDispose = run('call-dispose');
  await new Promise(setImmediate);
  await fiber.dispose();
  assert.equal((await pendingOnDispose).value.status, 'interrupted');
  assert.equal(ctx.tools.get('coldx_present_page', agent), undefined);
  await assert.rejects(() => retainedDefinition.execute({ title: 'late', html: '', waitForInput: true }, {
    agent, callId: 'late-page', signal: new AbortController().signal,
  }), /unloaded/, 'an invocation retained before disposal cannot start a new wait');
  assert.ok(ctx.tools.get('cordis_define', agent));
});
