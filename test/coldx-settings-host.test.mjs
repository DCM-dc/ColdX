import test from 'node:test';
import assert from 'node:assert/strict';
import { COLDX_SETTINGS_NAMESPACE, COLDX_SETTINGS_BASE, coldxSettingsSchema, companionSettingsSchema, apply } from '../plugin/settings-host.mjs';

test('ColdX registers live terminal and companion preferences separately', () => {
  const calls = [];
  apply({ settings: { register(...args) { calls.push(args); return {}; } } });
  assert.equal(COLDX_SETTINGS_NAMESPACE, 'coldx-activity');
  assert.deepEqual(COLDX_SETTINGS_BASE, { showTerminal: false });
  assert.deepEqual(coldxSettingsSchema({}), { showTerminal: false });
  assert.deepEqual(coldxSettingsSchema({ showTerminal: true }), { showTerminal: true });
  assert.equal(calls.length, 3);
  assert.equal(calls[2][0], 'coldx-navigation');
  assert.equal(calls[1][0], 'coldx-companion');
  assert.deepEqual(companionSettingsSchema({}), {enabled:true});
  assert.deepEqual(companionSettingsSchema({enabled:false}), {enabled:false});
  assert.equal(companionSettingsSchema({enabled:true,desktop:false,reminders:false}).enabled,true,'old preferences remain loadable');
  assert.throws(() => companionSettingsSchema({enabled:'no'}), /boolean/i);
  assert.equal(calls[0][0], COLDX_SETTINGS_NAMESPACE);
  assert.equal(calls[0][1], coldxSettingsSchema);
  assert.deepEqual(calls[0][2], { base: COLDX_SETTINGS_BASE, applies: 'live' });
});

test('ColdX settings reject non-boolean Terminal values', () => {
  assert.throws(() => coldxSettingsSchema({ showTerminal: 'yes' }), /boolean/i);
});
