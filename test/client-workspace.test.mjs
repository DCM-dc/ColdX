import test from 'node:test';
import assert from 'node:assert/strict';
import * as clientHost from '../plugin/client/client-host.mjs';

test('client host awaits registration of the launcher cwd through the native workspace registry', async () => {
  assert.ok(clientHost.inject?.includes('workspaceRegistry'));
  const calls = [];
  const plugins = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let done = false;
  const start = clientHost.apply({ plugin: value => plugins.push(value.name), workspaceRegistry: { async create(...args) { calls.push(args); await gate; return { id: 'native-workspace' }; } } }).then(() => { done = true; });
  await Promise.resolve();
  assert.deepEqual(calls, [[process.cwd()]]);
  assert.equal(done, false);
  release();
  await start;
  assert.equal(done, true);
  assert.deepEqual(plugins, [], 'the sample experience is not mounted');
});

test('native registry errors remain visible and an existing workspace title is not overwritten', async () => {
  const failure = new Error('workspace path is unavailable');
  await assert.rejects(() => clientHost.apply({ workspaceRegistry: { create: async () => { throw failure; } } }), failure);
  const existing = { id: 'same-workspace', title: 'User-chosen title' };
  const registry = { async create(_path, title) { assert.equal(title, undefined); return existing; } };
  await clientHost.apply({ plugin() {}, workspaceRegistry: registry });
  await clientHost.apply({ plugin() {}, workspaceRegistry: registry });
  assert.equal(existing.title, 'User-chosen title');
});
