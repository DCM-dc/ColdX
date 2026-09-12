import { spawn } from 'node:child_process';
import { get } from 'node:http';
import { delimiter, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const DEFAULT_TIMEOUT_MS = 60_000;
const LOG_TAIL_CHARS = 16_000;
const SHUTDOWN_MESSAGE = Object.freeze({ type: 'coldx:shutdown' });
// The pinned native CLI announces its own Web listener with this exact prefix.
// Plugin previews may also print local URLs and must never become the app window.
const LOOPBACK_URL = /(?:^|\n)dsh web: http:\/\/127\.0\.0\.1:(\d{1,5})\/?(?=\r?\n)/g;

function requiredPath(name, value) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty path`);
  return resolve(value);
}

function positiveTimeout(value) {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError('timeoutMs must be a positive number');
  return value;
}

function startupAbortError(signal) {
  const reason = signal?.reason;
  const error = new Error('ColdX backend startup was aborted.', reason instanceof Error ? { cause: reason } : undefined);
  error.name = 'AbortError';
  return error;
}

function validAbortSignal(signal) {
  return signal === undefined || (signal && typeof signal.aborted === 'boolean'
    && typeof signal.addEventListener === 'function' && typeof signal.removeEventListener === 'function');
}

function backendEnvironment(executable) {
  const environment = { ...process.env };
  const pathKeys = Object.keys(environment).filter(key => key.toLowerCase() === 'path');
  const pathKey = pathKeys[0] ?? 'PATH';
  const inheritedPath = pathKeys.map(key => environment[key]).find(Boolean);
  for (const key of pathKeys.slice(1)) delete environment[key];
  environment[pathKey] = [dirname(executable), inheritedPath].filter(Boolean).join(delimiter);
  return environment;
}

function readyUrlFrom(value) {
  let match;
  let candidate;
  LOOPBACK_URL.lastIndex = 0;
  while ((match = LOOPBACK_URL.exec(value))) {
    const port = Number(match[1]);
    if (port > 0 && port <= 65_535) candidate = `http://127.0.0.1:${port}/`;
  }
  return candidate;
}

function probeHttp(url, timeoutMs) {
  return new Promise(resolveProbe => {
    let settled = false;
    const settle = value => {
      if (settled) return;
      settled = true;
      resolveProbe(value);
    };
    const request = get(url, { headers: { connection: 'close' } }, response => {
      response.resume();
      settle(response.statusCode === 200);
    });
    request.once('error', () => settle(false));
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      settle(false);
    });
  });
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child, timeoutMs) {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise(resolveWait => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    const onExit = () => finish(true);
    function finish(exited) {
      clearTimeout(timer);
      child.off('exit', onExit);
      resolveWait(exited);
    }
    child.once('exit', onExit);
  });
}

async function terminateOwnedChild(child, gracefulMs) {
  if (!child.pid || hasExited(child)) return;
  if (child.connected) {
    try { child.send(SHUTDOWN_MESSAGE, () => {}); }
    catch { /* The fallback below owns termination when IPC already closed. */ }
  }
  if (await waitForExit(child, gracefulMs)) return;
  try { child.kill('SIGTERM'); } catch { /* It may have exited between the check and kill. */ }
  if (await waitForExit(child, 500)) return;
  try { child.kill('SIGKILL'); } catch { /* It may have exited between escalation steps. */ }
  await waitForExit(child, 1_000);
}

function outputDiagnostic(logTail) {
  const value = logTail.trim();
  return value ? `\nRecent backend output:\n${value}` : '';
}

function exitedDiagnostic(state, logTail) {
  if (state.error) return new Error(`ColdX backend failed to start: ${state.error.message}${outputDiagnostic(logTail)}`, { cause: state.error });
  const status = state.signal ? `signal ${state.signal}` : `code ${state.code}`;
  return new Error(`ColdX backend exited before becoming ready (${status}).${outputDiagnostic(logTail)}`);
}

/** Start the unpacked Node sidecar and return only after its loopback HTTP surface answers. */
export async function startBackend({
  nodePath,
  runtimeRoot,
  dataHome,
  workspace,
  onLog,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const executable = requiredPath('nodePath', nodePath);
  const runtime = requiredPath('runtimeRoot', runtimeRoot);
  const home = requiredPath('dataHome', dataHome);
  const cwd = requiredPath('workspace', workspace);
  const timeout = positiveTimeout(timeoutMs);
  if (onLog !== undefined && typeof onLog !== 'function') throw new TypeError('onLog must be a function');
  if (!validAbortSignal(signal)) throw new TypeError('signal must be an AbortSignal');
  if (signal?.aborted) throw startupAbortError(signal);

  const child = spawn(executable, [
    '--import', pathToFileURL(join(runtime, 'desktop', 'backend-entry.mjs')).href,
    join(runtime, 'bin', 'coldx-web.mjs'),
    '--home', home,
    '--cwd', cwd,
    '--port', '0',
    '--no-open',
  ], {
    cwd,
    env: backendEnvironment(executable),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  const terminal = { error: undefined, exited: false, code: undefined, signal: undefined };
  let searchableOutput = '';
  let logTail = '';
  let url;
  const record = stream => chunk => {
    const text = String(chunk);
    if (stream === 'stdout') searchableOutput = (searchableOutput + text).slice(-LOG_TAIL_CHARS);
    logTail = (logTail + `[${stream}] ${text}`).slice(-LOG_TAIL_CHARS);
    url ??= readyUrlFrom(searchableOutput);
    try { onLog?.({ stream, text }); } catch { /* Logging must not break lifecycle ownership. */ }
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', record('stdout'));
  child.stderr.on('data', record('stderr'));
  child.once('error', error => { terminal.error = error; });
  child.once('exit', (code, signal) => {
    terminal.exited = true;
    terminal.code = code;
    terminal.signal = signal;
  });

  const deadline = Date.now() + timeout;
  let aborted = false;
  const onAbort = () => { aborted = true; };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (Date.now() < deadline) {
      if (aborted) {
        await terminateOwnedChild(child, Math.max(100, Math.min(timeout, 2_000)));
        throw startupAbortError(signal);
      }
      if (terminal.error || terminal.exited) throw exitedDiagnostic(terminal, logTail);
      if (url) {
        const remaining = Math.max(1, deadline - Date.now());
        if (await probeHttp(url, Math.min(250, remaining))) {
          if (aborted) {
            await terminateOwnedChild(child, Math.max(100, Math.min(timeout, 2_000)));
            throw startupAbortError(signal);
          }
          if (terminal.error || terminal.exited) throw exitedDiagnostic(terminal, logTail);
          let stopping;
          return {
            url,
            child,
            stop() {
              stopping ??= terminateOwnedChild(child, Math.max(250, Math.min(timeout, 5_000)));
              return stopping;
            },
          };
        }
      }
      await delay(Math.min(40, Math.max(1, deadline - Date.now())));
    }

    await terminateOwnedChild(child, Math.max(100, Math.min(timeout, 2_000)));
    if (aborted) throw startupAbortError(signal);
    throw new Error(`ColdX backend did not become ready within ${timeout}ms.${outputDiagnostic(logTail)}`);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
