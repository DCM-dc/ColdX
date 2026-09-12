import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

test('result display omits an isolated trailing model marker without changing stored content or literal examples', async () => {
  const { createWorkspaceModel } = await import('../plugin/client/workspace-model.mjs');
  const model = createWorkspaceModel();
  const marker = '<|DS2_AGENT_DONE|>';
  const raw = `已选择 **雾蓝**。\n\n${marker}\n`;
  const page = { pageId: 'result', resultText: raw };
  assert.equal(model.formatResult(raw), '已选择 **雾蓝**。');
  assert.equal(model({ pages: [page] }).entries[0].resultText, raw);
  for (const literal of [marker, `正文中的 ${marker}`, `说明\n\n> ${marker}`, `示例\n\n    ${marker}`, `示例\n\n\`\`\`text\n${marker}`, `示例\n\n~~~\n${marker}`, `示例\n\n\`\`\`text\n${marker}\n\`\`\``]) {
    assert.equal(model.formatResult(literal), literal);
  }
  assert.equal(model.formatResult(`\`\`\`js\nconst done = true;\n\`\`\`\n完成。\n\n${marker}`), '\`\`\`js\nconst done = true;\n\`\`\`\n完成。');
});

test('workbench orders native pages and decisions and gives supported pending questions a live surface', async () => {
  const url = new URL('../plugin/client/workspace-model.mjs', import.meta.url);
  assert.ok(existsSync(url), 'workbench entry model exists');
  const { createWorkspaceModel } = await import(url);
  const model = createWorkspaceModel();
  const carrier = { kind: 'question', key: 'question:live', sessionId: 'session-a', payload: { questions: [{ id: 'native-q', question: '你想用哪种方式？', options: [{ label: '混合' }, { label: '项目' }] }] } };
  const view = model({ pages: [{ pageId: 'p1', sequence: 5, title: '总览', status: 'displayed' }], flow: { currentTurn: 1, interactions: [{ interactionId: 'i1', questionId: 'coldx-interaction:i1:1', sequence: 8, status: 'selected', title: '风格' }], completion: null }, pending: [carrier], sessionId: 'session-a' });
  assert.deepEqual(view.entries.map(x => x.pageId), ['p1', 'i1', 'question:live']);
  assert.equal(view.latestId, 'question:live');
  assert.equal(view.entries[2].kind, 'question');
  assert.equal(view.entries[2].carrier, carrier);
  assert.equal(model.canPresent(carrier), true);
  assert.equal(model.canPresent({ ...carrier, payload: { questions: [{ ...carrier.payload.questions[0], intent: { kind: 'plan-review' } }] } }), false);
});

test('typed pending decisions are not duplicated, completion follows them, and foreign carriers are excluded', async () => {
  const { createWorkspaceModel } = await import('../plugin/client/workspace-model.mjs');
  const model = createWorkspaceModel();
  const decision = { interactionId: 'i', questionId: 'coldx-interaction:i:1', title: '选择', sequence: 2, status: 'waiting' };
  const carrier = { kind: 'question', key: 'q:i', sessionId: 's', payload: { questions: [{ id: decision.questionId, question: '选择' }] } };
  const flow = { currentTurn: 1, interactions: [decision], completion: null };
  assert.equal(model({ pages: [], flow, pending: [carrier], sessionId: 's' }).entries.length, 1);
  assert.equal(model({ pages: [], flow, pending: [carrier], sessionId: 'other' }).entries[0].carrier, undefined);
  const completed = model({ pages: [], flow: { ...flow, interactions: [{ ...decision, status: 'selected' }], completion: { callId: 'finish', summary: '已整理', sequence: 9, turn: 1 } }, pending: [], sessionId: 's' });
  assert.equal(completed.latestId, 'finish:finish');
  assert.equal(completed.entries[1].resultText, '已整理');
  const withResult = model({ pages: [{ pageId: 'coldx-result:turn:1', resultText: '完整结果', sequence: 11 }], flow: { ...flow, completion: { callId: 'finish', summary: '已整理', sequence: 9, turn: 1 } }, pending: [], sessionId: 's' });
  assert.equal(withResult.entries.filter(e => e.resultText).length, 1);
  const withPage = model({ pages: [{ pageId: 'visual-result', title: '可视结果', sequence: 8, status: 'displayed' }], flow: { ...flow, completion: { callId: 'finish', summary: '重复摘要', sequence: 9, turn: 1 } }, pending: [], sessionId: 's' });
  assert.deepEqual(withPage.entries.map(entry => entry.pageId), ['i', 'visual-result'], 'a generated result page must not gain a forced duplicate summary card');
  assert.equal(withPage.latestId, 'visual-result');
});

test('carrier-first hydration retains the decision identity', async () => {
  const { createWorkspaceModel } = await import('../plugin/client/workspace-model.mjs');
  const model = createWorkspaceModel();
  const carrier = { kind: 'question', key: 'question:rpc', sessionId: 's', payload: { questions: [{ id: 'coldx-interaction:choice:1', question: '哪个效果？' }] } };
  const first = model({ pending: [carrier], sessionId: 's' });
  const next = model({ pending: [carrier], sessionId: 's', flow: { interactions: [{ interactionId: 'choice', questionId: carrier.payload.questions[0].id, title: '效果', status: 'waiting' }] } });
  assert.equal(first.entries[0].pageId, next.entries[0].pageId);
  assert.equal(next.entries.length, 1);
});

test('a short answer with native completion activity stays in native chat', async () => {
  const { createWorkspaceModel } = await import('../plugin/client/workspace-model.mjs');
  const model = createWorkspaceModel();
  const view = model({ flow: {
    phase: 'completed', currentTurn: 1, interactions: [],
    activity: [{ id: 'answer', name: 'coldx_finish', sequence: 2, status: 'completed' }],
    completion: { callId: 'answer', summary: '42', turn: 1, sequence: 3 },
  } });
  assert.deepEqual(view.entries, []);
  assert.equal(view.latestId, undefined);
});

test('business tool activity leaves native chat visible until the task has a generated surface', async () => {
  const { createWorkspaceModel } = await import('../plugin/client/workspace-model.mjs');
  const model = createWorkspaceModel();
  const flow = {
    phase: 'working', currentTurn: 7, completion: null, interactions: [],
    activity: [
      { id: 'read-1', name: 'read', sequence: 41, status: 'completed' },
      { id: 'grep-1', name: 'grep', sequence: 46, status: 'running' },
    ],
  };
  const view = model({ pages: [], flow, pending: [], sessionId: 'session-a' });
  assert.deepEqual(view.entries, []);
  assert.equal(view.latestId, undefined);
});

test('a generated task page remains the main surface when later tools continue working', async () => {
  const { createWorkspaceModel } = await import('../plugin/client/workspace-model.mjs');
  const model = createWorkspaceModel();
  const page = { pageId: 'repo-map', title: '仓库关系', sequence: 40, status: 'displayed', html: '<main>依赖关系</main>' };
  const flow = {
    phase: 'working', currentTurn: 7, completion: null, interactions: [],
    activity: [{ id: 'read-1', name: 'read', sequence: 41, status: 'running' }],
  };
  const view = model({ pages: [page], flow, pending: [], sessionId: 'session-a' });
  assert.deepEqual(view.entries.map(entry => entry.pageId), ['repo-map']);
  assert.equal(view.latestId, 'repo-map');
  assert.equal(view.entries[0].kind, 'page');
  assert.equal(view.entries[0].html, '<main>依赖关系</main>');
});
