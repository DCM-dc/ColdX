#!/usr/bin/env node
// Host-only fake provider. Never reads product settings or sends an external API request.
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startExternalProxy } from './start-external-proxy.mjs';

const [host, output, undiciModulePath] = process.argv.slice(2);
const sentinel = process.env.COLDX_SMOKE_PROVIDER_SENTINEL;
if (!sentinel || !host || !output) throw new Error('Explicit mock-only configuration required.');
const state = { requests: 0, authenticatedRequests: 0, uploads: 0, chats: 0, cancelledStreams: 0, finalWireVerified: true };
const upstream = http.createServer(async (req, res) => {
  state.requests++;
  if (req.headers.authorization !== `Bearer ${sentinel}`) { res.writeHead(401); res.end(); return; }
  state.authenticatedRequests++;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  if (req.url === '/v1/files' && req.method === 'POST') {
    state.uploads++;
    const form = await new Response(bytes, { headers: { 'content-type': req.headers['content-type'] } }).formData();
    const file = form.get('file');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `file-smoke-${state.uploads}`, object: 'file', bytes: file.size, created_at: 100,
      filename: file.name, purpose: 'user_data', expires_at: 604900 }));
    return;
  }
  if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
  state.chats++;
  const payload = JSON.parse(bytes.toString('utf8'));
  state.finalWireVerified &&= payload.model === 'deepseek-flash' && payload.reasoning_effort === 'max'
    && payload.temperature === 1 && payload.top_p === 0.95 && payload.stream_options?.include_usage === true;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (payload.messages?.[0]?.content === 'cancel-probe') {
    res.once('close', () => { state.cancelledStreams++; });
    res.write('data: {"model":"deepseek-flash","choices":[{"delta":{"content":"partial"}}]}\n\n');
    return;
  }
  res.end('data: {"model":"deepseek-flash","choices":[{"delta":{"content":"mock-allowed"}}]}\n\ndata: {"model":"deepseek-flash","usage":{"prompt_tokens":30,"completion_tokens":5,"total_tokens":35,"prompt_cache_hit_tokens":20}}\n\ndata: [DONE]\n\n');
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
const relay = await startExternalProxy({ upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: sentinel,
  host, port: 80, advertisedBaseUrl: `http://${host}`, output, maxRequests: 10, undiciModulePath,
  timeoutMs: 10_800_000 });
console.log(JSON.stringify({ event: 'mock-relay-ready', sentinelSha256: createHash('sha256').update(sentinel).digest('hex') }));
let closing = false;
async function close() {
  if (closing) return; closing = true;
  await relay.close(); upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
  await writeFile(join(output, 'mock-provider-report.json'), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}
process.once('SIGTERM', () => { void close(); });
process.once('SIGINT', () => { void close(); });
