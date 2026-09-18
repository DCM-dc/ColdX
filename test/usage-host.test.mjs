import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageLedger, USAGE_INVOCATIONS, resolveBalanceConnection } from '../plugin/usage-host.mjs';
import * as usageHost from '../plugin/usage-host.mjs';
import { nativeImport, nativeRuntime } from './native-helpers.mjs';

const event = { seq: 0, time: 1000000, type: 'assistant/message', data: { turn: 0, step: 0, usage: { inputTokens: 10, outputTokens: 20 } } };
const snapshot = id => ({ session: { id, createdAt: 0 }, events: [event] });

test('ledger caches metrics, refreshes changed sessions, removes deleted sessions and never stores content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'coldx-usage-'));
  let ids = ['a', 'b'], reads = 0;
  const query = { listSessions: async () => ids.map(id => ({ header: { id } })), readSession: async id => { reads++; return snapshot(id); } };
  const ledger = new UsageLedger({ query, cachePath: join(dir, 'metrics.json'), now: () => 1000000 });
  try {
    assert.equal((await ledger.read({ timeZone: 'UTC' })).summary.totalTokens, 60);
    const firstReads = reads;
    await ledger.read({ timeZone: 'UTC' }); assert.equal(reads, firstReads);
    ledger.invalidate('a'); await ledger.read({ timeZone: 'UTC' }); assert.equal(reads, firstReads + 1);
    ids = ['b']; assert.equal((await ledger.read({ timeZone: 'UTC' })).summary.totalTokens, 30);
    const stored = await readFile(join(dir, 'metrics.json'), 'utf8');
    assert.doesNotMatch(stored, /assistant\/message|inputTokens.*PRIVATE|"events"|"arguments"/);
    assert.equal(JSON.parse(stored).entries.length, 1);
  } finally { await ledger.dispose(); await rm(dir, { recursive: true }); }
});

test('previous call-ID accounting caches rebuild even when native revisions are unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'coldx-usage-old-accounting-')), cachePath = join(dir, 'metrics.json');
  const oldSummary = { version: 1, sessionId: 'a', timeZone: 'UTC', throughSeq: 1, seedLength: 0, humanMessages: 0, activeMs: 0, openTurns: 0,
    isSubagent: false, hasActivity: true, totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0 },
    coverage: { reportedSteps: 0, missingSteps: 0, cacheReportedSteps: 0, reasoningReportedSteps: 0 }, days: [],
    tools: [{ name: 'fixture_probe', count: 1 }], skills: [], efforts: [] };
  await writeFile(cachePath, JSON.stringify({ version: 1, entries: [{ summary: oldSummary, revision: 'unchanged' }] }));
  let reads = 0;
  const ledger = new UsageLedger({ cachePath, revisions: async () => new Map([['a', 'unchanged']]), query: {
    listSessions: async () => [{ header: { id: 'a' } }],
    readSession: async () => { reads++; return { session: { id: 'a' }, events: [1, 2].map((turn, seq) => ({ seq, time: 1000000 + seq,
      type: 'tool/call', data: { turn, step: 1, callId: 'call_0', name: 'fixture_probe', arguments: '{}' } })) }; },
  } });
  try {
    assert.deepEqual((await ledger.read({ timeZone: 'UTC' })).tools, [{ name: 'fixture_probe', count: 2 }]);
    assert.equal(reads, 1);
  } finally { await ledger.dispose(); await rm(dir, { recursive: true }); }
});

test('failed history reads surface incomplete coverage and scan limits are explicit', async () => {
  const ledger = new UsageLedger({ maxSessions: 2, query: { listSessions: async () => ['a', 'b', 'c'].map(id => ({ header: { id } })), readSession: async id => { if (id === 'b') throw Error('private path'); return snapshot(id); } } });
  const value = await ledger.read({ timeZone: 'UTC' });
  assert.equal(value.coverage.unavailableSessions, 1); assert.equal(value.coverage.truncated, true);
  assert.equal(value.coverage.complete, false); assert.doesNotMatch(JSON.stringify(value), /private path/);
  await ledger.dispose();
});

test('disposed or caller-cancelled ledger cannot return a successful read', async () => {
  const ledger = new UsageLedger({ query: { listSessions: async () => [], readSession: async () => {} } });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(ledger.read({ timeZone: 'UTC' }, controller.signal));
  await ledger.dispose(); await assert.rejects(ledger.read({ timeZone: 'UTC' }));
});

test('balance connection uses native resolved settings and credential reference without file reads', async () => {
  let reference;
  const value = await resolveBalanceConnection({ settings: { get: () => ({ baseURL: 'https://gateway.example/v1', apiKeyEnv: 'PRIVATE_REF' }) }, get: name => name === 'credentials' ? { resolve: async ref => { reference = ref; return { value: 'fixture-secret' }; } } : undefined });
  assert.equal(reference, 'PRIVATE_REF'); assert.deepEqual(value, { baseURL: 'https://gateway.example/v1', apiKey: 'fixture-secret' });
  assert.deepEqual(USAGE_INVOCATIONS.map(row => row.method), ['read', 'balance', 'settings']);
});

test('native Typert exposes usage without creating sessions, settings validate and unload removes service', async t => {
  const ctx = await nativeRuntime(); t.after(() => ctx.fiber.dispose());
  for (const name of ['dsh-typert-registry', 'dsh-session', 'dsh-agent', 'dsh-llm', 'dsh-agent-loop', 'dsh-api-gateway']) {
    const mod = await nativeImport('@deepseek-ai/' + name); await ctx.plugin(mod.default ?? mod, {});
  }
  const data = new Map(); let fetches = 0;
  await ctx.plugin({ name: 'usage-fixture-dependencies', apply(owner) {
    owner.provide('settings', { register(ns, _schema, { base }) { data.set(ns, { ...base }); return { get: () => data.get(ns) }; }, get: ns => data.get(ns), async update(ns, patch) { data.set(ns, { ...data.get(ns), ...patch }); } });
    owner.provide('sessionQuery', { listSessions: async () => [{ header: { id: 'persisted-a' } }], readSession: async () => snapshot('persisted-a') });
  } });
  const fiber = await ctx.plugin(usageHost, { fetchImpl: async () => { fetches++; throw Error('must not query an unconfigured provider'); } });
  const rpc = (method, request = {}) => ctx.typertGateway.invokeRpc('coldxUsage/' + method, { args: { request } }, new AbortController().signal);
  const read = await rpc('read', { timeZone: 'UTC' });
  assert.equal(read.ok, true); assert.equal(read.value.summary.totalTokens, 30); assert.equal(ctx.sessions.list().length, 0);
  assert.equal((await rpc('balance')).value.status, 'unconfigured'); assert.equal(fetches, 0);
  assert.equal((await rpc('settings', { balanceEnabled: false, thresholds: { CNY: '5.50', USD: '1' } })).value.thresholds.CNY, '5.50');
  assert.equal((await rpc('balance')).value.status, 'disabled');
  assert.equal((await rpc('settings', { thresholds: { CNY: '-1', USD: '1' } })).ok, false);
  assert.equal((await rpc('balance', { apiKey: 'forged' })).ok, false);
  assert.equal((await rpc('read', { timeZone: 'Not/A_TimeZone' })).ok, false);
  await fiber.dispose(); assert.equal((await rpc('read')).ok, false);
});
