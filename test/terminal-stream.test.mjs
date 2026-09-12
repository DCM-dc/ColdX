import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeRuntime, nativeImport } from './native-helpers.mjs';
import { TerminalStreamStore } from '../plugin/terminal-stream.mjs';

function fakeProcess() {
  let resolve, reject;
  const data = { stdout: '', stderr: '' };
  const done = new Promise((yes, no) => { resolve = yes; reject = no; });
  const collected = Object.fromEntries(Object.keys(data).map(stream => [stream, {
    readFrom(offset) { const bytes = Buffer.from(data[stream]); return { text: bytes.subarray(offset).toString(), nextOffset: bytes.length, lossy: false }; },
  }]));
  return { data, handle: { collected, done }, resolve, reject };
}
const owner = (sessionId, callId) => ({ sessionId, callId, command: `command ${callId}` });

test('live native collected stdout/stderr appear before process settlement, without consuming tool output', async t => {
  const ctx = await nativeRuntime();
  const { default: LocalSubprocess } = await nativeImport('@deepseek-ai/dsh-subprocess-local');
  await ctx.plugin(LocalSubprocess);
  const store = new TerminalStreamStore({ pollMs: 15 });
  t.after(async () => { store.dispose(); await ctx.fiber.dispose(); });
  const handle = ctx.subprocess.spawn({ argv: [process.execPath, '-e', 'process.stdout.write("first\\n");process.stderr.write("warn\\n");setTimeout(()=>{process.stdout.write("last\\n");process.exitCode=7},350)'], cwd: process.cwd(), graceMs: 50, stdio: { stdin: 'ignore', stdout: { mode: 'collect', maxBytes: 65536 }, stderr: { mode: 'collect', maxBytes: 65536 } } });
  store.observe(owner('one', 'native'), handle, {});
  let live;
  for (let i = 0; i < 80; i += 1) { live = store.snapshot('one').records[0]; if (live.output.includes('first') && live.output.includes('warn')) break; await delay(10); }
  assert.equal(live.status, 'running');
  assert.match(live.output, /first/);
  assert.match(live.output, /warn/);
  await handle.done; await delay(10);
  const settled = store.snapshot('one').records[0];
  assert.equal(settled.status, 'failed');
  assert.equal(settled.exitCode, 7);
  assert.match(settled.output, /last/);
  assert.equal(handle.collected.stdout.readFrom(0).text, 'first\nlast\n');
  assert.equal(store.snapshot('other').records.length, 0);
});

test('cancelled native processes keep real exit facts and late output; detaching the display never terminates them', async t => {
  const store = new TerminalStreamStore({ pollMs: 10 }); t.after(() => store.dispose());
  const proc = fakeProcess(); const cancel = new AbortController();
  let terminations = 0; proc.handle.terminate = () => { terminations += 1; };
  store.observe(owner('one', 'cancel'), proc.handle, { signal: cancel.signal });
  proc.data.stdout = 'partial'; cancel.abort(); proc.resolve({ exitCode: null, signal: 'SIGTERM' });
  await delay(0);
  const row = store.snapshot('one').records[0];
  assert.equal(row.status, 'cancelled'); assert.equal(row.signal, 'SIGTERM'); assert.equal(row.output, 'partial');
  const running = fakeProcess(); store.observe(owner('one', 'keep'), running.handle, {});
  store.dispose(); assert.equal(terminations, 0);
  running.resolve({ exitCode: 0, signal: null });
});

test('long polling is session scoped, wakes for output, and aborts on navigation', async t => {
  const store = new TerminalStreamStore({ pollMs: 10 }); t.after(() => store.dispose());
  const proc = fakeProcess(); store.observe(owner('a', 'one'), proc.handle, {});
  const revision = store.snapshot('a').revision;
  const next = store.wait('a', revision, { waitMs: 1000 });
  proc.data.stdout = 'increment';
  const result = await next; assert.match(result.records[0].output, /increment/); assert.ok(result.revision > revision);
  const controller = new AbortController(); const pending = store.wait('b', store.snapshot('b').revision, { signal: controller.signal, waitMs: 1000 });
  controller.abort(); await assert.rejects(pending, /abort/i);
  proc.resolve({ exitCode: 0, signal: null });
});

test('record, session and combined text limits bound retention, and lossy native reads are explicit', async t => {
  const store = new TerminalStreamStore({ pollMs: 10, recordLimit: 2, totalRecordLimit: 3, outputLimit: 24, totalOutputLimit: 48 }); t.after(() => store.dispose());
  for (const [sessionId, callId] of [['a', 'one'], ['a', 'two'], ['a', 'three'], ['b', 'four']]) {
    const proc = fakeProcess(); store.observe(owner(sessionId, callId), proc.handle, {});
    proc.data.stdout = 'x'.repeat(100); proc.resolve({ exitCode: 0, signal: null }); await delay(0);
  }
  const rows = [...store.snapshot('a').records, ...store.snapshot('b').records];
  assert.ok(rows.length <= 3); assert.ok(store.snapshot('a').records.length <= 2);
  assert.ok(rows.reduce((sum, row) => sum + row.output.length, 0) <= 48);
  assert.ok(rows.some(row => row.outputTruncated));
  assert.ok(rows.every(row => row.output.length <= 24));
  const lossy = fakeProcess(); lossy.handle.collected.stdout.readFrom = () => ({ text: 'tail', nextOffset: 10000, lossy: true, spillPath: 'do-not-expose' });
  store.observe(owner('b', 'lossy'), lossy.handle, {}); lossy.resolve({ exitCode: 0, signal: null }); await delay(0);
  assert.equal(store.snapshot('b').records.at(-1).outputLossy, true);
  assert.doesNotMatch(JSON.stringify(store.snapshot('b')), /do-not-expose/);
});
