#!/usr/bin/env node
// Evaluation transport around the actual ColdX driver. This is not an agent loop.
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { finished } from 'node:stream/promises';
import { createEvaluationProxy } from './evaluation-proxy.mjs';
import { createEvaluationDispatcher } from './evaluation-dispatcher.mjs';
import { requireOwnedGroup, terminateOwnedMembers } from './linux-process-group.mjs';
import { isolatedExecutionEnvironment, cpuClampConfiguration } from './execution-environment.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const transportErrorFields = ['timedOutRequests', 'transportErrors', 'upstreamHttpErrors', 'refusedRedirects'];
const hasTransportErrors = stats => transportErrorFields.some(name => (stats[name] ?? 0) > 0) || (stats.files?.failures ?? 0) > 0;

export function classifySessionOutcome({ stopReason = null, stats = {}, native = null, exit = null }) {
  if (stopReason === 'wall-timeout') return 'timeout';
  if (stopReason === 'signal') return 'interrupted';
  if (stopReason === 'logging-error') return 'driver-error';
  if ((stats.budgetExhaustedRequests ?? 0) > 0 || (stats.files?.budgetExhaustedRequests ?? 0) > 0) return 'request-budget-exhausted';
  if (!native?.status || !exit || exit.signal || !Number.isInteger(exit.code)) return 'driver-error';
  const expectedExit = { completed: 0, 'step-limit': 2, timeout: 1 }[native.status];
  if (expectedExit !== undefined && exit.code !== expectedExit) return 'driver-error';
  if (native.status === 'completed' && native.nativeErrors?.length) return 'native-error';
  if ((stats.activeRequests ?? 0) > 0) return 'transport-error';
  // Native retry belongs to the product loop. A past 429/5xx must not erase a
  // later normal completion, nor convert an official step/time budget into an
  // infrastructure failure. All error counters remain in the report.
  if (['completed', 'step-limit', 'timeout'].includes(native.status)) return native.status;
  if (hasTransportErrors(stats)) return 'transport-error';
  return native.status;
}

export function describeTransportOutcome(status, stats = {}) {
  const errors = hasTransportErrors(stats);
  return {
    state: !errors ? 'no-recorded-errors' : status === 'completed' ? 'completed-after-errors'
      : ['step-limit', 'timeout'].includes(status) ? 'budget-ended-after-errors' : 'failed-with-errors',
    errorCounters: { ...Object.fromEntries(transportErrorFields.map(name => [name, stats[name] ?? 0])), fileOperationFailures: stats.files?.failures ?? 0 },
    note: 'Historical counters are not reset. Normal native completion establishes final recovery of the task run, not that every auxiliary error was retried. Runtime status never substitutes for the official verifier reward; missing token usage remains missing.',
  };
}

export function environmentProxyConfiguration(env, execArgv) {
  return {
    requestedEnabled: env.NODE_USE_ENV_PROXY === '1' || execArgv.includes('--use-env-proxy') || /(?:^|\s|["'])--use-env-proxy(?=$|\s|["'])/.test(env.NODE_OPTIONS ?? ''),
    httpProxyConfigured: Boolean(env.HTTP_PROXY || env.http_proxy),
    httpsProxyConfigured: Boolean(env.HTTPS_PROXY || env.https_proxy),
    noProxyConfigured: Boolean(env.NO_PROXY || env.no_proxy),
    effectiveRoutingVerified: false,
    validation: 'Configuration presence only; effective Linux/Pier egress routing has not been validated by this launcher.',
  };
}

async function main() {
  const { values } = parseArgs({ options: Object.fromEntries([
    'source', 'workspace', 'output', 'task-file', 'max-steps', 'max-requests', 'timeout-ms', 'request-timeout-ms', 'playwright-browsers-path', 'undici-module',
  ].map(name => [name, { type: 'string' }])) });
  function number(name, fallback) {
    const raw = values[name] ?? String(fallback);
    const result = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(result) || result < 1) throw new Error('Invalid --' + name);
    return result;
  }

  let proxy;
  let child;
  let childExitPromise;
  let output;
  let outputCreated = false;
  let timer;
  let stopReason = null;
  let limits = null;
  let exit = null;
  let cpuClamp = null;
  let ownedGroup = null;
  let cleanupPromise;
  const processCleanup = { isolatedLinuxGroup: false, confirmed: false };
  const startedAt = new Date().toISOString();
  const environmentProxy = environmentProxyConfiguration(process.env, process.execArgv);
  const credentialKind = process.env.COLDX_EVAL_UPSTREAM_CREDENTIAL_KIND ?? 'provider-key';
  const cleanup = () => cleanupPromise ??= (async () => {
    if (ownedGroup) await terminateOwnedMembers(ownedGroup);
    else if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    processCleanup.confirmed = process.platform === 'linux' ? Boolean(ownedGroup) : false;
  })();
  const stop = () => { stopReason ??= 'signal'; cleanup().catch(() => { processCleanup.confirmed = false; }); };

  async function saveReport(status, native = null, failureCode = null) {
    const report = {
      schema: 'coldx-evaluation-session-v1', status, startedAt, finishedAt: new Date().toISOString(), exit,
      measuredBenchmarkReward: null,
      note: 'Completion is a runtime state, not a task score. Only the official verifier can award a reward.',
      nativeReport: native ? 'native/report.json' : null,
      transport: proxy?.getStats() ?? null,
      transportOutcome: describeTransportOutcome(status, proxy?.getStats() ?? {}),
      limits,
      stopReason,
      failureCode,
      processCleanup,
      cpuClamp,
      environmentProxyEnabled: environmentProxy.requestedEnabled,
      environmentProxy,
      tokenAccounting: proxy?.getStats()?.tokenAccounting ?? {
        source: 'native/report.json usage: native assistant/message events across task agents only',
        auxiliaryProviderTokens: 'not collected by the transport proxy',
        complete: false,
        costComputed: false,
        note: 'Transport counts requests and parameter overrides, not tokens. Title, compaction and other auxiliary token usage is not accounted for.',
      },
      credentialBoundary: {
        nativeChildEnvironment: 'local proxy bearer token only; upstream key and egress credentials are not inherited',
        upstreamCredentialKind: credentialKind,
        upstreamKeyProcess: credentialKind === 'relay-token' ? 'external-relay; deployment isolation must be verified separately' : 'session launcher',
        osProcessIsolationVerified: false,
        note: 'Environment inheritance isolation is not an OS security boundary. A task sharing access to the launcher process may read its credentials. Separate the credential-bearing proxy from task process access before a Linux/Pier evaluation.',
      },
      identity: native?.identity ?? null,
    };
    await writeFile(join(output, 'session-report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status, report: join(output, 'session-report.json'), forwardedRequests: report.transport?.forwardedRequests ?? 0 }));
  }

  try {
    if (!['provider-key', 'relay-token'].includes(credentialKind)) throw new Error('Invalid explicit upstream credential kind');
    if (process.platform === 'linux') {
      ownedGroup = await requireOwnedGroup(process.pid, fileURLToPath(import.meta.url));
      processCleanup.isolatedLinuxGroup = true;
    }
    for (const name of ['source', 'workspace', 'output', 'task-file']) if (!values[name]) throw new Error('Missing --' + name);
    const upstreamBaseUrl = process.env.COLDX_EVAL_UPSTREAM_BASE_URL;
    const apiKey = process.env.COLDX_EVAL_UPSTREAM_API_KEY;
    if (!upstreamBaseUrl || !apiKey) throw new Error('Explicit upstream URL and key are required.');
    const maxSteps = number('max-steps', 500);
    // A probe safeguard, independently recorded; NOT the native per-agent step limit.
    const maxRequests = number('max-requests', 500);
    const timeoutMs = number('timeout-ms', 10_800_000);
    const requestTimeoutMs = number('request-timeout-ms', timeoutMs);
    limits = { maxStepsPerAgent: maxSteps, maxRequestsAllCalls: maxRequests, timeoutMs, requestTimeoutMs, shutdownGraceMs: 30_000 };
    const undiciModulePath = values['undici-module'] ?? process.env.COLDX_EVAL_UNDICI_MODULE;
    if (environmentProxy.requestedEnabled && !undiciModulePath) throw new Error('Pier egress requires the explicit locked Undici dispatcher module.');
    const dispatcher = undiciModulePath ? await createEvaluationDispatcher({ modulePath: resolve(undiciModulePath),
      timeoutMs: requestTimeoutMs, useEnvironmentProxy: environmentProxy.requestedEnabled }) : null;
    proxy = createEvaluationProxy({ upstreamBaseUrl, apiKey, maxRequests, timeoutMs: requestTimeoutMs, dispatcher });
    output = resolve(values.output);
    // An existing trial directory must never be overwritten, including on failure.
    await mkdir(output);
    outputCreated = true;
    await proxy.listen();
    const stdout = createWriteStream(join(output, 'native-stdout.log'), { flags: 'wx' });
    const stderr = createWriteStream(join(output, 'native-stderr.log'), { flags: 'wx' });
    // Observe stream failures immediately, before a late await could cause an unhandled rejection.
    const logsFinished = Promise.all([finished(stdout), finished(stderr)]).catch(() => {
      stopReason ??= 'logging-error';
      cleanup().catch(() => { processCleanup.confirmed = false; });
    });
    const env = isolatedExecutionEnvironment(process.env);
    cpuClamp = cpuClampConfiguration(env);
    // The native process gets only an ephemeral local token, never the upstream key or egress credentials.
    env.COLDX_EVAL_API_KEY = proxy.downstreamToken;
    const args = [join(directory, 'run-native.mjs'), '--source', resolve(values.source), '--workspace', resolve(values.workspace),
      '--output', join(output, 'native'), '--task-file', resolve(values['task-file']), '--base-url', proxy.baseUrl,
      '--max-steps', String(maxSteps), '--timeout-ms', String(timeoutMs)];
    if (values['playwright-browsers-path']) args.push('--playwright-browsers-path', resolve(values['playwright-browsers-path']));
    child = spawn(process.execPath, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    // Native cancellation gets thirty seconds before the final process deadline.
    timer = setTimeout(() => { stopReason ??= 'wall-timeout'; cleanup().catch(() => { processCleanup.confirmed = false; }); }, timeoutMs + limits.shutdownGraceMs);
    childExitPromise = new Promise((resolveExit, reject) => {
      child.once('error', reject);
      // 'close' can wait forever when an orphaned shell still holds stdout.
      // Keep this launcher alive as the group owner until those tools stop.
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
    });
    exit = await childExitPromise;
    clearTimeout(timer);
    await cleanup();
    await logsFinished;
    await proxy.close();
    const stats = proxy.getStats();
    const native = await readFile(join(output, 'native', 'report.json'), 'utf8').then(JSON.parse).catch(() => null);
    const status = classifySessionOutcome({ stopReason, stats, native, exit });
    await saveReport(status, native);
    process.exitCode = status === 'completed' ? 0 : status === 'step-limit' ? 2 : 1;
  } catch {
    await cleanup().catch(() => { processCleanup.confirmed = false; });
    if (childExitPromise) exit = await childExitPromise.catch(() => null);
    await proxy?.close();
    // Do not serialize exception text: dependencies can include credentials in diagnostics.
    if (outputCreated) {
      await saveReport('driver-error', null, 'session_setup_or_io_error').catch(() => {
        console.error('ColdX evaluation session: could not persist the failure report.');
      });
    } else console.error('ColdX evaluation session: invalid explicit configuration or output directory; no existing output was modified.');
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await proxy?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('ColdX evaluation session: invalid command arguments or unexpected launcher failure.');
    process.exitCode = 1;
  });
}
