import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import vm from 'node:vm';
import { createPdfViewComponents } from '../plugin/client/pdf-view-source.mjs';
import { samplePdf } from './helpers/pdf-fixture.mjs';

function fixture(environment, { textStream } = {}) {
  const hooks = [], nodes = new Map(), renders = [], pages = [], jobs = [];
  let cursor, effects = [], dirty, tree, disposed = false, lateUpdates = 0;
  const props = { base64: btoa('PDF fixture'), name: 'fixture.pdf' };
  const cell = init => hooks[cursor++] ??= init();
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
    useRef: value => cell(() => ({ current: value })),
    useState(initial) {
      const item = cell(() => ({ value: initial }));
      return [item.value, next => {
        if (disposed) { lateUpdates++; return; }
        const value = typeof next === 'function' ? next(item.value) : next;
        if (!Object.is(value, item.value)) { item.value = value; dirty = true; }
      }];
    },
    useEffect(setup, dependencies) {
      const item = cell(() => ({}));
      if (!item.dependencies || dependencies.some((value, index) => !Object.is(value, item.dependencies[index]))) {
        item.dependencies = dependencies; effects.push(() => { item.cleanup?.(); item.cleanup = setup(); });
      }
    },
  };
  const runtime = { AnnotationMode: { DISABLE: 0 }, open() {
    let resolve;
    const job = { promise: new Promise(done => { resolve = done; }), destroy() { job.destroyed = true; } };
    const pdf = { numPages: 2, async getPage(number) {
      const page = { number, getViewport: ({ scale }) => ({ width: 400 * scale, height: 300 * scale }),
        render(options) {
          let finish, reject; const task = { options, promise: new Promise((yes, no) => { finish = yes; reject = no; }), finish: () => finish(),
            cancel() { task.cancelled = true; reject(Object.assign(new Error('cancelled'), { name: 'RenderingCancelledException' })); } };
          renders.push(task); return task;
        }, streamTextContent() { return textStream?.(number) ?? new ReadableStream({ start(controller) {
          controller.enqueue({ items: [{ str: `page ${number}` }], styles: {} }); controller.close();
        } }); }, cleanup() { page.cleaned = true; } };
      pages.push(page); return page;
    } };
    job.resolve = () => resolve(pdf); jobs.push(job); return job;
  }, TextLayer: class {
    constructor(options) { this.options = options; }
    async render() { this.options.container.textContent = this.options.textContentSource.items.map(item => item.str).join(' '); }
    cancel() {}
  } };
  const factory = environment ? vm.runInNewContext(`(${createPdfViewComponents.toString()})`, environment) : createPdfViewComponents;
  const { PdfPreview } = factory(React, environment ? undefined : async () => runtime);
  const ownerDocument = { createElement: type => {
    let value = '';
    const node = { type, ownerDocument, props: {}, children: [], width: 0, height: 0,
      style: { setProperty() {} }, clientWidth: 720,
      getContext: () => ({ save() {}, fillRect() {}, restore() {} }),
      setAttribute(name, value) { this.props[name] = value; },
      replaceChildren(...children) { this.children = children; value = ''; },
      get textContent() { return value + this.children.map(child => typeof child === 'string' ? child : child.textContent || '').join(''); },
      set textContent(next) { value = next; this.children = []; },
    };
    return node;
  } };
  function resolve(vnode, path = 'root') {
    if (vnode == null || typeof vnode === 'boolean') return null;
    if (typeof vnode !== 'object') return String(vnode);
    const node = nodes.get(path) ?? ownerDocument.createElement(vnode.type);
    nodes.set(path, node); node.props = vnode.props;
    // React leaves an empty host's imperative frame children alone.
    if (vnode.props.className !== 'cx-pdf-page') node.children = vnode.props.children.map((child, index) => resolve(child, `${path}.${index}`)).filter(value => value !== null);
    if (vnode.props.ref) vnode.props.ref.current = node;
    return node;
  }
  function render() {
    dirty = true; let count = 0;
    while (dirty) { if (++count > 20) throw new Error('PDF did not settle'); dirty = false; cursor = 0; effects = []; tree = resolve(PdfPreview(props)); for (const effect of effects) effect(); }
  }
  function dispose() { for (const hook of hooks) hook.cleanup?.(); disposed = true; }
  const visibleNodes=node=>node&&typeof node==='object'?[node,...node.children.flatMap(visibleNodes)]:[];
  return { props, render, dispose, jobs, renders, pages, runtime, get lateUpdates() { return lateUpdates; },
    node: label => [...nodes.values()].find(node => node.props['aria-label'] === label),
    get retry() { return [...nodes.values()].find(node => node.type === 'button' && node.props.children.includes('重试')); },
    get error() { return visibleNodes(tree).find(node => node.props.role === 'alert'); },
    get surface() { return [...nodes.values()].find(node => node.props.className === 'cx-pdf-page'); },
    get textLayer() { return this.surface?.children.find(node => node.className === 'cx-pdf-text-layer'); },
    get rendering() { return [...nodes.values()].find(node => node.props.className === 'cx-pdf-page')?.props['aria-busy']; },
    async flush() { await delay(0); render(); await delay(0); render(); } };
}

test('page and zoom switches reuse the loaded PDF, cancel old rendering and rebuild selectable text', async t => {
  const view = fixture(); t.after(() => view.dispose());
  view.render(); await view.flush(); assert.equal(view.jobs.length, 1);
  view.jobs[0].resolve(); await view.flush();
  assert.equal(view.textLayer, undefined, 'no incomplete first frame is published');
  view.renders[0].finish(); await view.flush();
  assert.equal(view.pages[0].number, 1); assert.equal(view.textLayer.textContent, 'page 1');
  const firstCanvas = view.surface.children[0];
  view.node('PDF 下一页').props.onClick(); view.render(); await view.flush();
  assert.equal(view.renders[0].cancelled, true); assert.equal(view.jobs.length, 1);
  assert.equal(view.pages.at(-1).number, 2); assert.equal(view.textLayer.textContent, 'page 1');
  assert.equal(view.surface.children[0], firstCanvas); assert.ok(firstCanvas.width > 0);
  view.renders.at(-1).finish(); await view.flush();
  assert.equal(view.textLayer.textContent, 'page 2'); assert.equal(firstCanvas.width, 0, 'retired frames release their pixel buffers');
  view.node('PDF 缩放').props.onChange({ target: { value: '2' } }); view.render(); await view.flush();
  assert.equal(view.renders.at(-1).options.viewport.width, 800); assert.equal(view.jobs.length, 1);
  view.renders.at(-1).finish(); await view.flush();
  view.dispose(); assert.equal(view.jobs[0].destroyed, true);
});

test('closing during document loading destroys the worker job and ignores its late resolution', async () => {
  const view = fixture(); view.render(); await view.flush();
  view.dispose(); assert.equal(view.jobs[0].destroyed, true);
  view.jobs[0].resolve(); await delay(0);
  assert.equal(view.lateUpdates, 0); assert.equal(view.renders.length, 0);
});

test('interrupted page updates retain the last frame and another document never displays that frame', async t => {
  const view = fixture(); t.after(() => view.dispose());
  view.render(); await view.flush(); view.jobs[0].resolve(); await view.flush();
  view.renders[0].finish(); await view.flush();
  const original = view.surface.children[0];
  view.node('PDF 下一页').props.onClick(); view.render(); await view.flush();
  const obsolete = view.renders.at(-1);
  view.node('PDF 缩放').props.onChange({ target: { value: '2' } }); view.render(); await view.flush();
  assert.equal(obsolete.cancelled, true);
  obsolete.finish(); await view.flush();
  assert.equal(view.surface.children[0], original); assert.equal(view.textLayer.textContent, 'page 1');
  view.renders.at(-1).cancel(); await view.flush();
  assert.match(view.error?.props.children[0], /渲染已中断/);
  assert.equal(view.surface.children[0], original); assert.ok(original.width > 0, 'a failed update does not erase the previous page');
  view.props.base64 = btoa('another PDF fixture'); view.render(); await view.flush();
  assert.equal(view.surface.props.style.visibility, 'hidden', 'an old document must not act as the next file\'s placeholder');
  view.jobs.at(-1).resolve(); await view.flush();
  assert.equal(view.surface.props.style.visibility, 'hidden');
  view.renders.at(-1).finish(); await view.flush();
  assert.equal(view.surface.props.style.visibility, 'visible'); assert.notEqual(view.surface.children[0], original);
  assert.equal(original.width, 0);
  const final = view.surface.children[0]; view.dispose(); assert.equal(final.width, 0);
});

test('a current render cancellation leaves pending state with a retryable error while owner cleanup stays silent',async t=>{
  const view=fixture();t.after(()=>view.dispose());view.render();await view.flush();view.jobs[0].resolve();await view.flush();
  assert.equal(view.rendering,true);view.renders[0].cancel();await view.flush();
  assert.equal(view.rendering,false,'a cancelled current task must not clear its deadline while staying busy');
  assert.match(view.error?.props.children[0],/渲染已中断/);assert.ok(view.retry);
  view.retry.props.onClick();view.render();await view.flush();
  assert.equal(view.jobs[0].destroyed,true);assert.equal(view.jobs.length,2);
  view.jobs[1].resolve();await view.flush();view.renders.at(-1).finish();await view.flush();
  assert.equal(view.rendering,false);assert.equal(view.error,undefined);
});

test('a stalled renderer request is removed and retry starts a fresh request that can render', async t => {
  const scripts = [], timers = new Map(); let sequence = 0;
  const environment = { atob, Uint8Array, setTimeout(callback, ms) { const id = ++sequence; timers.set(id, { callback, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    document: { createElement: () => ({ remove() { this.removed = true; } }), head: { append: script => scripts.push(script) } },
  };
  const view = fixture(environment); t.after(() => view.dispose());
  view.render(); await view.flush(); assert.equal(scripts.length, 1);
  const [deadline, timer] = [...timers].find(([_id, value]) => value.ms < 30_000);
  timers.delete(deadline); timer.callback(); await view.flush();
  assert.equal(scripts[0].removed, true); assert.equal(scripts[0].onload, null);
  assert.match(view.error.props.children[0], /加载超时/);
  view.retry.props.onClick(); view.render(); await view.flush();
  assert.equal(scripts.length, 2, 'retry does not reuse the stalled promise');
  environment.__ColdXPdfRuntime = view.runtime; scripts[1].onload(); await view.flush();
  assert.equal(view.jobs.length, 1);
  view.jobs[0].resolve(); await view.flush();
  view.renders.at(-1).finish(); await view.flush();
  assert.equal(view.pages[0].number, 1); assert.equal(view.textLayer.textContent, 'page 1');
});

test('a stalled current page reaches its deadline, stops waiting, and cancels its render',async t=>{
  const timers=new Map();let sequence=0;
  const environment={atob,Uint8Array,setTimeout(callback,ms){const id=++sequence;timers.set(id,{callback,ms});return id;},clearTimeout:id=>timers.delete(id)};
  const view=fixture(environment);environment.__ColdXPdfRuntime=view.runtime;t.after(()=>view.dispose());
  view.render();await view.flush();view.jobs[0].resolve();await view.flush();assert.equal(view.rendering,true);
  const deadline=[...timers.values()].find(timer=>timer.ms===30_000);assert.ok(deadline);deadline.callback();await view.flush();
  assert.equal(view.rendering,false);assert.equal(view.renders[0].cancelled,true);assert.match(view.error?.props.children[0],/这一页渲染超时/);
});

test('a missing text cancellation acknowledgement cannot block a bounded frame or retain its canvas on close',async()=>{
  let cancellations=0;
  const view=fixture(undefined,{textStream:()=>new ReadableStream({
    start(controller){controller.enqueue({items:Array.from({length:20_001},()=>({str:'x'})),styles:{}});},
    cancel(){cancellations++;return new Promise(()=>{});},
  })});
  try{
    view.render();await view.flush();view.jobs[0].resolve();await view.flush();
    assert.equal(cancellations,1);view.renders[0].finish();await view.flush();
    assert.equal(view.rendering,false,'graphics and bounded text can complete without the cancellation acknowledgement');
    assert.equal(view.textLayer.textContent.length,39_999);
  }finally{view.dispose();}
  await delay(0);
  assert.equal(view.renders[0].options.canvas.width,0);assert.equal(view.lateUpdates,0);
});

test('page and zoom cancellation closes the native PDF.js protocol before queued worker chunks arrive', async t => {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: samplePdf(), verbosity: 0 });
  t.after(() => task.destroy());
  const pdf = await task.promise;
  // Use the actual pinned protocol implementation; a generic ReadableStream
  // mock misses its required Error reason and its separate isClosed state.
  const MessageHandler = pdf._transport.messageHandler.constructor, streams = [];
  const textStream = () => {
    let listener;
    const sent = [], port = { postMessage: message => sent.push(message), addEventListener: (_name, callback) => { listener = callback; } };
    const handler = new MessageHandler('display', 'worker', port);
    const emit = (kind, data = {}) => listener({ data: { sourceName: 'worker', targetName: 'display', streamId: 1, stream: kind, ...data } });
    const stream = handler.sendWithStream('GetTextContent', {}, { highWaterMark: 0 });
    streams.push({ handler, emit, sent });
    emit(8, { success: true }); // START_COMPLETE
    return stream;
  };
  const view = fixture(undefined, { textStream });
  t.after(() => { view.dispose(); for (const stream of streams) stream.handler.destroy(); });
  view.render(); await view.flush(); view.jobs[0].resolve(); await view.flush();
  for (const action of [
    () => view.node('PDF 下一页').props.onClick(),
    () => view.node('PDF 缩放').props.onChange({ target: { value: '0.5' } }),
  ]) {
    const previous = streams.at(-1);
    action(); view.render(); await view.flush();
    assert.doesNotThrow(() => previous.emit(4, { chunk: { items: [{ str: 'late worker text' }], styles: {} } }), 'late ENQUEUE after cancellation is ignored');
    assert.doesNotThrow(() => previous.emit(3), 'late CLOSE after cancellation is ignored');
    const cancellations = previous.sent.filter(message => message.stream === 1);
    assert.equal(cancellations.length, 1, 'cancel is sent once to the worker');
    assert.equal(cancellations[0].reason.name, 'AbortException');
    previous.emit(7, { success: true }); previous.emit(2, { success: true });
    await view.flush();
  }
  const limited = streams.at(-1);
  limited.emit(4, { chunk: { items: Array.from({ length: 20_001 }, () => ({ str: 'bounded text' })), styles: {} } });
  await view.flush();
  assert.equal(limited.sent.filter(message => message.stream === 1).length, 1, 'text limit cancels the native producer once');
  assert.doesNotThrow(() => limited.emit(4, { chunk: { items: [], styles: {} } }));
  assert.doesNotThrow(() => limited.emit(3));
  limited.emit(7, { success: true }); limited.emit(2, { success: true }); await view.flush();
  view.renders.at(-1).finish(); await view.flush();
  assert.ok(view.textLayer.textContent.startsWith('bounded text'));
  view.node('PDF 缩放').props.onChange({ target: { value: '1' } }); view.render(); await view.flush();
  const closing = streams.at(-1); view.dispose();
  assert.equal(closing.sent.filter(message => message.stream === 1).length, 1, 'closing the preview cancels its native producer once');
  assert.doesNotThrow(() => closing.emit(4, { chunk: { items: [], styles: {} } }));
  assert.doesNotThrow(() => closing.emit(3));
  closing.emit(7, { success: true }); closing.emit(2, { success: true }); await delay(0);
  assert.equal(view.lateUpdates, 0, 'late output does not update a closed preview');
  assert.equal(view.jobs.length, 1, 'page changes still reuse one document');
});
