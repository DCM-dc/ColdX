import { renderIframeInert, canReceiveInnerKey } from './helpers/shipped-dom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPageStage } from '../plugin/client/stage-source.mjs';

function fixture(initialTheme = 'light') {
  const instances = new Map(), dom = new Map(), events = new Map();
  const themeListeners = new Set();
  let theme = initialTheme;
  let current, cursor, dirty = true, tree, layout = [], effects = [], seen;
  let pages = [{ pageId: 'page-1', kind: 'page', title: '第一页', status: 'waiting', html: '<p>one</p>', css: '', script: '', carrier: {} }];
  let calls = ['page-1'];
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const cell = initialize => current.hooks[cursor++] ??= initialize();
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
    useRef: value => cell(() => ({ current: value })),
    useState(initial) {
      const state = cell(() => ({ value: typeof initial === 'function' ? initial() : initial }));
      return [state.value, value => { const next = typeof value === 'function' ? value(state.value) : value; if (!Object.is(next, state.value)) { state.value = next; dirty = true; } }];
    },
    useMemo(factory, deps) { const state = cell(() => ({})); if (!same(state.deps, deps)) { state.value = factory(); state.deps = deps; } return state.value; },
    useEffect: (setup, deps) => effect(setup, deps, effects),
    useLayoutEffect: (setup, deps) => effect(setup, deps, layout),
  };
  function effect(setup, deps, queue) {
    const state = cell(() => ({}));
    if (!same(state.deps, deps)) { state.deps = deps; queue.push(() => { state.cleanup?.(); state.cleanup = setup(); }); }
  }
  const environment = {
    addEventListener(type, listener) { if (!events.has(type)) events.set(type, new Set()); events.get(type).add(listener); },
    removeEventListener(type, listener) { events.get(type)?.delete(listener); },
  };
  class ResizeObserver { observe() {} disconnect() {} }
  const create = vm.runInNewContext(`(${createPageStage.toString()})`, {
    window: environment,
    document: { getElementById: id => [...dom.values()].find(node => node.props.id === id) },
    crypto: { randomUUID }, ResizeObserver,
    requestAnimationFrame(callback) { callback(); return 1; }, cancelAnimationFrame() {},
  });
  const moments = [];
  const motion = {
    materialize() { moments.push("materialize"); }, confirm() { moments.push("confirm"); },
    pages({ from, to }) { if (from) { from.hidden = true; from.inert = true; } if (to) { to.hidden = false; to.inert = false; } },
    indicator() {}, press() {}, dispose() {},
  };
  const { InlineTool } = create(
    React,
    input => JSON.stringify(input),
    () => async () => ({ accepted: true }),
    () => theme,
    () => null,
    () => null,
    () => () => ({ entries: pages, latestId: pages.at(-1)?.pageId }),
    () => motion,
    listener => { themeListeners.add(listener); return () => themeListeners.delete(listener); },
  );
  function resolve(vnode, path = 'root') {
    if (vnode == null || typeof vnode === 'boolean') return null;
    if (typeof vnode !== 'object') return String(vnode);
    if (Array.isArray(vnode)) return vnode.map((child, index) => resolve(child, `${path}.${child?.props?.key ?? index}`));
    if (typeof vnode.type === 'function') {
      const key = `${path}:${vnode.type.name}`; seen.add(key);
      current = instances.get(key) ?? { hooks: [] }; instances.set(key, current); cursor = 0;
      return resolve(vnode.type(vnode.props), `${key}/`);
    }
    const key = `${path}:${vnode.type}`; seen.add(key);
    const node = dom.get(key) ?? {
      type: vnode.type, props: {}, style: {}, children: [], hidden: false, inert: false,
      offsetHeight: 40, offsetWidth: 120, offsetLeft: 0, offsetTop: 0, clientHeight: 0,
      classList: { add() {}, remove() {}, contains(name) { return node.props.className?.split(' ').includes(name); } },
      dataset: {}, closest() { return null; }, querySelector() { return null; }, scrollIntoView() {}, focus() {},
      getBoundingClientRect() { return { left: 0, top: 0, width: this.offsetWidth, height: this.offsetHeight }; },
      contentWindow: { replies: [], postMessage(message) { this.replies.push(structuredClone(message)); } },
    };
    dom.set(key, node);
    const previous = node.props; node.props = vnode.props;
    for (const flag of ['hidden', 'inert']) if (vnode.props[flag] !== previous[flag]) node[flag] = Boolean(vnode.props[flag]);
    if (node.type === 'iframe') renderIframeInert(node, vnode.props.inert);
    Object.assign(node.style, vnode.props.style);
    node.children = vnode.props.children.map((child, index) => resolve(child, `${key}.${child?.props?.key ?? index}`)).flat(Infinity).filter(child => child != null);
    for (const child of node.children) if (typeof child === 'object') child.parentElement = node;
    if (previous.ref !== vnode.props.ref) {
      if (typeof previous.ref === 'function') previous.ref(null); else if (previous.ref) previous.ref.current = null;
      if (typeof vnode.props.ref === 'function') vnode.props.ref(node); else if (vnode.props.ref) vnode.props.ref.current = node;
    }
    return node;
  }
  function render() {
    for (let attempts = 0; dirty; attempts++) {
      if (attempts > 20) throw new Error('component did not settle');
      dirty = false; layout = []; effects = []; seen = new Set();
      tree = resolve(React.createElement('main', null, calls.map(callId => React.createElement(InlineTool, {
        key: callId, callId, toolName: 'coldx_present_page', block: { name: 'coldx_present_page' },
        useProjection: key => key === 'coldx.pages' ? { pages } : { phase: 'waiting' },
        useSession: select => select({ pending: [] }), sessionId: 'session-1',
      }))));
      for (const setup of [...layout, ...effects]) setup();
    }
  }
  const flatten = node => typeof node === 'object' && node ? [node, ...node.children.flatMap(flatten)] : [];
  render();
  return {
    moments,
    themeListeners,
    changeTheme(value) { theme = value; for (const listener of themeListeners) listener(); render(); },
    unmount() { for (const instance of instances.values()) for (const hook of instance.hooks) hook.cleanup?.(); },
    all: predicate => flatten(tree).filter(predicate),
    dispatch(data, source) { for (const listener of events.get('message') ?? []) listener({ data, source }); render(); },
    addCall(callId) { calls = [...calls, callId]; dirty = true; render(); },
    addPage() { pages = [...pages, { pageId: 'page-2', kind: 'page', title: '第二页', status: 'waiting', html: '<p>two</p>', css: '', script: '', carrier: {} }]; if (!calls.includes('page-2')) calls = [...calls, 'page-2']; dirty = true; render(); },
    settle(status = 'selected') { pages = pages.map(page => ({ ...page, status })); dirty = true; render(); },
    fire(node, handler) { node.props[handler]?.({ detail: 1, currentTarget: node, target: node, preventDefault() {} }); render(); },
  };
}

test('native theme changes update an existing page without replacing its iframe document', () => {
  const f = fixture('dark');
  const frame = f.all(node => node.type === 'iframe')[0];
  const source = frame.props.srcDoc;
  const { channel, theme } = JSON.parse(source);
  assert.equal(theme, 'dark');
  frame.userDraft = 'unfinished input';
  f.changeTheme('light');
  assert.deepEqual(frame.contentWindow.replies.at(-1), { type: 'coldx:theme', channel, theme: 'light' });
  assert.equal(f.all(node => node.type === 'iframe')[0], frame);
  assert.equal(frame.props.srcDoc, source);
  assert.equal(frame.userDraft, 'unfinished input');
  frame.contentWindow.replies.length = 0;
  f.fire(frame, 'onLoad');
  assert.deepEqual(frame.contentWindow.replies.at(-1), { type: 'coldx:theme', channel, theme: 'light' }, 'load retries the latest scheme if earlier delivery preceded frame initialization');
  f.addPage();
  assert.equal(JSON.parse(f.all(node => node.type === 'iframe')[1].props.srcDoc).theme, 'light');
  f.unmount();
  assert.equal(f.themeListeners.size, 0);
});

test('inline frames authenticate readiness and retain both documents across new calls and lifecycle updates', () => {
  const f = fixture();
  const frame = f.all(node => node.type === 'iframe')[0];
  const channel = JSON.parse(frame.props.srcDoc).channel;
  assert.equal(frame.props['data-ready'], false);
  assert.equal(frame.props['aria-busy'], true);
  f.dispatch({ type: 'coldx:ready', channel }, {});
  assert.equal(f.all(node => node.type === 'iframe')[0].props['data-ready'], false, 'foreign windows cannot reveal content');
  f.dispatch({ type: 'coldx:ready', channel, height: 420 }, frame.contentWindow);
  assert.equal(f.all(node => node.type === 'iframe')[0].props['data-ready'], true);
  assert.equal(f.all(node => node.type === 'iframe')[0].props['aria-busy'], false);

  f.addPage();
  f.settle();
  assert.equal(f.all(node => node.type === 'iframe').length, 2);
  assert.equal(f.all(node => node.props.role === 'tablist').length, 0);
  const revisited = f.all(node => node.type === 'iframe').find(node => JSON.parse(node.props.srcDoc).channel === channel);
  assert.equal(revisited, frame);
  assert.equal(revisited.props['data-ready'], true, 'readiness is retained with the mounted page');
  assert.deepEqual(f.all(node => node.type === 'article').map(node => node.props['data-coldx-call-id']), ['page-1', 'page-2']);
});

test('inline frame height follows authenticated content resize without a fixed page viewport', () => {
  const f = fixture();
  const frame = f.all(node => node.type === 'iframe')[0];
  const channel = JSON.parse(frame.props.srcDoc).channel;
  f.dispatch({ type: 'coldx:resize', channel, height: 1400 }, {});
  assert.equal(frame.props.style.height, 360);
  f.dispatch({ type: 'coldx:resize', channel: 'foreign', height: 1400 }, frame.contentWindow);
  assert.equal(frame.props.style.height, 360);
  f.dispatch({ type: 'coldx:resize', channel, height: 1400 }, frame.contentWindow);
  assert.equal(frame.props.style.height, 1400);
  f.dispatch({ type: 'coldx:resize', channel, height: Number.NaN }, frame.contentWindow);
  assert.equal(frame.props.style.height, 1400);
  assert.equal(f.all(node => node.props.className === 'coldx-page-viewport').length, 0);
});

test('a native call awaiting projection has its own pending seat and never borrows another page', () => {
  const f = fixture();
  f.addCall('page-2');
  assert.equal(f.all(node => node.type === 'iframe').length, 1);
  const pending = f.all(node => node.props.className?.includes('coldx-inline-pending'));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].props['data-coldx-call-id'], 'page-2');
  f.addPage();
  assert.equal(f.all(node => node.type === 'iframe').length, 2);
  assert.equal(f.all(node => node.props.className?.includes('coldx-inline-pending')).length, 0);
});

test('the iframe load lifecycle reveals a page when its one-shot ready message races the parent subscription', () => {
  const f = fixture();
  const frame = f.all(node => node.type === 'iframe')[0];
  assert.equal(frame.props['data-ready'], false);

  f.fire(frame, 'onLoad');

  const loaded = f.all(node => node.type === 'iframe')[0];
  assert.equal(loaded.props['data-ready'], true);
  assert.equal(loaded.props['aria-busy'], false);
  assert.equal(loaded.props.tabIndex, 0);
});

test('generated frame reveal is a short opacity-only transition with a Reduced Motion variant', async () => {
  const css = await readFile(new URL('../plugin/client/coldx.css', import.meta.url), 'utf8');
  assert.match(css, /\.coldx-page-frame\s*\{[^}]*opacity:\s*0[^}]*visibility:\s*hidden[^}]*transition:\s*opacity\s+160ms/si);
  assert.match(css, /\.coldx-page-frame\[data-ready="true"\]\s*\{[^}]*opacity:\s*1[^}]*visibility:\s*visible/si);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.coldx-page-frame\s*\{[^}]*transition:\s*opacity\s+120ms/si);
  assert.match(css, /\.coldx-inline-message \.coldx-page-panel\s*\{[^}]*position:\s*relative[^}]*height:\s*auto/si);
  assert.doesNotMatch(css, /coldx-workbench-active[^}]*display:\s*none/si);
  assert.doesNotMatch(css, /composerSeat:has\(\.coldx-stage\)/);
});


test('settlement preserves sandbox identity and adds inertness, audit overlay and one confirmation', () => {
  const f = fixture(); const frame = f.all(node => node.type === 'iframe')[0];
  assert.deepEqual(f.moments, ['materialize']); f.fire(frame, 'onLoad');
  frame.focusedInside = true; assert.equal(canReceiveInnerKey(frame), true);
  f.settle(); assert.equal(frame.inert, true); assert.equal(frame.attributes.get('inert'), ''); assert.equal(canReceiveInnerKey(frame), false); assert.equal(frame.props.tabIndex, -1);
  assert.equal(frame.props['data-state'], 'settled'); assert.equal(frame.props.sandbox, 'allow-scripts');
  assert.ok(f.all(node => node.props.className === 'coldx-page-unavailable').length); assert.deepEqual(f.moments, ['materialize', 'confirm']);
  f.settle(); assert.equal(f.moments.length, 2); assert.equal(f.all(node => node.type === 'iframe')[0], frame);
  const cancelled = fixture(); cancelled.settle('cancelled'); assert.deepEqual(cancelled.moments, ['materialize']);
  assert.equal(cancelled.all(node => node.type === 'iframe')[0].props['data-state'], 'cancelled');
});


test('shipped React 18 keeps unavailable frames inert after inside focus without replacing sources', () => {
  for (const status of ['cancelled', 'interrupted']) {
    const f = fixture(); const frame = f.all(node => node.type === 'iframe')[0];
    f.fire(frame, 'onLoad'); const source = frame.props.srcDoc;
    assert.equal(frame.attributes.has('inert'), false); frame.focusedInside = true;
    assert.equal(canReceiveInnerKey(frame), true); f.settle(status);
    assert.equal(frame.attributes.get('inert'), ''); assert.equal(frame.inert, true);
    assert.equal(canReceiveInnerKey(frame), false); assert.equal(frame.props.tabIndex, -1);
    assert.equal(frame.props['data-state'], status); assert.equal(frame.props.srcDoc, source);
    assert.equal(f.all(node => node.type === 'iframe')[0], frame);
  }
});
