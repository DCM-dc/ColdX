import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeImport, nativeRuntime } from './native-helpers.mjs';

test('delegation inherits the actual request route after a Web model switch', async () => {
  const { resolveChildAgentOptions } = await nativeImport('@deepseek-ai/dsh-subagent');
  const parent = { options: { provider: 'retired-provider', model: 'retired-model', maxTokens: 8000 }, session: {
    requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max', maxTokens: 16000 } }),
  } };
  assert.deepEqual(resolveChildAgentOptions(parent, undefined, 1), { provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 16000, subagentDepth: 1 });
  assert.deepEqual(resolveChildAgentOptions(parent, { provider: 'custom', model: 'custom-model', maxTokens: 500 }, 2), { provider: 'custom', model: 'custom-model', maxTokens: 500, subagentDepth: 2 });
});

test('native child outcome projection binds to its own descriptor and exposes only safe codes', async t => {
  const ctx = await nativeRuntime(); t.after(() => ctx.fiber.dispose());
  for (const name of ['dsh-session', 'dsh-session-projection', 'dsh-subagent']) {
    const plugin = await nativeImport(`@deepseek-ai/${name}`); await ctx.plugin(plugin.default ?? plugin, {});
  }
  const descriptor = (seq, label) => ({ seq, time: seq, type: 'subagent/descriptor', data: { version: 2, mode: 'one-shot', provider: 'spawn', label } });
  const end = (seq, reason) => ({ seq, time: seq, type: 'turn/end', data: { turn: 1, reason } });
  const project = events => ctx.sessionProjections.restore({}, events, 0).snapshot.values.subagent;
  const events = [descriptor(0, 'parent'), end(1, { kind: 'completed' }), descriptor(2, 'child')];
  assert.equal(project(events).execution, undefined, 'fork ancestor outcome never transfers to the child');
  events.push(end(3, { kind: 'error', error: { code: 'AUTH', status: 401, message: 'DO NOT EXPOSE PRIVATE PROVIDER DETAIL' } }));
  const child = project(events);
  assert.deepEqual(child.execution, { status: 'failed', seq: 3, time: 3, code: 'AUTH', httpStatus: 401 });
  assert.equal(JSON.stringify(child).includes('PRIVATE'), false);
  events.push({ seq: 4, time: 4, type: 'turn/start', data: { turn: 2 } });
  assert.equal(project(events).execution.status, 'running', 'a follow-up replaces the previous failure');
});

for (const mode of ['spawn', 'fork', 'continuable']) test(`native ${mode} delegates through the selected provider and preserves explicit effort`, { timeout: 15000 }, async t => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'child route verified' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const ctx = await nativeRuntime();
  const storage = await mkdtemp(join(tmpdir(), 'coldx-subagent-routing-'));
  t.after(async () => { await ctx.fiber.dispose(); await new Promise(resolve => server.close(resolve)); await rm(storage, { recursive: true, force: true }); });
  for (const name of ['dsh-session', 'dsh-session-persistence-jsonl', 'dsh-agent', 'dsh-llm', 'dsh-agent-loop', 'dsh-subagent', 'dsh-subagent-spawn-in-process', 'dsh-subagent-fork-in-process']) {
    const plugin = await nativeImport(`@deepseek-ai/${name}`);
    await ctx.plugin(plugin.default ?? plugin, name === 'dsh-session-persistence-jsonl' ? { root: storage } : {});
  }
  const { DeepSeekAdapter, resolveAdapterOptions } = await nativeImport('@deepseek-ai/dsh-llm-deepseek');
  const { createUserMessage } = await nativeImport('@deepseek-ai/dsh-llm');
  const { installModelSelection } = await nativeImport('@deepseek-ai/dsh-agent');
  const options = resolveAdapterOptions({ apiKeyEnv: 'COLDX_OFFLINE_FIXTURE', baseURL: `http://127.0.0.1:${server.address().port}`, models: [{ id: 'deepseek-flash', name: 'Fixture' }] });
  ctx.llm.registerAdapter(['deepseek-official'], new DeepSeekAdapter({ options: () => options, resolveApiKey: async () => 'offline-fixture', resolveUserId: () => 'fixture' }));
  const { agent: parent } = await ctx.agents.create({ sessionId: `routing-parent-${mode}`, agentOptions: { provider: 'retired-provider', model: 'retired-model' }, setup: childCtx => {
    installModelSelection(childCtx, { current: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' } });
  } });
  parent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Verify routing.' }] }));
  await parent.whenIdle();
  assert.equal(parent.session.requestHeader().config.provider, 'deepseek-official');
  const request = { parent, label: 'Route check', prompt: [{ type: 'text', text: 'Return child route verified.' }], signal: new AbortController().signal };
  let child;
  if (mode === 'continuable') {
    const accepted = await ctx.subagents.startContinuable({ provider: 'spawn', label: request.label, request, signal: request.signal });
    child = ctx.agents.get(accepted.childId);
    await child.whenIdle();
  } else {
    const run = await ctx.subagents.start(mode, request);
    const result = await run.result;
    assert.equal(result.stopReason, 'completed', result.error);
    child = ctx.agents.get(run.id);
    await run.dispose();
  }
  assert.equal(requests.length, 2, 'parent and child both reached the selected adapter');
  assert.equal(requests[1].model, 'deepseek-flash');
  assert.equal(requests[1].reasoning_effort, 'max');
  if (child) {
    assert.equal(child.session.requestHeader().config.provider, 'deepseek-official');
    const descriptor = child.session.events.findLast(event => event.type === 'subagent/descriptor')?.data;
    if (mode === 'continuable') assert.equal(descriptor.agentProvider, 'deepseek-official');
  }
});
