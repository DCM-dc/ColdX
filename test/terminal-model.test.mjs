import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createTerminalComponents, selectTerminalRecords, truncateTerminalOutput } from '../plugin/client/terminal-source.mjs';
import { selectConversationActivity } from '../plugin/client/activity-source.mjs';

function chat(...nodes) {
  const map = new Map(nodes.map((node, index) => [node.key ?? `node-${index}`, node]));
  return { order: [...map.keys()], nodes: { get: key => map.get(key) } };
}

function tool(root) { return { key: root.callId, kind: 'tool-call', anchorSeq: root.seq ?? root.time, data: { root } }; }

test('Terminal model pairs real running commands and settled output without guessing', () => {
  const running = { callId: 'live', name: 'pwsh', time: 20, callView: { card: 'terminal', title: 'python demo.py', cwd: 'C:/repo' }, subCalls: [] };
  const passed = { kind: 'tool-result', callId: 'passed', seq: 8, time: 90, callTime: 80, call: { name: 'pwsh' }, isError: false, content: [], subCalls: [], callView: { card: 'terminal', title: 'pnpm test', cwd: 'C:/repo' }, resultView: { card: 'terminal', title: 'Tests', output: '12 passed\n', exitCode: 0 } };
  const failed = { kind: 'tool-result', callId: 'failed', seq: 9, time: 100, callTime: 95, call: { name: 'pwsh' }, isError: false, content: [], subCalls: [], callView: { card: 'terminal', title: 'cc bad.c' }, resultView: { card: 'terminal', output: 'compile error', exitCode: 1 } };
  const resultOnly = { kind: 'tool-result', callId: 'trimmed', seq: 10, time: 110, callTime: 105, call: { name: 'pwsh', argsRaw: 'secret command' }, isError: false, content: [{ type: 'text', text: 'do not parse' }], subCalls: [], resultView: { card: 'terminal', title: 'Captured output', output: 'kept', signal: 'SIGTERM' } };
  const generic = { kind: 'tool-result', callId: 'job', seq: 11, time: 120, callTime: 115, call: { name: 'job_output' }, isError: false, content: [{ type: 'text', text: 'background bytes' }], subCalls: [], callView: { card: 'generic', title: 'job output' }, resultView: { card: 'generic', title: 'job output' } };
  const session = { runningCalls: [running], chat: chat(tool(passed), tool(failed), tool(resultOnly), tool(generic)) };
  const records = selectTerminalRecords({ session }, selectConversationActivity);
  assert.deepEqual(records.map(row => ({ callId: row.callId, status: row.status, command: row.command, output: row.output, exitCode: row.exitCode, signal: row.signal })), [
    { callId: 'live', status: 'running', command: 'python demo.py', output: undefined, exitCode: undefined, signal: undefined },
    { callId: 'trimmed', status: 'failed', command: undefined, output: 'kept', exitCode: undefined, signal: 'SIGTERM' },
    { callId: 'failed', status: 'failed', command: 'cc bad.c', output: 'compile error', exitCode: 1, signal: undefined },
    { callId: 'passed', status: 'completed', command: 'pnpm test', output: '12 passed\n', exitCode: 0, signal: undefined },
  ]);
  assert.doesNotMatch(JSON.stringify(records), /secret command|do not parse|background bytes/);
});

test('Terminal output is bounded at a visible line-safe tail', () => {
  const value = `first line\n${'x'.repeat(40)}\nlast line`;
  assert.deepEqual(truncateTerminalOutput(value, 24), { text: '…\nxxxxxxxxxxxxxx\nlast line', truncated: true, omitted: value.length - 24 });
  assert.deepEqual(truncateTerminalOutput('short', 24), { text: 'short', truncated: false, omitted: 0 });
});

test('Terminal history has a total DOM budget while retaining the newest real rows', () => {
  const roots = Array.from({ length: 52 }, (_, index) => ({
    kind: 'tool-result', callId: `call-${index}`, seq: index + 1, time: index + 1,
    call: { name: 'pwsh' }, isError: false, content: [], subCalls: [],
    callView: { card: 'terminal', title: `command ${index}` },
    resultView: { card: 'terminal', output: `${index}:`.padEnd(30_000, 'x'), exitCode: 0 },
  }));
  const records = selectTerminalRecords({ session: { chat: chat(...roots.map(tool)) } }, selectConversationActivity);
  assert.equal(records.length, 40);
  assert.equal(records[0].callId, 'call-51');
  assert.equal(records.at(-1).callId, 'call-12');
  assert.ok(records.reduce((sum, record) => sum + (record.output?.length ?? 0), 0) <= 500_000);
  assert.ok(records.some(record => record.outputTruncated && record.outputOmitted > 0));
});

test('running commands lead history, keep their seat across stream/snapshot handoff, and sort stably newest first', () => {
  let native = [];
  const api = createTerminalComponents({ createElement() {} }, { selectConversationActivity: () => native }, null);
  const pending = (callId, time) => ({ callId, status: 'running', startedAt: time, presentation: { callView: { card: 'terminal', title: callId } } });
  const live = (callId, time) => ({ id: `${callId}:1`, callId, sessionId: 's', startedAt: time, status: 'running', output: `${callId} partial` });
  native = [pending('older', 90), pending('newer', 100)];
  const original = api.selectTerminalRecords({ sessionId: 's' });
  assert.deepEqual(original.map(row => row.callId), ['newer', 'older']);
  // Process spawn is later than the tool call. It must not reorder existing seats.
  let rows = api.selectTerminalRecords({ sessionId: 's', liveRecords: [live('older', 120), live('newer', 110)] });
  assert.deepEqual(rows.map(row => row.callId), ['newer', 'older']);
  assert.deepEqual(rows.map(row => row.key), original.map(row => row.key));
  // A stream may arrive before its native call projection. Late metadata keeps its place.
  native = [];
  rows = api.selectTerminalRecords({ sessionId: 's', liveRecords: [live('stream-first', 95), live('newer', 110)] });
  const before = rows.map(row => row.key);
  native = [pending('stream-first', 130), pending('newer', 100)];
  rows = api.selectTerminalRecords({ sessionId: 's', liveRecords: [live('newer', 110), live('stream-first', 95)] });
  assert.deepEqual(rows.map(row => row.key), before);
  native = [...native, { ...pending('closed', 1000), status: 'completed', presentation: { callView: { card: 'terminal', title: 'closed' }, resultView: { card: 'terminal', output: 'done', exitCode: 0 } } }];
  rows = api.selectTerminalRecords({ sessionId: 's', liveRecords: [live('newer', 110), live('stream-first', 95)] });
  assert.equal(rows.at(-1).callId, 'closed');
});

test('history limits keep active commands and give their output the first display budget', () => {
  const select = () => Array.from({ length: 50 }, (_, index) => ({ callId: `old-${index}`, status: 'completed', startedAt: index + 10,
    presentation: { callView: { card: 'terminal', title: `old-${index}` }, resultView: { card: 'terminal', output: 'x'.repeat(200_000), exitCode: 0 } } }));
  const records = selectTerminalRecords({ sessionId: 's', liveRecords: [{ id: 'long:1', callId: 'long', sessionId: 's', status: 'running', startedAt: 1, output: 'live output' }] }, select);
  assert.equal(records.length, 40); assert.equal(records[0].callId, 'long'); assert.equal(records[0].output, 'live output');
  assert.equal(records[1].callId, 'old-49');
});

test('serialized Terminal factory owns its model and settings behavior', () => {
  const factory = vm.runInNewContext(`(${createTerminalComponents.toString()})`);
  const activity = { selectConversationActivity: () => [] };
  const scope = { getSnapshot: () => ({ status: 'ready', value: { showTerminal: false }, writable: true }), subscribe: () => () => {}, set: async () => {} };
  const api = factory({ createElement() {} }, activity, scope, {});
  assert.equal(typeof api.TerminalSettingsRow, 'function');
  assert.equal(typeof api.SessionTerminal, 'function');
  assert.equal(api.selectTerminalRecords({}).length, 0);
});

test('terminal live output merges with the owning call before settlement and never crosses sessions', () => {
  const running = { callId: 'live', name: 'pwsh', time: 20, callView: { card: 'terminal', title: 'python demo.py' }, subCalls: [] };
  const input = { sessionId: 'a', session: { runningCalls: [running] }, liveRecords: [
    { id: 'live:1', sessionId: 'a', callId: 'live', command: 'python demo.py', output: 'first line\n', status: 'running', startedAt: 20 },
    { id: 'other:2', sessionId: 'b', callId: 'other', command: 'private command', output: 'private output', status: 'running' },
  ] };
  const records = selectTerminalRecords(input, selectConversationActivity);
  assert.equal(records.length, 1); assert.equal(records[0].output, 'first line\n'); assert.equal(records[0].status, 'running');
  assert.equal(records[0].streaming, true);
  assert.doesNotMatch(JSON.stringify(records), /private/);
  input.liveRecords[0] = { ...input.liveRecords[0], status: 'cancelled', signal: 'SIGTERM', finishedAt: 40 };
  assert.equal(selectTerminalRecords(input, selectConversationActivity)[0].status, 'cancelled');
});

test('native background admission does not mark a still-running streamed process complete', () => {
  const settled = { kind: 'tool-result', callId: 'background', seq: 5, time: 5, callTime: 1, call: { name: 'pwsh' }, content: [], subCalls: [], callView: { card: 'terminal', title: 'python task.py' }, resultView: { card: 'terminal', output: '', exitCode: 0 } };
  const records = selectTerminalRecords({ sessionId: 'a', session: { chat: chat(tool(settled)) }, liveRecords: [
    { id: 'background:1', sessionId: 'a', callId: 'background', background: true, output: 'still working', status: 'running', startedAt: 2 },
  ] }, selectConversationActivity);
  assert.equal(records.length, 1); assert.equal(records[0].status, 'running'); assert.equal(records[0].output, 'still working');
  assert.equal(records[0].exitCode, undefined);
});
