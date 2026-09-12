import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { nativeImport, nativeRuntime } from './native-helpers.mjs';

const DEFAULT_RETRYABLE_CODES = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'];

function sse(...payloads) {
  return `${payloads.map(payload => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`).join('')}data: [DONE]\n\n`;
}

async function fixture(t, responseBody, { maxRetries = 5 } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    request.resume();
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(responseBody);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const ctx = await nativeRuntime();
  t.after(async () => {
    await ctx.fiber.dispose();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  for (const packageName of ['dsh-session', 'dsh-agent', 'dsh-llm', 'dsh-agent-loop', 'dsh-llm-retry']) {
    const plugin = await nativeImport(`@deepseek-ai/${packageName}`);
    await ctx.plugin(plugin.default ?? plugin, {});
  }
  const { DeepSeekAdapter, resolveAdapterOptions } = await nativeImport('@deepseek-ai/dsh-llm-deepseek');
  const { createUserMessage } = await nativeImport('@deepseek-ai/dsh-llm');
  const address = server.address();
  assert(address && typeof address === 'object');
  const connection = resolveAdapterOptions({
    apiKeyEnv: 'COLDX_OFFLINE_FIXTURE_KEY',
    baseURL: `http://127.0.0.1:${address.port}`,
    models: [{ id: 'fixture-model', name: 'Fixture model' }],
    retryPolicy: {
      mode: 'normal',
      maxRetries,
      retryableCodes: DEFAULT_RETRYABLE_CODES,
      backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
    },
  });
  ctx.llm.registerAdapter(['deepseek-official'], new DeepSeekAdapter({
    options: () => connection,
    resolveApiKey: async () => 'offline-fixture-key',
    resolveUserId: () => 'offline-fixture-user',
  }));
  const { agent } = await ctx.agents.create({
    sessionId: 'deepseek-native-sse-error-fixture',
    agentOptions: { provider: 'deepseek-official', model: 'fixture-model' },
  });

  async function run() {
    agent.followup(createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Exercise the offline DeepSeek SSE fixture.' }],
    }));
    await agent.whenIdle();
    return {
      requests: [...requests],
      retries: agent.session.events.filter(event => event.type === 'llm/retry'),
      messages: agent.session.events.filter(event => event.type === 'assistant/message'),
      turnEnd: agent.session.events.findLast(event => event.type === 'turn/end')?.data.reason,
    };
  }
  return { run };
}

test('HTTP 200 SSE authentication errors retain provider detail and never retry', async t => {
  const body = sse({
    status_code: 401,
    error: {
      message: 'Authentication failed.',
      type: 'api_error',
      code: 'authentication_failed',
      param: null,
    },
  });
  const result = await (await fixture(t, body)).run();
  assert.equal(result.requests.length, 1);
  assert.equal(result.retries.length, 0);
  assert.deepEqual(result.turnEnd, {
    kind: 'error',
    error: { message: 'Authentication failed.', code: 'AUTH', status: 401 },
  });
  assert.equal(result.messages.length, 0);
});

test('a genuine completed response with no blocks stays EMPTY_RESPONSE and follows retry policy', async t => {
  const body = sse({ choices: [{ delta: {}, finish_reason: 'stop' }] });
  const result = await (await fixture(t, body, { maxRetries: 1 })).run();
  assert.equal(result.requests.length, 2);
  assert.equal(result.retries.length, 1);
  assert.deepEqual(result.turnEnd, {
    kind: 'error',
    error: { message: 'model returned a completed response with no content', code: 'EMPTY_RESPONSE' },
  });
});

test('ordinary streamed DeepSeek content remains a successful assistant message', async t => {
  const body = sse(
    { choices: [{ delta: { role: 'assistant', content: '正常' }, finish_reason: null }] },
    {
      choices: [{ delta: { content: '内容' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 2 },
    },
  );
  const result = await (await fixture(t, body)).run();
  assert.equal(result.requests.length, 1);
  assert.equal(result.retries.length, 0);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].data.message.content.find(block => block.type === 'text')?.text, '正常内容');
  assert.deepEqual(result.turnEnd, { kind: 'completed' });
});

test('an in-band error without status or message cannot turn preceding partial content into success', async t => {
  const body = sse(
    { choices: [{ delta: { role: 'assistant', content: 'unsafe partial' }, finish_reason: null }] },
    { error: { type: 'api_error', code: 'upstream_failed' } },
  );
  const result = await (await fixture(t, body)).run();
  assert.equal(result.requests.length, 1);
  assert.equal(result.retries.length, 0);
  assert.deepEqual(result.turnEnd, {
    kind: 'error',
    error: { message: 'DeepSeek API returned an in-band error (api_error/upstream_failed)', code: 'PROVIDER_ERROR' },
  });
  assert.equal(result.messages.length, 0);
});

test('a whitespace-only provider message uses a useful structured fallback', async t => {
  const body = sse({ error: { message: '   ', type: 'api_error', code: 'upstream_failed' } });
  const result = await (await fixture(t, body)).run();
  assert.equal(result.requests.length, 1);
  assert.equal(result.retries.length, 0);
  assert.deepEqual(result.turnEnd, {
    kind: 'error',
    error: { message: 'DeepSeek API returned an in-band error (api_error/upstream_failed)', code: 'PROVIDER_ERROR' },
  });
});

for (const { status, code } of [
  { status: 429, code: 'RATE_LIMIT' },
  { status: 500, code: 'SERVER' },
]) {
  test(`HTTP 200 in-band ${status} errors retain the existing ${code} retry behavior`, async t => {
    const body = sse({
      status_code: status,
      error: { message: `Transient ${status}`, type: 'api_error', code: 'upstream_error' },
    });
    const result = await (await fixture(t, body, { maxRetries: 1 })).run();
    assert.equal(result.requests.length, 2);
    assert.equal(result.retries.length, 1);
    assert.deepEqual(result.turnEnd, {
      kind: 'error',
      error: { message: `Transient ${status}`, code, status },
    });
  });
}
