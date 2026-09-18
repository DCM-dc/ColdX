import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { BalanceReader, balanceEndpoint, validateBalanceThresholds } from '../plugin/usage-balance.mjs';

const payload = (value = '12.50', available = true) => ({ is_available: available, balance_infos: [{ currency: 'CNY', total_balance: value, granted_balance: '0.00', topped_up_balance: value }] });
const connection = { baseURL: 'https://api.deepseek.com/v1', apiKey: 'test-only-placeholder' };
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('official endpoint normalizes v1, third party stays on its own origin, credentials never reach snapshot', async () => {
  assert.equal(balanceEndpoint(connection.baseURL), 'https://api.deepseek.com/user/balance');
  assert.equal(balanceEndpoint('https://gateway.example/v1'), 'https://gateway.example/v1/user/balance');
  assert.throws(() => balanceEndpoint('https://user:secret@gateway.example/v1'));
  let request;
  const reader = new BalanceReader({ resolveConnection: async () => connection, fetchImpl: async (url, init) => { request = { url, init }; return response(payload()); } });
  const value = await reader.read();
  assert.equal(request.init.redirect, 'error');
  assert.equal(request.init.headers.authorization, 'Bearer test-only-placeholder');
  assert.equal(value.balances[0].total, '12.50');
  assert.equal(value.alert, null);
  assert.doesNotMatch(JSON.stringify(value), /test-only-placeholder|apiKey/);
  reader.dispose();
});

test('cached and concurrent requests coalesce, explicit refresh has a 15 second minimum', async () => {
  let count = 0, now = 100000;
  const reader = new BalanceReader({ resolveConnection: async () => connection, now: () => now, fetchImpl: async () => { count++; await new Promise(resolve => setImmediate(resolve)); return response(payload()); } });
  await Promise.all([reader.read(), reader.read(), reader.read({ refresh: true })]);
  assert.equal(count, 1);
  await reader.read({ refresh: true }); assert.equal(count, 1);
  now += 16000; await reader.read({ refresh: true }); assert.equal(count, 2);
  now += 100000; await reader.read(); assert.equal(count, 2);
  reader.dispose();
});

test('credential rotation cannot reuse another account balance', async () => {
  let key = 'first-fixture', count = 0;
  const reader = new BalanceReader({ resolveConnection: async () => ({ ...connection, apiKey: key }), fetchImpl: async () => response(payload(String(++count))) });
  assert.equal((await reader.read()).balances[0].total, '1');
  key = 'second-fixture'; assert.equal((await reader.read()).balances[0].total, '2');
  reader.dispose();
});

test('decimal comparisons preserve threshold precision and currencies never merge', async () => {
  const data = payload('9.999999999999999999');
  data.balance_infos.push({ currency: 'USD', total_balance: '30.00', granted_balance: '0', topped_up_balance: '30' });
  const reader = new BalanceReader({ resolveConnection: async () => connection, fetchImpl: async () => response(data) });
  const value = await reader.read();
  assert.equal(value.alert, 'low');
  assert.deepEqual(value.balances.map(row => [row.currency, row.low]), [['CNY', true], ['USD', false]]);
  assert.throws(() => validateBalanceThresholds({ CNY: 'NaN', USD: '2' }));
  reader.dispose();
});

test('failed refresh preserves last balance as stale and never emits an insufficient balance alert', async () => {
  let now = 100000, fail = false;
  const reader = new BalanceReader({ resolveConnection: async () => connection, now: () => now, fetchImpl: async () => { if (fail) throw Error('request failed with secret-token'); return response(payload('1')); } });
  assert.equal((await reader.read()).alert, 'low');
  now += 310000; fail = true;
  const value = await reader.read();
  assert.equal(value.status, 'error'); assert.equal(value.stale, true);
  assert.equal(value.balances[0].total, '1'); assert.equal(value.checkedAt, 100000);
  assert.equal(value.alert, null); assert.doesNotMatch(JSON.stringify(value), /secret-token/);
  reader.dispose();
});

test('404 means unsupported, 401 means credentials failure, 402 means unavailable', async () => {
  for (const [status, expected, alert] of [[404, 'unsupported', null], [401, 'error', null], [402, 'ok', 'empty']]) {
    const reader = new BalanceReader({ resolveConnection: async () => connection, fetchImpl: async () => new Response('', { status }) });
    const value = await reader.read(); assert.equal(value.status, expected); assert.equal(value.alert, alert);
    reader.dispose();
  }
});

test('unavailable flag wins over a positive amount and malformed/oversize data stays unknown', async () => {
  for (const body of [payload('30', false), { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: 'oops' }] }, 'x'.repeat(70000)]) {
    const reader = new BalanceReader({ resolveConnection: async () => connection, fetchImpl: async () => response(body) });
    const result = await reader.read();
    assert.equal(result.alert, body?.is_available === false ? 'empty' : null);
    if (body?.is_available !== false) assert.equal(result.status, 'error');
    reader.dispose();
  }
});

test('real HTTP redirects never forward the bearer secret and hanging balance queries time out', async () => {
  let targetHits = 0;
  const server = createServer((request, response) => {
    if (request.url === '/redirect/user/balance') { response.writeHead(302, { location: '/target' }); response.end(); }
    else if (request.url === '/target') { targetHits++; response.end(JSON.stringify(payload())); }
    else if (request.url === '/hanging/user/balance') { request.on('close', () => response.destroy()); }
    else { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const route of ['redirect', 'hanging']) {
      const reader = new BalanceReader({ timeoutMs: 50, resolveConnection: async () => ({ apiKey: 'only-a-local-fixture', baseURL: `http://127.0.0.1:${server.address().port}/${route}` }) });
      const result = await reader.read(); assert.equal(result.status, 'error'); assert.equal(result.alert, null); reader.dispose();
    }
    assert.equal(targetHits, 0);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('a signed upstream balance is preserved while notification thresholds remain nonnegative', async () => {
  const reader = new BalanceReader({ resolveConnection: async () => connection, fetchImpl: async () => response(payload('-0.01', false)) });
  const value = await reader.read(); assert.equal(value.alert, 'empty'); assert.equal(value.balances[0].total, '-0.01');
  assert.throws(() => validateBalanceThresholds({ CNY: '-0.01', USD: '2' })); reader.dispose();
});
