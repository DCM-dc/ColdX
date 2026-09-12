import { renderIframeInert, canReceiveInnerKey } from './helpers/shipped-dom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { createInteractionComponents } from '../plugin/client/interaction-source.mjs';
import { createInteractionSubmitter } from '../plugin/client/interaction-submit.mjs';
import { createMotionRuntime } from '../plugin/client/motion-source.mjs';

// A focused component adapter: persistent keyed DOM, hook state/memo, refs,
// committed effects and a distinct WAAPI presentation layer. No CSS snapshots.
function mount({ preview = false, respond = async () => ({ accepted: true }), multiSelect = false, reduced = false, initialTheme = 'light' } = {}) {
  const instances = new Map(), dom = new Map(), events = new Map();
  const themeListeners = new Set();
  let theme = initialTheme;
  const documents = [], transitions = [], animations = [], sent = [], moments = [];
  let current, cursor, dirty = true, tree, focused, destroyed = false, continues = 0, engages = 0;
  let layout = [], effects = [], seen;
  const same = (a, b) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  function cell(initialize) { const index = cursor++; return current.hooks[index] ??= initialize(); }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
    useRef: value => cell(() => ({ current: value })),
    useState(initial) {
      const state = cell(() => ({ value: typeof initial === 'function' ? initial() : initial }));
      return [state.value, value => { const next = typeof value === 'function' ? value(state.value) : value; if (!Object.is(state.value, next)) { state.value = next; dirty = true; } }];
    },
    useMemo(factory, deps) { const state = cell(() => ({})); if (!same(state.deps, deps)) { state.value = factory(); state.deps = deps; } return state.value; },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps); },
    useId: () => cell(() => ({ value: randomUUID() })).value,
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
    matchMedia: () => ({ matches: reduced, addEventListener() {}, removeEventListener() {} }),
    getComputedStyle: node => ({ opacity: '1', filter: 'none', transform: 'none', ...node.style, ...node.presentation }),
  };
  class ResizeObserver { constructor(callback) { this.callback = callback; } observe() {} disconnect() {} }
  const create = vm.runInNewContext(`(${createInteractionComponents.toString()})`, { window: environment, crypto: { randomUUID }, ResizeObserver });
  const { QuestionFrame } = create(React, input => { documents.push(input); return JSON.stringify(input); }, createInteractionSubmitter, () => theme, () => {
    const runtime = createMotionRuntime({ environment }); const pages = runtime.pages;
    for (const name of ["materialize", "confirm"]) { const original = runtime[name]; if (original) runtime[name] = (...args) => { moments.push(name); return original(...args); }; }
    runtime.pages = args => { transitions.push(args); return pages(args); };
    return runtime;
  }, listener => { themeListeners.add(listener); return () => themeListeners.delete(listener); });
  const options = ['方案一', '方案二', '方案三'].map((label, i) => ({ id: `option-${i}`, label, ...(preview ? { preview: { html: `<button>${label}</button>`, css: 'button{color:blue}', script: 'window.demo=true' } } : {}) }));
  const question = { id: 'decision', question: '选择喜欢的效果', options: options.map(({ label }) => ({ label })), multiSelect };
  const carrier = { key: 'native-question-key', kind: 'question', sessionId: 'session-owner', payload: { questions: [question] }, respond: message => { sent.push(message); return respond(message); } };
  let props = {
    page: { pageId: 'interaction-one', questionId: question.id, status: 'waiting', title: '选择效果', metadata: { questionId: question.id, question: question.question, options, multiSelect, allowCustom: true } },
    active: true, carrier, sessionId: 'session-owner', onPanel() {}, onHeight() {}, onContinue() { continues++; }, onEngage() { engages++; },
  };
  function resolve(vnode, path = 'root') {
    if (vnode === null || vnode === undefined || typeof vnode === 'boolean') return null;
    if (typeof vnode !== 'object') return String(vnode);
    if (Array.isArray(vnode)) return vnode.map((child, i) => resolve(child, `${path}.${child?.props?.key ?? i}`));
    const { type, props: next } = vnode;
    if (typeof type === 'function') {
      const key = `${path}:${type.name}`; seen.add(key);
      const instance = instances.get(key) ?? { hooks: [] }; instances.set(key, instance);
      current = instance; cursor = 0;
      return resolve(type(next), `${key}/`);
    }
    const key = `${path}:${type}`; seen.add(key);
    let node = dom.get(key);
    if (!node) {
      node = { type, props: {}, style: {}, presentation: {}, children: [], offsetHeight: 80, offsetWidth: 120, offsetLeft: dom.size * 130, offsetTop: 0, hidden: false, inert: false,
        focus() { focused = node; }, setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false,
        getBoundingClientRect: () => ({ left: node.offsetLeft, top: node.offsetTop, width: node.offsetWidth, height: node.offsetHeight }),
        classList: { contains: name => node.props.className?.split(' ').includes(name) },
        contentWindow: { replies: [], postMessage(message) { this.replies.push(message); } },
        animate(frames) {
          const animation = { frames, onfinish: null, finished: Promise.resolve(), cancelled: false,
            cancel() { this.cancelled = true; if (node.animation === this) node.presentation = {}; },
            finish() { this.onfinish?.(); },
          };
          node.animation = animation; node.presentation = { ...frames[0] }; animations.push(animation); return animation;
        },
      };
      dom.set(key, node);
    }
    const previous = node.props; node.props = next;
    for (const flag of ['hidden', 'inert']) if (next[flag] !== previous[flag]) node[flag] = Boolean(next[flag]);
    if (node.type === 'iframe') renderIframeInert(node, next.inert);
    Object.assign(node.style, next.style);
    node.children = next.children.map((child, i) => resolve(child, `${key}.${child?.props?.key ?? i}`)).flat(Infinity).filter(x => x !== null);
    for (const child of node.children) if (typeof child === 'object') child.parentElement = node;
    if (previous.ref !== next.ref) {
      if (typeof previous.ref === 'function') previous.ref(null);
      else if (previous.ref) previous.ref.current = null;
      if (typeof next.ref === 'function') next.ref(node);
      else if (next.ref) next.ref.current = node;
    }
    return node;
  }
  function render() {
    if (destroyed) return;
    let attempts = 0;
    while (dirty) {
      if (++attempts > 20) throw new Error('Component did not settle');
      dirty = false; layout = []; effects = []; seen = new Set();
      tree = resolve(React.createElement(QuestionFrame, props));
      for (const [key, instance] of instances) if (!seen.has(key)) { for (const hook of instance.hooks) hook.cleanup?.(); instances.delete(key); }
      for (const setup of [...layout, ...effects]) setup();
    }
  }
  const flatten = node => typeof node === 'object' && node ? [node, ...node.children.flatMap(flatten)] : [];
  const text = node => typeof node === 'string' ? node : (node?.children ?? []).map(text).join('');
  render();
  return {
    documents, transitions, animations, sent, carrier, options, moments,
    themeListeners,
    changeTheme(value) { theme = value; for (const listener of themeListeners) listener(); render(); },
    get continues() { return continues; }, get engages() { return engages; }, get focused() { return focused; },
    all: predicate => flatten(tree).filter(predicate),
    radios: () => flatten(tree).filter(node => node.props.role === 'radio'),
    text: () => text(tree),
    update(changes) { props = { ...props, ...changes }; dirty = true; render(); },
    updatePage(changes) { props = { ...props, page: { ...props.page, ...changes } }; dirty = true; render(); },
    metadataCopy() { props = { ...props, page: { ...props.page, metadata: structuredClone(props.page.metadata) } }; dirty = true; render(); },
    fire(node, handler, detail = {}) { let prevented = false; const result = node.props[handler]?.({ detail: 1, currentTarget: node, target: node, preventDefault() { prevented = true; }, stopPropagation() {}, ...detail }); render(); return { result, prevented }; },
    dispatch(data, source) { for (const listener of events.get('message') ?? []) listener({ data, source }); render(); },
    async flush() { for (let i = 0; i < 8; i++) { await Promise.resolve(); render(); } },
    unmount() { destroyed = true; for (const instance of instances.values()) for (const hook of instance.hooks) hook.cleanup?.(); },
  };
}

test('visible and retained hidden previews follow native theme changes without losing their local state', () => {
  const f = mount({ preview: true, initialTheme: 'dark' });
  const first = f.all(node => node.type === 'iframe')[0];
  const source = first.props.srcDoc;
  assert.equal(JSON.parse(source).theme, 'dark');
  first.userDraft = 'keep this';
  f.fire(f.radios()[1], 'onClick');
  const frames = f.all(node => node.type === 'iframe');
  assert.equal(frames.length, 2);
  f.changeTheme('light');
  for (const frame of frames) {
    const { channel } = JSON.parse(frame.props.srcDoc);
    assert.equal(frame.contentWindow.replies.at(-1)?.type, 'coldx:theme');
    assert.equal(frame.contentWindow.replies.at(-1)?.channel, channel);
    assert.equal(frame.contentWindow.replies.at(-1)?.theme, 'light');
  }
  assert.equal(first.props.srcDoc, source);
  assert.equal(first.userDraft, 'keep this');
  first.contentWindow.replies.length = 0;
  f.fire(first, 'onLoad');
  assert.equal(first.contentWindow.replies.at(-1)?.theme, 'light');
  f.fire(f.radios()[2], 'onClick');
  assert.equal(f.documents.at(-1).theme, 'light');
  f.unmount();
  assert.equal(f.themeListeners.size, 0);
});

test('quick choice waits for native acceptance and continues once despite repeated clicks', async () => {
  let accept; const f = mount({ respond: () => new Promise(resolve => { accept = resolve; }) });
  const first = f.radios()[0]; f.fire(first, 'onClick'); f.fire(first, 'onClick');
  await f.flush(); assert.equal(f.sent.length, 1); assert.equal(f.continues, 0);
  accept({ accepted: true }); await f.flush();
  assert.equal(f.continues, 1); assert.match(f.text(), /已确认/); f.unmount();
});

test('status changes use a short semantic fade without spatial motion or blur, including Reduced Motion', async () => {
  for (const reduced of [false, true]) {
    const f = mount({ reduced, respond: () => new Promise(() => {}) });
    f.fire(f.radios()[0], 'onClick');
    const status = f.animations.find(animation => animation.frames.some(frame => frame.opacity === '.45'));
    assert.ok(status, `status should fade when reduced=${reduced}`);
    assert.ok(status.frames.every(frame => (frame.transform ?? 'none') === 'none'));
    assert.ok(status.frames.every(frame => (frame.filter ?? 'none') === 'none'));
    f.unmount();
  }
});

test('a cancelled question never advertises delivery or follows a late accepted receipt', async () => {
  let accept; const f = mount({ respond: () => new Promise(resolve => { accept = resolve; }) });
  f.fire(f.radios()[0], 'onClick'); await f.flush();
  f.updatePage({ status: 'cancelled' }); accept({ accepted: true }); await f.flush();
  assert.equal(f.continues, 0); assert.doesNotMatch(f.text(), /已确认|已收到/); assert.match(f.text(), /已结束/); f.unmount();
});

test('a refused native receipt permits retry and never calls continue prematurely', async () => {
  let attempts = 0; const f = mount({ respond: async () => ({ accepted: ++attempts > 1 }) });
  f.fire(f.radios()[0], 'onClick'); await f.flush(); assert.equal(f.continues, 0);
  f.fire(f.radios()[1], 'onClick'); await f.flush(); assert.equal(f.continues, 1); assert.equal(f.sent.length, 2); f.unmount();
});

test('projection object replacement keeps preview documents and switching keeps iframe identity', async () => {
  const f = mount({ preview: true });
  const first = f.all(node => node.type === 'iframe')[0]; const source = first.props.srcDoc;
  f.metadataCopy(); assert.equal(f.documents.length, 1); assert.equal(first.props.srcDoc, source);
  f.fire(f.radios()[1], 'onClick'); await f.flush();
  assert.equal(f.sent.length, 0, 'exploring a preview must not submit');
  assert.equal(f.all(node => node.type === 'iframe').length, 2);
  assert.ok(f.all(node => node.type === 'iframe').includes(first));
  assert.ok(f.transitions.some(change => change.from && change.to && change.from !== change.to));
  f.fire(f.radios()[0], 'onClick'); assert.equal(f.all(node => node.type === 'iframe')[0], first); assert.equal(first.props.srcDoc, source);
  assert.equal(f.documents.length, 2); f.unmount();
});

test('radio arrows wrap and change selection without committing; Enter commits the focused option', async () => {
  const f = mount(); let radios = f.radios();
  assert.deepEqual(radios.map(node => node.props.tabIndex), [0, -1, -1]);
  assert.equal(f.fire(radios[0], 'onKeyDown', { key: 'ArrowLeft' }).prevented, true);
  radios = f.radios(); assert.equal(f.focused, radios[2]); assert.equal(radios[2].props['aria-checked'], true);
  await f.flush(); assert.equal(f.sent.length, 0);
  assert.equal(f.fire(radios[2], 'onKeyDown', { key: 'Enter' }).prevented, true);
  await f.flush(); assert.equal(f.sent.length, 1); assert.deepEqual(f.sent[0].value.answer.answers[0].selected, ['方案三']);
  assert.equal(f.continues, 1); f.unmount();
});

test('only the current preview iframe can signal engagement; preview submission cannot commit a Host choice', () => {
  const f = mount({ preview: true }); const frame = f.all(node => node.type === 'iframe')[0];
  const channel = f.documents[0].channel;
  f.dispatch({ type: 'coldx:engage', channel }, {}); assert.equal(f.engages, 0);
  f.dispatch({ type: 'coldx:engage', channel }, frame.contentWindow); assert.equal(f.engages, 1);
  f.dispatch({ type: 'coldx:submit', channel, requestId: 'preview-only', value: 'arbitrary' }, frame.contentWindow);
  assert.equal(f.sent.length, 0); assert.equal(frame.contentWindow.replies.at(-1).ok, false); f.unmount();
});

test('an unmounted question cannot continue after a delayed receipt', async () => {
  let accept; const f = mount({ respond: () => new Promise(resolve => { accept = resolve; }) });
  f.fire(f.radios()[0], 'onClick'); await f.flush(); f.unmount();
  accept({ accepted: true }); await f.flush(); assert.equal(f.continues, 0);
});

test('a late receipt marks acceptance without replacing the history page the reader chose', async () => {
  let accept; const f = mount({ respond: () => new Promise(resolve => { accept = resolve; }) });
  f.fire(f.radios()[0], 'onClick'); await f.flush(); f.update({ active: false });
  accept({ accepted: true }); await f.flush();
  assert.equal(f.continues, 0); assert.match(f.text(), /已确认/); f.unmount();
});

test('checkboxes and optional custom input preserve a combined native answer', async () => {
  const f = mount({ multiSelect: true });
  const choices = f.all(node => node.props.role === 'checkbox');
  f.fire(choices[0], 'onKeyDown', { key: ' ' }); f.fire(choices[1], 'onKeyDown', { key: ' ' });
  assert.equal(f.sent.length, 0);
  f.fire(f.all(node => node.props.className === 'coldx-text-action')[0], 'onClick');
  const input = f.all(node => node.type === 'input')[0];
  f.fire(input, 'onChange', { target: { value: '保留我的调整' } });
  f.fire(input, 'onKeyDown', { key: 'Enter' }); await f.flush();
  assert.deepEqual(f.sent[0].value.answer.answers, [{ id: 'decision', selected: ['方案一', '方案二'], custom: '保留我的调整' }]);
  assert.equal(f.continues, 1); f.unmount();
});

test('keyboard preview navigation remains immediate and a resolved carrier may disappear before its receipt', async () => {
  let accept; const f = mount({ preview: true, respond: () => new Promise(resolve => { accept = resolve; }) });
  const before = f.animations.length;
  f.fire(f.radios()[0], 'onKeyDown', { key: 'ArrowRight' });
  assert.equal(f.animations.length, before); assert.equal(f.sent.length, 0);
  f.fire(f.radios()[1], 'onKeyDown', { key: 'Enter' }); await f.flush();
  f.update({ carrier: undefined }); accept({ accepted: true }); await f.flush();
  assert.equal(f.continues, 1); assert.deepEqual(f.moments, ['materialize', 'confirm']); f.unmount();
});

test('a retained inactive question cannot claim attention from its preview iframe', () => {
  const f = mount({ preview: true }); const frame = f.all(node => node.type === 'iframe')[0];
  f.update({ active: false });
  f.dispatch({ type: 'coldx:engage', channel: f.documents[0].channel }, frame.contentWindow);
  assert.equal(f.engages, 0); f.unmount();
});

test('reading by wheel, keyboard or touch claims the active question without claiming programmatic scroll', () => {
  const f = mount(); const panel = f.all(node => node.props.className?.includes('coldx-decision-panel'))[0];
  f.fire(panel, 'onWheelCapture'); f.fire(panel, 'onKeyDownCapture', { key: 'PageDown' }); f.fire(panel, 'onTouchStartCapture');
  assert.equal(f.engages, 3);
  assert.equal(panel.props.onScroll, undefined); assert.equal(panel.props.onScrollCapture, undefined);
  f.update({ active: false }); f.fire(panel, 'onWheelCapture'); assert.equal(f.engages, 3); f.unmount();
});

test('preview resize uses authenticated content height and keeps its document mounted', () => {
  const f = mount({ preview: true }); const frame = f.all(node => node.type === 'iframe')[0];
  const viewport = () => f.all(node => node.props.className === 'coldx-preview-viewport')[0];
  const resize = { type: 'coldx:resize', channel: f.documents[0].channel, height: 212 };
  f.dispatch(resize, frame.contentWindow); assert.equal(viewport().props.style?.height, 212);
  f.dispatch({ ...resize, height: 450 }, {});
  f.dispatch({ ...resize, channel: 'another-frame', height: 450 }, frame.contentWindow);
  f.dispatch({ ...resize, height: Infinity }, frame.contentWindow);
  assert.equal(viewport().props.style.height, 212);
  assert.equal(f.all(node => node.type === 'iframe')[0], frame); assert.equal(f.documents.length, 1); f.unmount();
});

test('100vh rounding echoes do not inflate preview height; actual growth and long content stay bounded', () => {
  const f = mount({ preview: true }); const frame = f.all(node => node.type === 'iframe')[0];
  const viewport = () => f.all(node => node.props.className === 'coldx-preview-viewport')[0];
  const resize = height => f.dispatch({ type: 'coldx:resize', channel: f.documents[0].channel, height }, frame.contentWindow);
  frame.clientHeight = 240;
  resize(241); resize(242); resize(241); assert.equal(viewport().props.style?.height, 240);
  resize(350); assert.equal(viewport().props.style.height, 350);
  resize(1200); assert.equal(viewport().props.style.height, 480);
  resize(130); assert.equal(viewport().props.style.height, 180); f.unmount();
});

test('each visited preview restores its measured height and ignores outgoing frame resize echoes', () => {
  const f = mount({ preview: true }); const first = f.all(node => node.type === 'iframe')[0];
  const viewport = () => f.all(node => node.props.className === 'coldx-preview-viewport')[0];
  const resize = (index, frame, height) => f.dispatch({ type: 'coldx:resize', channel: f.documents[index].channel, height }, frame.contentWindow);
  resize(0, first, 205); f.fire(f.radios()[1], 'onClick');
  const second = f.all(node => node.type === 'iframe')[1]; resize(1, second, 325);
  assert.equal(viewport().props.style?.height, 325);
  resize(0, first, 450); assert.equal(viewport().props.style.height, 325);
  f.fire(f.radios()[0], 'onClick'); assert.equal(viewport().props.style.height, 205);
  assert.equal(f.all(node => node.type === 'iframe')[0], first); assert.equal(f.documents.length, 2); f.unmount();
});


test('Frost question entrance plays once and confirmation follows acceptance only', async () => {
  let accept; const f = mount({ respond: () => new Promise(resolve => { accept = resolve; }) });
  assert.deepEqual(f.moments, ['materialize']); f.metadataCopy(); assert.equal(f.moments.length, 1);
  f.fire(f.radios()[0], 'onClick'); await f.flush(); assert.equal(f.moments.includes('confirm'), false);
  accept({ accepted: true }); await f.flush(); assert.deepEqual(f.moments, ['materialize', 'confirm']);
  f.updatePage({ status: 'selected' }); assert.equal(f.moments.length, 2); f.unmount();
  const cancelled = mount({ respond: async () => ({ accepted: false }) });
  cancelled.fire(cancelled.radios()[0], 'onClick'); await cancelled.flush(); cancelled.updatePage({ status: 'cancelled' });
  assert.equal(cancelled.moments.includes('confirm'), false); cancelled.unmount();
});

test('settled question previews remain mounted but inert with a visible audit overlay', () => {
  const f = mount({ preview: true }); const frame = f.all(node => node.type === 'iframe')[0];
  frame.focusedInside = true; assert.equal(canReceiveInnerKey(frame), true);
  f.updatePage({ status: 'selected' }); assert.equal(f.all(node => node.type === 'iframe')[0], frame);
  assert.equal(frame.inert, true); assert.equal(frame.attributes.get('inert'), ''); assert.equal(canReceiveInnerKey(frame), false); assert.equal(frame.props.tabIndex, -1); assert.equal(frame.props['data-state'], 'settled');
  assert.ok(f.all(node => node.props.className === 'coldx-page-unavailable').length); f.unmount();
});


test('shipped React 18 makes cancelled and interrupted preview documents inert with inside focus', () => {
  for (const status of ['cancelled', 'interrupted']) {
    const f = mount({ preview: true }); const frame = f.all(node => node.type === 'iframe')[0];
    const source = frame.props.srcDoc; frame.focusedInside = true;
    assert.equal(frame.attributes.has('inert'), false); assert.equal(canReceiveInnerKey(frame), true);
    f.updatePage({ status }); assert.equal(frame.inert, true); assert.equal(frame.attributes.get('inert'), '');
    assert.equal(canReceiveInnerKey(frame), false); assert.equal(frame.props.tabIndex, -1);
    assert.equal(frame.props['data-state'], status); assert.equal(frame.props.srcDoc, source);
    assert.equal(f.all(node => node.type === 'iframe')[0], frame); f.unmount();
  }
});
