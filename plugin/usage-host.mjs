import { mkdir, readFile, rename, writeFile, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { nativeImport } from './page-native.mjs';
import { foldSessionUsage, summarizeUsage, validateTimeZone, USAGE_MODEL_VERSION } from './usage-model.mjs';
import { BalanceReader, DEFAULT_BALANCE_THRESHOLDS, validateBalanceThresholds } from './usage-balance.mjs';

const { TypertRemoteService } = await nativeImport('@deepseek-ai/dsh-typert-protocol');
const { settingsNamespace } = await nativeImport('@deepseek-ai/dsh-settings');
const { default: Schema } = await nativeImport('@deepseek-ai/schemastery');
const { resolveAdapterOptions } = await nativeImport('@deepseek-ai/dsh-llm-deepseek');
const { launchEnvironmentOf } = await nativeImport('@deepseek-ai/dsh-launch-environment');
const { assertUsableApiKey } = await nativeImport('@deepseek-ai/dsh-llm');

export const name = 'coldx-usage';
export const inject = ['sessionQuery', 'settings', 'typert'];
export const USAGE_NAMESPACE = settingsNamespace('coldx-usage');
const settingsSchema = Schema.object({ balanceEnabled: Schema.boolean().default(true), thresholdCNY: Schema.string().default('10'), thresholdUSD: Schema.string().default('2') });
export const USAGE_INVOCATIONS = ['read', 'balance', 'settings'].map(method => ({
  id: `coldx-usage:${method}`, service: 'coldxUsage', namespace: 'coldxUsage', method, invocation: { kind: 'direct' },
  parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'src-json' } }], cancellation: { parameter: 'signal' }, result: { mode: 'src-json' },
}));
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw Error('Invalid usage request.');
}

/** Uses the same native connection resolution as the provider adapter, including its credential seam. */
export async function resolveBalanceConnection(ctx) {
  const configured = ctx.settings.get(settingsNamespace('llm-deepseek'));
  if (!configured) return undefined;
  let environment;
  try { environment = launchEnvironmentOf(ctx); } catch { /* Programmatic hosts may not have launch environment. */ }
  const connection = resolveAdapterOptions(configured, environment), ref = connection.apiKeyEnv;
  const credentials = ctx.get?.('credentials');
  const hit = credentials ? await credentials.resolve(ref) : environment?.get(ref);
  if (!hit?.value) return undefined;
  return { baseURL: connection.baseURL, apiKey: assertUsableApiKey(hit.value, 'coldx-usage', ref) };
}

const count = value => Number.isSafeInteger(value) && value >= 0;
function safeCachedSummary(value) {
  if (!value || value.version !== USAGE_MODEL_VERSION || typeof value.sessionId !== 'string' || value.sessionId.length > 256 || !Number.isInteger(value.throughSeq) || value.throughSeq < -1) return null;
  try {
    validateTimeZone(value.timeZone);
    const pickCounts = (source, keys) => Object.fromEntries(keys.map(key => { if (!count(source?.[key])) throw Error('Invalid cache.'); return [key, source[key]]; }));
    const tokenKeys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'];
    const coverageKeys = ['reportedSteps', 'missingSteps', 'cacheReportedSteps', 'reasoningReportedSteps'];
    const rows = key => { if (!Array.isArray(value[key]) || value[key].length > 20000) throw Error('Invalid cache.'); return value[key].map(row => { if (typeof row.name !== 'string' || row.name.length > 200 || !count(row.count)) throw Error('Invalid cache.'); return { name: row.name, count: row.count }; }); };
    if (!Array.isArray(value.days) || value.days.length > 40000) return null;
    return { version: USAGE_MODEL_VERSION, sessionId: value.sessionId, timeZone: value.timeZone, throughSeq: value.throughSeq, ...pickCounts(value, ['seedLength', 'humanMessages', 'activeMs', 'openTurns']),
      isSubagent: value.isSubagent === true, hasActivity: value.hasActivity === true, totals: pickCounts(value.totals, tokenKeys), coverage: pickCounts(value.coverage, coverageKeys),
      days: value.days.map(day => { if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date)) throw Error('Invalid cache.'); return { date: day.date, ...pickCounts(day, [...tokenKeys, ...coverageKeys]) }; }),
      tools: rows('tools'), skills: rows('skills'), efforts: rows('efforts') };
  } catch { return null; }
}

/** Detached metrics cache. Source logs remain native and are read through sessionQuery, never scraped from disk. */
export class UsageLedger {
  constructor({ query, cachePath, revisions, maxSessions = 10000, now = Date.now } = {}) {
    this.query = query; this.cachePath = cachePath; this.revisions = revisions; this.maxSessions = maxSessions; this.now = now;
    this.cache = new Map(); this.dirty = new Set(); this.lifetime = new AbortController(); this.tail = Promise.resolve(); this.loaded = false; this.cacheNotice = null;
  }
  invalidate(id) { if (typeof id === 'string') this.dirty.add(id); }
  read({ timeZone = 'UTC' } = {}, signal) {
    timeZone = validateTimeZone(timeZone);
    const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    const operation = this.tail.then(() => this.scan(timeZone, combined));
    this.tail = operation.catch(() => {}); return operation;
  }
  async load() {
    if (this.loaded) return; this.loaded = true;
    if (!this.cachePath) return;
    try {
      if ((await stat(this.cachePath)).size > 16 * 1024 * 1024) return;
      const text = await readFile(this.cachePath, 'utf8'); if (text.length > 16 * 1024 * 1024) return;
      const saved = JSON.parse(text); if (saved.version !== USAGE_MODEL_VERSION || !Array.isArray(saved.entries)) return;
      for (const entry of saved.entries.slice(0, this.maxSessions)) {
        const summary = safeCachedSummary(entry.summary);
        if (summary) this.cache.set(summary.sessionId, { summary, revision: typeof entry.revision === 'string' && entry.revision.length <= 200 ? entry.revision : null, verified: false });
      }
    } catch { /* Missing or damaged derived cache is rebuilt from native history. */ }
  }
  async scan(timeZone, signal) {
    signal.throwIfAborted(); await this.load(); signal.throwIfAborted();
    const records = await this.query.listSessions(signal); signal.throwIfAborted();
    const unique = [...new Map(records.map(row => [row.header.id, row])).values()];
    const known = new Set(unique.map(row => row.header.id));
    for (const id of this.cache.keys()) if (!known.has(id)) { this.cache.delete(id); this.dirty.delete(id); }
    const selected = unique.slice(0, this.maxSessions), revisions = this.revisions ? await this.revisions(signal) : new Map();
    const summaries = []; let unavailableSessions = 0;
    // Two readers bound transient log memory and do not start or resume agents.
    let cursor = 0;
    const scans = await Promise.allSettled([0, 1].map(async () => {
      while (cursor < selected.length) {
        signal.throwIfAborted(); const record = selected[cursor++], id = record.header.id, entry = this.cache.get(id), revision = revisions.get(id);
        const unchanged = entry && entry.summary.timeZone === timeZone && !this.dirty.has(id)
          && (revision !== undefined ? entry.revision === revision : entry.verified);
        if (unchanged) { summaries.push(entry.summary); continue; }
        // Remove dirtiness before the read; events arriving during the read mark it again.
        this.dirty.delete(id);
        try {
          const log = await this.query.readSession(id); signal.throwIfAborted();
          const summary = foldSessionUsage(log, { timeZone });
          this.cache.set(id, { summary, revision: revision ?? null, verified: true }); summaries.push(summary);
        } catch (error) { signal.throwIfAborted(); unavailableSessions++; this.dirty.add(id); }
      }
    }));
    for (const scan of scans) if (scan.status === 'rejected') throw scan.reason;
    signal.throwIfAborted();
    await this.persist(); signal.throwIfAborted();
    const result = summarizeUsage(summaries, { now: this.now(), timeZone, unavailableSessions, truncated: unique.length > selected.length });
    return { ...result, indexedSessions: summaries.length, knownSessions: unique.length, notice: this.cacheNotice,
      scope: 'local-session-history', limitations: '仅统计本地会话记录的模型用量；未返回 usage 的调用和未记录的辅助请求不在已知总量中，不等于上游账单。' };
  }
  async persist() {
    if (!this.cachePath) return;
    let temp;
    try {
      await mkdir(dirname(this.cachePath), { recursive: true });
      temp = this.cachePath + '.' + randomUUID() + '.tmp';
      await writeFile(temp, JSON.stringify({ version: USAGE_MODEL_VERSION, entries: [...this.cache.values()].map(({ summary, revision }) => ({ summary, revision })) }), { mode: 0o600 });
      await rename(temp, this.cachePath); this.cacheNotice = null;
    } catch { this.cacheNotice = '本地统计缓存暂时无法保存；下次启动会从会话记录重建。'; }
    finally { if (temp) await unlink(temp).catch(() => {}); }
  }
  async dispose() { this.lifetime.abort(new Error('Usage ledger closed.')); await this.tail; }
}

export class UsageService extends TypertRemoteService {
  constructor(ctx, { profileDir, query = ctx.sessionQuery, fetchImpl } = {}) {
    super(ctx, 'coldxUsage');
    this.scope = ctx.settings.register(USAGE_NAMESPACE, settingsSchema, { base: { balanceEnabled: true, thresholdCNY: '10', thresholdUSD: '2' }, applies: 'live' });
    this.ledger = new UsageLedger({ query, cachePath: profileDir ? join(profileDir, '.coldx-usage', 'metrics-v1.json') : undefined, revisions: async signal => {
      const values = new Map(); const persistence = ctx.get?.('sessionPersistence');
      if (persistence?.listSnapshots) for (const row of await persistence.listSnapshots(signal)) values.set(row.header.id, String(row.revision));
      for (const session of ctx.get?.('sessions')?.list?.() ?? []) values.set(session.id, `live:${session.events.length}:${session.events.at(-1)?.time ?? 0}`);
      return values;
    } });
    this.reader = new BalanceReader({ resolveConnection: () => resolveBalanceConnection(ctx), ...(fetchImpl ? { fetchImpl } : {}) });
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/chunk' || event.data?.chunk?.type === 'usage') this.ledger.invalidate(session.id);
    });
    ctx.effect(() => async () => { this.reader.dispose(); await this.ledger.dispose(); });
  }
  currentSettings() {
    const value = this.scope.get();
    let thresholds; try { thresholds = validateBalanceThresholds({ CNY: value.thresholdCNY, USD: value.thresholdUSD }); } catch { thresholds = { ...DEFAULT_BALANCE_THRESHOLDS }; }
    return { balanceEnabled: value.balanceEnabled === true, thresholds };
  }
  read(request, signal) { object(request, ['timeZone']); return this.ledger.read(request, signal); }
  async balance(request, signal) {
    object(request, ['refresh']); if (request.refresh !== undefined && typeof request.refresh !== 'boolean') throw Error('Invalid refresh request.');
    signal?.throwIfAborted(); const settings = this.currentSettings();
    if (!settings.balanceEnabled) return this.reader.empty('disabled', '自动余额查询已关闭。', settings.thresholds);
    return this.reader.read({ ...request, thresholds: settings.thresholds }, signal);
  }
  async settings(request, signal) {
    object(request, ['balanceEnabled', 'thresholds']); signal?.throwIfAborted(); const patch = {};
    if (request.balanceEnabled !== undefined) { if (typeof request.balanceEnabled !== 'boolean') throw Error('Invalid balance setting.'); patch.balanceEnabled = request.balanceEnabled; }
    if (request.thresholds !== undefined) { const value = validateBalanceThresholds(request.thresholds); patch.thresholdCNY = value.CNY; patch.thresholdUSD = value.USD; }
    if (Object.keys(patch).length) await this.ctx.settings.update(USAGE_NAMESPACE, patch);
    return this.currentSettings();
  }
}
export function apply(ctx, config = {}) {
  new UsageService(ctx, config);
  ctx.typert.register({ package: 'coldx-usage', face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: USAGE_INVOCATIONS });
}
