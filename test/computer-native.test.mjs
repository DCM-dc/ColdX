import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeImport, nativeRuntime } from './native-helpers.mjs';
import { validateBrowserArguments, browserPreset } from '../plugin/computer-preset.mjs';

test('screenshot names allow harmless basenames and reject paths and reserved Windows names', () => {
  for (const filename of ['before.png', 'after-click.jpeg', '页面截图.png', 'Screen 2.webp']) {
    assert.equal(validateBrowserArguments('browser_take_screenshot', { filename }), undefined, filename);
  }
  for (const filename of ['../image.png', '/image.png', 'C:\\image.png', 'a/b.png', 'a\\b.png', 'a:stream.png', '..png',
    'CON.png', 'nul.jpeg', 'COM1.png', 'lpt9.jpg', 'COM¹.png', 'con .png', 'report.html', '', 'hidden.png ', 'image.png\0', 3]) {
    assert.match(validateBrowserArguments('browser_take_screenshot', { filename }), /filename/, String(filename));
  }
  assert.match(validateBrowserArguments('browser_snapshot', { filename: 'snapshot.png' }), /filename/);
});

async function fixture(t) {
  const ctx = await nativeRuntime();
  t.after(() => ctx.fiber.dispose());
  for (const name of ['dsh-typert-registry', 'dsh-session', 'dsh-agent', 'dsh-llm', 'dsh-agent-loop', 'dsh-api-gateway']) {
    const module = await nativeImport('@deepseek-ai/' + name); await ctx.plugin(module.default ?? module, {});
  }
  const { agent: a } = await ctx.agents.create({ sessionId: 'browser-a', meta: { cwd: process.cwd() }, agentOptions: { provider: 'browser-fixture', model: 'vision' } });
  const { agent: b } = await ctx.agents.create({ sessionId: 'browser-b', meta: { cwd: process.cwd() } });
  return { ctx, a, b };
}

test('native MCP filters exact raw names and reserves same namespace independently per Agent', async t => {
  const { ctx, a, b } = await fixture(t);
  const mcp = await nativeImport('@deepseek-ai/dsh-mcp-client');
  const config = { transport: 'stdio', serverName: 'coldx_browser', command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/browser-mcp.mjs', import.meta.url))], cwd: process.cwd(), env: {},
    toolCallTimeoutMs: 5000, failOnStartupError: true, reconnect: { enabled: false }, allowedTools: ['browser_snapshot', 'browser_close'] };
  await a.ctx.plugin(mcp, config);
  assert.deepEqual(ctx.tools.schemas(a).filter(row => row.name.startsWith('mcp__')).map(row => row.name).sort(),
    ['mcp__coldx_browser__browser_close', 'mcp__coldx_browser__browser_snapshot']);
  assert.equal(ctx.tools.schemas(b).some(row => row.name.startsWith('mcp__')), false);
  await b.ctx.plugin(mcp, config);
  const aTool = ctx.tools.get('mcp__coldx_browser__browser_snapshot', a);
  const bTool = ctx.tools.get('mcp__coldx_browser__browser_snapshot', b);
  assert.notEqual(aTool, bTool);
  const result = await ctx.tools.execute({ agent: b, name: bTool.name, arguments: {}, callId: 'browser-test', signal: new AbortController().signal });
  assert.equal(result.isError, false);
});

test('child browser calls cannot reach inherited parent connection; child close uses native lineage', async t => {
  const { ctx, a, b } = await fixture(t);
  for (const name of ['dsh-session-projection', 'dsh-subagent']) {
    const module = await nativeImport('@deepseek-ai/' + name); await ctx.plugin(module.default ?? module, {});
  }
  await ctx.plugin(await import('../plugin/computer-host.mjs'), { driverArgs: [fileURLToPath(new URL('./fixtures/browser-mcp.mjs', import.meta.url))] });
  const run = (agent, name) => ctx.tools.execute({ agent, name, arguments: {}, callId: agent.id + name, signal: new AbortController().signal });
  await run(a, 'coldx_browser');
  const { agent: child } = await a.ctx.agents.create({ sessionId: 'browser-child', meta: { cwd: process.cwd(), origin: 'subagent', parentSession: a.id } });
  child.session.append('subagent/descriptor', { version: 2, mode: 'one-shot', provider: 'spawn', label: 'Browser test child' });
  const before = await run(child, 'mcp__coldx_browser__browser_snapshot');
  assert.equal(before.isError, true);
  assert.match(before.content[0].text, /this session first/);
  await run(child, 'coldx_browser');
  assert.notEqual(ctx.tools.get('mcp__coldx_browser__browser_snapshot', child), ctx.tools.get('mcp__coldx_browser__browser_snapshot', a));
  assert.equal((await run(child, 'mcp__coldx_browser__browser_snapshot')).isError, false);
  const address = { parentSessionId: a.id, childSessionId: child.id, mode: 'one-shot' };
  const close = target => ctx.typertGateway.invokeRpc('coldxComputer/closeChild', { args: { address: target, request: {} } }, new AbortController().signal);
  assert.equal((await close({ ...address, parentSessionId: b.id })).ok, false);
  assert.equal(ctx.coldxComputer.snapshot(child.id).connected, true);
  assert.equal((await close(address)).ok, true);
  assert.equal(ctx.coldxComputer.snapshot(child.id).connected, false);
  assert.equal(ctx.coldxComputer.snapshot(a.id).connected, true);
});

test('real Playwright screenshot becomes a native durable attachment and RPC preview without another capture', { timeout: 30_000 }, async t => {
  const { browserRuntime } = await import('../plugin/computer-preset.mjs');
  if (!browserRuntime().available) return t.skip('Install the dedicated browser with pnpm computer:install.');
  const { ctx, a, b } = await fixture(t);
  const storage = await mkdtemp(join(tmpdir(), 'coldx-computer-image-'));
  t.after(() => rm(storage, { recursive: true, force: true }));
  await ctx.plugin((await nativeImport('@deepseek-ai/dsh-attachment-local')).default, { dshHome: storage });
  const { DeepSeekAdapter, resolveAdapterOptions } = await nativeImport('@deepseek-ai/dsh-llm-deepseek');
  const options = resolveAdapterOptions({ models: [{ id: 'vision', name: 'Local fixture only', inputModalities: ['text', 'image'] }] });
  ctx.llm.registerAdapter(['browser-fixture'], new DeepSeekAdapter({ options: () => options, resolveApiKey: async () => 'unused', attachments: ctx.attachments }));
  await ctx.plugin(await import('../plugin/computer-host.mjs'));
  const server = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><body style="background:#fff"><button style="position:absolute;left:40px;top:40px;width:180px;height:70px" onclick="this.textContent=\'Clicked\'">Test button</button></body>'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  let seq = 0;
  const run = (name, args = {}) => ctx.tools.execute({ agent: a, name, arguments: args, callId: 'real-browser-' + ++seq, signal: new AbortController().signal });
  assert.equal((await run('coldx_browser')).isError, false);
  const navigation = await run('mcp__coldx_browser__browser_navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  assert.equal(navigation.isError, false, JSON.stringify(navigation.content));
  const click = await run('mcp__coldx_browser__browser_mouse_click_xy', { x: 100, y: 70 });
  assert.equal(click.isError, false, JSON.stringify(click.content));
  const exported = await run('mcp__coldx_browser__browser_take_screenshot', { type: 'png', filename: 'verified-native-screenshot.png' });
  assert.equal(exported.isError, false, JSON.stringify(exported.content));
  assert.ok((await readFile(join(browserPreset(a).args[1], 'verified-native-screenshot.png'))).byteLength > 0);
  const screenshot = await run('mcp__coldx_browser__browser_take_screenshot', { type: 'png' });
  assert.equal(screenshot.isError, false, JSON.stringify(screenshot.content));
  const ref = screenshot.content.find(block => block.type === 'image')?.attachment;
  assert.ok(ref, 'real MCP screenshot must be admitted as a native attachment');
  assert.ok((await ctx.attachments.readImage(ref)).data.byteLength > 0);
  await Promise.all([...ctx.coldxComputer.pendingImages]);
  const result = await ctx.typertGateway.invokeRpc('coldxComputer/read', { args: { agentId: a.id, request: { afterRevision: -1, waitMs: 0 } } }, new AbortController().signal);
  assert.equal(result.ok, true, JSON.stringify(result));
  const preview = result.value.records.at(-1).previewAttachment;
  assert.ok(preview, JSON.stringify({ image: ref, pending: ctx.coldxComputer.pendingImages.size, record: result.value.records.at(-1) }));
  assert.equal(preview.mime, ref.mediaType);
  assert.deepEqual(Buffer.from(preview.base64, 'base64'), Buffer.from((await ctx.attachments.readImage(ref)).data));
  assert.equal(ctx.coldxComputer.snapshot(b.id).records.length, 0);
  const snapshot = await run('mcp__coldx_browser__browser_snapshot');
  assert.match(snapshot.content.map(block => block.text ?? '').join(''), /Clicked/);
  assert.equal((await run('mcp__coldx_browser__browser_close')).isError, false);
  assert.equal(ctx.coldxComputer.snapshot(a.id).browserOpen, false);
  assert.equal((await run('mcp__coldx_browser__browser_navigate', { url: `http://127.0.0.1:${server.address().port}/` })).isError, false);
  assert.equal(ctx.coldxComputer.snapshot(a.id).browserOpen, true);
  await ctx.coldxComputer.close(a, {});
});

test('native model request refreshes lazy browser schemas on the very next turn step', { timeout: 15_000 }, async t => {
  const { ctx, a } = await fixture(t);
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.setHeader('content-type', 'text/event-stream');
    const choice = requests.length === 1
      ? { delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'lazy-browser-open', type: 'function', function: { name: 'coldx_browser', arguments: '{}' } }] }, finish_reason: 'tool_calls' }
      : { delta: { role: 'assistant', content: 'Tools ready.' }, finish_reason: 'stop' };
    response.end('data: ' + JSON.stringify({ choices: [choice] }) + '\n\ndata: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const { DeepSeekAdapter, resolveAdapterOptions } = await nativeImport('@deepseek-ai/dsh-llm-deepseek');
  const options = resolveAdapterOptions({ baseURL: `http://127.0.0.1:${server.address().port}`, models: [{ id: 'vision', name: 'Offline fixture' }] });
  ctx.llm.registerAdapter(['browser-fixture'], new DeepSeekAdapter({ options: () => options, resolveApiKey: async () => 'offline-fixture', resolveUserId: () => 'fixture' }));
  await ctx.plugin(await import('../plugin/computer-host.mjs'), { driverArgs: [fileURLToPath(new URL('./fixtures/browser-mcp.mjs', import.meta.url))] });
  const { createUserMessage } = await nativeImport('@deepseek-ai/dsh-llm');
  a.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Enable the browser.' }] }));
  await a.whenIdle();
  assert.equal(requests.length, 2, JSON.stringify(a.session.events.findLast(event => event.type === 'turn/end')?.data));
  const names = request => request.tools.map(tool => tool.function.name);
  assert.ok(names(requests[0]).includes('coldx_browser'));
  assert.equal(names(requests[0]).some(name => name.startsWith('mcp__coldx_browser__')), false);
  assert.ok(names(requests[1]).includes('mcp__coldx_browser__browser_take_screenshot'));
  assert.equal(names(requests[1]).some(name => name.includes('unsafe')), false);
});

test('computer service is lazy, rejects foreign owner, filters unsafe tools and closes only its own client', async t => {
  const { ctx, a, b } = await fixture(t);
  const module = await import('../plugin/computer-host.mjs');
  await ctx.plugin(module, { driverArgs: [fileURLToPath(new URL('./fixtures/browser-mcp.mjs', import.meta.url))] });
  assert.equal(ctx.coldxComputer.snapshot(a.id).browserOpen, false);
  assert.equal(ctx.tools.schemas(a).filter(row => row.name.startsWith('mcp__')).length, 0);
  const run = (agent, name, args = {}) => ctx.tools.execute({ agent, name, arguments: args, callId: agent.id + name, signal: new AbortController().signal });
  assert.equal((await run(a, 'coldx_browser')).isError, false);
  assert.equal(ctx.tools.schemas(a).some(row => row.name.includes('unsafe')), false);
  assert.equal(ctx.tools.schemas(b).some(row => row.name.startsWith('mcp__')), false);
  assert.equal((await run(b, 'coldx_browser')).isError, false);
  assert.equal((await run(a, 'mcp__coldx_browser__browser_snapshot')).isError, false);
  assert.equal(ctx.coldxComputer.snapshot(a.id).records.at(-1).status, 'completed');
  await ctx.coldxComputer.close(a, {}, new AbortController().signal);
  assert.equal(ctx.coldxComputer.snapshot(a.id).browserOpen, false);
  assert.equal(ctx.coldxComputer.snapshot(b.id).connected, true);
  assert.throws(() => ctx.coldxComputer.read({ id: a.id }, { afterRevision: -1, waitMs: 0 }), /exact live Agent/);
});
