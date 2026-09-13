import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedExecutionEnvironment } from './execution-environment.mjs';
import { createEvaluationProxy } from './evaluation-proxy.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const source = process.env.COLDX_EVAL_TEST_SOURCE;
if (!source) throw new Error('Set COLDX_EVAL_TEST_SOURCE to the ColdX source checkout.');
const browserArgs = process.env.COLDX_EVAL_TEST_BROWSERS_PATH ? ['--playwright-browsers-path', process.env.COLDX_EVAL_TEST_BROWSERS_PATH] : [];

function isolatedEnv() {
  const env = isolatedExecutionEnvironment(process.env);
  return { ...env, COLDX_EVAL_API_KEY: 'synthetic-local-only' };
}

function emit(res, delta, finish = 'stop') {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ id: 'synthetic-local', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: 'synthetic-local', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 123, completion_tokens: 7, total_tokens: 130 } })}\n\n`);
  res.end('data: [DONE]\n\n');
}

async function runCase(t, { loop = false, maxSteps = 500, delegate = false, stall = false, nested = false, browser = false, session = false, shell = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'coldx-native-eval-test-'));
  const workspace = join(root, 'workspace');
  const output = join(root, 'run');
  await mkdir(workspace);
  const task = join(root, 'task.txt');
  await writeFile(task, 'Write native-evidence.txt with the exact content native ColdX tool executed, then finish.');
  if (shell) await writeFile(join(workspace, 'inspect-worker-environment.cjs'), `
    const fs = require('node:fs'), os = require('node:os');
    const keys = ['GOMAXPROCS', 'CARGO_BUILD_JOBS', 'NEXTEST_TEST_THREADS', 'PYTEST_XDIST_AUTO_NUM_WORKERS', 'NODE_OPTIONS'];
    fs.writeFileSync('child-environment.json', JSON.stringify({ env: Object.fromEntries(keys.map(key => [key, process.env[key] ?? null])), cpus: os.cpus().length, availableParallelism: os.availableParallelism() }));
    fs.writeFileSync('native-evidence.txt', 'native ColdX tool executed');
    console.log('NATIVE_BASH_ENVIRONMENT_OBSERVED');
  `);
  const requests = [];
  const uploadedImages = new Map();
  let mainRequests = 0;
  const roleRequests = new Map();
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/browser-fixture') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><title>ColdX isolated browser fixture</title><h1>NATIVE_BROWSER_VERIFIED</h1>');
    }
    if (req.method === 'POST' && req.url === '/files') {
      const parts = [];
      for await (const chunk of req) parts.push(chunk);
      const form = await new Response(Buffer.concat(parts), { headers: { 'content-type': req.headers['content-type'] } }).formData();
      const file = form.get('file');
      const id = `file-native-browser-${uploadedImages.size + 1}`;
      const created = Math.floor(Date.now() / 1000);
      const metadata = { id, object: 'file', bytes: file.size, created_at: created, filename: file.name,
        purpose: 'user_data', expires_at: created + Number(form.get('expires_after[seconds]')) };
      uploadedImages.set(id, { metadata, image: Buffer.from(await file.arrayBuffer()) });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(metadata));
    }
    if (req.url.startsWith('/files')) {
      const url = new URL(req.url, 'http://synthetic.invalid');
      const id = decodeURIComponent(url.pathname.slice('/files/'.length));
      const value = url.pathname === '/files' ? { object: 'list', data: [...uploadedImages.values()].map(value => value.metadata), has_more: false }
        : req.method === 'DELETE' ? { id, object: 'file', deleted: true } : uploadedImages.get(id)?.metadata;
      res.writeHead(value ? 200 : 404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(value ?? { error: { message: 'Unknown synthetic file' } }));
    }
    if (req.method !== 'POST' || req.url !== '/chat/completions') { res.writeHead(404); return res.end(); }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ url: req.url, body });
    if (!body.tools?.length) return emit(res, { content: 'Synthetic task title' });
    mainRequests++;
    assert.ok(body.tools.some(tool => tool.function.name === 'coldx_session_context'));
    if (stall) return;
    if (shell && mainRequests === 1) {
      const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
      const command = `${quote(process.execPath)} ${quote(join(workspace, 'inspect-worker-environment.cjs'))}`;
      return emit(res, { tool_calls: [{ index: 0, id: 'native-bash-environment', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command, description: 'Inspect inherited benchmark worker limits', timeoutMs: 10000 }) } }] }, 'tool_calls');
    }
    if (browser) {
      const calls = [
        ['coldx_browser', {}],
        ['mcp__coldx_browser__browser_navigate', { url: `http://127.0.0.1:${server.address().port}/browser-fixture` }],
        ['mcp__coldx_browser__browser_take_screenshot', {}],
        ['write', { file_path: 'native-evidence.txt', content: 'native ColdX tool executed' }],
      ];
      const call = calls[mainRequests - 1];
      if (call) {
        assert.ok(body.tools.some(tool => tool.function.name === call[0]), `Native browser tool unavailable: ${call[0]}`);
        return emit(res, { tool_calls: [{ index: 0, id: `browser-fixture-${mainRequests}`, type: 'function', function: { name: call[0], arguments: JSON.stringify(call[1]) } }] }, 'tool_calls');
      }
      return emit(res, { content: 'Verified native ColdX browser completion.' });
    }
    if (nested) {
      const userText = body.messages.filter(message => message.role === 'user').map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
      const role = userText.some(value => value.startsWith('COLDX_SYNTHETIC_GRANDCHILD')) ? 'grandchild'
        : userText.some(value => value.startsWith('COLDX_SYNTHETIC_CHILD')) ? 'child' : 'root';
      const count = (roleRequests.get(role) ?? 0) + 1;
      roleRequests.set(role, count);
      if (count === 1 && role !== 'grandchild') {
        const prompt = role === 'root' ? 'COLDX_SYNTHETIC_CHILD Delegate the file operation to a background child.' : 'COLDX_SYNTHETIC_GRANDCHILD Write native-evidence.txt.';
        return emit(res, { tool_calls: [{ index: 0, id: `${role}-background`, type: 'function', function: { name: 'subagent', arguments: JSON.stringify({ description: 'Exercise nested native background', prompt, run_in_background: true }) } }] }, 'tool_calls');
      }
      if (count === 1 && role === 'grandchild') {
        await new Promise(resolve => setTimeout(resolve, 350));
        return emit(res, { tool_calls: [{ index: 0, id: 'grandchild-write', type: 'function', function: { name: 'write', arguments: JSON.stringify({ file_path: 'native-evidence.txt', content: 'native ColdX tool executed' }) } }] }, 'tool_calls');
      }
      return emit(res, { content: 'Verified native ColdX completion.' });
    }
    if (delegate && mainRequests === 1) {
      return emit(res, { tool_calls: [{ index: 0, id: 'delegate-fixture', type: 'function', function: { name: 'subagent', arguments: JSON.stringify({ description: 'Exercise native child limit', prompt: 'COLDX_SYNTHETIC_CHILD Write native-evidence.txt.', run_in_background: false }) } }] }, 'tool_calls');
    }
    const child = body.messages.some(message => message.role === 'user' && (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).startsWith('COLDX_SYNTHETIC_CHILD'));
    if ((loop && (!delegate || child)) || mainRequests === 1) {
      return emit(res, { tool_calls: [{ index: 0, id: `fixture-${mainRequests}`, type: 'function', function: { name: 'write', arguments: JSON.stringify({ file_path: 'native-evidence.txt', content: 'native ColdX tool executed' }) } }] }, 'tool_calls');
    }
    emit(res, { content: 'Verified native ColdX completion.' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  let relay;
  const env = isolatedEnv();
  if (session) {
    relay = createEvaluationProxy({ upstreamBaseUrl: baseURL, apiKey: 'SYNTHETIC_EXTERNAL_RELAY_KEY' });
    await relay.listen();
    t.after(() => relay.close());
    Object.assign(env, { COLDX_EVAL_UPSTREAM_BASE_URL: relay.baseUrl, COLDX_EVAL_UPSTREAM_API_KEY: relay.downstreamToken, COLDX_EVAL_UPSTREAM_CREDENTIAL_KIND: 'relay-token' });
  }
  const args = [join(directory, session ? 'run-session.mjs' : 'run-native.mjs'), '--source', resolve(source), '--workspace', workspace, '--output', output, '--task-file', task,
    ...(session ? [] : ['--base-url', baseURL]), '--max-steps', String(maxSteps), '--timeout-ms', stall ? '1500' : '45000', ...browserArgs];
  const child = spawn(process.execPath, args, { cwd: root, env, detached: session && process.platform === 'linux', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => stdout += data);
  child.stderr.on('data', data => stderr += data);
  const timer = setTimeout(() => child.kill(), 60000);
  const code = await new Promise(resolve => child.once('close', resolve));
  clearTimeout(timer);
  await writeFile(join(root, 'process-output.json'), JSON.stringify({ code, stdout, stderr }, null, 2));
  await writeFile(join(root, 'mock-requests.json'), JSON.stringify(requests, null, 2));
  assert.equal(code, stall ? 1 : loop ? 2 : 0, `native process failed; artifacts: ${root}\n${stderr}\n${stdout}`);
  const report = JSON.parse(await readFile(join(output, ...(session ? ['native'] : []), 'report.json'), 'utf8'));
  if (!stall) assert.equal(await readFile(join(workspace, 'native-evidence.txt'), 'utf8'), 'native ColdX tool executed');
  assert.equal(report.identity.preset, 'coldx');
  assert.equal(report.identity.policyPresent, true);
  for (const tool of ['coldx_session_context', 'coldx_present_page', 'coldx_browser', 'write']) assert.ok(report.identity.tools.includes(tool), `${tool} missing from native tool catalog`);
  assert.equal(report.configuration.contextWindow, 1000000);
  for (const { body } of requests.filter(row => row.body.tools?.length)) {
    assert.equal(body.model, 'deepseek-flash');
    assert.equal(body.reasoning_effort, 'max');
    assert.equal(body.temperature, 1);
    assert.equal(body.top_p, session ? 0.95 : undefined, 'top_p is owned by the forwarding proxy');
  }
  if (!stall) {
    assert.ok(report.usage.inputTokens >= 123);
    assert.ok((await readFile(report.trajectory, 'utf8')).includes('tool/call'));
  }
  t.diagnostic(`Offline evidence: ${root}`);
  return { report, mainRequests, root, requests, uploadedImages,
    sessionReport: session ? JSON.parse(await readFile(join(output, 'session-report.json'), 'utf8')) : null,
    relayStats: relay?.getStats() };
}

test('real ColdX Web composition mounts preset, executes a native tool and exports its result', { timeout: 65000 }, async t => {
  const { report, mainRequests } = await runCase(t);
  assert.equal(report.status, 'completed');
  assert.equal(report.visibleResult, 'Verified native ColdX completion.');
  assert.equal(mainRequests, 2);
  assert.equal(report.steps.actual, 2);
});

test('native pre-step gate blocks request N+1 and exports a step-limit result', { timeout: 65000 }, async t => {
  const { report, mainRequests } = await runCase(t, { loop: true, maxSteps: 2 });
  assert.equal(report.status, 'step-limit');
  assert.equal(mainRequests, 2);
  assert.equal(report.steps.actual, 2);
});

test('native subagent inherits ColdX and sampling while receiving its own step gate', { timeout: 65000 }, async t => {
  const { report, mainRequests } = await runCase(t, { delegate: true, loop: true, maxSteps: 2 });
  assert.equal(report.status, 'step-limit');
  assert.equal(report.agents.length, 2);
  assert.equal(mainRequests, 4);
  assert.equal(report.steps.actual, 4);
  assert.equal(report.agents.filter(agent => agent.limited).length, 1);
  assert.ok(report.agents.every(agent => agent.steps === 2 && agent.requestPreparations === 2));
});

test('a stalled native model request is cancelled and exported as timeout', { timeout: 65000 }, async t => {
  const { report, mainRequests } = await runCase(t, { stall: true });
  assert.equal(report.status, 'timeout');
  assert.equal(mainRequests, 1);
  if (report.end !== null) assert.equal(report.end.kind, 'aborted');
  else assert.ok(report.nativeErrors.some(error => error.message.includes('turn/end') && error.message.includes('non-JSON-serializable')), 'a missing native end must be explained, never fabricated');
});

test('nested background native grandchildren finish before trajectory export and shutdown', { timeout: 65000 }, async t => {
  const { report } = await runCase(t, { nested: true });
  assert.equal(report.status, 'completed');
  assert.equal(report.agents.length, 3);
  const root = report.agents.find(agent => !agent.parentSession);
  const child = report.agents.find(agent => agent.parentSession === root.id);
  const grandchild = report.agents.find(agent => agent.parentSession === child.id);
  assert.equal(grandchild.steps, 2);
  const grandchildTrace = await readFile(grandchild.trajectory, 'utf8');
  assert.ok(grandchildTrace.includes('grandchild-write'));
  assert.ok(grandchildTrace.includes('Verified native ColdX completion.'));
});

test('explicit Chromium cache survives the isolated HOME and launches the real native browser', { timeout: 65000, skip: !browserArgs.length }, async t => {
  const { report, requests, uploadedImages } = await runCase(t, { browser: true });
  assert.equal(report.status, 'completed');
  assert.equal(report.configuration.browserRuntime.available, true);
  assert.equal(report.configuration.browserRuntime.browsersPath, await import('node:fs/promises').then(fs => fs.realpath(process.env.COLDX_EVAL_TEST_BROWSERS_PATH)));
  const trace = await readFile(report.trajectory, 'utf8');
  assert.ok(trace.includes('Page Title: ColdX isolated browser fixture'), 'Native browser must observe the fixture title');
  assert.ok(uploadedImages.size > 0, 'Pinned DeepSeek Files API must receive the actual screenshot bytes');
  const first = [...uploadedImages.values()][0];
  assert.deepEqual([...first.image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(requests.some(({ body }) => JSON.stringify(body.messages).includes(first.metadata.id)), 'Screenshot file ID must reach the native multimodal request, not only a local file link');
});

test('real browser screenshots cross both evaluation proxies before the native model resumes', { timeout: 65000, skip: !browserArgs.length }, async t => {
  const { report, requests, uploadedImages, sessionReport, relayStats } = await runCase(t, { browser: true, session: true });
  assert.equal(report.status, 'completed');
  assert.equal(sessionReport.status, 'completed');
  assert.equal(sessionReport.credentialBoundary.upstreamCredentialKind, 'relay-token');
  assert.ok(uploadedImages.size > 0);
  assert.equal(sessionReport.transport.files.successfulUploads, uploadedImages.size);
  assert.equal(relayStats.files.successfulUploads, uploadedImages.size);
  assert.ok(requests.some(({ body }) => JSON.stringify(body.messages).includes([...uploadedImages.keys()][0])));
  if (process.platform === 'linux') assert.equal(sessionReport.processCleanup.confirmed, true);
});

test('native bash retains official worker limits in its real subprocess', { timeout: 65000, skip: process.platform !== 'linux' }, async t => {
  const { report, root } = await runCase(t, { shell: true, session: true });
  assert.equal(report.status, 'completed');
  const child = JSON.parse(await readFile(join(root, 'workspace', 'child-environment.json'), 'utf8'));
  const expected = isolatedExecutionEnvironment(process.env);
  for (const key of ['GOMAXPROCS', 'CARGO_BUILD_JOBS', 'NEXTEST_TEST_THREADS', 'PYTEST_XDIST_AUTO_NUM_WORKERS', 'NODE_OPTIONS']) assert.equal(child.env[key], expected[key] ?? null, `${key} must survive the native shell boundary`);
  if (expected.GOMAXPROCS) {
    assert.equal(child.cpus, Number(expected.GOMAXPROCS));
    assert.equal(child.availableParallelism, Number(expected.GOMAXPROCS));
    assert.equal(report.configuration.processParallelism.cpus, Number(expected.GOMAXPROCS));
    assert.equal(report.configuration.processParallelism.availableParallelism, Number(expected.GOMAXPROCS));
  }
  assert.ok((await readFile(report.trajectory, 'utf8')).includes('NATIVE_BASH_ENVIRONMENT_OBSERVED'));
});
