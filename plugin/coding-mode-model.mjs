import { createRequire } from 'node:module';
import { dshRequire } from './page-native.mjs';

const { z } = createRequire(dshRequire.resolve('@deepseek-ai/dsh-session-projection'))('zod');

export const CODING_MODE_EVENT = 'coldx/coding-mode';
export const CODING_MODE_PROJECTION = 'coldx.codingMode';

const viewSchema = z.object({ goal: z.boolean() });
const pendingSchema = z.object({ commandId: z.string(), goal: z.boolean() });
const stateSchema = viewSchema.extend({ pending: z.array(pendingSchema) });

function validChange(data) {
  return data !== null && typeof data === 'object' && !Array.isArray(data)
    && Object.keys(data).length === 2 && data.version === 1 && typeof data.goal === 'boolean';
}

/** Fold only validated ColdX preference events; native Goal state remains separate. */
export function applyCodingModeEvent(state, event) {
  if (event?.type === CODING_MODE_EVENT && validChange(event.data)) return { ...state, goal: event.data.goal };
  const data = event?.data;
  const pending = Array.isArray(state.pending) ? state.pending : [];
  if (event?.type === 'command/run') {
    const args = typeof data?.args === 'string' ? data.args.trim().toLowerCase() : undefined;
    if (!data || data.name !== 'coldx-goal' || data.source?.kind !== 'user'
      || typeof data.commandId !== 'string' || !['on', 'off'].includes(args)) return state;
    const goal = args === 'on';
    return { ...state, pending: [...pending.filter(item => item.commandId !== data.commandId), { commandId: data.commandId, goal }] };
  }
  if (event?.type === 'command/done' && data && typeof data.commandId === 'string') {
    const change = pending.find(item => item.commandId === data.commandId);
    if (!change) return state;
    const next = pending.filter(item => item.commandId !== data.commandId);
    return data.kind === 'success' ? { ...state, goal: change.goal, pending: next } : { ...state, pending: next };
  }
  if (event?.type === 'session/end-seed' && pending.length) return { ...state, pending: [] };
  return state;
}

export const codingModeProjection = {
  key: CODING_MODE_PROJECTION,
  stateVersion: 2,
  stateSchema,
  init: () => ({ goal: false, pending: [] }),
  apply: applyCodingModeEvent,
  wire: { viewSchema, view: state => ({ goal: state.goal }) },
};

export function codingModeState(events) {
  let state = codingModeProjection.init();
  for (const event of events ?? []) state = applyCodingModeEvent(state, event);
  return codingModeProjection.wire.view(state);
}
