import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createTui, parseTuiArguments, renderPlainHistory } from '../lib/tui/interface.mjs';

test('CLI defaults to the local Host and rejects unsupported flags', () => {
  assert.deepEqual(parseTuiArguments([]), { url: 'http://127.0.0.1:3086', sessionId: undefined, help: false });
  assert.deepEqual(parseTuiArguments(['--url', 'http://127.0.0.1:3087', '--session', 's1']), { url: 'http://127.0.0.1:3087', sessionId: 's1', help: false });
  assert.throws(() => parseTuiArguments(['--unknown']), /Unknown option/);
});

test('CLI explains an unavailable local Host and shows Chinese help', () => {
  const cli = fileURLToPath(new URL('../bin/coldx-tui.mjs', import.meta.url));
  const absent = spawnSync(process.execPath, [cli, '--url', 'http://127.0.0.1:1'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /无法连接.*http:\/\/127\.0\.0\.1:1/);
  assert.match(absent.stderr, /pnpm start --no-open/);
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /用法|使用方法/);
  assert.match(help.stdout, /连接.*ColdX/);
});

test('session picker uses native projected title when list row has no direct title', async () => {
  const h = harness({ sessions: [{ sessionId: 's1', projections: { values: { title: '工作台验收' } } }] });
  await h.tui.start();
  assert.match(h.output.text, /工作台验收/);
  await h.tui.stop();
});

test('session picker sorts by native recency and labels blank sessions clearly', async () => {
  const h = harness({ sessions: [
    { sessionId: 'blank-s', blank: true, updatedAt: 10 },
    { sessionId: 'ready-s', projections: { values: { title: 'Ready' } }, updatedAt: 20 },
  ] });
  await h.tui.start();
  assert.deepEqual(h.tui.state.sessions.map(item => item.sessionId), ['ready-s', 'blank-s']);
  assert.match(h.output.text, /新会话/);
  assert.match(h.output.text, /blank-s/);
  await h.tui.stop();
});

test('session list and header favor titles and short workspace names over UUIDs and absolute paths', async () => {
  const id = 'session-12345678-aaaa-bbbb-cccc-123456789abc';
  const h = harness({ sessions: [{ sessionId: id, title: '工作台验收', cwd: 'C:/projects/coldx/workspace' }] });
  await h.tui.start();
  const screen = h.output.text.slice(h.output.text.lastIndexOf('\x1b[H'));
  assert.match(screen, /工作台验收/);
  assert.doesNotMatch(screen, /session-12345678-aaaa-bbbb-cccc-123456789abc/);
  assert.doesNotMatch(screen, /C:[:\\/]projects/);
  await h.tui.stop();
});

test('session picker keeps the highlighted row visible when the list is taller than the terminal', async () => {
  const sessions = Array.from({ length: 30 }, (_, index) => ({ sessionId: `s-${index}`, title: `Task ${index}` }));
  const h = harness({ sessions });
  await h.tui.start();
  assert.match(h.output.text.slice(h.output.text.lastIndexOf('\x1b[H')), /Task 0/);
  for (let index = 0; index < 25; index++) await h.key('down', '\x1b[B');
  assert.match(h.output.text.slice(h.output.text.lastIndexOf('\x1b[H')), /Task 25/);
  await h.tui.stop();
});

test('screen refresh does not clear the whole alternate buffer or discard draft on resize', async () => {
  const h = harness();
  await h.tui.start(); await h.key('return', '\r');
  await h.type('unfinished draft');
  const before = h.output.text;
  h.output.columns = 54; h.output.rows = 18;
  h.output.emit?.('resize');
  await h.settle();
  assert.equal(h.tui.state.input, 'unfinished draft');
  assert.match(h.output.text.slice(before.length), /unfinished draft/);
  assert.doesNotMatch(h.output.text.slice(before.length), /\u001b\[2J/);
  await h.tui.stop();
});

function harness({ sessions = [{ sessionId: 's1', title: 'Repair build' }], events = [], promptImpl, respondImpl, executeCommandImpl } = {}) {
  const input = new EventEmitter();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; };
  input.resume = () => {};
  input.pause = () => {};
  const output = Object.assign(new EventEmitter(), { isTTY: true, columns: 80, rows: 24, text: '', write(value) { this.text += value; } });
  const calls = [];
  let subscriber;
  const client = {
    async describe() { calls.push(['describe']); return { version: 'fixture', cwd: 'C:/work', canOpenPath: true }; },
    async sessions() { calls.push(['sessions']); return sessions; },
    async history(sessionId) { calls.push(['history', sessionId]); return { events }; },
    async subscribe(sessionId, onEvent) { calls.push(['subscribe', sessionId]); subscriber = onEvent; for (const event of events) onEvent({ type: 'session/event', sessionId, event: event.event }); return () => calls.push(['unsubscribe', sessionId]); },
    async prompt(sessionId, text, options) { calls.push(['prompt', sessionId, text, options]); return promptImpl ? promptImpl(sessionId, text, options) : { accepted: true }; },
    async cancel(sessionId) { calls.push(['cancel', sessionId]); return { accepted: true }; },
    async respond(rpcId, response) { calls.push(['respond', rpcId, response]); return respondImpl ? respondImpl(rpcId, response) : { accepted: true }; },
    async commands(sessionId) { calls.push(['commands', sessionId]); return [{ name: 'plan' }, { name: 'goal' }, { name: 'coldx-goal' }, { name: 'compact' }]; },
    async executeCommand(sessionId, line) { calls.push(['executeCommand', sessionId, line]); return executeCommandImpl ? executeCommandImpl(sessionId, line) : { commandId: 'c1', result: { kind: 'success', text: `${line} done` } }; },
    async createSession(options) { calls.push(['createSession', options]); return { sessionId: 'new-s' }; },
    close() { calls.push(['close']); },
  };
  const tui = createTui({ client, input, output, url: 'http://127.0.0.1:3086', openUrl: url => calls.push(['openUrl', url]) });
  const settle = () => new Promise(resolve => setTimeout(resolve, 25));
  const key = async (name, sequence = name, extra = {}) => { input.emit('keypress', sequence, { name, sequence, ...extra }); await settle(); };
  const type = async text => { for (const char of text) await key(char, char); };
  return { tui, input, output, client, calls, key, type, settle, emit: frame => subscriber(frame) };
}

test('session picker resumes actual history and sends a native prompt', async () => {
  const h = harness({ events: [
    { event: { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'Fix the tests' }], source: { kind: 'user' } } } },
    { event: { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'I found the failing test.' }] } } } },
  ] });
  await h.tui.start();
  assert.match(h.output.text, /Repair build/);
  await h.key('return', '\r');
  assert.match(h.output.text, /Fix the tests/);
  assert.match(h.output.text, /I found the failing test/);
  await h.type('Run tests');
  await h.key('return', '\r');
  assert.deepEqual(h.calls.find(call => call[0] === 'prompt'), ['prompt', 's1', 'Run tests', { mode: 'queue' }]);
  await h.tui.stop();
  assert.equal(h.input.isRaw, false);
});

test('live tool events remain compact and a resolved approval cannot be answered twice', async () => {
  const h = harness();
  await h.tui.start();
  await h.key('return', '\r');
  h.emit({ type: 'session/event', sessionId: 's1', event: { seq: 3, type: 'tool/call', data: { callId: 'call-1', name: 'shell', arguments: '{"cmd":"echo hello"}' } } });
  h.emit({ type: 'session/event', sessionId: 's1', event: { seq: 4, type: 'tool/result', data: { message: { source: { callId: 'call-1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'hello\nsecond line' }] }] } } } });
  h.emit({ type: 'approval/requested', sessionId: 's1', approvalId: 'approval-1', toolName: 'shell', reason: 'write file', rpcId: 'rpc-1' });
  await h.settle();
  assert.match(h.output.text, /shell/);
  assert.match(h.output.text, /Approval|批准/);
  await h.key('y', 'y');
  assert.deepEqual(h.calls.find(call => call[0] === 'respond'), ['respond', 'rpc-1', { ok: true, value: { sessionId: 's1', approvalId: 'approval-1', outcome: 'allowed-once' } }]);
  h.emit({ type: 'approval/resolved', sessionId: 's1', approvalId: 'approval-1' });
  await h.key('y', 'y');
  assert.equal(h.calls.filter(call => call[0] === 'respond').length, 1);
  await h.tui.stop();
});

test('multiple pending approvals can be cycled and answered independently', async () => {
  const h = harness();
  await h.tui.start(); await h.key('return', '\r');
  h.emit({ type: 'approval/requested', sessionId: 's1', approvalId: 'a1', toolName: 'shell', rpcId: 'r1' });
  h.emit({ type: 'approval/requested', sessionId: 's1', approvalId: 'a2', toolName: 'python', rpcId: 'r2' });
  await h.settle();
  assert.match(h.output.text.slice(h.output.text.lastIndexOf('\x1b[H')), /1\/2.*shell/);
  await h.key('tab', '\t');
  assert.match(h.output.text.slice(h.output.text.lastIndexOf('\x1b[H')), /2\/2.*python/);
  await h.key('n', 'n');
  assert.deepEqual(h.calls.find(call => call[0] === 'respond')?.slice(0, 2), ['respond', 'r2']);
  assert.match(h.output.text.slice(h.output.text.lastIndexOf('\x1b[H')), /1\/1.*shell/);
  await h.key('y', 'y');
  assert.deepEqual(h.calls.filter(call => call[0] === 'respond').map(call => call[1]), ['r2', 'r1']);
  await h.tui.stop();
});

test('failed approval response remains pending and can be retried', async () => {
  let attempts = 0;
  const h = harness({ respondImpl: async () => { if (++attempts === 1) throw new Error('offline'); return { accepted: true }; } });
  await h.tui.start(); await h.key('return', '\r');
  h.emit({ type: 'approval/requested', sessionId: 's1', approvalId: 'a1', toolName: 'shell', rpcId: 'r1' });
  await h.key('y', 'y');
  assert.match(h.output.text.slice(h.output.text.lastIndexOf('\x1b[H')), /1\/1.*shell/);
  await h.key('y', 'y');
  assert.equal(attempts, 2);
  assert.equal(h.calls.filter(call => call[0] === 'respond').length, 2);
  await h.tui.stop();
});

test('native tool-result isError is shown as failure', async () => {
  const h = harness();
  await h.tui.start(); await h.key('return', '\r');
  h.emit({ type: 'session/event', sessionId: 's1', event: { seq: 3, type: 'tool/call', data: { callId: 'call-1', name: 'shell' } } });
  h.emit({ type: 'session/event', sessionId: 's1', event: { seq: 4, type: 'tool/result', data: { message: { source: { callId: 'call-1' }, content: [{ type: 'tool-result', isError: true, content: [{ type: 'text', text: 'permission denied' }] }] } } } });
  await h.settle();
  assert.match(h.output.text, /shell  失败/);
  await h.tui.stop();
});

test('tool rows stay concise without repeating the expansion command', async () => {
  const h = harness();
  await h.tui.start(); await h.key('return', '\r');
  h.emit({ type: 'session/event', sessionId: 's1', event: { seq: 3, type: 'tool/call', data: { callId: 'c1', name: 'shell' } } });
  h.emit({ type: 'session/event', sessionId: 's1', event: { seq: 4, type: 'tool/result', data: { message: { source: { callId: 'c1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'output' }] }] } } } });
  await h.settle();
  const screen = h.output.text.slice(h.output.text.lastIndexOf('\x1b[H'));
  assert.match(screen, /shell/);
  assert.doesNotMatch(screen, /\/tools 展开输出/);
  await h.tui.stop();
});

test('keyboard interrupt and slash commands use host methods without ghost messages', async () => {
  const h = harness();
  await h.tui.start();
  await h.key('return', '\r');
  await h.key('c', '\u0003', { ctrl: true });
  assert.deepEqual(h.calls.find(call => call[0] === 'cancel'), ['cancel', 's1']);
  await h.type('/open'); await h.key('return', '\r');
  assert.deepEqual(h.calls.find(call => call[0] === 'openUrl'), ['openUrl', 'http://127.0.0.1:3086/']);
  await h.type('/sessions'); await h.key('return', '\r');
  assert.match(h.output.text, /Repair build/);
  assert.equal(h.calls.filter(call => call[0] === 'prompt').length, 0);
  await h.tui.stop();
});

test('failed prompt restores original draft without replacing text typed while awaiting', async () => {
  let fail;
  const h = harness({ promptImpl: () => new Promise((resolve, reject) => { fail = reject; }) });
  await h.tui.start(); await h.key('return', '\r');
  await h.type('original'); await h.key('return', '\r');
  await h.type('new text');
  fail(new Error('network down'));
  await h.settle();
  assert.equal(h.tui.state.input, 'new text');
  await h.key('r', '\u0012', { ctrl: true });
  assert.equal(h.tui.state.input, 'original');
  await h.key('r', '\u0012', { ctrl: true });
  assert.equal(h.tui.state.input, 'new text');
  await h.tui.stop();
});

test('running and idle phase remain visible alongside notices', async () => {
  const h = harness();
  await h.tui.start(); await h.key('return', '\r');
  h.emit({ type: 'host/session-status', sessionId: 's1', running: true });
  await h.settle();
  assert.match(h.output.text.slice(h.output.text.lastIndexOf('\x1b[H')), /运行中.*已连接/);
  h.emit({ type: 'host/session-status', sessionId: 's1', running: false });
  await h.settle();
  assert.match(h.output.text.slice(h.output.text.lastIndexOf('\x1b[H')), /就绪.*已连接/);
  await h.tui.stop();
});

test('session picker shows typed slash command and /new creates only on request', async () => {
  const h = harness();
  await h.tui.start();
  assert.equal(h.calls.some(call => call[0] === 'createSession'), false);
  await h.type('/new');
  assert.match(h.output.text, /› \/new/);
  await h.key('return', '\r');
  assert.deepEqual(h.calls.find(call => call[0] === 'createSession'), ['createSession', { cwd: 'C:/work' }]);
  assert.equal(h.tui.state.sessionId, 'new-s');
  await h.tui.stop();
});

test('non-TTY output presents real sessions and requested history without terminal escapes', async () => {
  const events = [
    { event: { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'Need summary' }], source: { kind: 'user' } } } },
    { event: { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Here it is.' }] } } } },
  ];
  const text = renderPlainHistory(events);
  assert.match(text, /Need summary/);
  assert.match(text, /Here it is\./);
  assert.doesNotMatch(text, /\u001b/);
  const h = harness({ events });
  h.input.isTTY = false; h.output.isTTY = false;
  await h.tui.start({ sessionId: 's1' });
  assert.match(h.output.text, /s1/);
  assert.match(h.output.text, /Here it is\./);
  assert.equal(h.calls.some(call => call[0] === 'subscribe'), false);
});

test('system snapshots and skill catalogs are not mislabeled as human chat', async () => {
  const events = [
    { event: { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'My request' }], source: { kind: 'user' } } } },
    { event: { seq: 2, type: 'user/message', data: { content: [{ type: 'text', text: 'Internal runtime context' }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } } } },
    { event: { seq: 3, type: 'user/message', data: { content: [{ type: 'text', text: 'Skills catalog' }], source: { kind: 'skill-catalog' } } } },
  ];
  assert.match(renderPlainHistory(events), /My request/);
  assert.doesNotMatch(renderPlainHistory(events), /Internal runtime context|Skills catalog/);
  const h = harness({ events });
  await h.tui.start(); await h.key('return', '\r');
  assert.match(h.output.text, /My request/);
  assert.doesNotMatch(h.output.text, /Internal runtime context|Skills catalog/);
  await h.tui.stop();
});

test('new session uses the active workspace instead of Host startup cwd', async () => {
  const h = harness({ sessions: [{ sessionId: 's1', title: 'Project', cwd: 'C:/project', updatedAt: 2 }] });
  await h.tui.start(); await h.key('return', '\r');
  await h.type('/new'); await h.key('return', '\r');
  assert.deepEqual(h.calls.find(call => call[0] === 'createSession'), ['createSession', { cwd: 'C:/project' }]);
  await h.tui.stop();
});

test('native plan and goal slash commands execute without a model prompt', async () => {
  const h = harness();
  await h.tui.start(); await h.key('return', '\r');
  for (const command of ['/plan', '/goal', '/coldx-goal on']) {
    await h.type(command); await h.key('return', '\r');
  }
  assert.deepEqual(h.calls.filter(call => call[0] === 'executeCommand').map(call => call[2]), ['/plan', '/goal', '/coldx-goal on']);
  assert.equal(h.calls.filter(call => call[0] === 'prompt').length, 0);
  await h.tui.stop();
});

test('blank-session mode commands wait for first actual message', async () => {
  const h = harness({ sessions: [{ sessionId: 's1', title: '新会话', blank: true, cwd: 'C:/work' }] });
  await h.tui.start(); await h.key('return', '\r');
  await h.type('/plan'); await h.key('return', '\r');
  await h.type('/coldx-goal on'); await h.key('return', '\r');
  assert.equal(h.calls.filter(call => call[0] === 'executeCommand').length, 0);
  assert.equal(h.calls.filter(call => call[0] === 'prompt').length, 0);
  await h.type('Hello'); await h.key('return', '\r');
  await h.settle();
  assert.deepEqual(h.calls.filter(call => ['executeCommand', 'prompt'].includes(call[0])).map(call => call[0] === 'prompt' ? 'prompt' : call[2]), ['/plan', '/coldx-goal on', 'prompt']);
  await h.tui.stop();
});

test('unknown native slash stays local and missing command receipt does not claim success', async () => {
  const h = harness({ executeCommandImpl: async () => undefined });
  await h.tui.start(); await h.key('return', '\r');
  await h.type('/unknown'); await h.key('return', '\r');
  assert.equal(h.calls.filter(call => call[0] === 'executeCommand').length, 0);
  await h.type('/plan'); await h.key('return', '\r');
  assert.equal(h.calls.filter(call => call[0] === 'executeCommand').length, 1);
  assert.equal(h.calls.filter(call => call[0] === 'prompt').length, 0);
  assert.match(h.output.text.slice(h.output.text.lastIndexOf('\x1b[H')), /未返回命令结果|未执行/);
  await h.tui.stop();
});

test('native command error is reported as failure', async () => {
  const h = harness({ executeCommandImpl: async () => ({ commandId: 'c1', result: { kind: 'error', text: 'blocked' } }) });
  await h.tui.start(); await h.key('return', '\r');
  await h.type('/plan'); await h.key('return', '\r');
  assert.match(h.output.text.slice(h.output.text.lastIndexOf('\x1b[H')), /失败.*blocked/);
  await h.tui.stop();
});

test('small terminal stays within its real dimensions and paints a visible input caret', async () => {
  const h = harness();
  h.output.columns = 28; h.output.rows = 8;
  await h.tui.start(); await h.key('return', '\r');
  await h.type('draft');
  const moves = [...h.output.text.matchAll(/\x1b\[(\d+);1H/g)].map(match => Number(match[1]));
  assert.ok(moves.length > 0);
  assert.ok(moves.every(row => row >= 1 && row <= 8));
  assert.match(h.output.text, /draft▌/);
  await h.tui.stop();
});

test('long draft keeps its tail and caret visible, including in a narrow terminal', async () => {
  const h = harness();
  h.output.columns = 28; h.output.rows = 8;
  await h.tui.start(); await h.key('return', '\r');
  h.tui.state.input = `${'x'.repeat(100)}VISIBLE`;
  h.output.emit('resize'); await h.settle();
  assert.match(h.output.text.slice(h.output.text.lastIndexOf('\x1b[H')), /VISIBLE▌/);
  await h.tui.stop();
});

test('narrow approval footer keeps y and n keys visible', async () => {
  const h = harness();
  h.output.columns = 28; h.output.rows = 8;
  await h.tui.start(); await h.key('return', '\r');
  h.emit({ type: 'approval/requested', sessionId: 's1', approvalId: 'a1', toolName: 'shell', rpcId: 'r1' });
  await h.settle();
  assert.match(h.output.text.slice(h.output.text.lastIndexOf('\x1b[H')), /y.*n.*(准|拒)/);
  await h.tui.stop();
});

test('typing repaints only changed terminal rows', async () => {
  const h = harness();
  await h.tui.start(); await h.key('return', '\r');
  const before = h.output.text.length;
  await h.key('x', 'x');
  const frame = h.output.text.slice(before);
  const painted = (frame.match(/\x1b\[\d+;1H/g) ?? []).length;
  assert.ok(painted > 0 && painted <= 3);
  assert.doesNotMatch(frame, /\x1b\[2J/);
  await h.tui.stop();
});

test('question awaiting Web remains visible after a later notice', async () => {
  const h = harness();
  await h.tui.start(); await h.key('return', '\r');
  h.emit({ type: 'question/requested', sessionId: 's1', rpcId: 'question-1' });
  h.emit({ type: 'host/session-status', sessionId: 's1', running: true });
  await h.settle();
  assert.match(h.output.text.slice(h.output.text.lastIndexOf('\x1b[H')), /问题待回答.*\/open/);
  await h.tui.stop();
});

test('incoming messages preserve an older scroll anchor', async () => {
  const h = harness();
  await h.tui.start(); await h.key('return', '\r');
  for (let seq = 0; seq < 30; seq++) h.emit({ type: 'session/event', sessionId: 's1', event: { seq, type: 'user/message', data: { content: [{ type: 'text', text: `message ${seq}` }], source: { kind: 'user' } } } });
  await h.key('pageup', '\x1b[5~');
  const anchor = h.tui.state.scroll;
  assert.ok(anchor > 0);
  h.emit({ type: 'session/event', sessionId: 's1', event: { seq: 31, type: 'user/message', data: { content: [{ type: 'text', text: 'new message' }], source: { kind: 'user' } } } });
  assert.ok(h.tui.state.scroll > anchor);
  await h.tui.stop();
});

test('event sequence dedupe stays bounded in a long session', async () => {
  const h = harness();
  await h.tui.start(); await h.key('return', '\r');
  for (let seq = 0; seq < 2_200; seq++) h.emit({ type: 'session/event', sessionId: 's1', event: { seq, type: 'step/start', data: {} } });
  assert.ok(h.tui.state.seen.size <= 2_048);
  await h.tui.stop();
});

test('queue, reconnecting, and limited history are visible as truthful status', async () => {
  const h = harness();
  await h.tui.start(); await h.key('return', '\r');
  h.emit({ type: 'session/queue', sessionId: 's1', items: [{ id: 'q1', placement: 'queued' }, { id: 'context', placement: 'context' }] });
  h.emit({ type: 'session/history-limited', sessionId: 's1', hasMore: true, limit: 100 });
  h.emit({ type: 'transport/status', sessionId: 's1', state: 'reconnecting' });
  await h.settle();
  assert.match(h.output.text, /重连中/);
  assert.match(h.output.text, /排队 1/);
  assert.match(h.output.text, /最近 100|历史未完整/);
  h.emit({ type: 'transport/status', sessionId: 's1', state: 'connected' });
  await h.settle();
  assert.match(h.output.text, /就绪/);
  await h.tui.stop();
});
