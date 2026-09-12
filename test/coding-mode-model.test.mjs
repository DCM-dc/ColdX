import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCodingModeEvent, codingModeProjection, codingModeState } from '../plugin/coding-mode-model.mjs';

const enabled = { type: 'coldx/coding-mode', data: { version: 1, goal: true } };

test('coding mode projection is strict, last-wins, and wire-safe', () => {
  const initial = codingModeProjection.init();
  assert.deepEqual(initial, { goal: false, pending: [] });
  assert.equal(applyCodingModeEvent(initial, { type: 'turn/start', data: { turn: 1 } }), initial);
  assert.deepEqual(applyCodingModeEvent(initial, enabled), { goal: true, pending: [] });
  assert.deepEqual(applyCodingModeEvent({ goal: true }, { type: 'coldx/coding-mode', data: { version: 1, goal: false } }), { goal: false });
  for (const data of [null, {}, { version: 2, goal: true }, { version: 1, goal: 'yes' }, { version: 1, goal: true, plan: true }]) {
    const state = { goal: false };
    assert.equal(applyCodingModeEvent(state, { type: 'coldx/coding-mode', data }), state, JSON.stringify(data));
  }
  assert.equal(applyCodingModeEvent(initial, {
    type: 'command/run', data: { commandId: 'malformed', name: 'coldx-goal', args: 1, source: { kind: 'user' } },
  }), initial, 'malformed durable command data is ignored without breaking history projection');
  assert.equal(codingModeProjection.key, 'coldx.codingMode');
  assert.equal(codingModeProjection.stateVersion, 2);
  assert.deepEqual(codingModeProjection.wire.view({ goal: true }), { goal: true });
  assert.deepEqual(codingModeProjection.stateSchema.parse({ goal: true, pending: [] }), { goal: true, pending: [] });
  assert.deepEqual(codingModeProjection.wire.viewSchema.parse({ goal: false }), { goal: false });
});

test('codingModeState replays durable session events without sharing state', () => {
  const first = codingModeState([enabled]);
  const second = codingModeState([]);
  assert.deepEqual(first, { goal: true });
  assert.deepEqual(second, { goal: false });
  assert.notEqual(first, second);
});

test('successful native command pairs supersede legacy preferences while failed pairs do not', () => {
  const run = (commandId, args) => ({
    type: 'command/run',
    data: { commandId, name: 'coldx-goal', args, source: { kind: 'user' } },
  });
  const done = (commandId, kind) => ({ type: 'command/done', data: { commandId, kind } });
  assert.deepEqual(codingModeState([enabled, run('off-success', 'off'), done('off-success', 'success')]), { goal: false });
  assert.deepEqual(codingModeState([enabled, run('off-failed', 'off'), done('off-failed', 'error')]), { goal: true });
  assert.deepEqual(codingModeState([
    enabled,
    run('other-command', 'off'),
    { type: 'command/done', data: { commandId: 'other-command', kind: 'success' } },
    run('on-success', 'on'),
    done('on-success', 'success'),
  ]), { goal: true });
});
