import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { readFile, realpath } from 'node:fs/promises';

async function browserClient(value) {
  const resolveNative = createRequire(await realpath(new URL('../node_modules/@deepseek-ai/dsh/package.json', import.meta.url)));
  const source = await readFile(resolveNative.resolve('@deepseek-ai/dsh-client-connection/client'), 'utf8');
  let record;
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(module) { record = module; } } },
    URL, crypto: globalThis.crypto, AbortSignal, TextDecoder, TextEncoder, setTimeout, clearTimeout, queueMicrotask,
  });
  assert.equal(record.id, '@deepseek-ai/dsh-client-connection');
  const { AbstractApiClient } = record.factory(() => { throw new Error('Unexpected external browser dependency.'); });
  return new class extends AbstractApiClient {
    async doFetch(_url, request) {
      const sent = JSON.parse(request.body);
      return Response.json({ type: 'server-response', rpcId: sent.rpcId, result: { ok: true, value } });
    }
  }();
}

test('the actual shipped browser decoder preserves typed child outcomes without retaining unknown fields', async () => {
  const execution = { status: 'failed', seq: 21, time: 100, code: 'AUTH', httpStatus: 401 };
  const entries = ['one-shot', 'continuable'].map((mode, index) => ({ kind: 'child', id: `child-${index}`, mode, label: 'Child', activity: 'inactive', hasChildren: false,
    execution: { ...execution, privateReasoning: 'must not survive' }, privatePrompt: 'must not survive' }));
  const client = await browserClient({ entries, parentAvailable: true });
  const response = await client.subagents.list({ parentSessionId: 'parent' });
  assert.equal(response.result.ok, true);
  for (const entry of response.result.value.entries) {
    assert.deepEqual(JSON.parse(JSON.stringify(entry.execution ?? null)), execution);
    assert.equal('privatePrompt' in entry, false);
    assert.equal('privateReasoning' in entry.execution, false);
  }
});

test('the shipped browser decoder rejects malformed child outcomes while old optional-free rows remain valid', async () => {
  const entry = { kind: 'child', id: 'child', mode: 'one-shot', activity: 'inactive', hasChildren: false };
  const old = await (await browserClient({ entries: [entry], parentAvailable: false })).subagents.list({ parentSessionId: 'parent' });
  assert.equal(old.result.ok, true);
  const invalid = await browserClient({ entries: [{ ...entry, execution: { status: 'invented', seq: 1, time: 1 } }], parentAvailable: false });
  await assert.rejects(invalid.subagents.list({ parentSessionId: 'parent' }));
});
