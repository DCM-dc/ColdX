import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createSessionControls } from '../plugin/client/session-controls-source.mjs';
import { createFrostComponents } from '../plugin/client/frost-source.mjs';

function mount({ projections = {}, executeCommand = async () => {}, strict = false, factory = createSessionControls, environment = globalThis, draftSnapshot } = {}) {
  const instances = new Map(), nodes = new Map(), listeners = new Map();
  let current, cursor, dirty = true, tree, seen, destroyed = false, focused, lateUpdates = 0, ids = new Map(), strictReplayed = false;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const cell = initialize => current.hooks[cursor++] ??= initialize();
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
    useRef: value => cell(() => ({ current: value })),
    useState(initial) {
      const state = cell(() => ({ value: typeof initial === 'function' ? initial() : initial }));
      return [state.value, value => {
        if (destroyed) { lateUpdates++; return; }
        const next = typeof value === 'function' ? value(state.value) : value;
        if (!Object.is(next, state.value)) { state.value = next; dirty = true; }
      }];
    },
    useId: () => cell(() => ({ value: `coding-mode-${instances.size}-${cursor}` })).value,
    useSyncExternalStore(subscribe, getSnapshot) {
      React.useEffect(() => subscribe(() => { dirty = true; }),[subscribe]);
      return getSnapshot();
    },
    useEffect(setup, deps) {
      const effect = cell(() => ({}));
      if (!same(effect.deps, deps)) { effect.deps = deps; effect.setup = setup; effects.push(effect); }
    },
  };
  const document = {
    addEventListener(type, listener) { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    getElementById(id) { return ids.get(id) ?? null; },
  };
  environment.document = document;
  const api = factory(React, createFrostComponents(React));
  const coordinator = draftSnapshot ? api.createModeCoordinator({executeCommand:(_id,command) => executeCommand(command)}) : null;
  let props = { sessionId: 'session-1', useProjection: key => projections[key], executeCommand, useSession: select => select(draftSnapshot) };
  function ControlOwner(props) { return React.createElement(api.CodingModeControl,coordinator ? coordinator.useControls(props) : props); }
  function ChipsOwner(props) { return React.createElement(api.CodingModeChips,coordinator ? coordinator.useControls(props) : props); }
  let effects = [];
  function resolve(vnode, path = 'root') {
    if (vnode === null || vnode === undefined || typeof vnode === 'boolean') return null;
    if (typeof vnode !== 'object') return String(vnode);
    if (Array.isArray(vnode)) return vnode.map((child, index) => resolve(child, `${path}.${index}`)).flat().filter(Boolean);
    if (typeof vnode.type === 'function') {
      const key = `${path}:${vnode.type.name}`; seen.add(key);
      current = instances.get(key) ?? { hooks: [] }; instances.set(key, current); cursor = 0;
      const { ref: _ref, ...componentProps } = vnode.props;
      return resolve(vnode.type(componentProps), `${key}/`);
    }
    const key = `${path}:${vnode.type}`; seen.add(key);
    const node = nodes.get(key) ?? { type: vnode.type, props: {}, children: [], focus() { focused = node; document.activeElement = node; }, contains(target) {
      return target === node || node.children.some(child => typeof child === 'object' && child.contains?.(target));
    } };
    nodes.set(key, node); node.props = vnode.props;
    if (vnode.props.id) ids.set(vnode.props.id, node);
    node.children = vnode.props.children.map((child, index) => resolve(child, `${key}.${child?.props?.key ?? index}`)).flat().filter(Boolean);
    for (const child of node.children) if (typeof child === 'object') child.parentElement = node;
    return node;
  }
  function render() {
    if (destroyed) return;
    let attempts = 0;
    while (dirty) {
      if (++attempts > 20) throw new Error('coding mode control did not settle');
      dirty = false; effects = []; seen = new Set(); ids = new Map();
      tree = resolve(React.createElement('div', null,
        React.createElement(ControlOwner, props), React.createElement(ChipsOwner, props)));
      for (const [key, instance] of instances) if (!seen.has(key)) { for (const hook of instance.hooks) hook.cleanup?.(); instances.delete(key); }
      for (const effect of effects) { effect.cleanup?.(); effect.cleanup = effect.setup(); }
      if (strict && !strictReplayed) {
        for (const effect of effects) { effect.cleanup?.(); effect.cleanup = effect.setup(); }
        strictReplayed = true;
      }
    }
  }
  const flatten = node => typeof node === 'object' && node ? [node, ...node.children.flatMap(flatten)] : [];
  const text = node => typeof node === 'string' ? node : (node?.children ?? []).map(text).join('');
  render();
  return {
    api, coordinator, get focused() { return focused; }, get lateUpdates() { return lateUpdates; },
    all(predicate) { return flatten(tree).filter(predicate); }, text: () => text(tree), textOf: node => text(node),
    listenerCount(type) { return listeners.get(type)?.size ?? 0; },
    fire(node, handler, extra = {}) { const result = node.props[handler]?.({ currentTarget: node, target: node, preventDefault() {}, ...extra }); render(); return result; },
    dispatch(type, event = {}) { for (const listener of listeners.get(type) ?? []) listener({ preventDefault() {}, ...event }); render(); },
    updateProjection(key, value) { projections = { ...projections, [key]: value }; props = { ...props, useProjection: name => projections[name] }; dirty = true; render(); },
    updateSession(sessionId) { props = { ...props, sessionId }; dirty = true; render(); },
    async flush() { for (let i = 0; i < 8; i++) { await Promise.resolve(); render(); } },
    unmount() { destroyed = true; for (const instance of instances.values()) for (const hook of instance.hooks) hook.cleanup?.(); },
  };
}

const plainReact = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
const model = createSessionControls(plainReact, createFrostComponents(plainReact));

test('native projections derive truthful independent Goal, Plan, and cache states', () => {
  assert.deepEqual(model.effectivePlanState(), { known: false, active: false, pending: false, effective: false, label: 'Plan 状态未知', transition: null });
  assert.deepEqual(model.effectivePlanState({ active: false, pending: true }), { known: true, active: false, pending: true, effective: true, label: 'Plan 待开启', transition: 'on' });
  assert.equal(model.effectivePlanState({ active: true, pending: true }).label, 'Plan 待关闭');
  assert.deepEqual(model.goalPreference(), { known: false, selected: false });
  assert.deepEqual(model.goalPreference({ goal: true }), { known: true, selected: true });
  assert.deepEqual(model.goalPreference({ goal: false }), { known: true, selected: false });
  assert.deepEqual(model.goalPreference({ goal: 'yes' }), { known: false, selected: false });
  assert.equal(model.cacheStats({ uncachedInputTokens: 300, outputTokens: 20, cacheReadTokens: 600, cacheWriteTokens: 100 }).cache.label, '67%');
  assert.equal(model.cacheStats({ uncachedInputTokens: 300, cacheReadTokens: 600 }).cache.label, '67%', 'output and cache writes are optional details, not cache-ratio inputs');
  assert.equal(model.cacheStats().cache.known, false);
});

test('Coding mode opens a semantic menu with exactly Goal and Plan', () => {
  const f = mount({ projections: { 'coldx.codingMode': { goal: false }, plan: { active: false, pending: false } } });
  const trigger = f.all(node => node.props['aria-haspopup'] === 'menu')[0];
  assert.equal(trigger.props['aria-label'], 'Coding mode');
  assert.equal(f.textOf(trigger), 'Coding mode');
  f.fire(trigger, 'onClick');
  const menu = f.all(node => node.props.role === 'menu')[0];
  assert.equal(menu.props['data-motion'], 'quiet', 'pointer open uses the same quiet motion as keyboard open');
  const choices = f.all(node => node.props.role === 'menuitemcheckbox');
  assert.equal(menu.props['aria-label'], 'Coding mode');
  assert.deepEqual(choices.map(node => node.props['data-mode']), ['goal', 'plan']);
  assert.deepEqual(choices.map(node => node.props['aria-checked']), [false, false]);
  assert.match(f.textOf(menu), /Goal/); assert.match(f.textOf(menu), /Plan/);
  assert.equal(f.all(node => node.type === 'input').length, 0);
  assert.doesNotMatch(f.textOf(menu), /缓存|compact|目标内容|编辑目标|暂停目标|清除目标/i);
  f.unmount();
});

test('new-chat mode controls share immediate local chips and never call the host before a real message', async () => {
  const commands=[];
  const f=mount({draftSnapshot:{sessionId:'session-1',blank:true,composerPhase:'blank'},projections:{'coldx.codingMode':{goal:false},plan:{active:false,pending:false}},executeCommand:async command => commands.push(command)});
  const trigger=f.all(node => node.props['aria-haspopup']==='menu')[0];
  f.fire(trigger,'onClick');f.fire(f.all(node => node.props['data-mode']==='goal')[0],'onClick');await f.flush();
  assert.equal(f.all(node => node.props['data-selected-mode']==='goal').length,1);
  f.fire(trigger,'onClick');f.fire(f.all(node => node.props['data-mode']==='plan')[0],'onClick');await f.flush();
  assert.deepEqual(f.all(node => node.props['data-selected-mode']).map(node => node.props['data-selected-mode']),['plan','goal']);
  f.fire(f.all(node => node.props['data-selected-mode']==='goal')[0],'onClick');await f.flush();
  assert.equal(f.all(node => node.props['data-selected-mode']==='goal').length,0);
  assert.deepEqual(commands,[]);
  f.unmount();f.coordinator.dispose();
});

test('Goal and Plan send exact commands and their accepted chips share one stable Plan then Goal order', async () => {
  const commands = [];
  const f = mount({ projections: { 'coldx.codingMode': { goal: false }, plan: { active: false, pending: false } }, executeCommand: async command => commands.push(command) });
  const trigger = f.all(node => node.props['aria-haspopup'] === 'menu')[0]; f.fire(trigger, 'onClick');
  f.fire(f.all(node => node.props['data-mode'] === 'goal')[0], 'onClick'); await f.flush();
  assert.deepEqual(commands, ['/coldx-goal on']);
  assert.equal(f.all(node => node.props['data-selected-mode'] === 'goal').length, 0);
  f.updateProjection('coldx.codingMode', { goal: true });
  assert.equal(f.all(node => node.props['data-selected-mode'] === 'goal').length, 1);
  f.fire(trigger, 'onClick');
  f.fire(f.all(node => node.props['data-mode'] === 'plan')[0], 'onClick'); await f.flush();
  assert.deepEqual(commands, ['/coldx-goal on', '/plan']);
  f.updateProjection('plan', { active: true, pending: false });
  assert.deepEqual(f.all(node => node.props['data-selected-mode']).map(node => node.props['data-selected-mode']), ['plan', 'goal']);
  f.fire(trigger, 'onClick');
  f.fire(f.all(node => node.props['data-mode'] === 'goal')[0], 'onClick'); await f.flush();
  f.fire(trigger, 'onClick');
  f.fire(f.all(node => node.props['data-mode'] === 'plan')[0], 'onClick'); await f.flush();
  assert.deepEqual(commands.slice(-2), ['/coldx-goal off', '/plan off']);
  f.unmount();
});

test('native Plan pending is visible and Goal remains independently selected', () => {
  const f = mount({ projections: { 'coldx.codingMode': { goal: true }, plan: { active: false, pending: true } } });
  f.fire(f.all(node => node.props['aria-haspopup'] === 'menu')[0], 'onClick');
  const plan = f.all(node => node.props['data-mode'] === 'plan')[0];
  assert.equal(plan.props['aria-checked'], true); assert.equal(plan.props['data-pending'], 'true');
  assert.equal(f.all(node => node.props['data-selected-mode'] === 'goal').length, 1);
  assert.equal(f.all(node => node.props['data-selected-mode'] === 'plan').length, 1, 'the single native mode seat owns both chips');
  assert.equal(f.all(node => node.props['data-selected-mode'] === 'plan')[0].props.disabled, true);
  f.unmount();
});

test('opening while only native Plan is pending focuses the enabled Goal row', () => {
  const f = mount({ projections: { plan: { active: false, pending: true } } });
  f.fire(f.all(node => node.props['aria-haspopup'] === 'menu')[0], 'onClick');
  const goal = f.all(node => node.props['data-mode'] === 'goal')[0];
  const plan = f.all(node => node.props['data-mode'] === 'plan')[0];
  assert.equal(plan.props.disabled, true);
  assert.equal(f.focused, goal);
  f.unmount();
});

test('Goal remains clickable while its projection hydrates and only renders a tag after acceptance', async () => {
  const commands = [];
  const f = mount({ projections: { plan: { active: false, pending: false } }, executeCommand: async command => commands.push(command) });
  f.fire(f.all(node => node.props['aria-haspopup'] === 'menu')[0], 'onClick');
  const goal = f.all(node => node.props['data-mode'] === 'goal')[0];
  assert.equal(goal.props.disabled, false);
  assert.equal(goal.props['aria-checked'], false);
  f.fire(goal, 'onClick'); await f.flush();
  assert.deepEqual(commands, ['/coldx-goal on']);
  assert.equal(f.all(node => node.props['data-selected-mode'] === 'goal').length, 0);
  f.updateProjection('coldx.codingMode', { goal: true });
  assert.equal(f.all(node => node.props['data-selected-mode'] === 'goal').length, 1);
  f.unmount();
});

test('provider cache ratio is a subdued read-only badge outside the two-row menu', () => {
  const f = mount({ projections: { 'coldx.codingMode': { goal: false }, plan: { active: false, pending: false }, tokenUsage: { uncachedInputTokens: 300, outputTokens: 5, cacheReadTokens: 600, cacheWriteTokens: 100 } } });
  const badge = f.all(node => node.props['data-cache-badge'] === 'true')[0];
  assert.equal(f.textOf(badge), '缓存 67%');
  assert.equal(badge.props.title, '会话累计输入缓存命中率');
  f.fire(f.all(node => node.props['aria-haspopup'] === 'menu')[0], 'onClick');
  assert.doesNotMatch(f.textOf(f.all(node => node.props.role === 'menu')[0]), /缓存/);
  assert.equal(f.all(node => node.props['data-command'] === 'compact').length, 0);
  f.unmount();
  const unknown = mount(); assert.equal(unknown.all(node => node.props['data-cache-badge'] === 'true').length, 0); unknown.unmount();
});

test('cache badge waits for measured input and distinguishes no usage from a real zero hit rate', () => {
  for (const tokenUsage of [
    { uncachedInputTokens: 0, cacheReadTokens: 0 },
    { uncachedInputTokens: -1, cacheReadTokens: 2 },
    { uncachedInputTokens: 2, cacheReadTokens: -1 },
    { uncachedInputTokens: Infinity, cacheReadTokens: 0 },
  ]) {
    const f = mount({ projections: { tokenUsage } });
    assert.equal(f.all(node => node.props['data-cache-badge'] === 'true').length, 0);
    assert.equal(model.cacheStats(tokenUsage).cache.label, '暂无统计');
    f.unmount();
  }
  const measured = mount({ projections: { tokenUsage: { uncachedInputTokens: 120, cacheReadTokens: 0 } } });
  const badge = measured.all(node => node.props['data-cache-badge'] === 'true')[0];
  assert.equal(measured.textOf(badge), '缓存 0%');
  measured.unmount();
});

test('one command runs at a time and native errors stay visible without changing tags', async () => {
  let release; const commands = [];
  const f = mount({ projections: { 'coldx.codingMode': { goal: false }, plan: { active: false, pending: false } }, executeCommand: command => {
    commands.push(command); return new Promise(resolve => { release = resolve; });
  } });
  f.fire(f.all(node => node.props['aria-haspopup'] === 'menu')[0], 'onClick');
  const goal = f.all(node => node.props['data-mode'] === 'goal')[0]; f.fire(goal, 'onClick'); f.fire(goal, 'onClick');
  assert.deepEqual(commands, ['/coldx-goal on']);
  assert.equal(f.all(node => node.props.role === 'menuitemcheckbox').every(node => node.props.disabled), true);
  release(); await f.flush(); assert.equal(f.all(node => node.props['data-selected-mode']).length, 0); f.unmount();

  const failure = mount({ projections: { 'coldx.codingMode': { goal: false }, plan: { active: false, pending: false } }, executeCommand: async () => { throw new Error('native command rejected'); } });
  failure.fire(failure.all(node => node.props['aria-haspopup'] === 'menu')[0], 'onClick');
  failure.fire(failure.all(node => node.props['data-mode'] === 'goal')[0], 'onClick'); await failure.flush();
  assert.match(failure.textOf(failure.all(node => node.props.role === 'alert')[0]), /native command rejected/);
  assert.equal(failure.all(node => node.props['data-selected-mode']).length, 0); failure.unmount();
});

test('session switching discards stale feedback', async () => {
  let rejectOld, resolveNew; let call = 0;
  const f = mount({ projections: { 'coldx.codingMode': { goal: false }, plan: { active: false, pending: false } }, executeCommand: () => new Promise((resolve, reject) => {
    if (++call === 1) rejectOld = reject; else resolveNew = resolve;
  }) });
  f.fire(f.all(node => node.props['aria-haspopup'] === 'menu')[0], 'onClick');
  f.fire(f.all(node => node.props['data-mode'] === 'goal')[0], 'onClick'); f.updateSession('session-2');
  f.fire(f.all(node => node.props['aria-haspopup'] === 'menu')[0], 'onClick');
  f.fire(f.all(node => node.props['data-mode'] === 'plan')[0], 'onClick');
  rejectOld(new Error('old session error')); await f.flush();
  assert.doesNotMatch(f.text(), /old session error/);
  assert.equal(f.all(node => node.props.role === 'menuitemcheckbox').every(node => node.props.disabled), true, 'Session A must not release Session B command');
  resolveNew(); await f.flush();
  assert.equal(f.all(node => node.props.role === 'menuitemcheckbox').every(node => node.props.disabled), false);
  f.unmount();
});

test('Escape and outside pointer close the menu, restore focus, and clean listeners', () => {
  const f = mount(); const trigger = f.all(node => node.props['aria-haspopup'] === 'menu')[0]; f.fire(trigger, 'onClick');
  const menu = f.all(node => node.props.role === 'menu')[0];
  const goal = f.all(node => node.props['data-mode'] === 'goal')[0];
  const plan = f.all(node => node.props['data-mode'] === 'plan')[0];
  assert.equal(f.focused, goal, 'opening focuses the first menu item');
  f.fire(menu, 'onKeyDown', { key: 'ArrowDown' }); assert.equal(f.focused, plan);
  f.fire(menu, 'onKeyDown', { key: 'ArrowUp' }); assert.equal(f.focused, goal);
  f.fire(menu, 'onKeyDown', { key: 'End' }); assert.equal(f.focused, plan);
  f.fire(menu, 'onKeyDown', { key: 'Home' }); assert.equal(f.focused, goal);
  assert.equal(f.listenerCount('keydown'), 1); assert.equal(f.listenerCount('pointerdown'), 1);
  f.dispatch('pointerdown', { target: menu }); assert.equal(f.all(node => node.props.role === 'menu').length, 1);
  f.dispatch('keydown', { key: 'Escape' });
  const escaped = f.all(node => node.props.role === 'menu')[0];
  assert.equal(escaped.props['data-presence'], 'closed'); assert.equal(f.focused, trigger);
  f.fire(escaped, 'onTransitionEnd'); assert.equal(f.all(node => node.props.role === 'menu').length, 0);
  f.fire(trigger, 'onClick');
  const focusedItem = f.focused; f.dispatch('pointerdown', { target: {} });
  const outside = f.all(node => node.props.role === 'menu')[0];
  assert.equal(outside.props['data-presence'], 'closed'); assert.equal(f.focused, focusedItem, 'outside close must not steal focus from the pointer target');
  f.fire(outside, 'onTransitionEnd'); assert.equal(f.all(node => node.props.role === 'menu').length, 0);
  f.fire(trigger, 'onClick', { detail: 0 });
  assert.equal(f.all(node => node.props.role === 'menu')[0].props['data-motion'], 'quiet', 'keyboard open uses a non-spatial fade');
  const keyboardMenu = f.all(node => node.props.role === 'menu')[0];
  f.fire(keyboardMenu, 'onKeyDown', { key: 'Tab' });
  assert.equal(f.all(node => node.props.role === 'menu')[0].props['data-presence'], 'closed', 'Tab begins exit and follows native focus order');
  f.fire(f.all(node => node.props.role === 'menu')[0], 'onTransitionEnd');
  assert.equal(f.all(node => node.props.role === 'menu').length, 0);
  f.fire(trigger, 'onClick'); f.unmount(); assert.equal(f.listenerCount('pointerdown'), 0); assert.equal(f.listenerCount('keydown'), 0);
});

test('menu reversal remains stable while accepted mode chips disappear immediately like the native Plan pill', () => {
  const f = mount({ projections: { 'coldx.codingMode': { goal: true }, plan: { active: false, pending: false } } });
  const trigger = f.all(node => node.props['aria-haspopup'] === 'menu')[0];
  f.fire(trigger, 'onClick');
  const enteredMenu = f.all(node => node.props.role === 'menu')[0];
  assert.equal(enteredMenu.props['data-presence'], 'open');
  f.fire(trigger, 'onClick');
  const exitingMenu = f.all(node => node.props.role === 'menu')[0];
  assert.equal(exitingMenu, enteredMenu);
  assert.equal(exitingMenu.props['data-presence'], 'closed');
  assert.equal(exitingMenu.props['aria-hidden'], true);
  f.fire(trigger, 'onClick');
  const reversedMenu = f.all(node => node.props.role === 'menu')[0];
  assert.equal(reversedMenu, enteredMenu, 'rapid reopen reverses the mounted transition');
  assert.equal(reversedMenu.props['data-presence'], 'open');
  f.fire(reversedMenu, 'onTransitionEnd');
  assert.equal(f.all(node => node.props.role === 'menu').length, 1, 'a stale exit event cannot unmount a reopened menu');
  f.fire(trigger, 'onClick');
  f.fire(f.all(node => node.props.role === 'menu')[0], 'onTransitionEnd');
  assert.equal(f.all(node => node.props.role === 'menu').length, 0);

  const enteredTag = f.all(node => node.props['data-selected-mode'] === 'goal')[0];
  assert.equal(enteredTag.type, 'button');
  assert.match(enteredTag.props.className, /rS3zOq_chip/);
  f.updateProjection('coldx.codingMode', { goal: false });
  assert.equal(f.all(node => node.props['data-selected-mode'] === 'goal').length, 0, 'no exit ghost occupies the toolbar');
  f.updateProjection('coldx.codingMode', { goal: true });
  assert.equal(f.all(node => node.props['data-selected-mode'] === 'goal').length, 1);
  f.updateProjection('coldx.codingMode', { goal: false });
  assert.equal(f.all(node => node.props['data-selected-mode'] === 'goal').length, 0);
  f.unmount();
});

test('Strict Mode and unmount safety survive asynchronous command settlement', async () => {
  let release;
  const f = mount({ strict: true, projections: { 'coldx.codingMode': { goal: false }, plan: { active: false, pending: false } }, executeCommand: () => new Promise(resolve => { release = resolve; }) });
  f.fire(f.all(node => node.props['aria-haspopup'] === 'menu')[0], 'onClick'); f.fire(f.all(node => node.props['data-mode'] === 'goal')[0], 'onClick');
  release(); await f.flush(); assert.equal(f.all(node => node.props['data-mode'] === 'goal')[0].props.disabled, false);
  let late;
  const gone = mount({ projections: { 'coldx.codingMode': { goal: false }, plan: { active: false, pending: false } }, executeCommand: () => new Promise(resolve => { late = resolve; }) });
  gone.fire(gone.all(node => node.props['aria-haspopup'] === 'menu')[0], 'onClick'); gone.fire(gone.all(node => node.props['data-mode'] === 'goal')[0], 'onClick');
  gone.unmount(); late(); await gone.flush(); assert.equal(gone.lateUpdates, 0); f.unmount();
});

test('the serialized factory executes the Coding mode component without module closures', () => {
  const environment = {};
  const factory = vm.runInNewContext(`(${createSessionControls.toString()})`, environment);
  const f = mount({ factory, environment });
  const trigger = f.all(node => node.props['aria-haspopup'] === 'menu')[0]; f.fire(trigger, 'onClick');
  assert.equal(f.all(node => node.props.role === 'menuitemcheckbox').length, 2);
  f.dispatch('keydown', { key: 'Escape' }); assert.equal(f.focused, trigger); f.unmount();
});

test('composer blank-space focus preserves the native editor and skips interactive, locked and secondary-button targets', () => {
  let focused = 0, prevented = 0, options;
  const input = { value: 'existing draft', selectionStart: 3, selectionEnd: 7, disabled: false, readOnly: false,
    focus(value) { focused++; options = value; } };
  const card = { querySelector: selector => selector === 'textarea.uV2eYG_input' ? input : undefined };
  const target = { matches: selector => selector.includes('[data-composer-card]'), closest: () => card };
  const event = { target, button: 0, preventDefault() { prevented++; } };
  assert.equal(model.focusComposerSurface(event), true);
  assert.deepEqual(options, { preventScroll: true });
  assert.equal(input.value, 'existing draft');
  assert.deepEqual([input.selectionStart, input.selectionEnd], [3, 7]);
  assert.equal(prevented, 1);
  for (const tag of ['button', 'textarea', 'input', 'a', 'menu', 'backdrop text']) {
    assert.equal(model.focusComposerSurface({ ...event, target: { matches: () => false, closest: () => card, tag } }), false);
  }
  assert.equal(model.focusComposerSurface({ ...event, button: 2 }), false);
  assert.equal(model.focusComposerSurface({ ...event, defaultPrevented: true }), false);
  input.disabled = true; assert.equal(model.focusComposerSurface(event), false);
  input.disabled = false; input.readOnly = true; assert.equal(model.focusComposerSurface(event), false);
  assert.equal(focused, 1);
});

test('only successful typed mode-switch receipts disappear while failures and unrelated command output remain visible', () => {
  assert.equal(model.shouldHideModeReceipt({ kind:'command', name:'coldx-goal', args:null, outcome:{kind:'success',text:'Goal mode selected for the next direct human request.'} }), true);
  assert.equal(model.shouldHideModeReceipt({ kind:'command', name:'coldx-goal', args:null, outcome:{kind:'error',text:'Goal mode selected for the next direct human request.'} }), false);
  const node = (name, args, kind = 'success') => ({ kind: 'command', name, args, outcome: { kind, text: 'Plan mode on.' } });
  for (const [name, args] of [['plan', null], ['plan', ''], ['plan', ' off '], ['coldx-goal', ' on'], ['coldx-goal', 'off']]) {
    const receipt = node(name, args); const before = structuredClone(receipt);
    assert.equal(model.shouldHideModeReceipt(receipt), true);
    assert.equal(model.ModeCommandReceipt({ node: receipt }), null);
    assert.deepEqual(receipt, before, 'rendering leaves the durable command data intact');
    assert.notEqual(model.ModeCommandReceipt({ node: node(name, args, 'error') }), null);
  }
  for (const receipt of [node('compact', ''), node('plan', 'status'), node('plan', 'off extra'), node('coldx-goal', ''),
    { ...node('plan', ''), kind: 'user' }, { ...node('plan', ''), outcome: null }, { ...node(null, null) }]) {
    assert.equal(model.shouldHideModeReceipt(receipt), false);
    assert.notEqual(model.ModeCommandReceipt({ node: receipt }), null);
  }
  const failure = model.ModeCommandReceipt({ node: node('plan', '', 'error') });
  assert.equal(failure.props.role, 'alert');
});

test('mode projection updates do not steal focus from the selected menu row', () => {
  const f = mount({ projections: { 'coldx.codingMode': { goal: false }, plan: { active: false, pending: false } } });
  f.fire(f.all(node => node.props['aria-haspopup'] === 'menu')[0], 'onClick');
  f.fire(f.all(node => node.props.role === 'menu')[0], 'onKeyDown', { key: 'End' });
  const planRow = f.focused;
  assert.equal(planRow.props['data-mode'], 'plan');
  f.updateProjection('coldx.codingMode', { goal: true });
  assert.equal(f.focused, planRow);
  f.unmount();
});

test('a completed switch closes its menu without stealing focus after an outside click', async () => {
  let resolveCommand;
  const f = mount({ executeCommand: () => new Promise(resolve => { resolveCommand = resolve; }) });
  f.fire(f.all(node => node.props['aria-haspopup'] === 'menu')[0], 'onClick');
  f.fire(f.all(node => node.props['data-mode'] === 'goal')[0], 'onClick');
  const editor = { tagName: 'TEXTAREA' };
  f.dispatch('pointerdown', { target: editor });
  globalThis.document.activeElement = editor;
  resolveCommand(); await f.flush();
  assert.equal(globalThis.document.activeElement, editor);
  assert.equal(f.all(node => node.props.role === 'menu')[0].props['data-presence'], 'closed');
  f.unmount();
});

test('both native-style chips remain selected until accepted projections and expose command failures', async () => {
  const commands = []; let rejectCommand;
  const f = mount({ projections: { 'coldx.codingMode': { goal: true }, plan: { active: true, pending: false } }, executeCommand: command => {
    commands.push(command); return new Promise((_, reject) => { rejectCommand = reject; });
  } });
  const chips = f.all(node => node.props['data-selected-mode']);
  assert.deepEqual(chips.map(node => node.props['data-selected-mode']), ['plan', 'goal']);
  assert.ok(chips.every(node => node.props.className.includes('rS3zOq_chip')));
  f.fire(chips[1], 'onClick'); f.fire(chips[1], 'onClick');
  assert.deepEqual(commands, ['/coldx-goal off']);
  assert.equal(f.all(node => node.props['data-selected-mode']).length, 2);
  rejectCommand(new Error('server rejected mode change')); await f.flush();
  assert.match(f.textOf(f.all(node => node.props.role === 'alert')[0]), /server rejected mode change/);
  assert.equal(f.all(node => node.props['data-selected-mode']).length, 2);
  f.unmount();
});
