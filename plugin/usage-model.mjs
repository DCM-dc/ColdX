/** Numeric read model of native DSH logs. Never retains prompt, output, paths or tool arguments. */
export const USAGE_MODEL_VERSION = 2;
const dateFormatters = new Map();
const validCount = value => Number.isSafeInteger(value) && value >= 0;
const zero = () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0 });
const coverageZero = () => ({ reportedSteps: 0, missingSteps: 0, cacheReportedSteps: 0, reasoningReportedSteps: 0 });
const add = (target, row) => { for (const key of Object.keys(target)) if (typeof target[key] === 'number') target[key] += row[key] ?? 0; };
const increment = (map, key) => { if (typeof key === 'string' && key && key.length <= 200) map.set(key, (map.get(key) ?? 0) + 1); };
const ranked = map => [...map].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
export function validateTimeZone(timeZone = 'UTC') {
  if (typeof timeZone !== 'string' || timeZone.length > 100) throw new Error('Invalid time zone.');
  try { return new Intl.DateTimeFormat('en-CA', { timeZone }).resolvedOptions().timeZone; }
  catch { throw new Error('Invalid time zone.'); }
}
export function dateKey(time, timeZone) {
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) { formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }); if (dateFormatters.size >= 16) dateFormatters.clear(); dateFormatters.set(timeZone, formatter); }
  const parts = formatter.formatToParts(time);
  const read = type => parts.find(row => row.type === type).value;
  return `${read('year')}-${read('month')}-${read('day')}`;
}
const shiftDate = (date, days) => new Date(Date.parse(date + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);
function normalizeUsage(usage) {
  if (!usage || !validCount(usage.inputTokens) || !validCount(usage.outputTokens)) return null;
  for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    if (usage[key] !== undefined && !validCount(usage[key])) return null;
  }
  if ((usage.reasoningTokens ?? 0) > usage.outputTokens) return null;
  const result = { ...zero(), ...Object.fromEntries(Object.keys(zero()).filter(key => key !== 'totalTokens').map(key => [key, usage[key] ?? 0])) };
  result.totalTokens = result.inputTokens + result.cacheReadTokens + result.cacheWriteTokens + result.outputTokens;
  return Number.isSafeInteger(result.totalTokens) ? result : null;
}
function intervalDuration(intervals) {
  let total = 0, start, end;
  for (const [left, right] of intervals.sort((a, b) => a[0] - b[0])) {
    if (start === undefined) { start = left; end = right; }
    else if (left <= end) end = Math.max(end, right);
    else { total += end - start; start = left; end = right; }
  }
  return total + (start === undefined ? 0 : end - start);
}

export function foldSessionUsage(snapshot, { timeZone = 'UTC' } = {}) {
  timeZone = validateTimeZone(timeZone);
  const header = snapshot?.session ?? snapshot?.meta;
  if (!header || typeof header.id !== 'string' || !Array.isArray(snapshot.events)) throw new Error('Invalid native session snapshot.');
  const seedLength = validCount(header.seedLength) ? header.seedLength : 0;
  const steps = new Map(), calls = new Map(), callScopes = new Map(), turns = new Map(), intervals = [], tools = new Map(), skills = new Map(), efforts = new Map();
  let throughSeq = -1, humanMessages = 0, effort;
  for (const event of snapshot.events) {
    if (!validCount(event?.seq)) continue;
    throughSeq = Math.max(throughSeq, event.seq);
    const data = event.data ?? {};
    if (event.type === 'request/header') effort = data.header?.config?.reasoningEffort;
    if (event.type === 'tool/call' && typeof data.callId === 'string' && validCount(data.turn) && validCount(data.step)) {
      callScopes.set(data.callId, [data.turn, data.step]);
    }
    if (event.seq < seedLength || !validCount(event.time)) continue;
    if (event.type === 'user/message' && (!data.source || ['human', 'user'].includes(data.source.kind))) humanMessages++;
    if (event.type === 'turn/start') turns.set(data.turn, event.time);
    if (event.type === 'turn/end' && turns.has(data.turn)) {
      const start = turns.get(data.turn); turns.delete(data.turn);
      // Recovery synthesizes a close at restart, which cannot measure crash downtime.
      if (event.time >= start && data.reason?.kind !== 'interrupted') intervals.push([start, event.time]);
    }
    if (['step/start', 'step/end', 'assistant/chunk', 'assistant/message'].includes(event.type) && validCount(data.turn) && validCount(data.step)) {
      const key = `${data.turn}:${data.step}`;
      const step = steps.get(key) ?? { time: event.time, usage: null, effort };
      const reported = event.type === 'assistant/message' ? data.usage : data.chunk?.type === 'usage' ? data.chunk.usage : undefined;
      if (reported !== undefined) {
        step.effort = effort;
        step.usage = normalizeUsage(reported);
        step.cacheReported = validCount(reported?.cacheReadTokens);
        step.reasoningReported = validCount(reported?.reasoningTokens);
        step.time = event.time;
      }
      steps.set(key, step);
    }
    if (event.type === 'tool/call' || event.type === 'tool/code-dispatch-start' || event.type === 'tool/code-dispatch') {
      const callId = data.subCallId ?? data.callId;
      if (typeof callId !== 'string' || typeof data.name !== 'string') continue;
      // Provider IDs may repeat in later requests. Native code-dispatch pairs
      // omit turn/step, so inherit them from the preceding root tool/call.
      const scope = validCount(data.turn) && validCount(data.step) ? [data.turn, data.step] : callScopes.get(data.rootCallId) ?? [null, null];
      const key = JSON.stringify([...scope, event.type === 'tool/call' ? 'call' : 'dispatch', callId]);
      if (calls.has(key)) continue;
      calls.set(key, true); increment(tools, data.name);
      if (data.name === 'skill') {
        try { const args = typeof data.arguments === 'string' && data.arguments.length <= 4096 ? JSON.parse(data.arguments) : data.arguments; increment(skills, args?.name); }
        catch { /* Invalid arguments do not identify a skill. */ }
      }
    }
  }
  const totals = zero(), coverage = coverageZero(), days = new Map();
  for (const step of steps.values()) {
    const date = dateKey(step.time, timeZone);
    const day = days.get(date) ?? { date, ...zero(), ...coverageZero() };
    if (step.usage) {
      add(totals, step.usage); add(day, step.usage);
      coverage.reportedSteps++; day.reportedSteps++;
      if (step.cacheReported) { coverage.cacheReportedSteps++; day.cacheReportedSteps++; }
      if (step.reasoningReported) { coverage.reasoningReportedSteps++; day.reasoningReportedSteps++; }
      increment(efforts, step.effort);
    } else { coverage.missingSteps++; day.missingSteps++; }
    days.set(date, day);
  }
  return { version: USAGE_MODEL_VERSION, sessionId: header.id, timeZone, throughSeq, seedLength, isSubagent: header.origin === 'subagent',
    hasActivity: steps.size > 0 || calls.size > 0 || humanMessages > 0, humanMessages, totals, coverage,
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)), activeMs: intervalDuration(intervals),
    openTurns: turns.size, tools: ranked(tools), skills: ranked(skills), efforts: ranked(efforts) };
}

export function summarizeUsage(sessions, { now = Date.now(), timeZone = 'UTC', unavailableSessions = 0, truncated = false } = {}) {
  timeZone = validateTimeZone(timeZone);
  const totals = zero(), coverage = coverageZero(), days = new Map(), tools = new Map(), skills = new Map(), efforts = new Map();
  let longestSessionMs = 0, chatCount = 0, activeMs = 0, openTurns = 0;
  for (const session of sessions) {
    add(totals, session.totals); add(coverage, session.coverage);
    if (!session.isSubagent && session.hasActivity) { chatCount++; longestSessionMs = Math.max(longestSessionMs, session.activeMs); activeMs += session.activeMs; }
    openTurns += session.openTurns;
    for (const row of session.days) {
      const day = days.get(row.date) ?? { date: row.date, ...zero(), ...coverageZero() };
      for (const key of Object.keys(day)) if (key !== 'date') day[key] += row[key] ?? 0;
      days.set(day.date, day);
    }
    for (const [rows, map] of [[session.tools, tools], [session.skills, skills], [session.efforts, efforts]]) for (const row of rows) map.set(row.name, (map.get(row.name) ?? 0) + row.count);
  }
  const daily = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  const activeDates = daily.filter(row => row.reportedSteps + row.missingSteps > 0).map(row => row.date), dates = new Set(activeDates);
  let longestStreak = 0, streak = 0, previous;
  for (const date of activeDates) { streak = previous && shiftDate(previous, 1) === date ? streak + 1 : 1; longestStreak = Math.max(longestStreak, streak); previous = date; }
  let cursor = dateKey(now, timeZone), currentStreak = 0;
  if (!dates.has(cursor)) cursor = shiftDate(cursor, -1);
  while (dates.has(cursor)) { currentStreak++; cursor = shiftDate(cursor, -1); }
  const cacheKnown = coverage.reportedSteps > 0 && coverage.cacheReportedSteps === coverage.reportedSteps;
  const denominator = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
  return { version: USAGE_MODEL_VERSION, generatedAt: now, timeZone, totals, coverage: { ...coverage, unavailableSessions, truncated, complete: !unavailableSessions && !truncated && coverage.missingSteps === 0 },
    summary: { totalTokens: totals.totalTokens, peakDailyTokens: Math.max(0, ...daily.map(row => row.totalTokens)), longestSessionMs, currentStreak, longestStreak, chatCount, activeMs, openTurns },
    cacheHitRatio: cacheKnown && denominator > 0 ? totals.cacheReadTokens / denominator : null,
    days: daily, tools: ranked(tools), skills: ranked(skills), efforts: ranked(efforts) };
}
