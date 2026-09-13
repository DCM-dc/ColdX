import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createEvaluationProxy, EVALUATION_PARAMETERS } from './evaluation-proxy.mjs';

const secret = 'upstream-test-secret-never-log';
const prompt = 'private-test-prompt-never-log';
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function fixture(t, handler, options = {}) {
  const upstream = http.createServer(handler);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamBaseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  const proxy = createEvaluationProxy({ upstreamBaseUrl, apiKey: secret, ...options });
  await proxy.listen();
  t.after(async () => {
    await proxy.close();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  });
  return { proxy, upstream };
}

function post(proxy, body = { messages: [{ role: 'user', content: prompt }] }, options = {}) {
  return fetch(`${proxy.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${proxy.downstreamToken}` },
    body: JSON.stringify(body),
    ...options,
  });
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return JSON.parse(body);
}

test('forces only the evaluation parameters, authenticates separately, and retains no prompt or secrets in stats', async (t) => {
  const requests = [];
  const { proxy } = await fixture(t, async (req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization, body: await readJson(req) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  });
  assert.ok(proxy.downstreamToken.length >= 32);
  assert.notEqual(proxy.downstreamToken, secret);
  assert.ok(!JSON.stringify(proxy).includes(proxy.downstreamToken));
  const body = { messages: [{ role: 'user', content: prompt }], tools: [{ type: 'function', function: { name: 'bash' } }], stream: false, max_tokens: 1234, model: 'wrong', temperature: 0, top_p: 1, reasoning_effort: 'low' };
  const response = await post(proxy, body);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, 'ok');
  assert.equal(requests[0].url, '/v1/chat/completions');
  assert.equal(requests[0].authorization, `Bearer ${secret}`);
  assert.deepEqual(requests[0].body, { ...body, ...EVALUATION_PARAMETERS });
  assert.equal(body.model, 'wrong');
  await (await post(proxy, { ...body, ...EVALUATION_PARAMETERS })).text();
  const stats = proxy.getStats();
  assert.equal(stats.forwardedRequests, 2);
  assert.equal(stats.completedResponses, 2);
  assert.deepEqual(stats.parameterOverrides, { model: 1, reasoning_effort: 1, temperature: 1, top_p: 1 });
  assert.deepEqual(stats.wireParameters, EVALUATION_PARAMETERS);
  for (const forbidden of [secret, prompt, proxy.downstreamToken]) assert.ok(!JSON.stringify(stats).includes(forbidden));
});

test('rejects missing/wrong local tokens and all nonexact routes without reaching upstream', async (t) => {
  let hits = 0;
  const { proxy } = await fixture(t, (_req, res) => { hits++; res.end('unexpected'); });
  for (const authorization of [undefined, `Bearer ${secret}`, 'Bearer wrong']) {
    const headers = { 'content-type': 'application/json' };
    if (authorization) headers.authorization = authorization;
    assert.equal((await post(proxy, {}, { headers })).status, 401);
  }
  for (const path of ['/v1/chat/completions', '/models', '/chat/completions?url=https://example.com', '/chat/completions/']) {
    const response = await fetch(proxy.baseUrl + path, { method: 'POST', headers: { authorization: `Bearer ${proxy.downstreamToken}` }, body: '{}' });
    assert.equal(response.status, 404);
  }
  assert.equal((await fetch(`${proxy.baseUrl}/chat/completions`, { headers: { authorization: `Bearer ${proxy.downstreamToken}` } })).status, 405);
  assert.equal(hits, 0);
});

test('invalid JSON and oversized inputs are rejected before the request budget is spent', async (t) => {
  let hits = 0;
  const { proxy } = await fixture(t, (_req, res) => { hits++; res.end('{}'); }, { maxBodyBytes: 128 });
  assert.equal((await post(proxy, {}, { body: '{' })).status, 400);
  assert.equal((await post(proxy, [])).status, 400);
  assert.equal((await post(proxy, {}, { headers: { authorization: `Bearer ${proxy.downstreamToken}`, 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await post(proxy, { messages: ['x'.repeat(256)] })).status, 413);
  assert.equal(hits, 0);
  assert.equal(proxy.getStats().forwardedRequests, 0);
});

test('the global request cap reserves atomically and returns budget_exhausted rather than success', async (t) => {
  let hits = 0;
  const { proxy } = await fixture(t, async (req, res) => { hits++; await readJson(req); await delay(30); res.end('{}'); }, { maxRequests: 2 });
  const responses = await Promise.all(Array.from({ length: 5 }, () => post(proxy)));
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 200, 429, 429, 429]);
  for (const response of responses) {
    const body = await response.json();
    if (response.status === 429) assert.equal(body.error.type, 'budget_exhausted');
  }
  assert.equal(hits, 2);
  assert.equal(proxy.getStats().budgetExhaustedRequests, 3);
});

test('SSE is delivered incrementally and byte-for-byte, including the upstream completion marker', async (t) => {
  const release = deferred();
  const first = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n';
  const last = 'data: [DONE]\n\n';
  t.after(() => release.resolve());
  const { proxy } = await fixture(t, async (req, res) => {
    await readJson(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(first);
    await release.promise;
    res.end(last);
  });
  const response = await post(proxy, { messages: [], stream: true });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const piece = await reader.read();
  assert.equal(new TextDecoder().decode(piece.value), first);
  release.resolve();
  let remaining = '';
  for (;;) { const next = await reader.read(); if (next.done) break; remaining += new TextDecoder().decode(next.value); }
  assert.equal(remaining, last);
});

test('HTTP error statuses remain visible while unsafe bodies are discarded, and redirects are never followed', async (t) => {
  let mode = 'error';
  let redirectedHits = 0;
  const { proxy, upstream } = await fixture(t, async (req, res) => {
    if (req.url === '/other') { redirectedHits++; res.end('unexpected'); return; }
    await readJson(req);
    if (mode === 'error') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3' });
      res.end(JSON.stringify({ error: { message: `upstream quota: ${secret}` } }));
    } else {
      res.writeHead(307, { location: `http://127.0.0.1:${upstream.address().port}/other` });
      res.end('redirect');
    }
  });
  const error = await post(proxy);
  assert.equal(error.status, 429);
  assert.equal(error.headers.get('retry-after'), '3');
  const sanitized = await error.json();
  assert.equal(sanitized.error.type, 'upstream_http_error');
  assert.equal(sanitized.error.code, 'upstream_http_429');
  assert.ok(!JSON.stringify(sanitized).includes(secret));
  mode = 'redirect';
  const redirect = await post(proxy);
  assert.equal(redirect.status, 502);
  assert.equal((await redirect.json()).error.code, 'upstream_redirect_refused');
  assert.equal(redirectedHits, 0);
});

test('a pre-header timeout returns 504 and aborts the upstream request', async (t) => {
  const disconnected = deferred();
  const { proxy } = await fixture(t, async (req, res) => {
    res.on('close', () => disconnected.resolve());
    await readJson(req);
  }, { timeoutMs: 80 });
  const response = await post(proxy);
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, 'upstream_timeout');
  await disconnected.promise;
  assert.equal(proxy.getStats().timedOutRequests, 1);
});

test('client stream cancellation aborts the upstream instead of allowing billed generation to continue', async (t) => {
  const disconnected = deferred();
  const { proxy } = await fixture(t, async (req, res) => {
    res.on('close', () => disconnected.resolve());
    await readJson(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
  });
  const controller = new AbortController();
  const response = await post(proxy, { messages: [], stream: true }, { signal: controller.signal });
  await response.body.getReader().read();
  controller.abort();
  await disconnected.promise;
  await delay(10);
  assert.equal(proxy.getStats().clientCancelledRequests, 1);
});

test('a stalled SSE times out after headers without forging a successful completion marker', async (t) => {
  const { proxy } = await fixture(t, async (req, res) => {
    await readJson(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
  }, { timeoutMs: 100 });
  const response = await post(proxy, { messages: [], stream: true });
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /first/);
  await assert.rejects(reader.read());
  assert.equal(proxy.getStats().timedOutRequests, 1);
});

test('slow downstream readers apply backpressure and cancellation closes a large upstream stream', async (t) => {
  const disconnected = deferred();
  let sentBytes = 0;
  const totalBytes = 64 * 1024 * 1024;
  const { proxy } = await fixture(t, async (req, res) => {
    res.on('close', () => disconnected.resolve());
    await readJson(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = Buffer.alloc(64 * 1024, 65);
    try {
      while (sentBytes < totalBytes && !res.destroyed) {
        sentBytes += chunk.length;
        if (!res.write(chunk)) await Promise.race([once(res, 'drain'), disconnected.promise]);
      }
      if (!res.destroyed) res.end();
    } catch { /* Deliberate client cancellation. */ }
  });
  const client = http.request(`${proxy.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${proxy.downstreamToken}`, 'content-type': 'application/json' } });
  client.end('{"messages":[],"stream":true}');
  const [response] = await once(client, 'response');
  response.pause();
  await delay(100);
  assert.ok(sentBytes < totalBytes, `upstream consumed all ${sentBytes} bytes despite paused downstream`);
  response.destroy();
  await disconnected.promise;
});

test('configuration rejects credential-bearing URLs, fragments, and invalid budgets', () => {
  for (const upstreamBaseUrl of ['ftp://localhost', 'http://user:pass@localhost', 'http://localhost/?key=secret', 'http://localhost/#fragment']) {
    assert.throws(() => createEvaluationProxy({ upstreamBaseUrl, apiKey: secret }));
  }
  for (const maxRequests of [0, -1, Infinity, 1.5]) assert.throws(() => createEvaluationProxy({ upstreamBaseUrl: 'http://localhost', apiKey: secret, maxRequests }));
  assert.throws(() => createEvaluationProxy({ upstreamBaseUrl: 'http://localhost', apiKey: '' }));
});

test('an upstream stream failure is recorded as transport failure, not client cancellation or success', async (t) => {
  const release = deferred();
  t.after(() => release.resolve());
  const { proxy } = await fixture(t, async (req, res) => {
    await readJson(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
    await release.promise;
    res.destroy();
  });
  const response = await post(proxy, { messages: [], stream: true });
  const reader = response.body.getReader();
  await reader.read();
  release.resolve();
  await assert.rejects(reader.read());
  await proxy.close();
  const stats = proxy.getStats();
  assert.equal(stats.transportErrors, 1);
  assert.equal(stats.clientCancelledRequests, 0);
  assert.equal(stats.completedResponses, 0);
  assert.equal(stats.activeRequests, 0);
});

test('close cancels active requests and waits for final statistics to settle', async (t) => {
  const started = deferred();
  const { proxy } = await fixture(t, async (req, res) => {
    await readJson(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
    started.resolve();
  });
  const response = await post(proxy, { messages: [], stream: true });
  await started.promise;
  const reader = response.body.getReader();
  await reader.read();
  const failedRead = assert.rejects(reader.read());
  await proxy.close();
  await failedRead;
  assert.equal(proxy.getStats().activeRequests, 0);
  assert.equal(proxy.getStats().shutdownCancelledRequests, 1);
});

test('meters final SSE usage once, requests stream usage, and does not retain reasoning bodies', async (t) => {
  let wire;
  const secretReasoning = 'private-reasoning-do-not-persist';
  const chunks = [
    `data: ${JSON.stringify({ model: 'deepseek-v4.1-flash', choices: [{ delta: { reasoning_content: secretReasoning } }] })}\r\n\r\n`,
    `data: ${JSON.stringify({ model: 'deepseek-v4.1-flash', usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 12 } } })}\n\n`,
    `data: ${JSON.stringify({ model: 'deepseek-v4.1-flash', usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 } })}\n\n`,
    'data: [DONE]\n\n',
  ];
  const { proxy } = await fixture(t, async (req, res) => {
    wire = await readJson(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // Split arbitrarily inside JSON, UTF-8 and newline boundaries.
    const data = Buffer.from(chunks.join(''));
    for (let offset = 0; offset < data.length; offset += 7) res.write(data.subarray(offset, offset + 7));
    res.end();
  });
  assert.equal(await (await post(proxy, { stream: true, stream_options: { include_usage: false, other: true } })).text(), chunks.join(''));
  await proxy.close();
  assert.deepEqual(wire.stream_options, { include_usage: true, other: true });
  const stats = proxy.getStats();
  const accounting = stats.tokenAccounting;
  assert.equal(stats.streamUsageRequestOverrides, 1);
  assert.equal(accounting.accountedRequests, 1);
  assert.equal(accounting.complete, true);
  assert.equal(accounting.totals.promptTokens, 100);
  assert.equal(accounting.totals.completionTokens, 20);
  assert.equal(accounting.totals.totalTokens, 120);
  assert.equal(accounting.totals.cachedInputTokens, 60);
  assert.equal(accounting.totals.uncachedInputTokens, 40);
  assert.equal(accounting.modelResponseCounts['deepseek-v4.1-flash'], 1);
  assert.equal(accounting.cost, null);
  for (const forbidden of [secretReasoning, prompt, secret]) assert.ok(!JSON.stringify(stats).includes(forbidden));
});

test('all successful, auxiliary and missing/error usages remain represented; unknown is not zero', async (t) => {
  let count = 0;
  const { proxy } = await fixture(t, async (req, res) => {
    await readJson(req);
    count++;
    res.writeHead(count === 3 ? 500 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(count === 1 ? { model: 'deepseek-flash', usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } } : { choices: [] }));
  });
  for (let i = 0; i < 3; i++) await (await post(proxy)).text();
  await proxy.close();
  const accounting = proxy.getStats().tokenAccounting;
  assert.equal(accounting.observedRequests, 3);
  assert.equal(accounting.accountedRequests, 1);
  assert.equal(accounting.missingUsageRequests, 2);
  assert.equal(accounting.complete, false);
  assert.equal(accounting.totals.promptTokens, 7);
  assert.equal(accounting.totals.cachedInputTokens, null);
  assert.equal(accounting.knownRequestCounts.cachedInputTokens, 0);
  assert.equal(accounting.cost, null);
});

test('oversized or malformed metering events preserve stream bytes and make metering incomplete', async (t) => {
  const data = `data: ${JSON.stringify({ model: 'deepseek-flash', choices: [{ delta: { content: 'x'.repeat(5000) } }] })}\n\ndata: {bad}\n\ndata: [DONE]\n\n`;
  const { proxy } = await fixture(t, async (req, res) => {
    await readJson(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(data);
  }, { maxMeterEventBytes: 1024 });
  assert.equal(await (await post(proxy, { stream: true })).text(), data);
  await proxy.close();
  const accounting = proxy.getStats().tokenAccounting;
  assert.equal(accounting.complete, false);
  assert.equal(accounting.oversizedEvents, 1);
  assert.equal(accounting.malformedEvents, 1);
  assert.equal(accounting.totals.promptTokens, null);
});

test('partial streams keep observed counts but cannot claim complete usage or cost', async (t) => {
  const { proxy } = await fixture(t, async (req, res) => {
    await readJson(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"model":"deepseek-flash","usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12,"prompt_cache_hit_tokens":0}}\n\n');
  }, { timeoutMs: 100 });
  const response = await post(proxy, { stream: true });
  await assert.rejects(response.text());
  await proxy.close();
  const accounting = proxy.getStats().tokenAccounting;
  assert.equal(accounting.totals.promptTokens, 10);
  assert.equal(accounting.incompleteResponseRequests, 1);
  assert.equal(accounting.complete, false);
});

test('explicit prices produce an estimate only with complete input/cache/output usage', async (t) => {
  const { proxy } = await fixture(t, async (req, res) => {
    await readJson(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'deepseek-flash', usage: { prompt_tokens: 1000000, completion_tokens: 500000, total_tokens: 1500000, prompt_cache_hit_tokens: 400000 } }));
  }, { pricing: { currency: 'USD', uncachedInputPerMillion: 1, cachedInputPerMillion: 0.1, outputPerMillion: 2 } });
  await (await post(proxy)).text();
  await proxy.close();
  const accounting = proxy.getStats().tokenAccounting;
  assert.equal(accounting.cost.estimatedAmount, 1.64);
  assert.equal(accounting.cost.currency, 'USD');
  assert.equal(accounting.cost.complete, true);
});

test('a later cumulative usage snapshot replaces earlier totals and does not reuse missing cache counts', async (t) => {
  const { proxy } = await fixture(t, async (req, res) => {
    await readJson(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12,"prompt_cache_hit_tokens":5}}\n\ndata: {"usage":{"prompt_tokens":20,"completion_tokens":4}}\n\ndata: [DONE]\n\n');
  });
  await (await post(proxy, { stream: true })).text();
  await proxy.close();
  const accounting = proxy.getStats().tokenAccounting;
  assert.equal(accounting.totals.promptTokens, 20);
  assert.equal(accounting.totals.completionTokens, 4);
  assert.equal(accounting.totals.totalTokens, 24);
  assert.equal(accounting.totals.cachedInputTokens, null);
  assert.equal(accounting.accountedRequests, 1);
});

function imageUpload(data = 'image-test-bytes-never-log') {
  const form = new FormData();
  form.set('purpose', 'user_data');
  form.set('expires_after[anchor]', 'created_at');
  form.set('expires_after[seconds]', '604800');
  form.set('file', new Blob([data], { type: 'image/png' }), 'screenshot-private.png');
  return form;
}

function fileFetch(proxy, path, method = 'GET', body) {
  return fetch(proxy.baseUrl + path, { method, headers: { authorization: `Bearer ${proxy.downstreamToken}` }, ...(body ? { body } : {}) });
}

test('native image upload, scoped list/retrieve/delete and chat references retain fixed upstream and separate budgets', async (t) => {
  const received = [];
  const imageBytes = 'image-test-bytes-never-log';
  let metadata;
  const { proxy } = await fixture(t, async (req, res) => {
    received.push({ path: req.url, method: req.method, authorization: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/v1/files') {
      const bytes = [];
      for await (const piece of req) bytes.push(piece);
      const form = await new Response(Buffer.concat(bytes), { headers: { 'content-type': req.headers['content-type'] } }).formData();
      assert.equal(form.get('purpose'), 'user_data');
      assert.equal(form.get('expires_after[seconds]'), '604800');
      assert.equal(await form.get('file').text(), imageBytes);
      metadata = { id: 'file-owned', object: 'file', bytes: form.get('file').size, created_at: 100,
        filename: form.get('file').name, purpose: 'user_data', expires_at: 604900 };
      res.end(JSON.stringify(metadata));
    } else if (req.url === '/v1/files/file-owned') {
      res.end(JSON.stringify(req.method === 'DELETE' ? { id: 'file-owned', object: 'file', deleted: true } : metadata));
    } else if (req.url === '/v1/chat/completions') {
      const body = await readJson(req);
      assert.equal(body.messages[0].content[0].file_id, 'file-owned');
      res.end('{"model":"deepseek-flash","usage":{"prompt_tokens":4,"completion_tokens":2}}');
    } else { res.statusCode = 500; res.end('unexpected global account request'); }
  });
  const upload = await fileFetch(proxy, '/files', 'POST', imageUpload());
  assert.equal(upload.status, 200);
  assert.deepEqual(await upload.json(), metadata);
  const list = await (await fileFetch(proxy, '/files?purpose=user_data&order=asc&limit=10')).json();
  assert.deepEqual(list.data, [metadata]);
  assert.equal(received.length, 1, 'list must never request the provider account-wide file list');
  assert.equal((await (await fileFetch(proxy, '/files/file-owned')).json()).id, 'file-owned');
  await (await post(proxy, { messages: [{ role: 'user', content: [{ type: 'file', file_id: 'file-owned' }] }] })).text();
  assert.equal((await (await fileFetch(proxy, '/files/file-owned', 'DELETE')).json()).deleted, true);
  assert.equal((await fileFetch(proxy, '/files/file-owned')).status, 404);
  assert.equal((await post(proxy, { messages: [{ role: 'user', content: [{ type: 'file', file_id: 'file-other-account' }] }] })).status, 400);
  await proxy.close();
  const stats = proxy.getStats();
  assert.equal(stats.forwardedRequests, 1);
  assert.equal(stats.tokenAccounting.observedRequests, 1);
  assert.equal(stats.files.forwardedRequests, 3);
  assert.equal(stats.files.successfulUploads, 1);
  assert.equal(stats.files.uploadedBytes, Buffer.byteLength(imageBytes));
  assert.equal(stats.files.ownedFileCount, 0);
  assert.equal(stats.files.localLists, 1);
  for (const item of received) assert.equal(item.authorization, `Bearer ${secret}`);
  for (const forbidden of [imageBytes, 'screenshot-private.png', 'file-owned', secret]) assert.ok(!JSON.stringify(stats).includes(forbidden));
});

test('Files API rejects invalid fields, paths, arbitrary account IDs and upload limits without model calls', async (t) => {
  let hits = 0;
  const { proxy } = await fixture(t, (_req, res) => { hits++; res.end('{}'); }, { maxFileUploadBytes: 8 });
  for (const path of ['/files/file-private', '/files/file-private/content', '/files/%2Fetc%2Fpasswd', '/files/file-private?x=1']) {
    assert.equal((await fileFetch(proxy, path)).status, 404);
  }
  for (const path of ['/files?purpose=assistants', '/files?purpose=user_data&url=http://private', '/files?purpose=user_data&limit=1&limit=2']) {
    assert.equal((await fileFetch(proxy, path)).status, 400);
  }
  assert.equal((await fileFetch(proxy, '/files?url=http://private', 'POST', imageUpload('123'))).status, 404);
  const invalid = imageUpload('123'); invalid.set('purpose', 'assistants');
  assert.equal((await fileFetch(proxy, '/files', 'POST', invalid)).status, 400);
  const duplicate = imageUpload('123'); duplicate.append('file', new Blob(['x'], { type: 'image/png' }), 'other.png');
  assert.equal((await fileFetch(proxy, '/files', 'POST', duplicate)).status, 400);
  assert.equal((await fileFetch(proxy, '/files', 'POST', imageUpload('123456789'))).status, 413);
  assert.equal(hits, 0);
  assert.equal(proxy.getStats().forwardedRequests, 0);
});

test('file request budgets reserve concurrent uploads separately and sanitize provider errors and redirects', async (t) => {
  let hits = 0, mode = 'success';
  const { proxy } = await fixture(t, async (req, res) => {
    hits++;
    for await (const _chunk of req) { /* Drain multipart. */ }
    await delay(20);
    if (mode === 'success') {
      res.setHeader('content-type', 'application/json');
      res.end('{"id":"file-one","object":"file","bytes":3,"created_at":1,"filename":"x.png","purpose":"user_data","expires_at":9999}');
    } else if (mode === 'error') { res.statusCode = 429; res.end(secret); }
    else { res.writeHead(307, { location: '/untrusted' }); res.end(secret); }
  }, { maxFileUploads: 1 });
  const responses = await Promise.all([fileFetch(proxy, '/files', 'POST', imageUpload('123')), fileFetch(proxy, '/files', 'POST', imageUpload('123'))]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 429]);
  for (const response of responses) await response.text();
  assert.equal(hits, 1);
  mode = 'error';
  const failure = await fileFetch(proxy, '/files/file-one');
  assert.equal(failure.status, 429); assert.ok(!(await failure.text()).includes(secret));
  mode = 'redirect';
  const redirect = await fileFetch(proxy, '/files/file-one');
  assert.equal(redirect.status, 502); assert.ok(!(await redirect.text()).includes(secret));
  await proxy.close();
  assert.equal(hits, 3);
  assert.equal(proxy.getStats().files.budgetExhaustedRequests, 1);
  assert.equal(proxy.getStats().forwardedRequests, 0);
  assert.equal(proxy.getStats().tokenAccounting.observedRequests, 0);
});
