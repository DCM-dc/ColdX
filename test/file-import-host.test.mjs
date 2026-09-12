import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readFile, readdir, stat, symlink, unlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeImport, nativeRuntime } from './native-helpers.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'coldx-file-import-'));
  const ctx = await nativeRuntime();
  t.after(() => ctx.fiber.dispose());
  for (const name of ['dsh-typert-registry', 'dsh-session', 'dsh-agent', 'dsh-llm', 'dsh-agent-loop', 'dsh-api-gateway']) {
    const mod = await nativeImport(`@deepseek-ai/${name}`);
    await ctx.plugin(mod.default ?? mod, {});
  }
  const { agent } = await ctx.agents.create({ sessionId: 'session-file-import', meta: { cwd: root } });
  const fileImportHost = await import('../plugin/file-import-host.mjs');
  const fiber = await ctx.plugin(fileImportHost);
  const invokeRpc = (request, signal = new AbortController().signal) => ctx.typertGateway.invokeRpc(
    'coldxFiles/importFile',
    { args: { agentId: agent.id, request } },
    signal,
  );
  const invoke = (target, request, signal = new AbortController().signal) => ctx.typertGateway.invoke({
    namespace: 'coldxFiles', method: 'importFile', args: { agentId: target.id, request }, signal,
  });
  return { ctx, root, agent, fiber, invokeRpc, invoke };
}

test('native RPC imports a file into the live Agent workspace and returns its descriptor', async t => {
  const { root, invokeRpc } = await fixture(t);
  const response = await invokeRpc({
    name: 'note.txt', mime: 'text/plain', base64: 'aGVsbG8=', size: 5,
  });
  assert.deepEqual(response, {
    ok: true,
    value: {
      path: '.coldx/uploads/note.txt',
      name: 'note.txt',
      bytes: 5,
      mime: 'text/plain',
      hash: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    },
  });
  assert.equal(await readFile(join(root, '.coldx', 'uploads', 'note.txt'), 'utf8'), 'hello');
});
test('native authenticated file routes browse and preview the exact session workspace', async t => {
  const {ctx,agent,invokeRpc} = await fixture(t);
  await invokeRpc({name:'readable.txt',mime:'text/plain',base64:'aGVsbG8=',size:5});
  const rpc = (method,path) => ctx.typertGateway.invokeRpc(`coldxFiles/${method}`,{args:{agentId:agent.id,request:{path}}},new AbortController().signal);
  const list = await rpc('listFiles','.coldx/uploads');
  assert.equal(list.ok,true); assert.equal(list.value.entries[0].name,'readable.txt');
  const file = await rpc('readFile',list.value.entries[0].path);
  assert.equal(file.ok,true); assert.equal(file.value.text,'hello');
  assert.equal((await rpc('readFile','../outside.txt')).ok,false);
  await assert.rejects(ctx.coldxFiles.readFile({id:agent.id},{path:'.'},new AbortController().signal),/exact live root Agent/);
});

test('the service rejects forged, delegated, and workspace-less Agents before writing', async t => {
  const { ctx, agent } = await fixture(t);
  const request = { name: 'blocked.txt', mime: 'text/plain', base64: 'eA==', size: 1 };
  const signal = new AbortController().signal;
  await assert.rejects(ctx.coldxFiles.importFile({ id: agent.id }, request, signal), /exact live root Agent/);

  const { agent: child } = await agent.ctx.agents.create({
    sessionId: 'session-file-import-child',
    meta: { cwd: agent.session.header.cwd },
  });
  assert.equal(ctx.agents.roots().includes(child), false);
  await assert.rejects(ctx.coldxFiles.importFile(child, request, signal), /exact live root Agent/);

  const { agent: noWorkspace } = await ctx.agents.create({ sessionId: 'session-file-import-no-cwd' });
  await assert.rejects(ctx.coldxFiles.importFile(noWorkspace, request, signal), /workspace/);
});

test('the import contract strictly validates fields, canonical base64, byte size, and the 8 MiB limit', async t => {
  const { agent, invoke } = await fixture(t);
  const valid = { name: 'data.bin', mime: 'application/octet-stream', base64: 'Zg==', size: 1 };
  for (const request of [
    null,
    [],
    { ...valid, extra: true },
    { name: valid.name, mime: valid.mime, base64: valid.base64 },
    { ...valid, name: 1 },
    { ...valid, mime: null },
    { ...valid, base64: false },
    { ...valid, size: '1' },
  ]) await assert.rejects(invoke(agent, request), /Invalid file import request fields/);

  for (const request of [
    { ...valid, base64: 'Z h==' },
    { ...valid, base64: 'Zg' },
    { ...valid, base64: 'Zh==' },
    { ...valid, base64: 'data:application/octet-stream;base64,Zg==' },
  ]) await assert.rejects(invoke(agent, request), /canonical base64/);

  for (const size of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(invoke(agent, { ...valid, size }), /non-negative integer/);
  }
  await assert.rejects(invoke(agent, { ...valid, size: 2 }), /does not match/);
  await assert.rejects(invoke(agent, { ...valid, size: 8 * 1024 * 1024 + 1, base64: '' }), /8 MiB/);
});

test('a full 8 MiB canonical payload validates and imports without exhausting the regexp stack', async t => {
  const { ctx, root, agent } = await fixture(t);
  const data = Buffer.alloc(8 * 1024 * 1024, 0xa5);
  const result = await ctx.coldxFiles.importFile(agent, {
    name: 'limit.bin', mime: 'application/octet-stream', base64: data.toString('base64'), size: data.length,
  }, new AbortController().signal);
  assert.equal(result.path, '.coldx/uploads/limit.bin');
  assert.equal(result.bytes, data.length);
  assert.equal((await stat(join(root, '.coldx', 'uploads', 'limit.bin'))).size, data.length);
});

test('file names lose supplied paths and control characters before becoming POSIX workspace paths', async t => {
  const { root, agent, invoke } = await fixture(t);
  const result = await invoke(agent, {
    name: '../../private\\folder/\u0000report\u001f.txt',
    mime: 'text/plain', base64: 'b2s=', size: 2,
  });
  assert.deepEqual(result, {
    path: '.coldx/uploads/report.txt',
    name: 'report.txt',
    bytes: 2,
    mime: 'text/plain',
    hash: '2689367b205c16ce32ed4200942b8b8b1e262dfc70d9bc9fbc77c49699a4f1df',
  });
  assert.equal(await readFile(join(root, '.coldx', 'uploads', 'report.txt'), 'utf8'), 'ok');
  await assert.rejects(invoke(agent, {
    name: '../\u0000\u001f', mime: 'text/plain', base64: '', size: 0,
  }), /usable file name/);
});

test('sanitized file names have a portable UTF-8 byte limit', async t => {
  const { agent, invoke } = await fixture(t);
  for (const name of ['a'.repeat(241), '界'.repeat(81)]) {
    await assert.rejects(invoke(agent, {
      name, mime: 'application/octet-stream', base64: '', size: 0,
    }), /240 UTF-8 bytes/);
  }
});

test('Windows device names are made portable even when they have an extension', async t => {
  const { agent, invoke } = await fixture(t);
  const names = new Map([
    ['CON', '_CON'],
    ['prn.txt', '_prn.txt'],
    ['AUX.log', '_AUX.log'],
    ['nul.bin', '_nul.bin'],
    ['Com1.js', '_Com1.js'],
    ['LPT1.csv', '_LPT1.csv'],
    ['COM10.txt', 'COM10.txt'],
  ]);
  for (const [name, expected] of names) {
    const result = await invoke(agent, {
      name, mime: 'application/octet-stream', base64: '', size: 0,
    });
    assert.equal(result.name, expected);
    assert.equal(result.path, `.coldx/uploads/${expected}`);
  }
});

test('a redirected upload directory cannot escape the real workspace', async t => {
  const { root, agent, invoke } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'coldx-file-outside-'));
  await mkdir(join(root, '.coldx'), { recursive: true });
  await symlink(outside, join(root, '.coldx', 'uploads'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(invoke(agent, {
    name: 'escape.txt', mime: 'text/plain', base64: 'bm8=', size: 2,
  }), /symbolic link/);
  await assert.rejects(readFile(join(outside, 'escape.txt')));
});

test('a redirected .coldx parent is rejected before creating an external uploads directory', async t => {
  const { root, agent, invoke } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'coldx-parent-outside-'));
  await symlink(outside, join(root, '.coldx'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(invoke(agent, {
    name: 'escape.txt', mime: 'text/plain', base64: 'bm8=', size: 2,
  }), /symbolic link/);
  await assert.rejects(stat(join(outside, 'uploads')), { code: 'ENOENT' });
});

test('same-name imports are idempotent for equal content and hash-suffixed for different content', async t => {
  const { root, agent, invoke } = await fixture(t);
  const firstRequest = { name: 'report.txt', mime: 'text/plain', base64: 'Zmlyc3Q=', size: 5 };
  const first = await invoke(agent, firstRequest);
  const originalPath = join(root, '.coldx', 'uploads', 'report.txt');
  await utimes(originalPath, new Date(1_000), new Date(1_000));
  const preservedMtime = (await stat(originalPath)).mtimeMs;
  assert.deepEqual(await invoke(agent, firstRequest), first);
  assert.equal((await stat(originalPath)).mtimeMs, preservedMtime, 'idempotent retry must not rewrite the file');

  const second = await invoke(agent, {
    name: 'report.txt', mime: 'text/plain', base64: 'c2Vjb25k', size: 6,
  });
  assert.deepEqual(second, {
    path: '.coldx/uploads/report-16367aacb67a.txt',
    name: 'report-16367aacb67a.txt',
    bytes: 6,
    mime: 'text/plain',
    hash: '16367aacb67a4a017c8da8ab95682ccb390863780f7114dda0a0e0c55644c7c4',
  });
  assert.equal(await readFile(originalPath, 'utf8'), 'first');
  assert.equal(await readFile(join(root, '.coldx', 'uploads', second.name), 'utf8'), 'second');
  assert.deepEqual((await readdir(join(root, '.coldx', 'uploads'))).sort(), ['report-16367aacb67a.txt', 'report.txt']);
  assert.deepEqual(await invoke(agent, { name: 'report.txt', mime: 'text/plain', base64: 'c2Vjb25k', size: 6 }), second);
});

test('an exclusive write that fails after creating the file removes its partial output', async t => {
  const { root, agent, invoke } = await fixture(t);
  const probePath = join(root, 'probe.tmp');
  const probe = await open(probePath, 'wx');
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  await unlink(probePath);

  const originalWriteFile = fileHandlePrototype.writeFile;
  let intercepted = false;
  fileHandlePrototype.writeFile = async function failAfterOneByte(data, options) {
    intercepted = true;
    await originalWriteFile.call(this, data.subarray(0, 1), options);
    const error = new Error('simulated partial write failure');
    error.code = 'ENOSPC';
    throw error;
  };
  t.after(() => { fileHandlePrototype.writeFile = originalWriteFile; });

  await assert.rejects(invoke(agent, {
    name: 'partial.bin', mime: 'application/octet-stream', base64: 'YWJj', size: 3,
  }), /simulated partial write failure/);
  assert.equal(intercepted, true, 'the import must write through its owned FileHandle');
  await assert.rejects(stat(join(root, '.coldx', 'uploads', 'partial.bin')), { code: 'ENOENT' });
});

test('cancellation and Host disposal prevent later writes and withdraw the native route', async t => {
  const { ctx, root, agent, fiber, invoke } = await fixture(t);
  const request = { name: 'cancelled.txt', mime: 'text/plain', base64: 'bm8=', size: 2 };
  await assert.rejects(invoke(agent, request, AbortSignal.abort(new Error('cancelled by caller'))), /was aborted/);
  await assert.rejects(readFile(join(root, '.coldx', 'uploads', request.name)));

  const service = ctx.coldxFiles;
  const inFlight = { name: 'in-flight.txt', mime: 'text/plain', base64: 'c3RvcA==', size: 4 };
  const pending = service.importFile(agent, inFlight, new AbortController().signal);
  await fiber.dispose();
  await assert.rejects(pending, /unloaded/);
  await assert.rejects(service.importFile(agent, request, new AbortController().signal), /unloaded/);
  await assert.rejects(invoke(agent, request), /withdrawn|unavailable/);
  await assert.rejects(readFile(join(root, '.coldx', 'uploads', request.name)));
  await assert.rejects(readFile(join(root, '.coldx', 'uploads', inFlight.name)));
});
