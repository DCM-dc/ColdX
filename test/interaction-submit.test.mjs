import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

async function submitter() {
  const file = new URL('../plugin/client/interaction-submit.mjs', import.meta.url);
  assert.ok(existsSync(file), 'native choice submitter must exist');
  return (await import(file)).createInteractionSubmitter();
}
const question = { id: 'choose-files', question: '选择整理效果', options: [{ label: '按项目' }, { label: '混合方案' }] };
const makeCarrier = respond => ({ kind: 'question', key: 'question:opaque', sessionId: 'session-owner', payload: { questions: [question] }, respond });

test('native choices preserve labels, owner and carrier identity, and deduplicate rapid submits', async () => {
  const submit = await submitter();
  const messages = [];
  let accept;
  const carrier = makeCarrier(message => { messages.push(message); return new Promise(resolve => { accept = resolve; }); });
  const first = submit({ carrier, sessionId: 'session-owner', answers: [{ id: question.id, selected: ['混合方案'] }] });
  const second = submit({ carrier, sessionId: 'session-owner', answers: [{ id: question.id, selected: ['按项目'] }] });
  await Promise.resolve();
  accept({ accepted: true });
  assert.deepEqual(await first, await second);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], { ok: true, value: { sessionId: 'session-owner', answer: { answers: [{ id: question.id, selected: ['混合方案'] }] } } });
});

test('choice submission rejects wrong owner, invalid labels, missing questions and protected intents', async () => {
  const submit = await submitter();
  let calls = 0;
  const carrier = makeCarrier(async () => { calls++; return { accepted: true }; });
  for (const args of [
    { sessionId: 'other', answers: [{ id: question.id, selected: ['按项目'] }] },
    { sessionId: 'session-owner', answers: [] },
    { sessionId: 'session-owner', answers: [{ id: question.id, selected: ['不存在'] }] },
    { sessionId: 'session-owner', answers: [{ id: question.id, selected: ['按项目', '混合方案'] }] },
    { sessionId: 'session-owner', answers: [{ id: question.id, selected: [], custom: ' ' }] },
  ]) await assert.rejects(submit({ carrier, ...args }));
  await assert.rejects(submit({ carrier: { ...carrier, payload: { questions: [{ ...question, intent: { kind: 'plan-review', approve: '按项目' } }] } }, sessionId: 'session-owner', answers: [{ id: question.id, selected: ['按项目'] }] }));
  assert.equal(calls, 0);
});

test('native multiple questions and custom responses retain their semantics and retry after refusal', async () => {
  const submit = await submitter();
  const messages = [];
  const carrier = { ...makeCarrier(async message => { messages.push(message); return { accepted: messages.length > 1 }; }), payload: { questions: [
    { ...question, multiSelect: true }, { id: 'name', question: '目录名' },
  ] } };
  const args = { carrier, sessionId: 'session-owner', answers: [{ id: 'name', selected: [], custom: '  我的项目  ' }, { id: question.id, selected: ['按项目', '混合方案'], custom: '保留截图' }] };
  await assert.rejects(submit(args), /未被接收/);
  const accepted = await submit(args);
  assert.deepEqual(accepted, [{ id: question.id, selected: ['按项目', '混合方案'], custom: '保留截图' }, { id: 'name', selected: [], custom: '我的项目' }]);
  assert.equal(messages.length, 2);
});

test('explicit no-custom constraints and oversized answers never reach the native responder', async () => {
  const submit = await submitter();
  let calls = 0;
  const carrier = makeCarrier(async () => { calls++; return { accepted: true }; });
  await assert.rejects(submit({ carrier, sessionId: 'session-owner', constraints: { [question.id]: { allowCustom: false } }, answers: [{ id: question.id, selected: [], custom: '自定义' }] }));
  await assert.rejects(submit({ carrier, sessionId: 'session-owner', answers: [{ id: question.id, selected: [], custom: 'a'.repeat(65537) }] }));
  assert.equal(calls, 0);
});
