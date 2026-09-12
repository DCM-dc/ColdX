import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CATEGORY_COUNTS, HARD_GATES, CACHE_AB_TARGETS, validateScenarioSet, passesGate } from '../eval/prompt/rubric.mjs';

const scenarios = JSON.parse(await readFile(new URL('../eval/prompt/scenarios.json', import.meta.url), 'utf8'));

test('prompt release set contains 36 balanced direct and implicit-interface scenarios', () => {
  const report = validateScenarioSet(scenarios);
  assert.equal(report.total, 36);
  assert.deepEqual(report.counts, CATEGORY_COUNTS);
});

test('release gates cover autonomy, truthfulness, delegation, sources, and cache A/B', () => {
  for (const name of ['taskSuccess', 'uiAutonomy', 'proactiveResultPage', 'missedUsefulPage', 'pageBeforeFinish', 'freshPageAfterWork', 'unjustifiedQuestions', 'unnecessarySubagent', 'missedUsefulParallelism', 'citationPrecision', 'unsupportedTruthClaim', 'unverifiedCompletion']) assert.ok(HARD_GATES[name]);
  for (const name of ['staticCharacterReduction', 'warmUncachedInputTokenReduction', 'cacheReadRateRegressionPoints', 'taskSuccessRegressionPoints', 'p50WallTimeRegression']) assert.ok(CACHE_AB_TARGETS[name]);
  assert.equal(passesGate(HARD_GATES.taskSuccess, 0.90), true);
  assert.equal(passesGate(HARD_GATES.taskSuccess, 0.89), false);
  assert.equal(passesGate(HARD_GATES.unsupportedTruthClaim, 0), true);
  assert.equal(passesGate(HARD_GATES.unsupportedTruthClaim, 1), false);
  assert.equal(passesGate(HARD_GATES.taskSuccess, Number.NaN), false);
});

test('implicit-interface scenarios never tell the model to build a page', () => {
  const rows = scenarios.filter(scenario => scenario.category === 'implicitInterface');
  assert.equal(rows.length, 6);
  for (const scenario of rows) {
    assert.doesNotMatch(scenario.prompt, /(?:页面|网页|界面|交互|\bUI\b|\bpages?\b|\binterface\b|\bdashboard\b|\btimeline\b)/i, scenario.id);
    assert.ok(scenario.expected.some(value => /autonomous|主动/.test(value)), scenario.id);
  }
});

test('every scenario defines both success evidence and explicit failure behavior', () => {
  for (const scenario of scenarios) {
    assert.ok(scenario.expected.length > 0, scenario.id);
    assert.ok(scenario.forbidden.length > 0, scenario.id);
  }
});
