import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createEvaluationProxy, EVALUATION_PARAMETERS } from './evaluation-proxy.mjs';
import { startExternalProxy } from './start-external-proxy.mjs';

test('two-hop proxy keeps provider credentials external and meters final wire response at each hop', async (t) => {
  const key = 'real-key-in-test-external-process-only';
  const privatePrompt = 'task-data-never-write-to-proxy-report';
  let received;
  const upstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received = { path: req.url, authorization: req.headers.authorization, body: JSON.parse(body) };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"model":"deepseek-v4.1-flash","choices":[{"delta":{"content":"answer"}}]}\n\ndata: {"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16,"prompt_cache_hit_tokens":10}}\n\ndata: [DONE]\n\n');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const temporary = await mkdtemp(join(tmpdir(), 'coldx-external-proxy-'));
  let external, session;
  t.after(async () => {
    await session?.close(); await external?.close();
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  });
  external = await startExternalProxy({ upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: key,
    output: join(temporary, 'external'), advertisedBaseUrl: 'http://127.0.0.1', flushIntervalMs: 20 });
  const privateConfigPath = join(temporary, 'external', 'downstream.private.json');
  const config = JSON.parse(await readFile(privateConfigPath, 'utf8'));
  assert.equal(config.COLDX_EVAL_UPSTREAM_CREDENTIAL_KIND, 'relay-token');
  assert.notEqual(config.COLDX_EVAL_UPSTREAM_API_KEY, key);
  if (process.platform !== 'win32') assert.equal((await stat(privateConfigPath)).mode & 0o777, 0o600);
  session = createEvaluationProxy({ upstreamBaseUrl: external.baseUrl, apiKey: config.COLDX_EVAL_UPSTREAM_API_KEY });
  await session.listen();
  const response = await fetch(`${session.baseUrl}/chat/completions`, { method: 'POST',
    headers: { authorization: `Bearer ${session.downstreamToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'wrong-model', stream: true, messages: [{ role: 'user', content: privatePrompt }] }) });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /\[DONE\]/);
  await session.close(); await external.close();
  assert.equal(received.path, '/v1/chat/completions');
  assert.equal(received.authorization, `Bearer ${key}`);
  for (const [name, value] of Object.entries(EVALUATION_PARAMETERS)) assert.equal(received.body[name], value);
  assert.equal(received.body.stream_options.include_usage, true);
  const report = JSON.parse(await readFile(join(temporary, 'external', 'transport-report.json'), 'utf8'));
  assert.equal(report.status, 'stopped');
  assert.equal(report.stats.tokenAccounting.totals.totalTokens, 16);
  assert.equal(session.getStats().tokenAccounting.totals.totalTokens, 16);
  for (const forbidden of [key, privatePrompt, config.COLDX_EVAL_UPSTREAM_API_KEY, session.downstreamToken]) assert.ok(!JSON.stringify(report).includes(forbidden));
  assert.deepEqual((await readdir(join(temporary, 'external'))).sort(), ['downstream.private.json', 'transport-report.json']);
  await assert.rejects(startExternalProxy({ upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: key,
    output: join(temporary, 'external'), advertisedBaseUrl: 'http://127.0.0.1' }));
});

test('external proxy rejects credential-bearing or path-bearing advertised endpoints', async () => {
  for (const advertisedBaseUrl of ['http://user:password@localhost', 'http://localhost/v1', 'http://localhost?x=1', 'http://localhost#x']) {
    await assert.rejects(startExternalProxy({ advertisedBaseUrl }));
  }
});

test('native multimodal multipart upload reaches both proxy ownership scopes before chat completion', async (t) => {
  const key = 'provider-key-only-external';
  const image = Buffer.from('fake-image-local-multimodal-test-only');
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    calls.push({ path: req.url, authorization: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    let body = [];
    for await (const chunk of req) body.push(chunk);
    const bytes = Buffer.concat(body);
    if (req.url === '/v1/files') {
      const form = await new Response(bytes, { headers: { 'content-type': req.headers['content-type'] } }).formData();
      assert.equal(form.get('purpose'), 'user_data');
      assert.equal(form.get('expires_after[anchor]'), 'created_at');
      assert.equal(form.get('expires_after[seconds]'), '604800');
      assert.deepEqual(Buffer.from(await form.get('file').arrayBuffer()), image);
      res.end(JSON.stringify({ id: 'file-two-hop', object: 'file', bytes: image.length, created_at: 100,
        filename: form.get('file').name, purpose: 'user_data', expires_at: 604900 }));
    } else if (req.url === '/v1/chat/completions') {
      const payload = JSON.parse(bytes.toString());
      assert.deepEqual(payload.messages[0].content, [{ type: 'file', file_id: 'file-two-hop' }]);
      res.setHeader('content-type', 'text/event-stream');
      res.end('data: {"model":"deepseek-v4.1-flash","usage":{"prompt_tokens":100,"completion_tokens":10,"prompt_cache_hit_tokens":0}}\n\ndata: [DONE]\n\n');
    } else { res.statusCode = 500; res.end('unsupported'); }
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const temporary = await mkdtemp(join(tmpdir(), 'coldx-multimodal-two-hop-'));
  let external, session;
  t.after(async () => {
    await session?.close(); await external?.close();
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  });
  external = await startExternalProxy({ upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: key,
    output: join(temporary, 'external'), advertisedBaseUrl: 'http://127.0.0.1' });
  const config = JSON.parse(await readFile(join(temporary, 'external', 'downstream.private.json'), 'utf8'));
  session = createEvaluationProxy({ upstreamBaseUrl: external.baseUrl, apiKey: config.COLDX_EVAL_UPSTREAM_API_KEY });
  await session.listen();
  const headers = { authorization: `Bearer ${session.downstreamToken}` };
  const form = new FormData();
  form.set('purpose', 'user_data'); form.set('expires_after[anchor]', 'created_at'); form.set('expires_after[seconds]', '604800');
  form.set('file', new Blob([image], { type: 'image/png' }), 'native-browser-screenshot.png');
  const uploaded = await fetch(`${session.baseUrl}/files`, { method: 'POST', headers, body: form });
  assert.equal(uploaded.status, 200);
  assert.equal((await uploaded.json()).bytes, image.length);
  const response = await fetch(`${session.baseUrl}/chat/completions`, { method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: [{ type: 'file', file_id: 'file-two-hop' }] }] }) });
  assert.equal(response.status, 200); assert.match(await response.text(), /\[DONE\]/);
  await session.close(); await external.close();
  assert.deepEqual(calls.map(call => call.path), ['/v1/files', '/v1/chat/completions']);
  for (const call of calls) assert.equal(call.authorization, `Bearer ${key}`);
  for (const stats of [external.getStats(), session.getStats()]) {
    assert.equal(stats.files.successfulUploads, 1);
    assert.equal(stats.files.uploadedBytes, image.length);
    assert.equal(stats.forwardedRequests, 1);
    assert.equal(stats.tokenAccounting.totals.totalTokens, 110);
    assert.ok(!JSON.stringify(stats).includes(image.toString()));
    assert.ok(!JSON.stringify(stats).includes('native-browser-screenshot'));
  }
});
