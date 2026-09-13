#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createEvaluationProxy } from './evaluation-proxy.mjs';
import { createEvaluationDispatcher } from './evaluation-dispatcher.mjs';

const result = { schema: 'coldx-pier-egress-probe-v1', mockOnly: true, measuredBenchmarkReward: null, checks: {} };
const digest = value => createHash('sha256').update(value).digest('hex');
const expectedDigest = process.env.COLDX_SMOKE_SENTINEL_SHA256;
let session;
let routing;
function check(name, condition) { result.checks[name] = Boolean(condition); assert.ok(condition, name); }
function directConnectionBlocked(host) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port: 80 });
    const finish = blocked => { socket.destroy(); resolve(blocked); };
    socket.once('connect', () => finish(false)); socket.once('error', () => finish(true)); socket.setTimeout(1500, () => finish(true));
  });
}
try {
  check('nodeEnvProxyEnabled', process.execArgv.includes('--use-env-proxy'));
  check('relayTokenIsNotProviderSentinel', digest(process.env.COLDX_EVAL_UPSTREAM_API_KEY) !== expectedDigest);
  let sentinelVisible = Object.values(process.env).some(value => digest(value) === expectedDigest);
  let examinedProcesses = 0;
  for (const pid of (await readdir('/proc')).filter(name => /^\d+$/.test(name))) {
    try {
      const env = (await readFile(`/proc/${pid}/environ`, 'utf8')).split('\0'); examinedProcesses++;
      sentinelVisible ||= env.some(pair => digest(pair.slice(pair.indexOf('=') + 1)) === expectedDigest);
    } catch { /* Short-lived or inaccessible process. */ }
  }
  result.examinedProcesses = examinedProcesses;
  check('providerSentinelAbsentFromTaskProcesses', !sentinelVisible);
  result.pidNamespace = await readlink('/proc/self/ns/pid');
  check('differentHostPidNamespace', result.pidNamespace !== process.env.COLDX_SMOKE_HOST_PID_NAMESPACE);
  check('dockerSocketAbsent', await access('/var/run/docker.sock').then(() => false, () => true));
  check('hostPrivateRelayPathAbsent', await access(process.env.COLDX_SMOKE_HOST_PRIVATE_PATH).then(() => false, () => true));
  const writeError = await writeFile('/opt/probe/readonly-marker.txt', 'overwrite').then(() => null, error => error.code);
  check('sourceMountIsReadOnly', writeError === 'EROFS');
  await writeFile('/logs/agent/smoke-log-write.txt', 'owned smoke output\n');
  check('defaultLogsRemainWritable', true);
  const bridge = new URL(process.env.COLDX_EVAL_UPSTREAM_BASE_URL).hostname;
  check('directHostRelayBlocked', await directConnectionBlocked(bridge));
  check('directInternetBlocked', await directConnectionBlocked('1.1.1.1'));
  routing = await createEvaluationDispatcher({ modulePath: '/opt/undici/index.js', timeoutMs: 10_800_000, useEnvironmentProxy: true });
  const denied = await fetch('http://1.1.1.1/', { signal: AbortSignal.timeout(5000), dispatcher: routing });
  await denied.body?.cancel();
  check('squidRejectsNonAllowlistedInternet', denied.status === 403);
  const arbitrary = await fetch(`${process.env.COLDX_EVAL_UPSTREAM_BASE_URL}/arbitrary-unavailable`, {
    headers: { authorization: `Bearer ${process.env.COLDX_EVAL_UPSTREAM_API_KEY}` }, signal: AbortSignal.timeout(5000), dispatcher: routing,
  });
  await arbitrary.body?.cancel(); check('relayRejectsArbitraryPath', arbitrary.status === 404);
  session = createEvaluationProxy({ upstreamBaseUrl: process.env.COLDX_EVAL_UPSTREAM_BASE_URL,
    apiKey: process.env.COLDX_EVAL_UPSTREAM_API_KEY, maxRequests: 4, timeoutMs: 10_800_000, dispatcher: routing });
  await session.listen();
  const headers = { authorization: `Bearer ${session.downstreamToken}` };
  const form = new FormData();
  form.set('purpose', 'user_data'); form.set('expires_after[anchor]', 'created_at'); form.set('expires_after[seconds]', '604800');
  form.set('file', new Blob(['mock-image-not-a-user-file'], { type: 'image/png' }), 'mock.png');
  const upload = await fetch(`${session.baseUrl}/files`, { method: 'POST', headers, body: form });
  check('nativeFileUploadAllowed', upload.status === 200); const file = await upload.json();
  const body = { stream: true, messages: [{ role: 'user', content: [{ type: 'file', file_id: file.id }] }] };
  const reply = await fetch(`${session.baseUrl}/chat/completions`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  check('modelPathAllowed', reply.status === 200); check('modelStreamComplete', (await reply.text()).includes('[DONE]'));
  const cancellation = new AbortController();
  const partial = await fetch(`${session.baseUrl}/chat/completions`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    signal: cancellation.signal, body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'cancel-probe' }] }) });
  await partial.body.getReader().read(); cancellation.abort(); await delay(300); await session.close();
  result.sessionStats = session.getStats();
  check('cancellationPropagatedFromLocalClient', result.sessionStats.clientCancelledRequests === 1);
  check('knownUsageRetained', result.sessionStats.tokenAccounting.totals.totalTokens === 35);
  check('cancelledUsageNotInvented', result.sessionStats.tokenAccounting.complete === false && result.sessionStats.tokenAccounting.missingUsageRequests === 1);
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.failureCode = error?.code ?? error?.name ?? 'probe-failure'; process.exitCode = 1;
} finally {
  await session?.close();
  if (!session) await routing?.close();
  console.log(JSON.stringify(result));
}
