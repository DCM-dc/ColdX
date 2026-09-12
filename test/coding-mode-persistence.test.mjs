import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { nativeImport, nativeRuntime } from './native-helpers.mjs';

async function runtime(root) {
  const ctx = await nativeRuntime();
  for (const name of ['dsh-session', 'dsh-session-projection']) {
    const plugin = await nativeImport(`@deepseek-ai/${name}`);
    await ctx.plugin(plugin.default ?? plugin, {});
  }
  const persistence = await nativeImport('@deepseek-ai/dsh-session-persistence-jsonl');
  await ctx.plugin(persistence.default ?? persistence, { root, compression: 'none', writeBatchMaxDelayMs: 1_000 });
  return ctx;
}

test('Host compatibility restores legacy coding mode without weakening unknown-event refusal', async t => {
  const root = await mkdtemp(join(tmpdir(), 'coldx-coding-mode-cold-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await runtime(root);
  const legacy = first.sessions.create('session-coding-mode-legacy', { meta: { cwd: resolve('.') } });
  legacy.append('coldx/coding-mode', { version: 1, goal: true });
  const unknown = first.sessions.create('session-coding-mode-unknown', { meta: { cwd: resolve('.') } });
  unknown.append('coldx/unrecognized-required', { version: 1 });
  await first.sessions.flush(legacy);
  await first.sessions.flush(unknown);
  const legacyPath = first.sessionPersistence.locate(legacy.header).path;
  const original = await readFile(legacyPath);
  await first.fiber.dispose();

  const compatibility = await import('../plugin/coding-mode-persistence-host.mjs').catch(() => undefined);
  assert.ok(compatibility, 'a global Host compatibility plugin must load before cold history reads');
  const second = await runtime(root);
  t.after(() => second.fiber.dispose());
  await second.plugin(compatibility);
  const preparation = await second.sessionPersistence.prepare(legacy.id);
  try {
    assert.deepEqual(second.sessionProjections.snapshot(preparation.session).values['coldx.codingMode'], { goal: true });
  } finally { preparation[Symbol.dispose](); }
  assert.deepEqual(await readFile(legacyPath), original, 'compatibility must not rewrite the append-only user log');
  await assert.rejects(second.sessionPersistence.inspect(unknown.id), /coldx\/unrecognized-required.*unknown to this harness/);
});
