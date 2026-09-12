import test from 'node:test';
import assert from 'node:assert/strict';
import { createPageSubmitter } from '../plugin/client/page-submit.mjs';

const page = { pageId: 'call-1', revision: 1, questionId: 'coldx-page:call-1:1', status: 'waiting', waitForInput: true };
const carrier = (respond, sessionId = 'session-a') => ({ kind: 'question', sessionId, payload: { questions: [{ id: page.questionId }] }, respond });
test('page action preserves native owner and answer envelope, deduplicates competing submissions', async () => {
  let calls = 0;
  const submit = createPageSubmitter();
  const target = carrier(async answer => {
    calls++;
    assert.deepEqual(answer, { ok: true, value: { sessionId: 'session-a', answer: { answers: [{ id: page.questionId, selected: [], custom: '{"color":"blue"}' }] } } });
    return { accepted: true };
  });
  const input = { page, carrier: target, sessionId: 'session-a' };
  const results = await Promise.all([submit({ ...input, value: { color: 'blue' } }), submit({ ...input, value: { color: 'orange' } })]);
  assert.equal(calls, 1);
  assert.deepEqual(results, [{ color: 'blue' }, { color: 'blue' }]);
});
test('wrong owner, missing carrier and closed pages never send', async () => {
  const submit = createPageSubmitter();
  let calls = 0;
  const target = carrier(() => { calls++; }, 'session-b');
  await assert.rejects(submit({ page, carrier: target, sessionId: 'session-a', value: {} }));
  await assert.rejects(submit({ page, sessionId: 'session-a', value: {} }));
  await assert.rejects(submit({ page: { ...page, status: 'cancelled' }, carrier: target, sessionId: 'session-b', value: {} }));
  assert.equal(calls, 0);
});
test('rejected receipt is not acknowledged and can be retried', async () => {
  const submit = createPageSubmitter();
  let accepted = false;
  const input = { page, carrier: carrier(async () => ({ accepted })), sessionId: 'session-a', value: ['x'] };
  await assert.rejects(submit(input), /未被接收/);
  accepted = true;
  assert.deepEqual(await submit(input), ['x']);
});
test('non-JSON and oversized results do not reach the native responder', async () => {
  let calls = 0;
  const submit = createPageSubmitter();
  const input = { page, carrier: carrier(() => { calls++; }), sessionId: 'session-a' };
  const circular = {}; circular.self = circular;
  for (const value of [undefined, 1n, circular, 'x'.repeat(65_536)]) await assert.rejects(submit({ ...input, value }));
  assert.equal(calls, 0);
});
