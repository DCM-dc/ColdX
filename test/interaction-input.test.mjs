import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

test('interaction validation keeps stable option IDs, safe previews and native answer semantics', async () => {
  assert.ok(existsSync(new URL('../plugin/interaction-input.mjs', import.meta.url)), 'interaction validation must exist');
  const { normalizeInteractionInput, normalizeInteractionAnswer } = await import('../plugin/interaction-input.mjs');
  const input = normalizeInteractionInput({ title: '方案', question: '选哪一种？', options: [
    { id: 'cool', label: '冰蓝', recommended: true, preview: { script: 'document.getElementById("coldx-root").textContent="冰蓝";' } },
    { id: 'warm', label: '暖橙', description: '暖色调' },
  ], multiSelect: true });
  assert.equal(input.options[0].preview.html, '<div id="coldx-root"></div>');
  assert.equal(input.options[0].recommended, true);
  assert.throws(() => normalizeInteractionInput({ ...input, options: input.options.map(option => ({ ...option, recommended: true })) }), /recommended/);
  assert.deepEqual(normalizeInteractionAnswer(input, 'question-1', { answers: [{ id: 'question-1', selected: ['暖橙', '冰蓝'], custom: '浅一点' }] }), {
    selectedIds: ['warm', 'cool'], selectedLabels: ['暖橙', '冰蓝'], custom: '浅一点',
  });
  for (const answers of [
    [{ id: 'other', selected: ['冰蓝'] }], [{ id: 'question-1', selected: ['不存在'] }],
    [{ id: 'question-1', selected: ['冰蓝', '冰蓝'] }], [{ id: 'question-1', selected: [] }],
  ]) assert.throws(() => normalizeInteractionAnswer(input, 'question-1', { answers }));
  assert.throws(() => normalizeInteractionInput({ ...input, options: [{ id: 'a', label: '重复' }, { id: 'b', label: '重复' }] }), /unique/);
  assert.throws(() => normalizeInteractionInput({ ...input, options: [], allowCustom: false }));
  const custom = normalizeInteractionInput({ title: '输入', question: '名称是什么？', options: [] });
  assert.deepEqual(normalizeInteractionAnswer(custom, 'q', { answers: [{ id: 'q', selected: [], custom: '测试' }] }), {
    selectedIds: [], selectedLabels: [], custom: '测试',
  });
});
