import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeImport, nativeRuntime } from './native-helpers.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'coldx-child-read-'));
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  await writeFile(join(workspace, 'report.txt'), 'child result');
  const ctx = await nativeRuntime();
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  for (const name of ['dsh-typert-registry', 'dsh-session', 'dsh-session-projection', 'dsh-session-persistence-jsonl', 'dsh-agent', 'dsh-llm', 'dsh-agent-loop', 'dsh-subagent', 'dsh-api-gateway']) {
    const module = await nativeImport(`@deepseek-ai/${name}`); await ctx.plugin(module.default ?? module, name === 'dsh-session-persistence-jsonl' ? { root: join(root, 'sessions') } : {});
  }
  const { createApiRemoteAgentResolver } = await nativeImport('@deepseek-ai/dsh-api-remotes');
  createApiRemoteAgentResolver(ctx, {});
  const { agent: parent } = await ctx.agents.create({ sessionId: 'child-read-parent', meta: { cwd: workspace } });
  const { agent: other } = await ctx.agents.create({ sessionId: 'child-read-other', meta: { cwd: workspace } });
  const child = await parent.ctx.agents.create({ sessionId: 'child-read-child', meta: { cwd: workspace, origin: 'subagent', parentSession: parent.id } });
  child.agent.session.append('subagent/descriptor', { version: 2, mode: 'one-shot', provider: 'spawn', label: 'Read-only child' });
  await ctx.plugin(await import('../plugin/file-import-host.mjs'));
  await ctx.plugin(await import('../plugin/terminal-host.mjs'));
  const address = { parentSessionId: parent.id, childSessionId: child.agent.id, mode: 'one-shot' };
  const rpc = (method, request, target = address) => ctx.typertGateway.invokeRpc(method, { args: { address: target, request } }, new AbortController().signal);
  return { ctx, parent, other, child, address, rpc };
}

test('child read-only file RPC uses native lineage while generic child Agent lookup remains fenced', async t => {
  const { ctx, child, other, address, rpc } = await fixture(t);
  const generic = await ctx.typertGateway.invokeRpc('coldxFiles/readFile', { args: { agentId: child.agent.id, request: { path: 'report.txt' } } }, new AbortController().signal);
  assert.equal(generic.ok, false);
  assert.equal(generic.error.code, 'agent-busy');
  const read = await rpc('coldxFiles/readChildFile', { path: 'report.txt' });
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.equal(read.value.text, 'child result');
  const list = await rpc('coldxFiles/listChildFiles', { path: '.' });
  assert.equal(list.ok, true);
  assert.equal(list.value.entries[0].path, 'report.txt');
  assert.equal((await rpc('coldxFiles/readChildFile', { path: 'report.txt' }, { ...address, parentSessionId: other.id })).ok, false);
  assert.equal((await rpc('coldxFiles/readChildFile', { path: 'report.txt' }, { ...address, mode: 'continuable' })).ok, false);
  assert.equal((await rpc('coldxFiles/readChildFile', { path: '../outside.txt' })).ok, false);
});

test('cold child preview does not resume its Agent and still uses native durable catalog ownership', async t => {
  const { ctx, child, address, rpc } = await fixture(t);
  await ctx.sessions.flush(child.agent.session);
  await child.dispose();
  assert.equal(ctx.agents.get(address.childSessionId), undefined);
  const read = await rpc('coldxFiles/readChildFile', { path: 'report.txt' });
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.equal(read.value.text, 'child result');
  assert.equal(ctx.agents.get(address.childSessionId), undefined, 'a preview never activates a cold child');
});

test('child terminal RPC returns its real native process stream and rejects another parent', async t => {
  const { ctx, parent, child, address, other, rpc } = await fixture(t);
  await ctx.plugin((await nativeImport('@deepseek-ai/dsh-subprocess-local')).default);
  const { defineContentToolFixture } = await nativeImport('@deepseek-ai/dsh-tools');
  ctx.tools.register(defineContentToolFixture({
    name: 'pwsh', description: 'child stream fixture', parameters: {},
    presentCall: () => ({ card: 'terminal', title: 'child command' }),
    async execute(_args, exec) {
      const handle = ctx.subprocess.spawn({ argv: [process.execPath, '-e', 'process.stdout.write("child-ok")'], cwd: child.agent.session.header.cwd, graceMs: 50, signal: exec.signal,
        stdio: { stdin: 'ignore', stdout: { mode: 'collect', maxBytes: 65536 }, stderr: { mode: 'collect', maxBytes: 65536 } } });
      await handle.done; return [{ type: 'text', text: handle.collected.stdout.readFrom(0).text }];
    },
  }));
  const executed = await ctx.tools.execute({ name: 'pwsh', callId: 'child-shell', agent: child.agent, arguments: {}, signal: new AbortController().signal });
  assert.equal(executed.isError, false);
  const request = { afterRevision: -1, waitMs: 0 };
  const read = await rpc('coldxTerminal/readChild', request);
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.equal(read.value.records.length, 1);
  assert.equal(read.value.records[0].sessionId, child.agent.id);
  assert.equal(read.value.records[0].output, 'child-ok');
  assert.equal(read.value.records[0].status, 'completed');
  assert.equal(ctx.coldxTerminal.store.snapshot(parent.id).records.length, 0);
  assert.equal((await rpc('coldxTerminal/readChild', request, { ...address, parentSessionId: other.id })).ok, false);
});

test('terminal RPC preserves readable output when optional process metadata is absent', async t => {
  const { ctx, parent } = await fixture(t);
  ctx.coldxTerminal.store.observe({ sessionId: parent.id, callId: 'metadata-optional' }, {
    collected: { stdout: { readFrom: offset => ({ nextOffset: 2, text: offset ? '' : 'ok' }) } }, done: Promise.resolve({ exitCode: 0 }),
  });
  await Promise.resolve();
  const result = await ctx.typertGateway.invokeRpc('coldxTerminal/read', { args: { agentId: parent.id, request: { afterRevision: -1, waitMs: 0 } } }, new AbortController().signal);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.records[0].output, 'ok');
  assert.equal('cwd' in result.value.records[0], false);
  assert.equal('command' in result.value.records[0], false);
});
