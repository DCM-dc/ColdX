// Exercise the shipped browser driver, not a developer-installed Playwright.
// Usage: node scripts/desktop/browser-smoke.mjs [unpacked/resources/runtime]
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const script = fileURLToPath(import.meta.url);
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
const execFileAsync = promisify(execFile);

async function contained(root, path) {
  const resolved = await realpath(path);
  const part = relative(await realpath(root), resolved);
  assert.ok(part && !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`), `Path escapes packaged runtime: ${path}`);
  return resolved;
}

function isolatedEnvironment(runtime, sandbox) {
  // An allowlist prevents model credentials, Node preload hooks and user MCP
  // configuration from entering either the probe or the browser driver.
  const env = {};
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'PROCESSOR_ARCHITECTURE', 'LANG', 'LC_ALL']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const home = join(sandbox, 'home');
  return { ...env, CI: 'true', HOME: home, USERPROFILE: home,
    APPDATA: join(home, 'AppData/Roaming'), LOCALAPPDATA: join(home, 'AppData/Local'),
    XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
    DSH_HOME: join(home, 'dsh'), TMP: join(sandbox, 'tmp'), TEMP: join(sandbox, 'tmp'), TMPDIR: join(sandbox, 'tmp'),
    PATH: process.platform === 'win32' ? `${runtime};${join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')}` : `${runtime}:/usr/bin:/bin`,
    PLAYWRIGHT_BROWSERS_PATH: join(runtime, 'browsers'), PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' };
}

async function waitForExit(pid) {
  if (!pid) return;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await delay(100);
  }
  throw new Error(`Owned browser driver ${pid} remained after closing its MCP transport.`);
}

async function unixProcesses() {
  // Only ownership metadata, never command lines or user session contents.
  const { stdout } = await execFileAsync('/bin/ps', ['-A', '-o', 'pid=,ppid=,lstart='],
    { timeout: 3000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
  return new Map(stdout.trim().split('\n').map(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    assert.ok(match, 'Unable to parse process ownership metadata.');
    return [Number(match[1]), { parent: Number(match[2]), started: match[3] }];
  }));
}

function descendants(table, pid) {
  const owned = new Map();
  if (table.has(pid)) owned.set(pid, table.get(pid));
  for (const parent of owned.keys()) {
    for (const [candidate, info] of table) if (info.parent === parent) owned.set(candidate, info);
  }
  return owned;
}

async function terminateOwnedWorker(child, exited) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  // Chromium creates its own process group. Capture descendants before the
  // worker can exit and reparent them; do not assume kill(-worker.pid) owns it.
  const owned = process.platform === 'win32' ? null : descendants(await unixProcesses(), child.pid);
  if (child.connected) child.send({ type: 'coldx-browser-smoke-stop' }, () => {});
  if (process.platform !== 'win32') child.kill('SIGTERM');
  await Promise.race([exited, delay(8000)]);
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    // PID-scoped tree cleanup only; never terminate browsers by image name.
    await execFileAsync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
    await Promise.race([exited, delay(5000).then(() => { throw new Error('Owned smoke process tree did not stop.'); })]);
    return;
  }
  let current = await unixProcesses();
  for (const [pid, info] of [...owned]) {
    if (current.get(pid)?.started !== info.started) continue;
    for (const [descendant, details] of descendants(current, pid)) owned.set(descendant, details);
  }
  // Match start time too, so PID reuse never authorizes killing another task.
  for (const [pid, info] of [...owned].reverse()) {
    if (current.get(pid)?.started !== info.started) continue;
    try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    current = await unixProcesses();
    if (![...owned].some(([pid, info]) => current.get(pid)?.started === info.started)) return;
    await delay(100);
  }
  throw new Error('Owned browser descendants remained after timeout cleanup.');
}

async function probe(runtime, sandbox) {
  assert.equal(await realpath(process.execPath), await realpath(join(runtime, nodeName)), 'Probe must use bundled Node.');
  assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH, join(runtime, 'browsers'));
  const app = join(runtime, 'app');
  const appRequire = createRequire(join(app, 'package.json'));
  const dshRequire = createRequire(await contained(runtime, appRequire.resolve('@deepseek-ai/dsh/package.json')));
  const sdkRequire = createRequire(await contained(runtime, dshRequire.resolve('@deepseek-ai/dsh-mcp-client')));
  const clientPath = await contained(runtime, sdkRequire.resolve('@modelcontextprotocol/sdk/client/index.js'));
  const transportPath = await contained(runtime, sdkRequire.resolve('@modelcontextprotocol/sdk/client/stdio.js'));
  const sdkManifest = JSON.parse(await readFile(await contained(runtime, resolve(dirname(clientPath), '../../../package.json')), 'utf8'));
  assert.equal(sdkManifest.name, '@modelcontextprotocol/sdk');
  const { Client } = await import(pathToFileURL(clientPath).href);
  const { StdioClientTransport } = await import(pathToFileURL(transportPath).href);
  const { browserRuntime } = await import(pathToFileURL(join(app, 'plugin/computer-preset.mjs')).href);
  const browser = browserRuntime();
  assert.equal(browser.available, true, 'Packaged Chromium headless shell is missing.');
  const executable = await contained(join(runtime, 'browsers'), browser.executable);
  const mcpManifest = JSON.parse(await readFile(await contained(runtime, appRequire.resolve('@playwright/mcp/package.json')), 'utf8'));
  const manifest = JSON.parse(await readFile(join(runtime, 'manifest.json'), 'utf8'));
  assert.equal(manifest.platform, process.platform);
  assert.equal(manifest.arch, process.arch);
  assert.equal(manifest.node, process.versions.node);

  const output = join(sandbox, 'workspace/browser-output');
  await mkdir(output, { recursive: true });
  let requests = 0;
  const server = createServer((request, response) => {
    if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (request.url !== '/fixture') { response.writeHead(404); response.end(); return; }
    requests++;
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'" });
    response.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>ColdX packaged browser fixture</title>'
      + '<style>body{font:24px system-ui;margin:48px;background:#f4f7fb;color:#172a42}button{font:inherit;padding:12px}p{padding:16px}</style>'
      + '<h1>ColdX packaged browser fixture</h1><button type="button" onclick="document.getElementById(\'result\').textContent=\'Packaged browser click verified\'">Verify packaged browser</button>'
      + '<p id="result" role="status">Waiting for local click</p></html>');
  });
  let client, transport, pid, stderr = '', report;
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort(new Error('Packaged browser smoke cancelled or timed out.'));
  const onMessage = message => { if (message?.type === 'coldx-browser-smoke-stop') cancel(); };
  const deadline = setTimeout(cancel, 90_000);
  process.once('SIGTERM', cancel);
  process.on('message', onMessage);
  try {
    await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
    const url = `http://127.0.0.1:${server.address().port}/fixture`;
    transport = new StdioClientTransport({ command: process.execPath,
      args: [join(app, 'plugin/browser-driver.mjs'), output], cwd: output,
      env: isolatedEnvironment(runtime, sandbox), stderr: 'pipe' });
    transport.stderr.on('data', data => { stderr = (stderr + data).slice(-8192); });
    client = new Client({ name: 'coldx-packaged-browser-smoke', version: '1.0.0' });
    await client.connect(transport, { timeout: 30_000, signal: cancellation.signal });
    pid = transport.pid;
    const toolList = (await client.listTools(undefined, { timeout: 15_000, signal: cancellation.signal })).tools;
    const available = new Set(toolList.map(tool => tool.name));
    for (const name of ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_take_screenshot', 'browser_close']) {
      assert.ok(available.has(name), `Packaged MCP driver is missing ${name}.`);
    }
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 40_000, signal: cancellation.signal });
      assert.ok(!result.isError, `${name} failed: ${JSON.stringify(result.content)}`);
      return result;
    };
    const text = result => result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    await call('browser_navigate', { url });
    const before = text(await call('browser_snapshot'));
    assert.match(before, /ColdX packaged browser fixture/);
    assert.match(before, /Waiting for local click/);
    const button = before.match(/button "Verify packaged browser" \[ref=([^\]]+)\]/);
    assert.ok(button, `Fixture button missing from MCP snapshot: ${before}`);
    assert.equal(toolList.find(tool => tool.name === 'browser_click').inputSchema.properties.target.type, 'string');
    await call('browser_click', { element: 'Verify packaged browser button', target: button[1] });
    const after = text(await call('browser_snapshot'));
    assert.match(after, /Packaged browser click verified/);
    assert.doesNotMatch(after, /Waiting for local click/);
    // This pinned MCP returns inline image data only without a filename.
    const screenshot = await call('browser_take_screenshot', { type: 'png', scale: 'css' });
    const image = screenshot.content.find(item => item.type === 'image' && item.mimeType === 'image/png');
    assert.ok(image, 'MCP did not return the PNG image.');
    const bytes = Buffer.from(image.data, 'base64');
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    assert.deepEqual(bytes.subarray(0, 8), signature, 'Screenshot is not a PNG.');
    assert.ok(bytes.length > 1000, 'Screenshot is unexpectedly empty.');
    assert.equal(bytes.readUInt32BE(16), 1280);
    assert.equal(bytes.readUInt32BE(20), 720);
    assert.equal(requests, 1, 'Fixture was not loaded exactly once.');
    await call('browser_close');
    report = { ok: true, platform: process.platform, arch: process.arch, node: process.versions.node,
      playwrightMcp: mcpManifest.version, mcpSdk: sdkManifest.version, bundledBrowser: relative(runtime, executable).split(sep).join('/'),
      bundledNode: true, isolatedHome: true, isolatedBrowserPath: true, localFixtureOnly: true,
      navigation: true, click: true, snapshot: true,
      screenshot: { format: 'png', width: 1280, height: 720, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
  } catch (error) {
    throw new Error(`${error.message}${stderr ? `\nDriver stderr: ${stderr}` : ''}`, { cause: error });
  } finally {
    clearTimeout(deadline);
    process.removeListener('SIGTERM', cancel);
    process.removeListener('message', onMessage);
    pid ??= transport?.pid;
    try { await client?.close(); }
    finally {
      await transport?.close();
      server.closeAllConnections();
      await new Promise(done => server.close(done));
      await waitForExit(pid);
    }
  }
  return { ...report, driverStopped: true };
}

async function main() {
  const output = resolve(dirname(script), '../../dist/desktop');
  const defaultRuntime = process.platform === 'win32' ? join(output, 'win-unpacked/resources/runtime')
    : process.platform === 'darwin' ? join(output, process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'ColdX.app/Contents/Resources/runtime')
      : join(output, 'linux-unpacked/resources/runtime');
  const source = await realpath(resolve(process.argv[2] ?? defaultRuntime));
  await Promise.all([nodeName, 'app/plugin/browser-driver.mjs', 'browsers'].map(name => access(join(source, name))));
  try {
    await lstat(join(source, 'browsers/.links'));
    throw new Error('Packaged browsers contain build-machine .links metadata.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporaryRoot = await realpath(tmpdir());
  const sandbox = await mkdtemp(join(temporaryRoot, 'coldx browser smoke '));
  const owned = await realpath(sandbox);
  try {
    const runtime = join(sandbox, 'runtime');
    // Relocation prevents missing transitive modules from resolving upward into
    // the developer checkout, and covers spaces in installed runtime paths.
    await cp(source, runtime, { recursive: true });
    await Promise.all(['home', 'tmp', 'workspace'].map(part => mkdir(join(sandbox, part))));
    const worker = join(sandbox, 'browser-smoke.mjs');
    await copyFile(script, worker);
    const report = await new Promise((done, reject) => {
      const child = spawn(join(runtime, nodeName), [worker, '--worker', runtime, sandbox], {
        cwd: join(sandbox, 'workspace'), env: isolatedEnvironment(runtime, sandbox), windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      const exited = new Promise(done => child.once('close', done));
      let stdout = '', stderr = '';
      let timedOut = false, termination;
      child.stdout.on('data', data => { stdout = (stdout + data).slice(-32768); });
      child.stderr.on('data', data => { stderr = (stderr + data).slice(-16384); });
      const timer = setTimeout(() => {
        timedOut = true;
        termination = terminateOwnedWorker(child, exited);
        termination.catch(reject);
      }, 120_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', async code => {
        clearTimeout(timer);
        if (timedOut) {
          try { await termination; reject(new Error('Packaged browser smoke exceeded 120 seconds.')); } catch (error) { reject(error); }
          return;
        }
        if (code !== 0) { reject(new Error(`Packaged browser smoke failed (${code}): ${stdout.trim()} ${stderr.trim()}`)); return; }
        try { const result = JSON.parse(stdout); assert.equal(result.ok, true); done(result); } catch (error) { reject(error); }
      });
    });
    return { ...report, sourceRuntime: source, relocated: true, buildMetadataAbsent: true, cleanup: true };
  } finally {
    // Delete only this invocation's mkdtemp directory, never the supplied app.
    assert.equal(await realpath(sandbox), owned);
    assert.equal(dirname(owned), temporaryRoot);
    assert.ok(basename(owned).startsWith('coldx browser smoke '));
    assert.equal((await lstat(sandbox)).isSymbolicLink(), false);
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

try {
  const report = process.argv[2] === '--worker' ? await probe(resolve(process.argv[3]), resolve(process.argv[4])) : await main();
  console.log(JSON.stringify(report));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
} finally {
  if (process.connected) process.disconnect();
}
