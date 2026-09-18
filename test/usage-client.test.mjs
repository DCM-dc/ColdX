import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsageComponents } from '../plugin/client/usage-source.mjs';
const api = createUsageComponents({ createElement() {} }, async () => {});

test('daily heatmap spans complete weeks with real daily amounts and explicit missing counts', () => {
  const chart = api.buildHeatmap([{ date: '2026-09-18', totalTokens: 120, missingSteps: 1 }], '2026-09-18', 'day');
  const cell = chart.find(row => row.date === '2026-09-18');
  assert.equal(cell.value, 120); assert.equal(cell.missing, 1);
  assert.equal(new Date(chart[0].date + 'T12:00:00Z').getUTCDay(), 1);
  assert.ok(chart.length >= 365 && chart.length <= 371);
});

test('weekly aggregation does not multiply a daily token count and cumulative includes older history', () => {
  const rows = [{ date: '2024-01-01', totalTokens: 100 }, { date: '2026-09-14', totalTokens: 30 }, { date: '2026-09-18', totalTokens: 20 }];
  assert.equal(api.buildHeatmap(rows, '2026-09-18', 'week').at(-1).value, 50);
  assert.equal(api.buildHeatmap(rows, '2026-09-18', 'cumulative').at(-1).value, 150);
});

test('formatters show unknown as a dash and registered components are callable', () => {
  assert.equal(api.formatCount(null), '—');
  assert.equal(api.formatCount(0), '0');
  assert.equal(api.formatDuration(12 * 3600000 + 16 * 60000), '12 小时 16 分');
  for (const key of ['UsageEntry', 'UsageSettingsRow', 'BalanceNotice']) assert.equal(typeof api[key], 'function');
});
