import { randomUUID } from 'node:crypto';
import { nativeImport } from './page-native.mjs';

const { isAgentLoopRequest } = await nativeImport('@deepseek-ai/dsh-llm');
const { scopeOf, scopeChainOf } = await nativeImport('@deepseek-ai/dsh-scope');

export const name = 'coldx-protocol-guard';
export const inject = ['llm', 'agents'];

const DSML_TOKENS = ['|DSML|', '｜DSML｜', '||DSML||'];
const DSML_OPENINGS = DSML_TOKENS.map(token => `<${token}tool_calls>`);
const CANONICAL_OPEN = '<|DSML|tool_calls>';
const CANONICAL_CLOSE = '</|DSML|tool_calls>';
const AGENT_DONE_MARKER = '<|DS2_AGENT_DONE|>';
const LOOKBEHIND = Math.max(AGENT_DONE_MARKER.length, ...DSML_OPENINGS.map(value => value.length)) + 16;
const IDLE_REMINDER = "<system-reminder>The user has not sent any new message. Do not perform any new work. Do not call any tools. Wait for the user's next instruction.</system-reminder>";

function normalizedControlText(value) {
  return value.trim().replace(/\s+/g, ' ');
}

function latestHumanMessage(options) {
  if (!Array.isArray(options?.messages)) return undefined;
  for (let index = options.messages.length - 1; index >= 0; index--) {
    const message = options.messages[index];
    if (message?.role === 'user' && message.source?.kind === 'user') return message;
  }
}

function latestHumanIncludes(options, value, normalize = false) {
  const message = latestHumanMessage(options);
  return Array.isArray(message?.content) && message.content.some(block => block?.type === 'text'
    && (normalize ? normalizedControlText(block.text).includes(value) : block.text.includes(value)));
}

function humanSuppliedReminder(options) {
  return latestHumanIncludes(options, IDLE_REMINDER, true);
}

function humanSuppliedAgentDone(options) {
  return latestHumanIncludes(options, AGENT_DONE_MARKER);
}

function normalizeDsmlTags(value) {
  return value.replaceAll('｜DSML｜', '|DSML|').replaceAll('||DSML||', '|DSML|');
}

function lineBoundaryBefore(value, index) {
  const lineStart = value.lastIndexOf('\n', index - 1) + 1;
  return value.slice(lineStart, index).trim() === '';
}

function insideMarkdownFence(value, index) {
  let fence;
  for (const line of value.slice(0, index).split(/\r?\n/)) {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!match) continue;
    if (!fence) fence = match[1];
    else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = undefined;
  }
  return fence !== undefined;
}

function findDsmlStart(value) {
  let best = -1;
  for (const opening of DSML_OPENINGS) {
    let from = 0;
    while (from < value.length) {
      const index = value.indexOf(opening, from);
      if (index < 0) break;
      if (lineBoundaryBefore(value, index) && !insideMarkdownFence(value, index)
        && (best < 0 || index < best)) best = index;
      from = index + opening.length;
    }
  }
  return best;
}

function literalAgentDoneAt(value, index) {
  if (insideMarkdownFence(value, index)) return true;
  const lineStart = value.lastIndexOf('\n', index - 1) + 1;
  const prefix = value.slice(lineStart, index);
  // Quoted and indented examples are content, not control output. Ordinary prose
  // followed by the private marker is still control output and must be cleaned.
  return /^ {0,3}>/.test(prefix) || /^(?: {4}|\t)/.test(prefix);
}

function findAgentDoneCandidate(value) {
  let from = 0;
  while (from < value.length) {
    const index = value.indexOf(AGENT_DONE_MARKER, from);
    if (index < 0) return -1;
    if (!literalAgentDoneAt(value, index)) return index;
    from = index + AGENT_DONE_MARKER.length;
  }
  return -1;
}

function findAgentDoneTail(value) {
  const match = /<\|DS2_AGENT_DONE\|>[ \t]*(?:\r?\n[ \t]*)*$/.exec(value);
  if (!match || literalAgentDoneAt(value, match.index)) return -1;
  return match.index;
}

function decodeParameterBody(raw) {
  let value = raw.trim();
  if (value.startsWith('<![CDATA[')) value = value.slice('<![CDATA['.length);
  else if (value.startsWith('<![CDATA')) value = value.slice('<![CDATA'.length);
  if (value.endsWith(']]>')) value = value.slice(0, -3);
  return value.trim();
}

function jsonValue(value) {
  try { return { ok: true, value: JSON.parse(value) }; }
  catch { return { ok: false }; }
}

function inferredValue(value, schema, stringFlag) {
  if (stringFlag === 'true') return { ok: true, value };
  if (stringFlag === 'false') return jsonValue(value);
  const type = Array.isArray(schema?.type) ? schema.type.find(item => item !== 'null') : schema?.type;
  if (type === 'string') return { ok: true, value };
  if (['number', 'integer', 'boolean', 'array', 'object', 'null'].includes(type)) {
    const parsed = jsonValue(value);
    if (!parsed.ok) return parsed;
    if (type === 'integer' && (!Number.isInteger(parsed.value))) return { ok: false };
    if (type === 'number' && typeof parsed.value !== 'number') return { ok: false };
    if (type === 'boolean' && typeof parsed.value !== 'boolean') return { ok: false };
    if (type === 'array' && !Array.isArray(parsed.value)) return { ok: false };
    if (type === 'object' && (parsed.value === null || Array.isArray(parsed.value) || typeof parsed.value !== 'object')) return { ok: false };
    if (type === 'null' && parsed.value !== null) return { ok: false };
    return parsed;
  }
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) return { ok: true, value: Number(value) };
  if (value === 'true') return { ok: true, value: true };
  if (value === 'false') return { ok: true, value: false };
  if (value === 'null') return { ok: true, value: null };
  if (/^[\[{\"]/.test(value)) {
    const parsed = jsonValue(value);
    if (parsed.ok) return parsed;
  }
  return { ok: true, value };
}

function toolDirectory(tools) {
  if (tools instanceof Set) return new Map([...tools].map(toolName => [toolName, undefined]));
  if (!Array.isArray(tools)) return new Map();
  return new Map(tools.filter(tool => typeof tool?.name === 'string').map(tool => [tool.name, tool]));
}

/** Parse only a complete DSML tail whose tools are present in this exact request. */
export function parseDsmlToolCalls(source, tools) {
  const directory = toolDirectory(tools);
  const input = normalizeDsmlTags(source).trim();
  if (!input.startsWith(CANONICAL_OPEN) || !input.endsWith(CANONICAL_CLOSE)) return null;
  const body = input.slice(CANONICAL_OPEN.length, -CANONICAL_CLOSE.length);
  const invoke = /<\|DSML\|invoke\b([^>]*)>([\s\S]*?)<\/\|DSML\|invoke\s*>/g;
  const calls = [];
  let cursor = 0;
  for (let match; (match = invoke.exec(body));) {
    if (body.slice(cursor, match.index).trim()) return null;
    cursor = invoke.lastIndex;
    const nameMatch = /\bname\s*=\s*(["'])([^"']+)\1/.exec(match[1]);
    const toolName = nameMatch?.[2];
    if (!toolName || !/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(toolName) || !directory.has(toolName)) return null;
    const tool = directory.get(toolName);
    const properties = tool?.parameters?.properties ?? {};
    const args = {};
    const parameter = /<\|DSML\|parameter\b([^>]*)>([\s\S]*?)<\/\|DSML\|parameter\s*>/g;
    let parameterCursor = 0;
    for (let item; (item = parameter.exec(match[2]));) {
      if (match[2].slice(parameterCursor, item.index).trim()) return null;
      parameterCursor = parameter.lastIndex;
      const parameterName = /\bname\s*=\s*(["'])([^"']+)\1/.exec(item[1])?.[2];
      const stringFlag = /\bstring\s*=\s*(["'])(true|false)\1/.exec(item[1])?.[2];
      if (!parameterName || Object.hasOwn(args, parameterName)) return null;
      const decoded = inferredValue(decodeParameterBody(item[2]), properties[parameterName], stringFlag);
      if (!decoded.ok) return null;
      args[parameterName] = decoded.value;
    }
    if (match[2].slice(parameterCursor).trim()) return null;
    calls.push({ name: toolName, arguments: args });
  }
  if (body.slice(cursor).trim() || calls.length === 0) return null;
  return calls;
}

function textState() {
  return {
    raw: '', cursor: 0, output: '', marker: -1, agentDoneCandidate: -1,
    outputIndex: undefined, ended: false, finalText: undefined,
  };
}

function textChunks(state, value, allocate, skipTo) {
  const chunks = [];
  if (value) {
    state.outputIndex ??= allocate();
    if (state.output === '') chunks.push({ type: 'block-start', index: state.outputIndex, blockType: 'text' });
    state.output += value;
    chunks.push({ type: 'text-delta', index: state.outputIndex, text: value });
  }
  state.cursor = skipTo;
  return chunks;
}

function completeText(state, allocate) {
  if (state.outputIndex === undefined && state.output === '') return [];
  state.outputIndex ??= allocate();
  return [{ type: 'block-end', index: state.outputIndex, block: { type: 'text', text: state.output } }];
}

/**
 * Normalize model-emitted DSML back into DSH's native stream vocabulary.
 * Rewritten calls still pass through the ordinary Agent Loop tool scheduler.
 */
export async function* repairProtocolStream(stream, options = {}) {
  const texts = new Map();
  const mapped = new Map();
  const nativeToolIndexes = new Set();
  const synthesized = [];
  const usages = [];
  const deferred = [];
  let nextIndex = 0;
  let rewritten = false;
  const preserveIdleReminder = humanSuppliedReminder(options);
  const preserveAgentDone = humanSuppliedAgentDone(options);
  const allocate = () => nextIndex++;
  const mapIndex = upstream => {
    if (!mapped.has(upstream)) mapped.set(upstream, allocate());
    return mapped.get(upstream);
  };
  function* emitNonText(chunk) {
    if (chunk.type === 'block-start') {
      const index = mapIndex(chunk.index);
      if (chunk.blockType === 'tool-call') nativeToolIndexes.add(chunk.index);
      yield { ...chunk, index };
      return;
    }
    if (chunk.type === 'tool-call-delta') {
      nativeToolIndexes.add(chunk.index);
      yield { ...chunk, index: mapIndex(chunk.index) };
      return;
    }
    if (chunk.type === 'reasoning-delta') {
      yield { ...chunk, index: mapIndex(chunk.index) };
      return;
    }
    if (chunk.type === 'block-end') {
      if (chunk.block.type === 'tool-call') nativeToolIndexes.add(chunk.index);
      yield { ...chunk, index: mapIndex(chunk.index) };
      return;
    }
    yield chunk;
  }
  function* flushDeferred() {
    for (const pending of deferred.splice(0)) yield* emitNonText(pending);
  }
  function* finalizeText(state, finalText = state.raw) {
    if (finalText !== state.raw) rewritten = true;
    state.raw = finalText;
    const agentDone = preserveAgentDone ? -1 : findAgentDoneTail(finalText);
    const protocolText = agentDone < 0 ? finalText : finalText.slice(0, agentDone).trimEnd();
    const marker = findDsmlStart(protocolText);
    let visible = protocolText;
    if (marker >= 0) {
      visible = protocolText.slice(0, marker).trimEnd();
      const calls = parseDsmlToolCalls(protocolText.slice(marker), options.tools);
      rewritten = true;
      if (calls) synthesized.push(...calls);
    } else if (agentDone >= 0) {
      rewritten = true;
    } else if (!preserveIdleReminder && normalizedControlText(finalText) === IDLE_REMINDER) {
      rewritten = true;
      visible = '';
    }
    if (visible.startsWith(state.output)) {
      const remainder = visible.slice(state.output.length);
      if (remainder) yield* textChunks(state, remainder, allocate, finalText.length);
    } else {
      if (state.outputIndex === undefined && visible) {
        state.outputIndex = allocate();
        yield { type: 'block-start', index: state.outputIndex, blockType: 'text' };
      }
      state.output = visible;
      state.cursor = finalText.length;
    }
    yield* completeText(state, allocate);
  }
  function* flushEndedTexts() {
    while (texts.size > 0) {
      const [index, state] = texts.entries().next().value;
      if (!state.ended) break;
      yield* finalizeText(state, state.finalText);
      texts.delete(index);
    }
    if (texts.size === 0) yield* flushDeferred();
  }

  for await (const chunk of stream) {
    if (chunk.type === 'usage') { usages.push(chunk); continue; }
    if (chunk.type === 'block-start' && chunk.blockType === 'text') {
      if (!texts.has(chunk.index)) texts.set(chunk.index, textState());
      continue;
    }
    if (chunk.type === 'text-delta') {
      const state = texts.get(chunk.index) ?? textState();
      texts.set(chunk.index, state);
      state.raw += chunk.text;
      if (texts.keys().next().value !== chunk.index) continue;
      if (state.marker < 0) state.marker = findDsmlStart(state.raw);
      if (!preserveAgentDone && state.agentDoneCandidate < 0) {
        state.agentDoneCandidate = findAgentDoneCandidate(state.raw);
      }
      const controlStart = [state.marker, state.agentDoneCandidate]
        .filter(index => index >= 0).reduce((first, index) => Math.min(first, index), Infinity);
      if (Number.isFinite(controlStart)) {
        if (state.cursor < controlStart) {
          let visibleEnd = controlStart;
          while (visibleEnd > state.cursor && /\s/.test(state.raw[visibleEnd - 1])) visibleEnd--;
          // DSML owns the whitespace before its private tail. An agent-done
          // candidate may turn out to be literal prose, so retain that gap
          // until block-end can decide without losing user-visible spacing.
          const skipTo = state.marker === controlStart ? controlStart : visibleEnd;
          for (const output of textChunks(state, state.raw.slice(state.cursor, visibleEnd), allocate, skipTo)) yield output;
        }
        continue;
      }
      const reminderPrefix = normalizedControlText(state.raw);
      if (!preserveIdleReminder && reminderPrefix && IDLE_REMINDER.startsWith(reminderPrefix)) continue;
      const safeEnd = Math.max(state.cursor, state.raw.length - LOOKBEHIND);
      if (safeEnd > state.cursor) for (const output of textChunks(state, state.raw.slice(state.cursor, safeEnd), allocate, safeEnd)) yield output;
      continue;
    }
    if (chunk.type === 'block-end' && chunk.block.type === 'text') {
      const state = texts.get(chunk.index) ?? textState();
      texts.set(chunk.index, state);
      state.ended = true;
      state.finalText = chunk.block.text;
      yield* flushEndedTexts();
      continue;
    }
    if (chunk.type !== 'finish') {
      if (texts.size > 0) deferred.push(chunk);
      else yield* emitNonText(chunk);
      continue;
    }

    if (texts.size > 0) rewritten = true;
    for (const [index, state] of texts) {
      yield* finalizeText(state, state.ended ? state.finalText : state.raw);
      texts.delete(index);
    }
    yield* flushDeferred();

    if (synthesized.length > 0 && nativeToolIndexes.size === 0 && chunk.reason.kind === 'stop') {
      for (const call of synthesized) {
        const index = allocate();
        const id = `coldx-dsml-${randomUUID()}`;
        const args = JSON.stringify(call.arguments);
        yield { type: 'block-start', index, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: args };
        yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: args } };
      }
      for (const usage of usages) yield usage;
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      continue;
    }
    for (const usage of usages) yield usage;
    if (rewritten) yield { type: 'finish', reason: chunk.reason };
    else yield chunk;
  }
}

/** Install the normalizer only for Agent requests in this preset's scope. */
export function apply(ctx) {
  const owner = scopeOf(ctx);
  if (!owner) return;
  ctx.on('llm/stream', (options, next) => {
    if (options.provider !== 'deepseek-official' || !isAgentLoopRequest(options) || !options.sessionId) return next();
    const agent = ctx.agents.get(options.sessionId);
    if (!agent || !scopeChainOf(agent).includes(owner)) return next();
    return repairProtocolStream(next(), options);
  }, { global: true, prepend: true });
}
