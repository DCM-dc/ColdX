import { createRequire } from 'node:module';
import { dshRequire } from './page-native.mjs';
import { normalizeInteractionInput, normalizeInteractionAnswer, normalizeCompletionInput } from './interaction-input.mjs';

const { z } = createRequire(dshRequire.resolve('@deepseek-ai/dsh-session-projection'))('zod');
export const INTERACT_TOOL = 'coldx_interact';
export const FINISH_TOOL = 'coldx_finish';
export const FLOW_PROJECTION = 'coldx.flow';
export const questionIdOf = id => `coldx-interaction:${id}:1`;

const optionSchema = z.object({ id: z.string(), label: z.string(), description: z.string(), recommended: z.boolean(),
  preview: z.object({ html: z.string(), css: z.string(), script: z.string() }).optional() });
const interactionSchema = z.object({
  interactionId: z.string(), rootCallId: z.string(), questionId: z.string(), sequence: z.number(),
  title: z.string(), question: z.string(), options: z.array(optionSchema), multiSelect: z.boolean(), allowCustom: z.boolean(), submitLabel: z.string(),
  status: z.enum(['waiting', 'selected', 'cancelled', 'interrupted']), selectedIds: z.array(z.string()), selectedLabels: z.array(z.string()), custom: z.string(),
});
const completionSchema = z.object({ callId: z.string(), summary: z.string(), turn: z.number(), sequence: z.number() });
const activitySchema = z.object({
  id: z.string(), name: z.string(), sequence: z.number(),
  status: z.enum(['running', 'waiting', 'completed', 'failed', 'cancelled', 'interrupted']),
});
const viewSchema = z.object({
  phase: z.enum(['idle', 'working', 'waiting', 'completed', 'cancelled', 'interrupted']), currentTurn: z.number().nullable(),
  activeInteractionId: z.string().nullable(), interactions: z.array(interactionSchema), completion: completionSchema.nullable(),
  activity: z.array(activitySchema),
});
const stateSchema = viewSchema.extend({
  interactions: z.array(interactionSchema.extend({ turn: z.number().nullable() })),
  workRevision: z.number(), closed: z.boolean(),
  calls: z.array(z.object({ id: z.string(), name: z.string(), rootCallId: z.string(), turn: z.number().nullable(),
    sequence: z.number(), workRevision: z.number(), wrapper: z.boolean(), waiting: z.boolean(), settled: z.boolean(),
    outcome: z.enum(['completed', 'failed', 'cancelled', 'interrupted']).optional() })),
});

function json(text) { try { return JSON.parse(text); } catch { return undefined; } }
function output(content) {
  for (const block of content ?? []) if (block.type === 'text') {
    const value = json(block.text);
    if (value && typeof value === 'object') return value;
  }
}
function refresh(state) {
  if (state.closed) return state;
  const open = state.calls.filter(call => !call.settled);
  const phase = open.some(call => call.waiting) ? 'waiting' : state.completion && !open.length ? 'completed' : state.currentTurn === null ? 'idle' : 'working';
  return { ...state, phase };
}

/** Explicit task state derived only from native durable calls, results and turn boundaries. */
export function applyInteractionEvent(state, event) {
  const data = event.data;
  if (event.type === 'turn/start') return { ...state, currentTurn: data.turn, phase: 'working', calls: [], completion: null, workRevision: 0, closed: false };
  const start = event.type === 'tool/call' || event.type === 'tool/code-dispatch-start';
  if (start) {
    const id = event.type === 'tool/call' ? data.callId : data.subCallId;
    if (typeof id !== 'string' || typeof data.name !== 'string' || state.calls.some(call => call.id === id)) return state;
    const args = typeof data.arguments === 'string' ? json(data.arguments) : data.arguments;
    const turn = event.type === 'tool/call' && Number.isInteger(data.turn) ? data.turn : state.currentTurn;
    const wrapper = data.name === 'run_code';
    const workRevision = state.workRevision + (data.name === FINISH_TOOL ? 0 : 1);
    let interaction;
    if (data.name === INTERACT_TOOL) {
      try { interaction = { ...normalizeInteractionInput(args), interactionId: id, rootCallId: data.rootCallId ?? id,
        questionId: questionIdOf(id), sequence: event.seq ?? 0, turn, status: 'waiting', selectedIds: [], selectedLabels: [], custom: '' }; } catch { /* Invalid inputs are ordinary failed tools, not waiting UI. */ }
    }
    const waiting = Boolean(interaction) || data.name === 'ask_user_question'
      || data.name === 'coldx_present_page' && args?.waitForInput !== false;
    return refresh({ ...state, currentTurn: turn, closed: false, workRevision,
      completion: data.name === FINISH_TOOL ? state.completion : null,
      activeInteractionId: interaction?.interactionId ?? state.activeInteractionId,
      interactions: interaction ? [...state.interactions, interaction] : state.interactions,
      calls: [...state.calls, { id, name: data.name, rootCallId: data.rootCallId ?? id, turn, sequence: event.seq ?? 0,
        workRevision, wrapper, waiting, settled: false }],
    });
  }
  if (event.type === 'turn/end' || event.type === 'session/end-seed') {
    const cancelled = data.reason?.kind === 'aborted';
    const affected = item => (item.status === 'waiting' || cancelled && item.status === 'interrupted') && (event.type === 'session/end-seed' || item.turn === data.turn);
    const hasOpen = state.calls.some(call => !call.settled);
    if (event.type === 'session/end-seed' && state.closed && !hasOpen) return state;
    const completed = event.type === 'turn/end' && data.reason?.kind === 'completed' && !hasOpen;
    return { ...state, closed: true, phase: cancelled ? 'cancelled' : completed ? 'completed' : 'interrupted',
      completion: completed ? state.completion : null,
      interactions: state.interactions.map(item => affected(item) ? { ...item, status: cancelled ? 'cancelled' : 'interrupted' } : item),
      calls: state.calls.map(call => call.settled ? call : ({ ...call, settled: true, outcome: cancelled ? 'cancelled' : 'interrupted' })),
    };
  }
  if (event.type !== 'tool/result' && event.type !== 'tool/code-dispatch') return state;
  const nested = event.type === 'tool/code-dispatch';
  const id = nested ? data.subCallId : data.message?.source?.callId;
  const call = state.calls.find(item => item.id === id);
  if (!call || call.settled) return state;
  const block = nested ? data : data.message?.content?.find(item => item.type === 'tool-result');
  const failed = !block || Boolean(block.isError);
  const value = nested ? output(data.content) : data.meta?.coldxInteraction ?? data.meta?.coldxFinish ?? output(block?.content);
  const calls = state.calls.map(item => item === call ? { ...item, settled: true, outcome: failed ? 'failed' : 'completed' } : item);
  let completion = state.completion;
  let workRevision = state.workRevision;
  if (call.name === FINISH_TOOL) {
    if (!failed && value?.completionId === id && value.status === 'completed' && call.workRevision === workRevision
      && !calls.some(item => !item.settled && !item.wrapper && item.name !== FINISH_TOOL)) {
      try { completion = { callId: id, ...normalizeCompletionInput(value), turn: call.turn, sequence: event.seq ?? 0 }; } catch { /* Invalid completion cannot end the task. */ }
    }
  } else if (!call.wrapper || failed) {
    workRevision += 1;
    completion = null;
  }
  let interactions = state.interactions;
  if (call.name === INTERACT_TOOL) interactions = interactions.map(item => {
    if (item.interactionId !== id) return item;
    let status = data.error?.code === 'ABORTED' || data.error?.code === 'ABORTED_BEFORE_DISPATCH' ? 'cancelled' : 'interrupted';
    if (!failed && value?.interactionId === id && value.status === 'selected') {
      try {
        const answer = normalizeInteractionAnswer(item, item.questionId, { answers: [{ id: item.questionId, selected: value.selectedLabels, custom: value.custom }] });
        if (JSON.stringify(answer.selectedIds) === JSON.stringify(value.selectedIds)) return { ...item, status: 'selected', ...answer };
      } catch { /* Retain a truthful failure state for obsolete or malformed records. */ }
    }
    return { ...item, status };
  });
  // A cancelled Code Mode envelope owns all of its unfinished child questions.
  if (call.wrapper && failed && ['ABORTED', 'ABORTED_BEFORE_DISPATCH'].includes(data.error?.code)) {
    interactions = interactions.map(item => item.rootCallId === id && item.status === 'waiting' ? { ...item, status: 'cancelled' } : item);
  }
  return refresh({ ...state, calls, completion, workRevision, interactions });
}

export const interactionProjection = {
  key: FLOW_PROJECTION, stateVersion: 1, stateSchema,
  init: () => ({ phase: 'idle', currentTurn: null, activeInteractionId: null, interactions: [], completion: null, activity: [], calls: [], workRevision: 0, closed: false }),
  apply: applyInteractionEvent,
  wire: { viewSchema, view: state => ({ phase: state.phase, currentTurn: state.currentTurn, activeInteractionId: state.activeInteractionId,
    interactions: state.interactions.map(({ turn: _turn, ...item }) => item), completion: state.completion,
    activity: state.calls.map(call => ({ id: call.id, name: call.name, sequence: call.sequence,
      status: call.settled ? call.outcome ?? 'completed' : call.waiting ? 'waiting' : 'running' })) }) },
};
