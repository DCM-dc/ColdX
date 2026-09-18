import test from 'node:test';
import assert from 'node:assert/strict';
import { foldSessionUsage, summarizeUsage } from '../plugin/usage-model.mjs';
import { nativeImport, nativeRuntime } from './native-helpers.mjs';

const epoch = Date.parse('2026-09-18T15:59:00Z');
function log(rows, header = {}) {
  return { session: { id: 'test-session', createdAt: epoch, ...header }, events: rows.map(([type, data, offset = 0], seq) => ({ type, data, seq, time: epoch + offset })) };
}
const usage = { inputTokens: 20, outputTokens: 30, cacheReadTokens: 80, reasoningTokens: 25 };

test('native stream and final usage replace the same step without counting reasoning twice', () => {
  const data = foldSessionUsage(log([
    ['step/start', { turn: 0, step: 0 }],
    ['assistant/chunk', { turn: 0, step: 0, chunk: { type: 'usage', usage: { ...usage, outputTokens: 25 } } }],
    ['assistant/message', { turn: 0, step: 0, usage }],
  ]), { timeZone: 'Asia/Shanghai' });
  assert.equal(data.totals.totalTokens, 130);
  assert.equal(data.totals.reasoningTokens, 25);
  assert.equal(data.coverage.reportedSteps, 1);
  assert.equal(data.days[0].date, '2026-09-18');
});

test('fork seed and replayed code dispatch are not billed or counted twice', () => {
  const data = foldSessionUsage(log([
    ['assistant/message', { turn: 0, step: 0, usage }],
    ['tool/call', { callId: 'old', name: 'bash', arguments: '{}' }],
    ['assistant/message', { turn: 1, step: 0, usage }],
    ['tool/code-dispatch-start', { subCallId: 'a:code:1', name: 'skill', arguments: { name: 'superpowers:debugging' } }],
    ['tool/code-dispatch', { subCallId: 'a:code:1', name: 'skill', arguments: { name: 'superpowers:debugging' }, isError: false }],
  ], { seedLength: 2, origin: 'subagent' }), { timeZone: 'UTC' });
  assert.equal(data.totals.totalTokens, 130);
  assert.deepEqual(data.tools.map(row => [row.name, row.count]), [['skill', 1]]);
  assert.deepEqual(data.skills.map(row => [row.name, row.count]), [['superpowers:debugging', 1]]);
});

test('provider call IDs reused across native steps and turns count each actual execution', async t => {
  const ctx = await nativeRuntime(); t.after(() => ctx.fiber.dispose());
  for (const name of ['dsh-session', 'dsh-agent', 'dsh-llm', 'dsh-agent-loop']) {
    const mod = await nativeImport('@deepseek-ai/' + name); await ctx.plugin(mod.default ?? mod, {});
  }
  const { LlmAdapter, createUserMessage } = await nativeImport('@deepseek-ai/dsh-llm');
  const { defineTool } = await nativeImport('@deepseek-ai/dsh-tools');
  let requests = 0, executions = 0;
  ctx.tools.register(defineTool({ name: 'fixture_probe', description: 'Local usage fixture', parameters: {},
    execute: async () => { executions++; return { ok: true }; },
    output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: 'ok' }] } }));
  class FixtureAdapter extends LlmAdapter {
    async *stream() {
      const block = ++requests % 3
        ? { type: 'tool-call', name: 'fixture_probe', id: 'call_0', arguments: '{}' }
        : { type: 'text', text: 'done' };
      yield { type: 'block-start', index: 0, blockType: block.type };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['usage-fixture'], new FixtureAdapter());
  const { agent } = await ctx.agents.create({ sessionId: 'usage-repeated-call-id', agentOptions: { provider: 'usage-fixture', model: 'fixture' } });
  for (let turn = 0; turn < 2; turn++) {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Run the local fixture' }] }));
    await agent.whenIdle();
  }
  assert.equal(executions, 4);
  const summary = foldSessionUsage({ session: agent.session.header, events: agent.session.events });
  assert.deepEqual(summary.tools, [{ name: 'fixture_probe', count: 4 }]);
});

test('code dispatch pairs inherit each root call step when their IDs are reused', () => {
  const dispatch = { rootCallId: 'call_0', parentCallId: 'call_0', subCallId: 'call_0:code:1', name: 'skill', arguments: { name: 'verification-before-completion' } };
  // Native nested dispatch events have no turn/step fields of their own.
  const rows = [[1, 1], [1, 2], [2, 1]].flatMap(([turn, step]) => [
    ['tool/call', { turn, step, callId: 'call_0', name: 'run_code', arguments: '{}' }],
    ['tool/code-dispatch-start', dispatch],
    ['tool/code-dispatch', { ...dispatch, isError: false, content: [] }],
  ]);
  const data = foldSessionUsage(log(rows, { seedLength: 3 }));
  assert.deepEqual(data.tools, [{ name: 'run_code', count: 2 }, { name: 'skill', count: 2 }]);
  assert.deepEqual(data.skills, [{ name: 'verification-before-completion', count: 2 }]);
});

test('missing usage stays missing while missing cache only removes cache certainty', () => {
  const data = foldSessionUsage(log([
    ['assistant/message', { turn: 0, step: 0, usage: { inputTokens: 100, outputTokens: 30 } }],
    ['assistant/message', { turn: 0, step: 1 }],
    ['assistant/message', { turn: 0, step: 2, usage: { inputTokens: -1, outputTokens: 8 } }],
  ]), { timeZone: 'UTC' });
  assert.equal(data.totals.totalTokens, 130);
  assert.equal(data.coverage.missingSteps, 2);
  assert.equal(data.coverage.cacheReportedSteps, 0);
  assert.equal(summarizeUsage([data], { now: epoch, timeZone: 'UTC' }).cacheHitRatio, null);
});

test('daily buckets use the selected timezone and exclude idle days from active duration', () => {
  const rows = [
    ['turn/start', { turn: 0 }], ['step/start', { turn: 0, step: 0 }],
    ['assistant/message', { turn: 0, step: 0, usage }, 120000], ['turn/end', { turn: 0 }, 120000],
    ['turn/start', { turn: 1 }, 2 * 86400000],
    ['assistant/message', { turn: 1, step: 0, usage }, 2 * 86400000 + 60000],
    ['turn/end', { turn: 1 }, 2 * 86400000 + 60000],
  ];
  const data = foldSessionUsage(log(rows), { timeZone: 'Asia/Shanghai' });
  assert.equal(data.activeMs, 180000);
  assert.deepEqual(data.days.map(row => row.date), ['2026-09-19', '2026-09-21']);
  const result = summarizeUsage([data], { now: epoch + 3 * 86400000, timeZone: 'Asia/Shanghai' });
  assert.equal(result.summary.longestSessionMs, 180000);
  assert.equal(result.summary.peakDailyTokens, 130);
});

test('streak counts yesterday when today has no activity and no sessions is an honest empty state', () => {
  const samples = [0, 86400000, 2 * 86400000].map((offset, i) => foldSessionUsage(log([
    ['assistant/message', { turn: 0, step: 0, usage }, offset],
  ], { id: 's' + i }), { timeZone: 'UTC' }));
  const result = summarizeUsage(samples, { now: epoch + 3 * 86400000, timeZone: 'UTC' });
  assert.equal(result.summary.currentStreak, 3);
  assert.equal(result.summary.longestStreak, 3);
  const empty = summarizeUsage([], { now: epoch, timeZone: 'UTC' });
  assert.equal(empty.summary.totalTokens, 0);
  assert.equal(empty.coverage.reportedSteps, 0);
  assert.equal(empty.cacheHitRatio, null);
  assert.equal(empty.days.length, 0);
});

test('summaries contain only metrics, never prompts or tool arguments', () => {
  const data = foldSessionUsage(log([
    ['user/message', { content: [{ type: 'text', text: 'PRIVATE CONTENT' }] }],
    ['tool/call', { callId: 'x', name: 'pwsh', arguments: '{"command":"PRIVATE COMMAND"}' }],
  ]), { timeZone: 'UTC' });
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE/);
});

test('effort follows the actual native request header, including inherited configuration', () => {
  const data = foldSessionUsage(log([
    ['request/header', { header: { config: { reasoningEffort: 'max' } } }],
    ['step/start', { turn: 0, step: 0 }],
    ['assistant/message', { turn: 0, step: 0, usage }],
  ], { seedLength: 1 }), { timeZone: 'UTC' });
  assert.deepEqual(data.efforts, [{ name: 'max', count: 1 }]);
});

test('crash-recovery closing time never counts days of downtime as active work', () => {
  const data = foldSessionUsage(log([
    ['turn/start', { turn: 0 }],
    ['assistant/message', { turn: 0, step: 0, usage }, 60000],
    ['turn/end', { turn: 0, reason: { kind: 'interrupted' } }, 10 * 86400000],
  ]), { timeZone: 'UTC' });
  assert.equal(data.activeMs, 0);
});
