import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifySessionOutcome, describeTransportOutcome, environmentProxyConfiguration } from './run-session.mjs';
import { isolatedExecutionEnvironment } from './execution-environment.mjs';
const directory = dirname(fileURLToPath(import.meta.url));
const source = process.env.COLDX_EVAL_TEST_SOURCE;
if (!source) throw new Error('Set COLDX_EVAL_TEST_SOURCE to the ColdX source checkout.');
const browserArgs = process.env.COLDX_EVAL_TEST_BROWSERS_PATH ? ['--playwright-browsers-path', process.env.COLDX_EVAL_TEST_BROWSERS_PATH] : [];
const detached = process.platform === 'linux';

test('native environment retains the official CPU clamp without inheriting arbitrary preload or credentials', () => {
  const official = { GOMAXPROCS: '2', CARGO_BUILD_JOBS: '2', NEXTEST_TEST_THREADS: '2', PYTEST_XDIST_AUTO_NUM_WORKERS: '2', NODE_OPTIONS: '--require /opt/pier-node-cpu-clamp.js' };
  assert.deepEqual(isolatedExecutionEnvironment({ ...official, HOME: '/private', HTTPS_PROXY: 'secret', COLDX_EVAL_UPSTREAM_API_KEY: 'secret' }), official);
  assert.deepEqual(isolatedExecutionEnvironment({ NODE_OPTIONS: '--import /private/module.mjs' }), {});
  assert.throws(() => isolatedExecutionEnvironment({ ...official, NODE_OPTIONS: '--require /opt/pier-node-cpu-clamp.js --import /private/module.mjs' }), /exact read-only preload/);
  assert.throws(() => isolatedExecutionEnvironment({ ...official, GOMAXPROCS: '4' }), /consistent/);
});

test('session completion requires a successful process exit and no recorded native errors', () => {
  const native = { status: 'completed', nativeErrors: [] };
  assert.equal(classifySessionOutcome({ native, exit: { code: 0, signal: null }, stats: {} }), 'completed');
  assert.equal(classifySessionOutcome({ native, exit: { code: 1, signal: null }, stats: {} }), 'driver-error');
  assert.equal(classifySessionOutcome({ native, exit: { code: null, signal: 'SIGTERM' }, stats: {} }), 'driver-error');
  assert.equal(classifySessionOutcome({ native: { ...native, nativeErrors: [{ name: 'Error' }] }, exit: { code: 0, signal: null }, stats: {} }), 'native-error');
  assert.equal(classifySessionOutcome({ native: null, exit: { code: 0, signal: null }, stats: {} }), 'driver-error');
});

test('request caps, native step caps, transport failure and wall timeout remain distinct non-success states', () => {
  const base = { native: { status: 'completed' }, exit: { code: 0, signal: null }, stats: {} };
  assert.equal(classifySessionOutcome({ ...base, stats: { budgetExhaustedRequests: 1 } }), 'request-budget-exhausted');
  assert.equal(classifySessionOutcome({ ...base, stats: { files: { budgetExhaustedRequests: 1 } } }), 'request-budget-exhausted');
  assert.equal(classifySessionOutcome({ ...base, native: { status: 'error' }, exit: { code: 1, signal: null }, stats: { upstreamHttpErrors: 1 } }), 'transport-error');
  assert.equal(classifySessionOutcome({ ...base, native: { status: 'step-limit' }, exit: { code: 2, signal: null } }), 'step-limit');
  assert.equal(classifySessionOutcome({ ...base, stopReason: 'wall-timeout' }), 'timeout');
  assert.equal(classifySessionOutcome({ ...base, stopReason: 'signal' }), 'interrupted');
  assert.equal(classifySessionOutcome({ ...base, stopReason: 'logging-error' }), 'driver-error');
});

test('historical transport errors remain visible after recovery without overriding terminal failures or official budgets', () => {
  const stats = { upstreamHttpErrors: 2, transportErrors: 1, activeRequests: 0, files: { failures: 1 } };
  const completed = { stats, native: { status: 'completed', nativeErrors: [] }, exit: { code: 0, signal: null } };
  assert.equal(classifySessionOutcome(completed), 'completed');
  const recovered = describeTransportOutcome('completed', stats);
  assert.equal(recovered.state, 'completed-after-errors');
  assert.equal(recovered.errorCounters.upstreamHttpErrors, 2);
  assert.equal(recovered.errorCounters.fileOperationFailures, 1);
  assert.equal(classifySessionOutcome({ ...completed, exit: { code: 1, signal: null } }), 'driver-error');
  assert.equal(classifySessionOutcome({ ...completed, native: { status: 'completed', nativeErrors: [{ name: 'LlmError' }] } }), 'native-error');
  assert.equal(classifySessionOutcome({ ...completed, stats: { ...stats, activeRequests: 1 } }), 'transport-error');
  assert.equal(classifySessionOutcome({ ...completed, native: { status: 'error' }, exit: { code: 1, signal: null } }), 'transport-error');
  assert.equal(classifySessionOutcome({ ...completed, native: null }), 'driver-error');
  assert.equal(classifySessionOutcome({ ...completed, native: { status: 'step-limit' }, exit: { code: 7, signal: null } }), 'driver-error');
  assert.equal(classifySessionOutcome({ ...completed, native: { status: 'timeout' }, exit: { code: 0, signal: null } }), 'driver-error');
  for (const status of ['step-limit', 'timeout']) {
    assert.equal(classifySessionOutcome({ ...completed, native: { status }, exit: { code: status === 'timeout' ? 1 : 2, signal: null } }), status);
    assert.equal(describeTransportOutcome(status, stats).state, 'budget-ended-after-errors');
  }
});

test('environment proxy reporting recognizes NODE_OPTIONS without recording proxy credentials or claiming Pier verification', () => {
  const config = environmentProxyConfiguration({ NODE_OPTIONS: '--use-env-proxy', HTTPS_PROXY: 'http://user:SYNTHETIC_PROXY_SECRET@127.0.0.1:1234', NO_PROXY: 'localhost,127.0.0.1' }, []);
  assert.equal(config.requestedEnabled, true);
  assert.equal(config.httpsProxyConfigured, true);
  assert.equal(config.noProxyConfigured, true);
  assert.equal(config.effectiveRoutingVerified, false);
  assert.ok(!JSON.stringify(config).includes('SYNTHETIC_PROXY_SECRET'));
});

test('an invalid native source yields an unscored driver-error report, while an existing output remains untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coldx-eval-failure-report-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  await writeFile(join(root, 'task.txt'), 'Synthetic setup failure only.');
  const output = join(root, 'run');
  const env = { ...isolatedExecutionEnvironment(process.env), COLDX_EVAL_UPSTREAM_API_KEY: 'SYNTHETIC_NO_NETWORK_KEY', COLDX_EVAL_UPSTREAM_BASE_URL: 'http://127.0.0.1:1' };
  async function launch() {
    const child = spawn(process.execPath, [join(directory, 'run-session.mjs'), '--source', join(root, 'missing-source'), '--workspace', workspace,
      '--output', output, '--task-file', join(root, 'task.txt'), ...browserArgs], { env, detached, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let log = '';
    child.stdout.on('data', chunk => log += chunk);
    child.stderr.on('data', chunk => log += chunk);
    const code = await new Promise(resolve => child.once('close', resolve));
    assert.equal(code, 1);
    assert.ok(!log.includes(env.COLDX_EVAL_UPSTREAM_API_KEY));
  }
  await launch();
  const reportPath = join(output, 'session-report.json');
  const before = await readFile(reportPath, 'utf8');
  const report = JSON.parse(before);
  assert.equal(report.status, 'driver-error');
  assert.equal(report.measuredBenchmarkReward, null);
  assert.equal(report.transport.forwardedRequests, 0);
  await launch();
  assert.equal(await readFile(reportPath, 'utf8'), before);
});

test('native ColdX plus forwarding proxy enforces official wire parameters and keeps output unscored', { timeout: 65000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'coldx-eval-synthetic-integration-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  await writeFile(join(root, 'task.txt'), 'Synthetic transport integration only. Say SYNTHETIC_OK, then finish.');
  const requests = [];
  const upstream = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(raw) });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'synthetic', choices: [{ index: 0, delta: { content: 'SYNTHETIC_OK' }, finish_reason: null }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => upstream.close());
  const env = isolatedExecutionEnvironment(process.env);
  const syntheticToken = 'SYNTHETIC_UPSTREAM_TOKEN_NOT_A_REAL_KEY';
  Object.assign(env, { COLDX_EVAL_UPSTREAM_API_KEY: syntheticToken, COLDX_EVAL_UPSTREAM_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1` });
  const output = join(root, 'run');
  const child = spawn(process.execPath, [join(directory, 'run-session.mjs'), '--source', source, '--workspace', workspace,
    '--output', output, '--task-file', join(root, 'task.txt'), '--timeout-ms', '45000', ...browserArgs], { env, detached, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  child.stdout.on('data', data => log += data);
  child.stderr.on('data', data => log += data);
  const timer = setTimeout(() => child.kill(), 60000);
  const code = await new Promise(resolve => child.once('close', resolve));
  clearTimeout(timer);
  assert.equal(code, 0, `${root}\n${log}`);
  assert.ok(requests.length >= 1);
  for (const request of requests) {
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.authorization, `Bearer ${syntheticToken}`);
    assert.equal(request.body.model, 'deepseek-flash');
    assert.equal(request.body.reasoning_effort, 'max');
    assert.equal(request.body.temperature, 1);
    assert.equal(request.body.top_p, 0.95);
  }
  const report = JSON.parse(await readFile(join(output, 'session-report.json'), 'utf8'));
  assert.equal(report.status, 'completed');
  assert.equal(report.measuredBenchmarkReward, null);
  assert.equal(report.transport.forwardedRequests, requests.length);
  assert.equal(report.transport.activeRequests, 0);
  assert.equal(report.identity.preset, 'coldx');
  assert.equal(report.tokenAccounting.complete, true);
  assert.equal(report.tokenAccounting.accountedRequests, requests.length);
  assert.equal(report.tokenAccounting.totals.promptTokens, 12 * requests.length);
  assert.equal(report.tokenAccounting.cost, null);
  assert.equal(report.environmentProxy.effectiveRoutingVerified, false);
  assert.equal(report.credentialBoundary.osProcessIsolationVerified, false);
  for (const relative of ['session-report.json', 'native-stdout.log', 'native-stderr.log', 'native/request.json', 'native/evaluation.patch.json', 'native/report.json']) {
    assert.ok(!(await readFile(join(output, relative), 'utf8')).includes(syntheticToken), `Upstream token persisted in ${relative}`);
  }
  assert.ok(!log.includes(syntheticToken));
});

test('an upstream 401 echoing its key remains an unscored transport error and no native artifact contains that key', { timeout: 65000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'coldx-eval-redacted-error-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  await writeFile(join(root, 'task.txt'), 'Synthetic authentication error test; no real model is used.');
  const syntheticToken = 'SYNTHETIC_401_UPSTREAM_KEY_MUST_NEVER_REACH_NATIVE';
  let requests = 0;
  const upstream = createServer(async (req, res) => {
    for await (const _chunk of req) { /* Discard synthetic request. */ }
    requests++;
    res.writeHead(401, { 'content-type': 'text/html', 'retry-after': syntheticToken });
    res.end('<html>Incorrect API key provided: ' + syntheticToken + '</html>');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const env = isolatedExecutionEnvironment(process.env);
  Object.assign(env, { COLDX_EVAL_UPSTREAM_API_KEY: syntheticToken, COLDX_EVAL_UPSTREAM_BASE_URL: 'http://127.0.0.1:' + upstream.address().port });
  const output = join(root, 'run');
  const child = spawn(process.execPath, [join(directory, 'run-session.mjs'), '--source', source, '--workspace', workspace,
    '--output', output, '--task-file', join(root, 'task.txt'), '--timeout-ms', '15000', '--max-requests', '10', ...browserArgs], { env, detached, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  child.stdout.on('data', data => log += data);
  child.stderr.on('data', data => log += data);
  const timer = setTimeout(() => child.kill(), 60000);
  t.after(() => { clearTimeout(timer); child.kill(); });
  const code = await new Promise(resolve => child.once('close', resolve));
  clearTimeout(timer);
  assert.notEqual(code, 0, log);
  assert.ok(requests > 0);
  const report = JSON.parse(await readFile(join(output, 'session-report.json'), 'utf8'));
  assert.equal(report.status, 'transport-error');
  assert.equal(report.measuredBenchmarkReward, null);
  assert.ok(report.transport.upstreamHttpErrors > 0);
  assert.ok(!log.includes(syntheticToken));
  let checkedFiles = 0;
  async function scan(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await scan(path);
      else if (entry.isFile()) {
        checkedFiles++;
        assert.ok(!(await readFile(path)).includes(Buffer.from(syntheticToken)), 'Upstream key persisted in ' + path);
      }
      // Symlinked runtime dependencies are not evaluation outputs.
    }
  }
  await scan(output);
  assert.ok(checkedFiles >= 6);
  t.diagnostic('Synthetic key-echo isolation evidence: ' + root);
});

test('the native retry loop recovers from a real 503 while retaining its error and incomplete usage coverage', { timeout: 65000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'coldx-eval-recovered-503-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  await writeFile(join(root, 'task.txt'), 'Synthetic retry test. Reply SYNTHETIC_RECOVERED, then finish.');
  let taskRequests = 0;
  const upstream = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (body.tools?.length && ++taskRequests === 1) {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { type: 'server_error', message: 'Synthetic temporary failure' } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'synthetic-recovery', choices: [{ index: 0, delta: { content: 'SYNTHETIC_RECOVERED' }, finish_reason: null }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const env = { ...isolatedExecutionEnvironment(process.env), COLDX_EVAL_UPSTREAM_API_KEY: 'SYNTHETIC_RETRY_KEY', COLDX_EVAL_UPSTREAM_BASE_URL: `http://127.0.0.1:${upstream.address().port}` };
  const output = join(root, 'run');
  const child = spawn(process.execPath, [join(directory, 'run-session.mjs'), '--source', source, '--workspace', workspace,
    '--output', output, '--task-file', join(root, 'task.txt'), '--timeout-ms', '45000', ...browserArgs], { env, detached, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  child.stdout.on('data', chunk => log += chunk);
  child.stderr.on('data', chunk => log += chunk);
  const timer = setTimeout(() => child.kill(), 60000);
  t.after(() => { clearTimeout(timer); child.kill(); });
  const code = await new Promise(resolve => child.once('close', resolve));
  clearTimeout(timer);
  assert.equal(code, 0, `${root}\n${log}`);
  assert.ok(taskRequests >= 2, 'Recovery must occur in the native retry loop');
  const report = JSON.parse(await readFile(join(output, 'session-report.json'), 'utf8'));
  assert.equal(report.status, 'completed');
  assert.equal(report.measuredBenchmarkReward, null);
  assert.equal(report.transport.upstreamHttpErrors, 1);
  assert.equal(report.transportOutcome.state, 'completed-after-errors');
  assert.equal(report.transportOutcome.errorCounters.upstreamHttpErrors, 1);
  assert.equal(report.tokenAccounting.complete, false);
  assert.equal(report.tokenAccounting.missingUsageRequests, 1);
  const native = JSON.parse(await readFile(join(output, 'native', 'report.json'), 'utf8'));
  assert.equal(native.visibleResult, 'SYNTHETIC_RECOVERED');
  assert.deepEqual(native.nativeErrors, []);
  t.diagnostic('Real native retry against synthetic HTTP evidence: ' + root);
});
