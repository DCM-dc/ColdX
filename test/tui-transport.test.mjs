import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const requireDsh = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'));
const { WebSocketServer } = requireDsh('ws');

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

async function fixture(t, { coldx = true } = {}) {
  const requests = [];
  const historyEvents = [];
  let historyHasMore = false;
  let historyGate;
  const sockets = { 'events.mux': new Set(), 'events.host': new Set() };
  const connections = { 'events.mux': 0, 'events.host': 0 };
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ path: request.url, body });
    const endpoint = request.url.slice('/api/'.length);
    if (endpoint === 'coldxUsage/settings' && !coldx) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: false, error: { code: 'not_found', message: 'Unknown method' } } }));
      return;
    }
    if (endpoint === 'session.history' && historyGate) {
      const gate = historyGate;
      historyGate = undefined;
      gate.enter();
      await gate.wait;
    }
    const value = endpoint === 'host.describe'
      ? { version: 'fixture', cwd: 'C:/fixture', home: 'C:/fixture-home', attachedSessions: 1, canOpenPath: true }
      : endpoint === 'coldxUsage/settings' ? { balanceEnabled: true, thresholds: { CNY: '10', USD: '2' } }
      : endpoint === 'session.list' ? { items: [{ sessionId: 's1', title: 'A session' }] }
      : endpoint === 'session.create' ? { sessionId: 'new-session' }
      : endpoint === 'session.history' ? { events: [...historyEvents], hasMore: historyHasMore }
      : endpoint === 'commands/list' ? [{ name: 'plan', description: 'Enter or leave plan mode' }, { name: 'coldx-goal', description: 'Select Goal mode' }]
      : endpoint === 'commands/execute' ? { commandId: 'command-1', result: { kind: 'success', text: 'Done' } }
      : { accepted: true };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(endpoint === 'respond'
      ? { accepted: true }
      : { type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }));
  });
  server.on('upgrade', (request, socket, head) => {
    const kind = request.url.slice('/api/'.length);
    if (!sockets[kind]) return socket.destroy();
    wss.handleUpgrade(request, socket, head, ws => {
      connections[kind]++;
      sockets[kind].add(ws);
      ws.on('close', () => sockets[kind].delete(ws));
      if (kind === 'events.mux') ws.send(JSON.stringify({ type: 'server-request', rpcId: 'subscribed', method: 'session/subscribed', payload: { type: 'session/subscribed', sessionId: 's1', lastSeq: historyEvents.at(-1)?.event.seq ?? -1 } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const group of Object.values(sockets)) for (const socket of group) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`, requests, historyEvents, sockets, connections,
    setHistoryHasMore(value) { historyHasMore = value; },
    holdNextHistory() {
      let enter, release;
      const entered = new Promise(resolve => { enter = resolve; });
      const wait = new Promise(resolve => { release = resolve; });
      historyGate = { enter, wait };
      return { entered, release };
    },
    send(kind, payload, rpcId = randomId()) {
      const body = JSON.stringify({ type: 'server-request', rpcId, method: payload.type, payload });
      for (const socket of sockets[kind]) socket.send(body);
    },
  };
}

let serial = 0;
function randomId() { return `fixture-${++serial}`; }

test('ColdX TUI calls the running DSH Host without creating another Agent', async t => {
  const { connect } = await import('../lib/tui/transport.mjs');
  const { url, requests } = await fixture(t);
  const client = connect({ url });
  t.after(() => client.close());
  assert.equal((await client.describe()).version, 'fixture');
  assert.deepEqual(await client.sessions(), [{ sessionId: 's1', title: 'A session' }]);
  assert.deepEqual(await client.createSession({ cwd: 'C:/fixture' }), { sessionId: 'new-session' });
  assert.deepEqual(await client.history('s1'), { events: [], hasMore: false });
  assert.deepEqual(await client.prompt('s1', 'Hello', { mode: 'steer' }), { accepted: true });
  assert.deepEqual(await client.cancel('s1'), { accepted: true });
  assert.deepEqual(await client.respond('approval-rpc', { ok: true, value: { sessionId: 's1', approvalId: 'a1', outcome: 'rejected' } }), { accepted: true });
  assert.deepEqual(await client.commands('s1'), [{ name: 'plan', description: 'Enter or leave plan mode' }, { name: 'coldx-goal', description: 'Select Goal mode' }]);
  assert.deepEqual(await client.executeCommand('s1', '/plan'), { commandId: 'command-1', result: { kind: 'success', text: 'Done' } });
  assert.deepEqual(requests.map(request => request.path), [
    '/api/host.describe', '/api/coldxUsage/settings', '/api/session.list',
    '/api/coldxUsage/settings', '/api/session.create', '/api/session.history',
    '/api/coldxUsage/settings', '/api/session.prompt',
    '/api/coldxUsage/settings', '/api/session.cancel',
    '/api/coldxUsage/settings', '/api/respond',
    '/api/commands/list', '/api/coldxUsage/settings', '/api/commands/execute',
  ]);
  assert.deepEqual(requests[4].body.payload, { cwd: 'C:/fixture' });
  assert.deepEqual(requests[7].body.payload, { sessionId: 's1', mode: 'steer', content: [{ type: 'text', text: 'Hello' }] });
  assert.deepEqual(requests[11].body, { type: 'client-response', rpcId: 'approval-rpc', result: { ok: true, value: { sessionId: 's1', approvalId: 'a1', outcome: 'rejected' } } });
  assert.deepEqual(requests[12].body.payload, { args: { agentId: 's1' } });
  assert.deepEqual(requests[14].body.payload, { args: { agentId: 's1', line: '/plan', images: [] } });
});

test('a generic DSH Host cannot receive ColdX TUI mutations', async t => {
  const { connect } = await import('../lib/tui/transport.mjs');
  const { url, requests } = await fixture(t, { coldx: false });
  const client = connect({ url });
  t.after(() => client.close());
  await assert.rejects(client.describe(), /ColdX.*identity/i);
  await assert.rejects(client.createSession({ cwd: 'C:/fixture' }), /ColdX.*identity/i);
  await assert.rejects(client.prompt('s1', 'Hello'), /ColdX.*identity/i);
  await assert.rejects(client.cancel('s1'), /ColdX.*identity/i);
  await assert.rejects(client.respond('approval-rpc', { ok: true, value: {} }), /ColdX.*identity/i);
  await assert.rejects(client.executeCommand('s1', '/plan'), /ColdX.*identity/i);
  assert.equal(requests.some(request => ['/api/session.create', '/api/session.prompt', '/api/session.cancel', '/api/respond', '/api/commands/execute'].includes(request.path)), false);
});

test('subscription reconnects and recovers missed events once from DSH history', async t => {
  const { connect } = await import('../lib/tui/transport.mjs');
  const fixtureState = await fixture(t);
  const event = seq => ({ event: { type: 'assistant/message', seq, time: seq, data: { message: { content: [{ type: 'text', text: `Step ${seq}` }] } } } });
  fixtureState.historyEvents.push(event(0));
  const client = connect({ url: fixtureState.url, reconnectDelayMs: 20 });
  t.after(() => client.close());
  const seen = [], states = [];
  await client.subscribe('s1', frame => {
    if (frame.type === 'session/event') seen.push(frame.event.seq);
    if (frame.type === 'transport/status') states.push(frame);
  });
  fixtureState.historyEvents.push(event(1));
  fixtureState.send('events.mux', { type: 'session/event', sessionId: 's1', ...event(1) });
  await waitFor(() => seen.includes(1), 'first live event was not observed');
  for (const group of Object.values(fixtureState.sockets)) for (const socket of group) socket.terminate();
  fixtureState.historyEvents.push(event(2), event(3));
  await waitFor(() => seen.includes(3), 'missed events were not recovered');
  fixtureState.send('events.mux', { type: 'session/event', sessionId: 's1', ...event(3) });
  fixtureState.historyEvents.push(event(4));
  fixtureState.send('events.mux', { type: 'session/event', sessionId: 's1', ...event(4) });
  await waitFor(() => seen.includes(4), 'post-reconnect event was not observed');
  assert.deepEqual(seen, [0, 1, 2, 3, 4]);
  assert.deepEqual(states.map(frame => frame.state), ['reconnecting', 'connected']);
  assert.ok(states.every(frame => frame.sessionId === 's1'));
  assert.ok(typeof states[0].error === 'string' && !states[0].error.includes(fixtureState.url));
  assert.ok(fixtureState.requests.filter(request => request.path === '/api/session.history').length >= 2);
});

test('initial history truncation is visible and older pages are explicitly addressable', async t => {
  const { connect } = await import('../lib/tui/transport.mjs');
  const f = await fixture(t);
  f.setHistoryHasMore(true);
  f.historyEvents.push({ event: { type: 'user/message', seq: 100, time: 1, data: {} } });
  const client = connect({ url: f.url });
  t.after(() => client.close());
  const frames = [];
  const stop = await client.subscribe('s1', frame => frames.push(frame));
  assert.deepEqual(frames.filter(frame => frame.type === 'session/history-limited'), [{ type: 'session/history-limited', sessionId: 's1', hasMore: true, limit: 100 }]);
  assert.equal(frames.filter(frame => frame.type === 'session/event').length, 1);
  const page = await client.history('s1', { beforeSeq: 100, maxMessages: 25 });
  assert.equal(page.hasMore, true);
  assert.deepEqual(f.requests.at(-1).body.payload, { sessionId: 's1', beforeSeq: 100, maxMessages: 25 });
  stop();
});

test('a second disconnect during replay still reconnects', async t => {
  const { connect } = await import('../lib/tui/transport.mjs');
  const fixtureState = await fixture(t);
  const event = seq => ({ event: { type: 'assistant/message', seq, time: seq, data: {} } });
  fixtureState.historyEvents.push(event(0));
  const client = connect({ url: fixtureState.url, reconnectDelayMs: 20 });
  t.after(() => client.close());
  const seen = [];
  await client.subscribe('s1', frame => { if (frame.type === 'session/event') seen.push(frame.event.seq); });
  const gate = fixtureState.holdNextHistory();
  for (const group of Object.values(fixtureState.sockets)) for (const socket of group) socket.terminate();
  await gate.entered;
  fixtureState.historyEvents.push(event(1));
  for (const group of Object.values(fixtureState.sockets)) for (const socket of group) socket.terminate();
  await waitFor(() => fixtureState.sockets['events.mux'].size === 0 && fixtureState.sockets['events.host'].size === 0, 'fixture sockets did not close during replay');
  gate.release();
  await waitFor(() => seen.includes(1) && fixtureState.connections['events.mux'] >= 3, 'second disconnect stopped the event stream');
});

test('subscription replays history then streams only the selected session and pending approvals', async t => {
  const { connect } = await import('../lib/tui/transport.mjs');
  const fixtureState = await fixture(t);
  fixtureState.historyEvents.push({ event: { type: 'assistant/message', seq: 0, time: 1, data: { message: { content: [{ type: 'text', text: 'Earlier' }] } } } });
  const client = connect({ url: fixtureState.url });
  t.after(() => client.close());
  const received = [];
  const unsubscribe = await client.subscribe('s1', event => received.push(event));
  assert.deepEqual(received.filter(event => event.type === 'session/event').map(event => event.event.seq), [0]);
  fixtureState.send('events.mux', { type: 'session/event', sessionId: 's1', event: { type: 'tool/call', seq: 1, time: 2, data: {} } });
  fixtureState.send('events.mux', { type: 'session/event', sessionId: 's2', event: { type: 'tool/call', seq: 1, time: 2, data: {} } });
  fixtureState.send('events.mux', { type: 'approval/requested', sessionId: 's1', approvalId: 'approval-1', toolName: 'shell' }, 'approval-rpc');
  fixtureState.send('events.host', { type: 'host/session-status', sessionId: 's1', running: true });
  await waitFor(() => received.length >= 4, 'live frames were not delivered');
  assert.deepEqual(received.filter(event => event.type === 'session/event').map(event => event.event.seq), [0, 1]);
  assert.equal(received.find(event => event.type === 'approval/requested').rpcId, 'approval-rpc');
  assert.ok(received.some(event => event.type === 'host/session-status' && event.running));
  unsubscribe();
  fixtureState.send('events.mux', { type: 'session/event', sessionId: 's1', event: { type: 'tool/result', seq: 2, time: 3, data: {} } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(received.length, 4);
});
