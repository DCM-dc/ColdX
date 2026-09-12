import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createTerminalComponents } from '../plugin/client/terminal-source.mjs';

function mount(readTerminal) {
  const hooks = []; let cursor = 0, effects = [], dirty = true, tree, disposed = false, lateUpdates = 0;
  const state = { enabled: false, props: { sessionId: 'a', session: {} } };
  const cell = initial => hooks[cursor++] ??= initial();
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    useMemo: factory => factory(),
    useRef: initial => cell(() => ({ current: initial })),
    useState(initial) {
      const entry = cell(() => ({ value: typeof initial === 'function' ? initial() : initial }));
      return [entry.value, next => {
        if (disposed) { lateUpdates += 1; return; }
        const value = typeof next === 'function' ? next(entry.value) : next;
        if (!Object.is(value, entry.value)) { entry.value = value; dirty = true; }
      }];
    },
    useEffect(setup, dependencies) {
      const entry = cell(() => ({}));
      if (!entry.dependencies || dependencies.some((value, index) => !Object.is(value, entry.dependencies[index]))) {
        entry.dependencies = dependencies; effects.push(() => { entry.cleanup?.(); entry.cleanup = setup(); });
      }
    },
  };
  const scope = { subscribe: () => () => {}, getSnapshot: () => ({ status: 'ready', writable: true, value: { showTerminal: state.enabled } }) };
  const api = createTerminalComponents(React, { selectConversationActivity: () => [] }, scope, {}, readTerminal);
  const content = vnode => vnode == null || typeof vnode === 'boolean' ? '' : typeof vnode !== 'object' ? String(vnode)
    : typeof vnode.type === 'function' ? content(vnode.type(vnode.props)) : vnode.props.children.map(content).join('');
  function render() {
    dirty = true; let attempts = 0;
    while (dirty) {
      if (++attempts > 20) throw new Error('Terminal did not settle');
      dirty = false; cursor = 0; effects = [];
      tree = api.SessionTerminal(state.props); for (const effect of effects) effect();
    }
    return content(tree);
  }
  return { state, render, get tree() { return tree; }, get lateUpdates() { return lateUpdates; }, dispose() {
    for (const entry of hooks) entry.cleanup?.(); disposed = true;
  } };
}

test('terminal subscribes only when enabled, prints live text, and cancels when switching session or disabling', async t => {
  const calls = [];
  const view = mount((sessionId, request, signal) => new Promise(resolve => calls.push({ sessionId, request, signal, resolve })));
  t.after(() => view.dispose());
  assert.equal(view.render(), ''); assert.equal(calls.length, 0);
  view.state.enabled = true; view.render(); assert.equal(calls.length, 1);
  calls[0].resolve({ revision: 1, records: [{ id: 'one', sessionId: 'a', callId: 'call-a', status: 'running', command: 'python task.py', output: 'streamed before exit', startedAt: 10 }] });
  await delay(0); const text = view.render();
  assert.match(text, /streamed before exit/); assert.match(text, /运行中/); assert.doesNotMatch(text, /输出将在命令结束后/);
  view.state.props = { sessionId: 'b', session: {} };
  assert.doesNotMatch(view.render(), /streamed before exit/);
  assert.equal(calls[0].signal.aborted, true); assert.equal(calls[1].sessionId, 'b');
  view.state.enabled = false; assert.equal(view.render(), ''); assert.equal(calls[1].signal.aborted, true);
  calls[1].resolve({ revision: 2, records: [{ id: 'late', sessionId: 'b', callId: 'late', output: 'late result', status: 'running' }] });
  view.dispose(); await delay(0); assert.equal(view.lateUpdates, 0);
});

test('connection failures are shown without inventing process output or starting execution', async t => {
  const view = mount(async () => { throw new Error('Disconnected'); }); t.after(() => view.dispose());
  view.state.enabled = true; view.render(); await delay(0);
  assert.match(view.render(), /实时连接暂不可用/);
  assert.doesNotMatch(view.render(), /exit 0/);
});
