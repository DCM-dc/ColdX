import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createWorkspaceShell } from '../plugin/client/workspace-shell-source.mjs';
import { selectActivityModel } from '../plugin/client/activity-source.mjs';

test('serialized workspace factory keeps home presentational and metrics honest', () => {
  const factory = new Function(`return (${createWorkspaceShell.toString()})`)();
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), Fragment: 'fragment' };
  const { Home, KernelStatus } = factory(React);
  assert.match(JSON.stringify(Home()), /今天想完成什么/);
  const empty = JSON.stringify(KernelStatus({ loading: true }));
  assert.match(empty, /正在读取运行状态/);
  assert.doesNotMatch(empty, /NaN|undefined|token/);
  const metrics = JSON.stringify(KernelStatus({ snapshot: {
    version: 1, scheduler: { active: 1, queued: 0 }, session: {
      requestCount: 2, completed: 1, failed: 0, cancelled: 0, toolCount: 3,
      last: { state: 'running', queueMs: 17, firstChunkMs: null, durationMs: null, context: { totalChars: 1850 }, usage: null },
    },
  } }));
  assert.match(metrics, /1,850/);
  assert.match(metrics, /17 ms/);
  assert.doesNotMatch(metrics, /1850 token|undefined|NaN/);
  assert.match(metrics, /全局运行/);
  const status = KernelStatus({snapshot:{version:1,session:{last:{state:'running'}}}});
  assert.doesNotMatch(JSON.stringify(status.children[0]), /运行中/);
});

test('one activity projection reads native chat map once and updates mutable same-session state', () => {
  const nodes = new Map();
  const order = [];
  for (let i = 0; i < 240; i++) {
    const key = `row-${i}`;
    order.push(key);
    nodes.set(key, { key, kind: 'message', anchorSeq: i });
  }
  const result = { kind: 'tool-result', callId: 'edit-1', seq: 242, time: 1, call: { name: 'edit' },
    callView: { card: 'diff', diffs: [{ path: 'first.txt' }] }, subCalls: [] };
  order.push('call');
  nodes.set('call', { kind: 'tool-call', anchorSeq: 242, data: { root: result } });
  let gets = 0;
  const originalGet = nodes.get.bind(nodes);
  nodes.get = key => { gets++; return originalGet(key); };
  const session = { sessionId: 'owner-a', chat: { order, nodes }, views: new Map() };
  const subagents = { entries: [{ kind: 'child', id: 'child-a', mode: 'one-shot', label: '任务 A' }] };
  const sessionsState = { byId: { 'owner-a': { cwd: 'C:/work' }, 'child-a': { displayTitle: '任务 A', running: true } } };
  const jobs = [{ id: 'job-a', label: '后台任务', status: 'running', startedAt: 1 }];
  const input = { sessionId: 'owner-a', session, subagents, sessionsState, jobs };
  const initial = selectActivityModel(input);
  assert.ok(gets <= order.length + 1, `one scan expected; got ${gets} map reads for ${order.length} rows`);
  assert.equal(initial.outputs.find(item => item.kind === 'file').path, 'first.txt');
  assert.equal(initial.subagents[0].status, 'running');
  gets = 0;
  result.callView.diffs[0].path = 'second.txt';
  sessionsState.byId['child-a'].running = false;
  jobs[0].status = 'failed';
  const updated = selectActivityModel(input);
  assert.ok(gets <= order.length + 1);
  assert.equal(updated.outputs.find(item => item.kind === 'file').path, 'second.txt');
  assert.equal(updated.subagents[0].status, 'inactive');
  assert.equal(updated.jobs[0].status, 'failed');
  assert.equal(initial.outputs.find(item => item.kind === 'file').path, 'first.txt');
  const other = selectActivityModel({ ...input, sessionId: 'owner-b', sessionsState: { byId: { 'owner-b': { cwd: 'D:/other' } } }, subagents: { entries: [] }, jobs: [] });
  assert.equal(other.sessionId, 'owner-b');
  assert.equal(other.subagents.length, 0);
  assert.equal(other.jobs.length, 0);
});

test('workspace presentation preserves native controls and responsive escape hatches', async () => {
  const css = await readFile(new URL('../plugin/client/workspace-shell.css', import.meta.url), 'utf8');
  for (const selector of ['.hHd-Xa_root', '.YDXeBa_sessionRow', '.wSkVaW_root', '.cx-workbench-panel', '.cx-activity-sheet', '[data-composer-card]', '.cx-composer-menu', '.cx-kernel-status']) {
    assert.ok(css.includes(selector), selector);
  }
  assert.match(css, /max-width: 820px/);
  assert.match(css, /max-width: 520px/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(css, /display:\s*none[^}]*uV2eYG|transition:\s*all/);
});
