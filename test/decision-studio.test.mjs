import test from 'node:test';
import assert from 'node:assert/strict';

async function fixture(owner = 'session-a') {
  const { createDecisionStudio } = await import('../examples/decision-studio.mjs');
  const definition = createDecisionStudio(owner);
  const handlers = new Map();
  let tool;
  const disposers = [];
  const harness = {
    handle(name, callback) { handlers.set(name, callback); return () => handlers.delete(name); },
    defineTool(value) { return value; },
    registerTool(_ctx, value) { tool = value; return () => { tool = undefined; }; },
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const plugin = await new AsyncFunction('harness', definition.code.host)(harness);
  plugin.apply({ effect(callback) { disposers.push(callback()); } });
  return { definition, handlers, tool, dispose: () => disposers.reverse().forEach((d) => d?.()) };
}

test('free-form interaction returns validated choices to the owning tool call', async () => {
  const f = await fixture();
  const controller = new AbortController();
  const waiting = f.tool.execute({}, { agent: { id: 'session-a' }, signal: controller.signal });
  await assert.rejects(() => f.handlers.get('commit')({ speed: 200, quality: 50, budget: 50 }), /0.*100/);
  const receipt = await f.handlers.get('commit')({ speed: 75, quality: 90, budget: 40 });
  assert.equal(receipt.accepted, true);
  assert.deepEqual(await waiting, { status: 'selected', speed: 75, quality: 90, budget: 40 });
  await assert.rejects(() => f.tool.execute({}, { agent: { id: 'session-b' }, signal: controller.signal }), /owning session/);
  f.dispose();
  assert.equal(f.handlers.size, 0);
});

test('early submissions, cancellation, and plugin disposal settle without a polling loop', async () => {
  const f = await fixture();
  await f.handlers.get('commit')({ speed: 20, quality: 30, budget: 40 });
  assert.equal((await f.tool.execute({}, { agent: { id: 'session-a' }, signal: new AbortController().signal })).speed, 20);
  f.dispose();
  const g = await fixture('other-owner');
  assert.notEqual(f.definition.toolName, g.definition.toolName);
  const controller = new AbortController();
  const pending = g.tool.execute({}, { agent: { id: 'other-owner' }, signal: controller.signal });
  controller.abort();
  assert.equal((await pending).status, 'cancelled');
  const again = g.tool.execute({}, { agent: { id: 'other-owner' }, signal: new AbortController().signal });
  g.dispose();
  assert.equal((await again).status, 'closed');
});
