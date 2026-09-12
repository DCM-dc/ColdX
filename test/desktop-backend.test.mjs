import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

async function startBackend(options) {
  const backend = await import('../desktop/backend.mjs').catch(() => ({}));
  assert.equal(typeof backend.startBackend, 'function', 'desktop/backend.mjs must export startBackend');
  return backend.startBackend(options);
}

async function fixtureRuntime(t, source) {
  const temp = await mkdtemp(join(tmpdir(), 'coldx-desktop-backend-'));
  const runtimeRoot = join(temp, 'runtime root');
  const dataHome = join(temp, 'data home');
  const workspace = join(temp, 'workspace with spaces');
  await Promise.all([
    mkdir(join(runtimeRoot, 'bin'), { recursive: true }),
    mkdir(join(runtimeRoot, 'desktop'), { recursive: true }),
    mkdir(dataHome, { recursive: true }),
    mkdir(workspace, { recursive: true }),
  ]);
  await Promise.all([
    copyFile(new URL('../desktop/backend-entry.mjs', import.meta.url), join(runtimeRoot, 'desktop', 'backend-entry.mjs')),
    writeFile(join(runtimeRoot, 'bin', 'coldx-web.mjs'), source),
  ]);
  t.after(() => rm(temp, { recursive: true, force: true }));
  return { runtimeRoot, dataHome, workspace, temp };
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const request = get(url, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', reject);
  });
}

async function waitUntilGone(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return true; else throw error; }
    await delay(25);
  }
  return false;
}

async function waitForPid(path, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return Number(await readFile(path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(20);
  }
  throw new Error(`fixture did not write its pid: ${path}`);
}

test('backend preload leaves IPC available without keeping a failed process alive', { timeout: 5_000 }, async () => {
  const entry = new URL('../desktop/backend-entry.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--import', entry, '--eval', 'process.exitCode = 37'], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const exited = new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  const outcome = await Promise.race([
    exited,
    delay(750).then(() => ({ timeout: true })),
  ]);
  if (outcome.timeout) {
    child.kill();
    await exited;
  }
  assert.deepEqual(outcome, { code: 37, signal: null });
});

test('desktop backend starts on a random loopback port, probes HTTP, and shuts down through IPC SIGINT', { timeout: 10_000 }, async t => {
  const runtime = await fixtureRuntime(t, `
    import { createServer } from 'node:http';
    import { delimiter, dirname } from 'node:path';
    const value = flag => process.argv[process.argv.indexOf(flag) + 1];
    const firstPathEntry = (process.env.PATH || '').split(delimiter)[0];
    if (value('--port') !== '0' || !value('--home') || value('--cwd') !== process.cwd()
      || !process.argv.includes('--no-open') || firstPathEntry !== dirname(process.execPath)) {
      console.error('bad ColdX desktop arguments');
      process.exit(64);
    }
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('fixture ready');
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      process.stdout.write('dsh web: http://127.0.');
      setTimeout(() => process.stdout.write('0.1:' + port + '/\\n'), 5);
    });
    process.on('SIGINT', () => {
      process.stdout.write('fixture received SIGINT\\n');
      server.close(() => process.exit(0));
    });
  `);
  const logs = [];
  const backend = await startBackend({
    nodePath: process.execPath,
    ...runtime,
    timeoutMs: 3_000,
    onLog: entry => logs.push(entry),
  });
  t.after(() => backend.stop());

  assert.match(backend.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.notEqual(new URL(backend.url).port, '0');
  assert.deepEqual(await fetchText(backend.url), { status: 200, body: 'fixture ready' });
  assert.equal(backend.child.exitCode, null);

  await backend.stop();
  await backend.stop();
  assert.equal(backend.child.exitCode, 0);
  assert.equal(logs.some(entry => entry.stream === 'stdout' && entry.text.includes('fixture received SIGINT')), true);
});

test('desktop backend reports a child that exits before HTTP readiness', { timeout: 10_000 }, async t => {
  const runtime = await fixtureRuntime(t, `
    console.error('fixture exploded before listen');
    process.exit(23);
  `);

  await assert.rejects(startBackend({
    nodePath: process.execPath,
    ...runtime,
    timeoutMs: 2_000,
  }), error => {
    assert.match(error.message, /exited before becoming ready/i);
    assert.match(error.message, /code 23/i);
    assert.match(error.message, /fixture exploded before listen/);
    return true;
  });
});

test('desktop opens the DSH app even when a plugin logs another ready local server first', { timeout: 10_000 }, async t => {
  const runtime=await fixtureRuntime(t,`
    import {createServer} from 'node:http';
    const plugin=createServer((_request,response)=>response.end('unrelated plugin UI'));
    const app=createServer((_request,response)=>response.end('ColdX app'));
    plugin.listen(0,'127.0.0.1',()=>{
      console.log('Plugin preview: http://127.0.0.1:'+plugin.address().port+'/');
      setTimeout(()=>app.listen(0,'127.0.0.1',()=>console.log('dsh web: http://127.0.0.1:'+app.address().port+'/')),100);
    });
    process.on('SIGINT',()=>{plugin.close();app.close(()=>process.exit(0));});
  `);
  const backend=await startBackend({nodePath:process.execPath,...runtime,timeoutMs:3000});
  try { assert.equal((await fetchText(backend.url)).body,'ColdX app'); }
  finally { await backend.stop(); }
});

test('desktop backend timeout is diagnostic and kills a child that ignores IPC shutdown', { timeout: 10_000 }, async t => {
  const runtime = await fixtureRuntime(t, `
    import { writeFileSync } from 'node:fs';
    const value = flag => process.argv[process.argv.indexOf(flag) + 1];
    writeFileSync(value('--home') + '/fixture.pid', String(process.pid));
    console.log('fixture deliberately never became ready');
    process.on('SIGINT', () => console.log('fixture ignored SIGINT'));
    setInterval(() => {}, 1_000);
  `);

  await assert.rejects(startBackend({
    nodePath: process.execPath,
    ...runtime,
    timeoutMs: 250,
  }), error => {
    assert.match(error.message, /did not become ready within 250ms/i);
    assert.match(error.message, /fixture deliberately never became ready/);
    return true;
  });
  const pid = Number(await readFile(join(runtime.dataHome, 'fixture.pid'), 'utf8'));
  assert.equal(await waitUntilGone(pid), true, 'timed-out backend child must not survive startup');
});

test('desktop backend aborts an in-flight startup and terminates its child', { timeout: 5_000 }, async t => {
  const runtime = await fixtureRuntime(t, `
    import { writeFileSync } from 'node:fs';
    const value = flag => process.argv[process.argv.indexOf(flag) + 1];
    writeFileSync(value('--home') + '/abort.pid', String(process.pid));
    console.log('fixture waiting to be aborted');
    process.on('SIGINT', () => process.exit(0));
    setInterval(() => {}, 1_000);
  `);
  const controller = new AbortController();
  const starting = startBackend({
    nodePath: process.execPath,
    ...runtime,
    signal: controller.signal,
    timeoutMs: 1_000,
  });
  const pid = await waitForPid(join(runtime.dataHome, 'abort.pid'));
  controller.abort();
  await assert.rejects(starting, error => error.name === 'AbortError');
  assert.equal(await waitUntilGone(pid), true, 'aborted backend child must not survive startup');
});
