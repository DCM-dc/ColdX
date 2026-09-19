// Reproducible local CPU microbenchmark for projection only, not model quality.
import { execFileSync } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { selectActivityModel as current } from '../plugin/client/activity-source.mjs';

const baseRef = process.argv[2] ?? 'c58d63d';
const baselineSource = execFileSync('git', ['show', `${baseRef}:plugin/client/activity-source.mjs`], { encoding: 'utf8' });
const baseline = (await import(`data:text/javascript;base64,${Buffer.from(baselineSource).toString('base64')}`)).selectActivityModel;
const order = [], nodes = new Map();
for (let i = 0; i < 600; i++) {
  const key = `message-${i}`;
  order.push(key);
  nodes.set(key, { kind: 'message', key, anchorSeq: i });
  if (i % 2 === 0) {
    const callId = `tool-${i}`;
    const tool = { kind: 'tool-result', callId, seq: i, callTime: i, time: i + 1, isError: false,
      call: { name: 'edit' }, callView: { card: 'diff', title: `edit ${i}`, diffs: [{ path: `file-${i % 40}.txt` }] },
      resultView: { card: 'diff', diffs: [{ path: `file-${i % 40}.txt` }] }, subCalls: [] };
    order.push(callId);
    nodes.set(callId, { kind: 'tool-call', anchorSeq: i, data: { root: tool } });
  }
}
const input = { sessionId: 'activity-bench', session: { sessionId: 'activity-bench', chat: { order, nodes }, views: new Map(), running: false },
  sessionsState: { byId: { 'activity-bench': { cwd: 'C:/work' } } },
  pages: Array.from({ length: 30 }, (_, i) => ({ pageId: `page-${i}`, title: `Result ${i}`, sequence: i + 1 })),
  subagents: { entries: Array.from({ length: 12 }, (_, i) => ({ id: `child-${i}`, kind: 'child', mode: 'one-shot', label: `Child ${i}` })) },
  jobs: Array.from({ length: 8 }, (_, i) => ({ id: `job-${i}`, label: `Job ${i}`, status: 'running', startedAt: i })) };
assert.deepStrictEqual(current(input), baseline(input), 'projection result must equal baseline');
function measure(fn, iterations = 90) {
  for (let i = 0; i < 20; i++) fn(input);
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now(); fn(input); samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return { medianMs: samples[Math.floor(samples.length / 2)], p90Ms: samples[Math.floor(samples.length * .9)] };
}
// Interleave orders to limit JIT/thermal bias, then use the second pass.
measure(baseline, 20); measure(current, 20);
const before = measure(baseline), after = measure(current);
const report = { kind: 'activity-projection-cpu', baselineRef: baseRef, outputEquivalent: true,
  fixture: { chatRows: order.length, tools: 300, pages: 30, children: 12, jobs: 8 },
  iterations: 90, warmup: 20, before, after,
  scope: 'selectActivityModel CPU only; no UI paint, model request, network, or memory-allocation claim' };
await mkdir('.runtime', { recursive: true });
await writeFile('.runtime/bench-activity.json', `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report)}\n`);
