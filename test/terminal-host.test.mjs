import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeRuntime, nativeImport } from './native-helpers.mjs';
import * as terminalHost from '../plugin/terminal-host.mjs';

async function fixture(t) {
  const ctx = await nativeRuntime(); t.after(() => ctx.fiber.dispose());
  for (const name of ['dsh-typert-registry', 'dsh-session', 'dsh-agent', 'dsh-llm', 'dsh-agent-loop', 'dsh-api-gateway']) {
    const mod = await nativeImport(`@deepseek-ai/${name}`); await ctx.plugin(mod.default ?? mod, {});
  }
  const { agent: a } = await ctx.agents.create({ sessionId: 'terminal-owner-a' });
  const { agent: b } = await ctx.agents.create({ sessionId: 'terminal-owner-b' });
  const fiber = await ctx.plugin(terminalHost);
  return { ctx, a, b, fiber, read: (agent, request = { afterRevision: -1, waitMs: 0 }, signal = new AbortController().signal) => ctx.typertGateway.invokeRpc('coldxTerminal/read', { args: { agentId: agent.id, request } }, signal) };
}

async function patchedLocalSubprocess() {
  // Verify the installable patch without altering the running dependency tree.
  const rootRequire = createRequire(await realpath(new URL('../node_modules/@deepseek-ai/dsh/package.json', import.meta.url)));
  const original = rootRequire.resolve('@deepseek-ai/dsh-subprocess-local');
  const originalRequire = createRequire(original);
  let source = await readFile(original, 'utf8');
  if (!source.includes('"subprocess/spawn"')) {
    const temp = await mkdtemp(join(tmpdir(), 'coldx-native-stream-patch-'));
    await mkdir(join(temp, 'lib')); await writeFile(join(temp, 'lib/index.js'), source);
    execFileSync('git', ['apply', '--no-index', fileURLToPath(new URL('../patches/@deepseek-ai__dsh-subprocess-local@0.1.1-rc.2.patch', import.meta.url))], { cwd: temp, windowsHide: true });
    source = await readFile(join(temp, 'lib/index.js'), 'utf8');
  }
  source = source.replace(/from "([^"\n]+)"/g, (whole, name) => name.startsWith('node:') ? whole : `from ${JSON.stringify(pathToFileURL(originalRequire.resolve(name)).href)}`);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('installed-patch contract streams real processes through native tool dispatch and Typert, isolating sessions and unrelated tools', async t => {
  const { ctx, a, b, read } = await fixture(t);
  const { default: Local } = await patchedLocalSubprocess(); await ctx.plugin(Local);
  const { defineContentToolFixture } = await nativeImport('@deepseek-ai/dsh-tools');
  for (const name of ['pwsh', 'search']) ctx.tools.register(defineContentToolFixture({
    name, description: 'terminal integration fixture', parameters: { label: { type: 'string' } },
    presentCall: args => ({ card: 'terminal', title: `print ${args.label}` }),
    async execute(args, exec) {
      const handle = ctx.subprocess.spawn({ argv: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(args.label + '\n')});setTimeout(()=>process.exit(0),250)`], cwd: process.cwd(), graceMs: 50, signal: exec.signal, stdio: { stdin: 'ignore', stdout: { mode: 'collect', maxBytes: 65536 }, stderr: { mode: 'collect', maxBytes: 65536 } } });
      await handle.done; return [{ type: 'text', text: handle.collected.stdout.readFrom(0).text }];
    },
  }));
  const invoke = (agent, name, label) => ctx.tools.execute({ name, callId: `${name}-${label}`, arguments: { label }, agent, signal: new AbortController().signal });
  const tasks = [invoke(a, 'pwsh', 'alpha'), invoke(b, 'pwsh', 'beta'), invoke(a, 'search', 'unrelated')];
  let response;
  for (let n = 0; n < 50; n += 1) { response = await read(a); if (response.value?.records?.[0]?.output.includes('alpha')) break; await delay(10); }
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.value.records.length, 1);
  assert.equal(response.value.records[0].status, 'running');
  assert.equal(response.value.records[0].command, 'print alpha');
  assert.equal(response.value.records[0].callId, 'pwsh-alpha');
  assert.doesNotMatch(JSON.stringify(response), /beta|unrelated/);
  const outcomes = await Promise.all(tasks);
  assert.ok(outcomes.every(row => !row.isError));
  assert.equal(outcomes[0].content[0].text, 'alpha\n');
  assert.equal((await read(a)).value.records[0].exitCode, 0);
  assert.equal((await read(b)).value.records[0].output, 'beta\n');
  assert.equal(a.session.events.some(event => JSON.stringify(event).includes('alpha')), false, 'stream output is never appended to model/session history');
});

test('terminal service validates exact Agent, rejects malformed requests and releases pending reads on unload', async t => {
  const { ctx, a, read, fiber } = await fixture(t);
  assert.throws(() => ctx.coldxTerminal.read({ id: a.id }, { afterRevision: -1, waitMs: 0 }), /exact live Agent/);
  assert.equal((await read(a, { afterRevision: -1, waitMs: 20_001 })).ok, false);
  assert.equal((await read(a, { afterRevision: -1, waitMs: 0, sessionId: 'other' })).ok, false);
  const pending = read(a, { afterRevision: 0, waitMs: 20_000 });
  await fiber.dispose();
  const result = await pending; assert.equal(result.ok, false);
});

test('native background jobs keep streaming after tool admission and explicit kill is shown as stopped', async t => {
  const { ctx, a, read } = await fixture(t);
  const { default: Local } = await patchedLocalSubprocess(); await ctx.plugin(Local);
  const { default: Jobs } = await nativeImport('@deepseek-ai/dsh-jobs-local'); await ctx.plugin(Jobs, {});
  ctx.jobs.attachController('terminal-integration-test');
  const { defineTool } = await nativeImport('@deepseek-ai/dsh-tools');
  ctx.tools.register(defineTool({
    name: 'pwsh', description: 'background integration fixture', parameters: { run_in_background: { type: 'boolean', required: true } },
    presentCall: () => ({ card: 'generic', title: 'background command' }),
    output: { schema: { type: 'json' }, render: () => [] },
    async execute(_args, exec) {
      let killed = false;
      const jobId = ctx.jobs.start({ kind: 'bash', label: 'background command', owner: exec.agent, run: () => {
        const handle = ctx.subprocess.spawn({ argv: [process.execPath, '-e', 'process.stdout.write("background-first\\n");setTimeout(()=>{},10000)'], cwd: process.cwd(), graceMs: 30, stdio: { stdin: 'ignore', stdout: { mode: 'collect', maxBytes: 65536 }, stderr: { mode: 'collect', maxBytes: 65536 } } });
        return { cancel: () => { killed = true; handle.terminate(); }, done: handle.done.then(() => ({ status: killed ? 'killed' : 'completed' })) };
      } });
      return { kind: 'background', jobId };
    },
  }));
  const admitted = await ctx.tools.execute({ name: 'pwsh', callId: 'background-call', arguments: { run_in_background: true }, agent: a, signal: new AbortController().signal });
  assert.equal(admitted.isError, false, JSON.stringify(admitted));
  let row;
  for (let n = 0; n < 100; n += 1) { row = (await read(a)).value.records[0]; if (row?.output.includes('background-first')) break; await delay(10); }
  assert.equal(row.background, true); assert.equal(row.status, 'running');
  assert.equal(row.jobId, admitted.value.jobId); assert.match(row.output, /background-first/);
  ctx.jobs.kill(admitted.value.jobId, a);
  assert.equal((await read(a)).value.records[0].stopping, true);
  await ctx.jobs.wait(admitted.value.jobId, 5000, a);
  row = (await read(a)).value.records[0];
  assert.equal(row.status, 'cancelled'); assert.ok(row.signal || row.exitCode !== 0);
});
