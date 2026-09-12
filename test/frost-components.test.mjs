import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createFrostComponents } from '../plugin/client/frost-source.mjs';

const React = {
  createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
};

test('Frost primitives render semantic elements with labels and preserved caller attributes', () => {
  const { Surface, Action, Status, Field, Meter, Disclosure } = createFrostComponents(React);
  const surface = Surface({ as: 'section', className: 'custom', 'data-run': 'active', children: 'Work' });
  assert.equal(surface.type, 'section');
  assert.equal(surface.props.className, 'cx-surface custom');
  assert.equal(surface.props['data-run'], 'active');
  const taggedSurface = Surface({ 'data-material': 'caller-specified' });
  assert.equal(taggedSurface.props['data-material'], 'caller-specified');
  const floatingSurface = Surface({ floating: true });
  assert.equal(floatingSurface.props['data-floating'], 'true');
  assert.equal('floating' in floatingSurface.props, false);

  const action = Action({ label: 'Save plan', className: 'save', 'data-kind': 'primary' });
  assert.equal(action.type, 'button');
  assert.equal(action.props.type, 'button');
  assert.equal(action.props['aria-label'], 'Save plan');
  assert.equal(action.props.className, 'cx-action save');
  assert.equal(action.props['data-kind'], 'primary');
  assert.deepEqual(action.props.children, ['Save plan']);

  const status = Status({ label: 'Plan pending', tone: 'waiting' });
  assert.equal(status.props.role, 'status');
  assert.equal(status.props['aria-live'], 'polite');
  assert.deepEqual(status.props.children, ['Plan pending']);

  const namedMeter = Meter({ label: 'Context pressure', value: 10, 'aria-label': 'Native pressure' });
  assert.equal(namedMeter.props['aria-label'], 'Native pressure');

  const field = Field({ label: 'Goal', hint: 'A durable objective', children: React.createElement('input', { name: 'goal' }) });
  assert.equal(field.type, 'label');
  assert.equal(field.props.children[0].type, 'span');
  assert.equal(field.props.children[0].props.children[0], 'Goal');
  assert.equal(field.props.children[1].props.children[0], 'A durable objective');
  assert.equal(field.props.children[2].type, 'input');

  const disclosure = Disclosure({ label: 'Token details', open: true, children: 'Provider reported values' });
  assert.equal(disclosure.type, 'details');
  assert.equal(disclosure.props.open, true);
  assert.equal(disclosure.props.children[0].type, 'summary');
  assert.equal(disclosure.props.children[0].props.children[0], 'Token details');
});

test('Meter clamps values and communicates its accessible visible state', () => {
  const { Meter } = createFrostComponents(React);
  const meter = Meter({ label: 'Context pressure', value: 130, min: 20, max: 100, className: 'pressure' });
  assert.equal(meter.props.role, 'meter');
  assert.equal(meter.props['aria-label'], 'Context pressure');
  assert.equal(meter.props['aria-valuemin'], 20);
  assert.equal(meter.props['aria-valuemax'], 100);
  assert.equal(meter.props['aria-valuenow'], 100);
  assert.equal(meter.props['aria-valuetext'], '100%');
  assert.equal(meter.props.className, 'cx-meter pressure');
  assert.equal(meter.props.children[1].props.children[0], '100%');

  const low = Meter({ label: 'Context pressure', value: -1, min: 20, max: 100 });
  assert.equal(low.props['aria-valuenow'], 20);
  assert.equal(low.props['aria-valuetext'], '0%');
});

test('press handlers compose caller input while using one interruptible motion contract', () => {
  const calls = [];
  const motion = { press(node, pressed, options) { calls.push({ node, pressed, options }); } };
  const { Action, pressHandlers } = createFrostComponents(React);
  let callerDown = 0;
  const handlers = pressHandlers(motion, false, { onPointerDown() { callerDown++; } });
  const node = { setPointerCapture(id) { calls.push({ capture: id }); } };
  handlers.onPointerDown({ currentTarget: node, button: 0, pointerId: 7 });
  handlers.onPointerCancel({ currentTarget: node });
  assert.equal(callerDown, 1);
  assert.deepEqual(calls, [
    { capture: 7 }, { node, pressed: true, options: undefined }, { node, pressed: false, options: { cancelled: true } },
  ]);

  const disabled = pressHandlers(motion, true);
  disabled.onPointerDown({ currentTarget: node, button: 0, pointerId: 8 });
  assert.equal(calls.length, 3);

  const action = Action({ label: 'Apply', motion, onPointerUp() { calls.push({ caller: 'up' }); } });
  action.props.onPointerUp({ currentTarget: node });
  assert.deepEqual(calls.slice(-2), [{ caller: 'up' }, { node, pressed: false, options: undefined }]);
});

test('Frost owns one supplied motion runtime by default and releases it on disposal', () => {
  const calls = [];
  let created = 0;
  const suppliedRuntime = () => ({
    press(node, pressed) { calls.push({ node, pressed }); },
    dispose() { calls.push({ disposed: true }); },
  });
  const { Action, dispose } = createFrostComponents(React, () => { created++; return suppliedRuntime(); });
  const node = { setPointerCapture() {} };
  Action({ label: 'Apply' }).props.onPointerDown({ currentTarget: node, button: 0, pointerId: 1 });
  assert.equal(created, 1);
  assert.deepEqual(calls, [{ node, pressed: true }]);
  dispose();
  assert.deepEqual(calls.at(-1), { disposed: true });
});

test('the serialized Frost factory evaluates in a clean VM', () => {
  const factory = vm.runInNewContext(`(${createFrostComponents.toString()})`);
  const api = factory(React, () => ({ press() {}, dispose() {} }));
  assert.equal(typeof api.Action, 'function');
  assert.equal(typeof api.dispose, 'function');
});
