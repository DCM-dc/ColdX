#!/usr/bin/env node
// Run outside the task container/PID namespace. Does not read product credentials or start a model call.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createEvaluationProxy } from './evaluation-proxy.mjs';
import { createEvaluationDispatcher } from './evaluation-dispatcher.mjs';

export async function startExternalProxy({ upstreamBaseUrl, apiKey, output, advertisedBaseUrl,
  host = '127.0.0.1', port = 0, maxRequests = 500, timeoutMs = 180_000, pricing = null, flushIntervalMs = 2_000,
  undiciModulePath = null, useEnvironmentProxy = false } = {}) {
  const advertised = new URL(advertisedBaseUrl);
  if (!['http:', 'https:'].includes(advertised.protocol) || advertised.username || advertised.password
    || advertised.search || advertised.hash || advertised.pathname !== '/') throw new Error('advertisedBaseUrl must be an HTTP(S) origin');
  if (!Number.isSafeInteger(flushIntervalMs) || flushIntervalMs < 10) throw new Error('flushIntervalMs must be at least 10');
  const root = resolve(output);
  const dispatcher = undiciModulePath ? await createEvaluationDispatcher({ modulePath: undiciModulePath, timeoutMs, useEnvironmentProxy }) : null;
  const proxy = createEvaluationProxy({ upstreamBaseUrl, apiKey, host, port, maxRequests, timeoutMs, pricing, dispatcher });
  await mkdir(root, { mode: 0o700 }); // Never overwrite/reuse an old trial credential directory.
  let flushChain = Promise.resolve();
  let interval;
  let closePromise;
  const startedAt = new Date().toISOString();
  const report = (status) => ({
    schema: 'coldx-external-evaluation-proxy-v1', status, startedAt, updatedAt: new Date().toISOString(),
    processId: process.pid, credentialBoundary: 'upstream credential exists only in this external proxy process; downstream config holds a random proxy token',
    osIsolationVerified: false, advertisedEndpointReachabilityVerified: false,
    note: 'The launcher does not prove namespace/network isolation or API identity. Validate Linux/Pier routing before a benchmark. No prompt or response text is recorded here.',
    stats: proxy.getStats(),
  });
  function flush(status) {
    const operation = flushChain.then(async () => {
      const temporary = join(root, 'transport-report.pending.json');
      await writeFile(temporary, JSON.stringify(report(status), null, 2) + '\n', { mode: 0o600 });
      await rename(temporary, join(root, 'transport-report.json'));
    });
    flushChain = operation.catch(() => {});
    return operation;
  }
  const close = () => {
    if (closePromise) return closePromise;
    clearInterval(interval);
    closePromise = (async () => { await proxy.close(); await flush('stopped'); })();
    return closePromise;
  };
  try {
    await proxy.listen();
    await writeFile(join(root, 'downstream.private.json'), JSON.stringify({
      COLDX_EVAL_UPSTREAM_BASE_URL: advertised.origin,
      COLDX_EVAL_UPSTREAM_API_KEY: proxy.downstreamToken,
      COLDX_EVAL_UPSTREAM_CREDENTIAL_KIND: 'relay-token',
    }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await flush('running');
    interval = setInterval(() => {
      flush('running').catch(() => { void close().catch(() => {}); });
    }, flushIntervalMs);
    interval.unref();
    return { baseUrl: proxy.baseUrl, output: root, close, getStats: () => proxy.getStats() };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

async function main() {
  const { values } = parseArgs({ options: Object.fromEntries([
    'output', 'advertise-url', 'host', 'port', 'max-requests', 'timeout-ms', 'pricing-json', 'undici-module',
  ].map(name => [name, { type: 'string' }])) });
  for (const field of ['output', 'advertise-url']) if (!values[field]) throw new Error('Missing explicit external proxy configuration');
  if (!values['undici-module']) throw new Error('The external CLI requires an explicit locked Undici module.');
  function number(name, fallback) {
    if (values[name] === undefined) return fallback;
    if (!/^\d+$/.test(values[name])) throw new Error('Invalid number');
    return Number(values[name]);
  }
  const runtime = await startExternalProxy({
    upstreamBaseUrl: process.env.COLDX_EVAL_REAL_BASE_URL,
    apiKey: process.env.COLDX_EVAL_REAL_API_KEY,
    output: values.output, advertisedBaseUrl: values['advertise-url'],
    host: values.host ?? '127.0.0.1', port: number('port', 0),
    maxRequests: number('max-requests', 500), timeoutMs: number('timeout-ms', 180_000),
    pricing: values['pricing-json'] ? JSON.parse(await readFile(values['pricing-json'], 'utf8')) : null,
    undiciModulePath: values['undici-module'], useEnvironmentProxy: process.env.NODE_USE_ENV_PROXY === '1' || process.execArgv.includes('--use-env-proxy')
      || /(?:^|\s|["'])--use-env-proxy(?=$|\s|["'])/.test(process.env.NODE_OPTIONS ?? ''),
  });
  console.log(JSON.stringify({ event: 'coldx_external_proxy_ready', output: runtime.output, listening: runtime.baseUrl,
    note: 'Private downstream config contains only a generated proxy token. Do not print it.' }));
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await runtime.close();
    console.log(JSON.stringify({ event: 'coldx_external_proxy_stopped', stats: runtime.getStats() }));
  };
  process.once('SIGINT', () => { void stop().catch(() => { process.exitCode = 1; }); });
  process.once('SIGTERM', () => { void stop().catch(() => { process.exitCode = 1; }); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('External evaluation proxy could not start. Check explicit host/port, output, URL and credential inputs. No credential or provider error was printed.');
    process.exitCode = 1;
  });
}
