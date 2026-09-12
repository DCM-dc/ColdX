import { createRequire } from 'node:module';
import { dshRequire } from './page-native.mjs';
import { normalizePageInput } from './page-input.mjs';
import { isExplicitTextOnly } from './page-opportunity.mjs';

const { z } = createRequire(dshRequire.resolve('@deepseek-ai/dsh-session-projection'))('zod');
export const PAGE_TOOL = 'coldx_present_page';
export const PAGE_PROJECTION = 'coldx.pages';
export const questionIdOf = pageId => `coldx-page:${pageId}:1`;

const pageSchema = z.object({
  pageId: z.string(), rootCallId: z.string(), revision: z.literal(1), questionId: z.string(),
  title: z.string(), subtitle: z.string(), html: z.string(), css: z.string(), script: z.string(),
  waitForInput: z.boolean(),
  status: z.enum(['waiting', 'selected', 'displayed', 'cancelled', 'interrupted']),
  value: z.json(),
  sequence: z.number().default(0),
  resultText: z.string().optional(),
});
const viewSchema = z.object({ pages: z.array(pageSchema), activePageId: z.string().nullable() });
const stateSchema = z.object({
  pages: z.array(pageSchema.extend({ turn: z.number().nullable() })),
  activePageId: z.string().nullable(), currentTurn: z.number().nullable(),
  resultCandidate: z.object({ turn: z.number(), text: z.string() }).nullable(),
  textOnlyTurn: z.number().nullable(),
});

function parseJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

function fromCall(pageId, args, rootCallId = pageId) {
  if (typeof pageId !== 'string' || !pageId || typeof rootCallId !== 'string') return undefined;
  let source;
  try { source = normalizePageInput(args); } catch { return undefined; }
  return {
    pageId, rootCallId, revision: 1, questionId: questionIdOf(pageId),
    ...source, status: source.waitForInput ? 'waiting' : 'displayed', value: null,
  };
}

function parsedResult(content) {
  for (const block of content ?? []) {
    if (block.type !== 'text') continue;
    const value = parseJson(block.text);
    if (value && typeof value === 'object' && typeof value.pageId === 'string') return value;
  }
}

function textOnly(message) {
  if (message?.source?.kind !== 'user') return false;
  const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  return isExplicitTextOnly(text);
}

function resultPage(state, data, sequence = 0) {
  const answer = state.resultCandidate;
  if (data.reason?.kind !== 'completed' || !answer || answer.turn !== data.turn || state.textOnlyTurn === data.turn) return undefined;
  const selectedIndex = state.pages.findLastIndex(page => page.turn === data.turn && page.status === 'selected');
  if (selectedIndex < 0 || state.pages.some(page => page.turn === data.turn && page.status === 'waiting')) return undefined;
  if (state.pages.slice(selectedIndex + 1).some(page => page.turn === data.turn && page.status === 'displayed')) return undefined;
  const pageId = `coldx-result:turn:${data.turn}`;
  if (state.pages.some(page => page.pageId === pageId)) return undefined;
  const escaped = answer.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  // A view derived from the real answer, not a tool execution or new log record.
  return {
    pageId, rootCallId: pageId, revision: 1, questionId: questionIdOf(pageId),
    title: '本次结果', subtitle: '根据你的选择', resultText: answer.text,
    html: `<article style="white-space:pre-wrap;overflow-wrap:anywhere">${escaped}</article>`,
    css: '', script: '', waitForInput: false, status: 'displayed', value: null, turn: data.turn, sequence,
  };
}

/** Pure fold over rc.2's durable, recognized events; no new Session event type. */
export function applyPageEvent(state, event) {
  const data = event.data;
  if (event.type === 'turn/start') {
    return { ...state, currentTurn: data.turn, resultCandidate: null, textOnlyTurn: null };
  }
  if (event.type === 'user/message') {
    return textOnly(data) ? { ...state, textOnlyTurn: state.currentTurn } : state;
  }
  if (event.type === 'assistant/message') {
    const blocks = data.message.content;
    const plain = !data.interrupted && blocks.every(block => block.type === 'text' || block.type === 'reasoning');
    const text = plain ? blocks.filter(block => block.type === 'text').map(block => block.text).join('\n\n').trim() : '';
    return { ...state, resultCandidate: text ? { turn: data.turn, text } : null };
  }
  const start = event.type === 'tool/call' || event.type === 'tool/code-dispatch-start';
  if (start) {
    const currentTurn = event.type === 'tool/call' && Number.isInteger(data.turn) ? data.turn : state.currentTurn;
    if (data.name !== PAGE_TOOL) return currentTurn === state.currentTurn ? state : { ...state, currentTurn };
    const id = event.type === 'tool/call' ? data.callId : data.subCallId;
    const args = typeof data.arguments === 'string' ? parseJson(data.arguments) : data.arguments;
    const page = fromCall(id, args, data.rootCallId ?? id);
    if (!page || state.pages.some(item => item.pageId === id)) return state;
    return { ...state, pages: [...state.pages, { ...page, turn: currentTurn, sequence: event.seq ?? 0 }], activePageId: id, currentTurn, resultCandidate: null };
  }
  if (event.type === 'session/end-seed' || event.type === 'turn/end') {
    const status = data.reason?.kind === 'aborted' ? 'cancelled' : 'interrupted';
    const affected = page => (event.type === 'session/end-seed' || page.turn === data.turn)
      && (page.status === 'waiting' || status === 'cancelled' && page.status === 'interrupted');
    const derived = event.type === 'turn/end' ? resultPage(state, data, event.seq ?? 0) : undefined;
    const pages = state.pages.map(page => affected(page) ? { ...page, status } : page);
    if (derived) pages.push(derived);
    return { ...state, pages, activePageId: derived?.pageId ?? state.activePageId, resultCandidate: null };
  }
  if (event.type !== 'tool/result' && event.type !== 'tool/code-dispatch') return state;
  const nested = event.type === 'tool/code-dispatch';
  const id = nested ? data.subCallId : data.message?.source?.callId;
  // Code Mode's child log has no structured error identity. Its outer native
  // tool result is the authoritative cancellation record; never guess from prose.
  const aborted = data.error?.code === 'ABORTED' || data.error?.code === 'ABORTED_BEFORE_DISPATCH';
  if (!nested && aborted) {
    const affected = page => page.rootCallId === id && (page.status === 'waiting' || page.status === 'interrupted');
    if (state.pages.some(affected)) return { ...state, pages: state.pages.map(page => affected(page) ? { ...page, status: 'cancelled' } : page) };
  }
  const index = state.pages.findIndex(page => page.pageId === id);
  if (index < 0) return state;
  const block = nested ? data : data.message?.content?.find(item => item.type === 'tool-result');
  const result = nested ? parsedResult(data.content) : data.meta?.coldxPage ?? parsedResult(block?.content);
  const current = state.pages[index];
  let status = 'interrupted';
  let value = null;
  if (block?.isError) {
    status = aborted ? 'cancelled' : 'interrupted';
  } else if (result?.pageId === id && result.revision === 1
    && ['selected', 'displayed', 'cancelled', 'interrupted'].includes(result.status)) {
    status = result.status;
    value = result.value ?? null;
  }
  const pages = state.pages.slice();
  pages[index] = { ...current, status, value };
  // Only an answer written after this successful selection may become a result.
  return { ...state, pages, resultCandidate: status === 'selected' ? null : state.resultCandidate };
}

export const pageProjection = {
  key: PAGE_PROJECTION, stateSchema, stateVersion: 7,
  init: () => ({ pages: [], activePageId: null, currentTurn: null, resultCandidate: null, textOnlyTurn: null }),
  apply: applyPageEvent,
  wire: { viewSchema, view: state => ({
    pages: state.pages.map(({ turn: _turn, ...page }) => page), activePageId: state.activePageId,
  }) },
};
