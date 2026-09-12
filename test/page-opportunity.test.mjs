import test from 'node:test';
import assert from 'node:assert/strict';
import * as intent from '../plugin/page-opportunity.mjs';

test('explicit text-output intent is preserved without exposing a page requirement classifier', () => {
  for (const prompt of [
    '比较三个方案，但不要生成页面，只用文字回答。',
    '比较三个方案，用三句话给结论。',
    'Compare the options in two sentences.',
    'Return JSON only.',
  ]) assert.equal(intent.isExplicitTextOnly(prompt), true, prompt);

  for (const prompt of [
    '比较三个方案并给出建议。',
    '研究近期项目并说明证据。',
    '修好问题并展示结果。',
  ]) assert.equal(intent.isExplicitTextOnly(prompt), false, prompt);

  assert.equal('assessPageOpportunity' in intent, false, 'runtime must not expose a reusable hard page gate');
  assert.equal('inspectPageOpportunity' in intent, false, 'runtime must not keep hidden business-step scoring');
});
