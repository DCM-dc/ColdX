import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Reuse the operator's locked Undici module; never install or infer a floating dependency. */
export async function createEvaluationDispatcher({ modulePath, timeoutMs, connectTimeoutMs = 30_000,
  useEnvironmentProxy = false, environment = process.env } = {}) {
  if (!isAbsolute(modulePath ?? '')) throw new Error('An explicit absolute locked Undici index.js path is required.');
  for (const value of [timeoutMs, connectTimeoutMs]) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Explicit positive dispatcher timeouts required.');
  const url = pathToFileURL(modulePath);
  const imported = await import(url.href);
  const { Agent, EnvHttpProxyAgent } = imported.default ?? imported;
  if (typeof Agent !== 'function' || typeof EnvHttpProxyAgent !== 'function') throw new Error('Locked module lacks required Undici dispatchers.');
  const version = JSON.parse(await readFile(new URL('./package.json', url), 'utf8')).version;
  if (!/^7\.\d+\.\d+$/.test(version ?? '')) throw new Error('This transport was validated with locked Undici 7.x.');
  const options = { headersTimeout: timeoutMs, bodyTimeout: timeoutMs, connect: { timeout: connectTimeoutMs },
    proxyTunnel: false };
  const httpProxy = environment.http_proxy ?? environment.HTTP_PROXY ?? '';
  const httpsProxy = environment.https_proxy ?? environment.HTTPS_PROXY ?? httpProxy;
  const noProxy = environment.no_proxy ?? environment.NO_PROXY ?? '';
  const dispatcher = useEnvironmentProxy ? new EnvHttpProxyAgent({ ...options, httpProxy, httpsProxy, noProxy }) : new Agent(options);
  Object.defineProperty(dispatcher, 'evaluationMetadata', { value: Object.freeze({
    implementation: useEnvironmentProxy ? 'Undici.EnvHttpProxyAgent' : 'Undici.Agent',
    nodeVersion: process.version, undiciVersion: version, explicitConfiguration: true,
    headersTimeoutMs: timeoutMs, bodyTimeoutMs: timeoutMs, connectTimeoutMs, proxyTunnel: false,
    httpProxyConfigured: useEnvironmentProxy && Boolean(httpProxy),
    httpsProxyConfigured: useEnvironmentProxy && Boolean(httpsProxy), noProxyConfigured: useEnvironmentProxy && Boolean(noProxy),
    note: 'HTTP uses forward-proxy requests; HTTPS still uses CONNECT. Connect timeout only bounds network establishment. No URL or credential is recorded.',
  }), enumerable: false });
  return dispatcher;
}
