import { createHash } from 'node:crypto';

export const DEFAULT_BALANCE_THRESHOLDS = Object.freeze({ CNY: '10', USD: '2' });
const decimalPattern = /^\d{1,18}(?:\.\d{1,18})?$/;
function decimal(value, signed = false) {
  if (typeof value !== 'string' || !(signed ? /^-?\d{1,18}(?:\.\d{1,18})?$/ : decimalPattern).test(value)) throw new Error('Invalid decimal balance.');
  return value;
}
function lessThan(left, right) {
  const [li, lf = ''] = decimal(left, true).split('.'), [ri, rf = ''] = decimal(right).split('.');
  const digits = Math.max(lf.length, rf.length);
  return BigInt(li + lf.padEnd(digits, '0')) < BigInt(ri + rf.padEnd(digits, '0'));
}
export function validateBalanceThresholds(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['CNY', 'USD'].includes(key))) throw Error('余额阈值格式无效。');
  return { CNY: decimal(value.CNY), USD: decimal(value.USD) };
}
export function balanceEndpoint(baseURL) {
  const url = new URL(baseURL);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('Unsupported balance endpoint.');
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('Balance checks require HTTPS.');
  let path = url.pathname.replace(/\/+$/, '');
  if (url.hostname === 'api.deepseek.com' && ['/v1', '/beta'].includes(path)) path = '';
  url.pathname = path + '/user/balance';
  return url.href;
}
async function boundedJson(response, signal) {
  if (Number(response.headers.get('content-length') ?? 0) > 65536) throw Error('Oversize response.');
  if (!response.body) throw Error('Empty response.');
  const reader = response.body.getReader(); let size = 0; const chunks = [];
  try {
    for (;;) {
      signal.throwIfAborted(); const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > 65536) throw Error('Oversize response.'); chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function parseBalances(value) {
  if (!value || typeof value.is_available !== 'boolean' || !Array.isArray(value.balance_infos) || value.balance_infos.length > 8) throw Error('Invalid balance response.');
  const currencies = new Set();
  const balances = value.balance_infos.map(row => {
    if (!row || !['CNY', 'USD'].includes(row.currency) || currencies.has(row.currency)) throw Error('Invalid balance currency.');
    currencies.add(row.currency);
    return { currency: row.currency, total: decimal(row.total_balance, true), granted: decimal(row.granted_balance, true), toppedUp: decimal(row.topped_up_balance, true) };
  });
  return { available: value.is_available, balances };
}
function aborted(signal, promise) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason); signal.addEventListener('abort', cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

/** Secret-bearing inputs stay inside this host object. Returned snapshots use an explicit allowlist. */
export class BalanceReader {
  constructor({ resolveConnection, fetchImpl = fetch, now = Date.now, timeoutMs = 8000 } = {}) {
    this.resolveConnection = resolveConnection; this.fetchImpl = fetchImpl; this.now = now; this.timeoutMs = timeoutMs;
    this.lifetime = new AbortController(); this.entries = new Map(); this.pending = new Map();
  }
  async read({ refresh = false, thresholds = DEFAULT_BALANCE_THRESHOLDS } = {}, signal) {
    signal?.throwIfAborted(); this.lifetime.signal.throwIfAborted(); thresholds = validateBalanceThresholds(thresholds);
    let connection, endpoint;
    try { connection = await this.resolveConnection(); if (!connection?.apiKey) return this.empty('unconfigured', '请先在模型设置中配置上游 API。', thresholds); endpoint = balanceEndpoint(connection.baseURL); }
    catch { return this.empty('unconfigured', '当前上游连接尚未配置，或不支持安全余额查询。', thresholds); }
    const identity = createHash('sha256').update(endpoint).update('\0').update(connection.apiKey).digest('hex');
    const old = this.entries.get(identity), elapsed = this.now() - (old?.attemptedAt ?? -Infinity);
    let entry = old;
    if (!old || elapsed >= (refresh ? 15000 : 300000)) {
      let pending = this.pending.get(identity);
      if (!pending) {
        pending = this.fetchBalance(endpoint, connection.apiKey, old).then(result => {
          this.entries.set(identity, result);
          while (this.entries.size > 8) this.entries.delete(this.entries.keys().next().value);
          return result;
        }).finally(() => this.pending.delete(identity));
        this.pending.set(identity, pending);
      }
      entry = await aborted(signal, pending);
    }
    signal?.throwIfAborted();
    const balances = (entry?.balances ?? []).map(row => ({ ...row, low: lessThan(row.total, thresholds[row.currency]) }));
    return { status: entry.status, checkedAt: entry.checkedAt ?? null, attemptedAt: entry.attemptedAt, stale: entry.status !== 'ok' && entry.checkedAt != null,
      available: entry.status === 'ok' ? entry.available : null, balances, thresholds, origin: new URL(endpoint).origin,
      alert: entry.status !== 'ok' ? null : entry.available === false ? 'empty' : balances.some(row => row.low) ? 'low' : null,
      message: entry.message ?? null };
  }
  empty(status, message, thresholds) { return { status, checkedAt: null, attemptedAt: null, stale: false, available: null, balances: [], alert: null, thresholds, origin: null, message }; }
  async fetchBalance(endpoint, apiKey, old) {
    const attemptedAt = this.now(), signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.timeoutMs)]);
    let response;
    try {
      response = await this.fetchImpl(endpoint, { method: 'GET', redirect: 'error', headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` }, signal });
      if (response.status === 404 || response.status === 405 || response.status === 501) { await response.body?.cancel(); return { status: 'unsupported', attemptedAt, message: '当前上游没有可用的余额查询接口。' }; }
      if (response.status === 402) { await response.body?.cancel(); return { status: 'ok', attemptedAt, checkedAt: attemptedAt, available: false, balances: [], message: '上游返回余额不足。' }; }
      if (!response.ok) { await response.body?.cancel(); return { ...old, status: 'error', attemptedAt, message: response.status === 401 || response.status === 403 ? '余额查询认证失败，请检查模型设置。' : '上游暂时无法查询余额，请稍后重试。' }; }
      const parsed = parseBalances(await boundedJson(response, signal));
      return { status: 'ok', attemptedAt, checkedAt: this.now(), ...parsed };
    } catch {
      this.lifetime.signal.throwIfAborted();
      return { ...old, status: 'error', attemptedAt, message: '余额暂时无法查询，请检查网络或稍后重试。' };
    }
  }
  dispose() { this.lifetime.abort(new Error('Balance reader closed.')); this.entries.clear(); }
}
