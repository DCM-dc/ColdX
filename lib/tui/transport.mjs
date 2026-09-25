import { randomUUID } from 'node:crypto';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function baseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('ColdX TUI requires a plain loopback HTTP URL');
  }
  return url;
}

export function connect({ url, fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, timeoutMs = 30_000, reconnectDelayMs = 250 } = {}) {
  const base = baseUrl(url);
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is unavailable');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
  if (!Number.isFinite(reconnectDelayMs) || reconnectDelayMs < 0) throw new TypeError('reconnectDelayMs must be nonnegative');
  const closed = new AbortController();
  const subscriptions = new Set();

  async function post(path, body) {
    if (closed.signal.aborted) throw new Error('ColdX TUI connection is closed');
    const signal = AbortSignal.any([closed.signal, AbortSignal.timeout(timeoutMs)]);
    const response = await fetchImpl(new URL(path, base), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
    });
    if (!response.ok) throw new Error(`DSH ${path} HTTP ${response.status}`);
    return response.json();
  }

  async function call(method, payload) {
    const rpcId = randomUUID();
    const response = await post(`/api/${method}`, { type: 'client-request', rpcId, method, payload });
    if (response?.type !== 'server-response' || response.rpcId !== rpcId) throw new Error(`DSH ${method} response correlation failed`);
    if (!response.result?.ok) {
      const error = response.result?.error;
      throw new Error(`DSH ${method}: ${error?.code ?? 'unknown'}: ${error?.message ?? 'request failed'}`);
    }
    return response.result.value;
  }

  async function assertColdX() {
    // host.describe is provided by every DSH Host. This ColdX-owned RPC is a
    // read when request is empty, so reject generic DSH Hosts before writes.
    try {
      const settings = await call('coldxUsage/settings', { args: { request: {} } });
      if (typeof settings?.balanceEnabled !== 'boolean'
        || typeof settings.thresholds?.CNY !== 'string'
        || typeof settings.thresholds?.USD !== 'string') {
        throw new Error('ColdX settings response has the wrong shape');
      }
    } catch (error) {
      throw new Error(`ColdX Host identity check failed: ${error.message}`, { cause: error });
    }
  }

  async function subscribe(sessionId, onEvent) {
    if (typeof WebSocketImpl !== 'function') throw new TypeError('WebSocket is unavailable');
    if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('sessionId is required');
    if (typeof onEvent !== 'function') throw new TypeError('onEvent must be a function');
    if (closed.signal.aborted) throw new Error('ColdX TUI connection is closed');

    let active = true, paused = true, lastSeq = -1, generation = 0, reconnecting = false, outageNotified = false;
    let retryTimer;
    let sockets = [];
    let buffered = [];

    const stopSockets = () => {
      const current = sockets;
      sockets = [];
      for (const socket of current) {
        try { if (socket.readyState < 2) socket.close(); }
        catch { /* Closing a still-connecting socket can throw on some clients. */ }
      }
    };
    const unsubscribe = () => {
      if (!active) return;
      active = false;
      generation++;
      clearTimeout(retryTimer);
      stopSockets();
      subscriptions.delete(unsubscribe);
    };
    subscriptions.add(unsubscribe);

    function emit(frame) {
      if (frame.sessionId !== sessionId || frame.type === 'session/subscribed') return;
      if (frame.type === 'session/event') {
        const seq = frame.event?.seq;
        if (!Number.isInteger(seq) || seq <= lastSeq) return;
        lastSeq = seq;
      }
      try { onEvent(frame); }
      catch (error) { console.error('ColdX TUI event callback failed:', error); }
    }

    function receive(message) {
      let frame;
      try {
        const envelope = JSON.parse(String(message.data));
        if (envelope?.type !== 'server-request' || envelope.method !== envelope.payload?.type) return;
        frame = { ...envelope.payload, rpcId: envelope.rpcId };
      } catch { return; }
      if (paused) buffered.push(frame);
      else emit(frame);
    }

    function scheduleReconnect(reason = 'DSH event stream disconnected') {
      if (!active || retryTimer !== undefined) return;
      generation++;
      paused = true;
      stopSockets();
      if (!outageNotified) {
        outageNotified = true;
        emit({ type: 'transport/status', sessionId, state: 'reconnecting', error: reason });
      }
      // A socket can fail while a previous reconnection is still replaying
      // history. Invalidate that replay now; its finally block schedules the
      // next attempt after it finishes.
      if (reconnecting) return;
      retryTimer = setTimeout(async () => {
        retryTimer = undefined;
        if (!active) return;
        reconnecting = true;
        let failure;
        try { await establish(); }
        catch (error) { failure = error; }
        finally {
          reconnecting = false;
          if (active && paused) scheduleReconnect(failure?.message?.startsWith('DSH ') ? failure.message : 'DSH reconnect failed');
        }
      }, reconnectDelayMs);
    }

    function openSocket(kind, epoch) {
      const address = new URL(`/api/${kind}`, base);
      address.protocol = 'ws:';
      return new Promise((resolve, reject) => {
        let socket;
        try { socket = new WebSocketImpl(address.href); }
        catch (error) { reject(error); return; }
        sockets.push(socket);
        let opened = false;
        const timer = setTimeout(() => {
          if (opened) return;
          try { socket.close(); } catch { /* Timeout still rejects below. */ }
          reject(new Error(`DSH ${kind} WebSocket timed out`));
        }, timeoutMs);
        socket.addEventListener('open', () => {
          clearTimeout(timer);
          if (!active || epoch !== generation) { socket.close(); return; }
          opened = true;
          resolve();
        });
        socket.addEventListener('message', receive);
        socket.addEventListener('close', () => {
          clearTimeout(timer);
          if (!opened) reject(new Error(`DSH ${kind} WebSocket closed before opening`));
          else if (active && epoch === generation) scheduleReconnect(`DSH ${kind} stream disconnected`);
        });
        socket.addEventListener('error', () => {
          if (!opened) reject(new Error(`DSH ${kind} WebSocket failed to open`));
          else if (active && epoch === generation) scheduleReconnect(`DSH ${kind} stream failed`);
        });
      });
    }

  async function replay(fromSeq) {
      const pages = [];
      let beforeSeq;
      let initialHasMore = false;
      for (let pageNumber = 0; pageNumber < 1_000; pageNumber++) {
        const page = await call('session.history', { sessionId, maxMessages: 100, ...(beforeSeq === undefined ? {} : { beforeSeq }) });
        if (!Array.isArray(page?.events)) throw new Error('DSH history returned invalid events');
        if (pageNumber === 0 && fromSeq < 0) initialHasMore = page.hasMore === true;
        pages.unshift(page.events);
        const earliest = page.events.reduce((minimum, entry) => Math.min(minimum, entry.event?.seq ?? Infinity), Infinity);
        if (fromSeq < 0 || earliest <= fromSeq || !page.hasMore) break;
        if (!Number.isFinite(earliest) || earliest >= (beforeSeq ?? Infinity)) throw new Error('DSH history pagination did not advance');
        beforeSeq = earliest;
        if (pageNumber === 999) throw new Error('DSH history replay exceeded 1000 pages');
      }
      const entries = pages.flat().sort((left, right) => left.event.seq - right.event.seq);
      if (fromSeq >= 0 && entries.length && entries[0].event.seq > fromSeq + 1) throw new Error('DSH history has an unrecoverable event gap');
      for (const entry of entries) emit({ type: 'session/event', sessionId, ...entry });
      if (initialHasMore) emit({ type: 'session/history-limited', sessionId, hasMore: true, limit: 100 });
    }

    async function establish() {
      const epoch = ++generation;
      paused = true;
      buffered = [];
      try {
        await Promise.all([openSocket('events.mux', epoch), openSocket('events.host', epoch)]);
        if (!active || epoch !== generation) return;
        await replay(lastSeq);
        if (!active || epoch !== generation) return;
        paused = false;
        const pending = buffered;
        buffered = [];
        const events = pending.filter(frame => frame.type === 'session/event').sort((left, right) => left.event.seq - right.event.seq);
        for (const frame of events) emit(frame);
        for (const frame of pending) if (frame.type !== 'session/event') emit(frame);
        if (outageNotified) {
          outageNotified = false;
          emit({ type: 'transport/status', sessionId, state: 'connected' });
        }
      } catch (error) {
        stopSockets();
        throw error;
      }
    }

    try { await establish(); return unsubscribe; }
    catch (error) { unsubscribe(); throw error; }
  }

  return {
    async describe() {
      const descriptor = await call('host.describe', {});
      await assertColdX();
      return descriptor;
    },
    sessions: async () => (await call('session.list', {})).items,
    createSession: async options => { await assertColdX(); return call('session.create', options ?? {}); },
    history: (sessionId, { beforeSeq, maxMessages } = {}) => {
      if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0)) throw new TypeError('beforeSeq must be a nonnegative integer');
      if (maxMessages !== undefined && (!Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 500)) throw new TypeError('maxMessages must be between 1 and 500');
      return call('session.history', { sessionId, ...(beforeSeq === undefined ? {} : { beforeSeq }), ...(maxMessages === undefined ? {} : { maxMessages }) });
    },
    async commands(sessionId) {
      const items = await call('commands/list', { args: { agentId: sessionId } });
      if (!Array.isArray(items)) throw new Error('DSH commands/list returned invalid commands');
      return items;
    },
    async executeCommand(sessionId, line) {
      if (typeof line !== 'string' || !/^\/[a-z][^\s/]*\b/i.test(line)) throw new TypeError('command must begin with a slash name');
      await assertColdX();
      return call('commands/execute', { args: { agentId: sessionId, line, images: [] } });
    },
    prompt: (sessionId, text, { mode = 'queue' } = {}) => {
      if (typeof text !== 'string' || !text.trim()) throw new TypeError('prompt text must be non-empty');
      if (mode !== 'queue' && mode !== 'steer') throw new TypeError('prompt mode must be queue or steer');
      return assertColdX().then(() => call('session.prompt', { sessionId, mode, content: [{ type: 'text', text }] }));
    },
    cancel: async sessionId => { await assertColdX(); return call('session.cancel', { sessionId }); },
    async respond(rpcId, result) {
      await assertColdX();
      const receipt = await post('/api/respond', { type: 'client-response', rpcId, result });
      if (typeof receipt?.accepted !== 'boolean') throw new Error('DSH respond returned an invalid receipt');
      return receipt;
    },
    subscribe,
    close() {
      if (closed.signal.aborted) return;
      closed.abort();
      for (const stop of subscriptions) stop();
      subscriptions.clear();
    },
  };
}
