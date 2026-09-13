import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createEvaluationDispatcher } from './evaluation-dispatcher.mjs';

const modulePath = process.env.COLDX_EVAL_UNDICI_MODULE;

test('explicit HTTP proxy dispatcher uses absolute-form requests rather than forbidden CONNECT :80', { skip: !modulePath }, async (t) => {
  let connectCalls = 0;
  let requestPath;
  let proxyAuth;
  const server = http.createServer((req, res) => {
    requestPath = req.url; proxyAuth = req.headers['proxy-authorization'];
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  });
  server.on('connect', (_req, socket) => { connectCalls++; socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const dispatcher = await createEvaluationDispatcher({ modulePath, timeoutMs: 10_800_000, useEnvironmentProxy: true,
    environment: { HTTP_PROXY: `http://agent:fake-egress-token@127.0.0.1:${server.address().port}`, NO_PROXY: 'localhost' } });
  t.after(async () => { await dispatcher.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const response = await fetch('http://203.0.113.20/chat/completions', { method: 'POST', body: '{}', dispatcher });
  assert.equal((await response.json()).ok, true);
  assert.equal(connectCalls, 0);
  assert.equal(requestPath, 'http://203.0.113.20/chat/completions');
  assert.equal(proxyAuth, `Basic ${Buffer.from('agent:fake-egress-token').toString('base64')}`);
  assert.equal(dispatcher.evaluationMetadata.headersTimeoutMs, 10_800_000);
  assert.equal(dispatcher.evaluationMetadata.bodyTimeoutMs, 10_800_000);
  assert.equal(dispatcher.evaluationMetadata.connectTimeoutMs, 30_000);
  assert.equal(dispatcher.evaluationMetadata.proxyTunnel, false);
  assert.ok(!JSON.stringify(dispatcher.evaluationMetadata).includes('fake-egress-token'));
});

test('explicit dispatcher rejects implicit/floating modules and invalid timeouts', async () => {
  await assert.rejects(createEvaluationDispatcher({ modulePath: 'undici', timeoutMs: 1000 }));
  await assert.rejects(createEvaluationDispatcher({ modulePath: '/operator/locked/index.js', timeoutMs: 0 }));
});
