import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const implementation = await import('../plugin/client/page-document.mjs').catch((error) => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});

function frame(options = {}, postFailure) {
  assert.equal(typeof implementation.buildPageDocument, 'function', 'page document builder must exist');
  // Rehydrate the shipped factory without module closure state, as the client build does.
  const build = vm.runInNewContext(`(${implementation.buildPageDocument.toString()})`);
  const html = build({ html: '<h1>Decide</h1>', channel: 'page-one', ...options });
  const listeners = new Map();
  const timers = new Map();
  const sent = [];
  const appended = [];
  const frames = new Map();
  const documentEvents = new Map();
  const styleSheets = options.styleSheets ?? [];
  const documentElement = { dataset: { theme: options.theme === 'dark' ? 'dark' : 'light' }, style: {} };
  const colorScheme = { content: documentElement.dataset.theme };
  let clock = 0;
  let timerId = 0;
  let frameId = 0;
  const app = {
    innerHTML: html.match(/<main\b[^>]*id=["']app["'][^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? '',
    getBoundingClientRect() { return { height: 173.25 }; },
  };
  const parent = { postMessage(message, origin) {
    if (postFailure) throw postFailure;
    sent.push({ message: structuredClone(message), origin });
  } };
  let context;
  function appendChild(node) {
    appended.push(node);
    if (node.tagName === 'SCRIPT') vm.runInContext(node.textContent, context);
    return node;
  }
  const sandbox = {
    parent,
    document: {
      documentElement,
      styleSheets,
      addEventListener(type, listener) { documentEvents.set(type, listener); },
      querySelector(selector) { return selector === 'meta[name="color-scheme"]' ? colorScheme : null; },
      createElement(tag) { return { tagName: tag.toUpperCase(), textContent: '' }; },
      getElementById(id) { return id === 'app' ? app : null; },
      head: { appendChild }, body: { appendChild },
    },
    addEventListener(type, listener) { listeners.set(type, listener); },
    dispatchEvent(event) { listeners.get(event.type)?.(event); return true; },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    requestAnimationFrame(callback) { const id = ++frameId; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: clock + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  sandbox.window = sandbox;
  context = vm.createContext(sandbox);
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    vm.runInContext(match[1], context);
  }
  return {
    html, sandbox, parent, sent, timers, app, appended, documentElement, colorScheme, styleSheets,
    loaded() { documentEvents.get('DOMContentLoaded')?.(); },
    dispatch(data, source = parent) { listeners.get('message')?.({ source, data }); },
    tickFrame() {
      const pending = [...frames.entries()];
      frames.clear();
      for (const [, callback] of pending) callback(clock);
    },
    tick(duration) {
      clock += duration;
      for (const [id, timer] of [...timers]) if (timer.at <= clock) {
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

function result(request, overrides = {}) {
  return { type: 'coldx:result', channel: request.channel, requestId: request.requestId, ok: true, value: 'saved', ...overrides };
}

test('bridge resolves each submitted value against its own host response', async () => {
  const f = frame();
  const first = f.sandbox.ColdX.submit({ choice: 'blue' });
  const second = f.sandbox.ColdX.submit(['red', 2]);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0].origin, '*');
  assert.equal(f.sent[0].message.type, 'coldx:submit');
  assert.equal(f.sent[0].message.channel, 'page-one');
  assert.deepEqual(f.sent[0].message.value, { choice: 'blue' });
  assert.notEqual(f.sent[0].message.requestId, f.sent[1].message.requestId);
  f.dispatch(result(f.sent[1].message, { value: 2 }));
  f.dispatch(result(f.sent[0].message, { value: { accepted: true } }));
  assert.deepEqual(await first, { accepted: true });
  assert.equal(await second, 2);
  assert.equal(f.timers.size, 0);
});

test('bridge ignores foreign sources, channels, request ids and malformed responses', async () => {
  const f = frame();
  let settled = false;
  const pending = f.sandbox.ColdX.submit('blue').then((value) => { settled = true; return value; });
  const request = f.sent[0].message;
  f.dispatch(result(request), {});
  f.dispatch(result(request, { channel: 'other-page' }));
  f.dispatch(result(request, { requestId: 'unknown' }));
  f.dispatch(result(request, { type: 'another-message' }));
  f.dispatch(result(request, { ok: 'true' }));
  f.dispatch(null);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(f.timers.size, 1);
  f.dispatch(result(request));
  assert.equal(await pending, 'saved');
  assert.equal(f.timers.size, 0);
});

test('host refusal rejects the submit promise and clears its timeout', async () => {
  const f = frame();
  const pending = f.sandbox.ColdX.submit({ selection: 1 });
  const rejected = assert.rejects(pending, /Selection already confirmed/);
  f.dispatch(result(f.sent[0].message, { ok: false, error: 'Selection already confirmed' }));
  await rejected;
  assert.equal(f.timers.size, 0);
});

test('submit times out after 30 seconds and ignores a late response', async () => {
  const f = frame();
  const pending = f.sandbox.ColdX.submit('wait');
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(pending, (error) => error.name === 'TimeoutError');
  f.tick(29999);
  await Promise.resolve();
  assert.equal(settled, false);
  f.tick(1);
  await rejected;
  assert.equal(f.timers.size, 0);
  f.dispatch(result(f.sent[0].message));
  assert.equal(f.timers.size, 0);
});

test('postMessage errors reject immediately and release the pending timer', async () => {
  const f = frame({}, new Error('Value cannot be cloned'));
  await assert.rejects(f.sandbox.ColdX.submit('blue'), /Value cannot be cloned/);
  assert.equal(f.timers.size, 0);
});

test('submit rejects non-JSON roots before sending or starting a waiter', async () => {
  for (const value of [undefined, () => {}, Symbol('choice'), 4n]) {
    const f = frame();
    const pending = f.sandbox.ColdX.submit(value);
    pending.catch(() => {});
    assert.equal(f.sent.length, 0, 'unsupported JSON values must stay inside the frame');
    await assert.rejects(pending, (error) => error.name === 'TypeError');
    assert.equal(f.timers.size, 0);
  }
});

test('submit rejects circular values and nested BigInt before sending', async () => {
  const circular = { choice: 'blue' };
  circular.self = circular;
  for (const value of [circular, { count: 9n }]) {
    const f = frame();
    const pending = f.sandbox.ColdX.submit(value);
    pending.catch(() => {});
    assert.equal(f.sent.length, 0, 'structured-clone support must not bypass the host JSON contract');
    await assert.rejects(pending, (error) => error.name === 'TypeError');
    assert.equal(f.timers.size, 0);
  }
});

test('submit normalizes nested values using JSON semantics before host delivery', async () => {
  const f = frame();
  const pending = f.sandbox.ColdX.submit({
    optional: undefined, choices: ['blue', undefined, NaN], when: new Date('2026-09-04T00:00:00.000Z'),
  });
  assert.deepEqual(f.sent[0].message.value, {
    choices: ['blue', null, null], when: '2026-09-04T00:00:00.000Z',
  });
  f.dispatch(result(f.sent[0].message));
  assert.equal(await pending, 'saved');
  assert.equal(f.timers.size, 0);
});

test('submit matches the host 65,536-character limit on serialized JSON', async () => {
  const maxChars = 65536;
  for (const value of ['x'.repeat(maxChars - 2), '冰'.repeat(maxChars - 2), '🧊'.repeat((maxChars - 2) / 2)]) {
    const f = frame();
    const atLimit = f.sandbox.ColdX.submit(value);
    assert.equal(f.sent.length, 1);
    f.dispatch(result(f.sent[0].message));
    assert.equal(await atLimit, 'saved');
  }
  for (const oversized of ['x'.repeat(maxChars - 1), '🧊'.repeat(maxChars / 2), '"'.repeat(maxChars / 2)]) {
    const f = frame();
    const pending = f.sandbox.ColdX.submit(oversized);
    pending.catch(() => {});
    assert.equal(f.sent.length, 0, 'oversized submissions must not reach the host');
    await assert.rejects(pending, (error) => error.name === 'RangeError');
    assert.equal(f.timers.size, 0);
  }
});

test('arbitrary user JavaScript runs after the bridge without script-end corruption', async () => {
  const channel = '</script><script>window.injected = true</script>\u2028';
  const script = 'window.originalText = "</script><script>not executable</script>"; window.pageSubmission = ColdX.submit({ text: originalText });';
  const css = '.demo::after { content: "</style><script>window.cssInjected = true</script>"; }';
  const f = frame({ channel, html: '<section class="demo"><canvas></canvas></section>', css, script });
  assert.equal(f.sandbox.injected, undefined);
  assert.equal(f.sandbox.cssInjected, undefined);
  assert.equal(f.sandbox.originalText, '</script><script>not executable</script>');
  assert.equal(f.sent[0].message.channel, channel);
  assert.equal(f.sent[0].message.value.text, f.sandbox.originalText);
  assert.equal(f.appended.find((node) => node.tagName === 'STYLE')?.textContent, css);
  assert.match(f.app.innerHTML, /<canvas><\/canvas>/);
  f.dispatch(result(f.sent[0].message));
  assert.equal(await f.sandbox.pageSubmission, 'saved');
});

test('reduced-motion safety override is installed after generated CSS and synchronous page scripts', () => {
  const generatedCss = '* { scroll-behavior: smooth !important; animation-duration: 9s !important; transition-duration: 8s !important; }';
  const generatedScript = `
    const lateStyle = document.createElement('style');
    lateStyle.textContent = '* { animation-iteration-count: infinite !important; }';
    document.head.appendChild(lateStyle);
  `;
  const f = frame({ css: generatedCss, script: generatedScript });
  const styles = f.appended.filter((node) => node.tagName === 'STYLE');

  assert.equal(styles.length, 3, 'generated CSS, synchronous script CSS, then the safety override');
  assert.equal(styles[0].textContent, generatedCss);
  assert.match(styles[1].textContent, /animation-iteration-count:\s*infinite/i);
  assert.equal(styles[2], f.appended.at(-1), 'the safety override must win the initial author cascade');
  assert.match(styles[2].textContent, /^@media\s*\(prefers-reduced-motion:\s*reduce\)/i);
  assert.match(styles[2].textContent, /scroll-behavior:\s*auto\s*!important/i);
  assert.match(styles[2].textContent, /animation-duration:\s*0\.001ms\s*!important/i);
  assert.match(styles[2].textContent, /animation-delay:\s*0ms\s*!important/i);
  assert.match(styles[2].textContent, /animation-iteration-count:\s*1\s*!important/i);
  assert.match(styles[2].textContent, /transition-duration:\s*0\.001ms\s*!important/i);
  assert.match(styles[2].textContent, /transition-delay:\s*0ms\s*!important/i);
});

test('page announces authenticated readiness only after its script and two layout frames', () => {
  const f = frame({ script: 'window.scriptComplete = true' });
  assert.equal(f.sandbox.scriptComplete, true);
  assert.equal(f.sent.some(({ message }) => message.type === 'coldx:ready'), false);
  f.tickFrame();
  assert.equal(f.sent.some(({ message }) => message.type === 'coldx:ready'), false);
  f.tickFrame();
  const ready = f.sent.find(({ message }) => message.type === 'coldx:ready')?.message;
  assert.deepEqual(ready, { type: 'coldx:ready', channel: 'page-one', height: 174 });
  f.tickFrame();
  assert.equal(f.sent.filter(({ message }) => message.type === 'coldx:ready').length, 1);
});

test('script and measurement failures do not prevent the page from becoming ready', () => {
  const f = frame({ script: 'document.getElementById("app").getBoundingClientRect = () => { throw new Error("measure failed") }; throw new Error("generated page failed")' });
  f.tickFrame();
  f.tickFrame();
  const ready = f.sent.find(({ message }) => message.type === 'coldx:ready')?.message;
  assert.equal(ready?.channel, 'page-one');
  assert.equal(ready?.height, undefined);
});

test('srcdoc includes the sandbox complement CSP and follows the requested color scheme', () => {
  for (const theme of ['light', 'dark']) {
    const f = frame({ theme });
    assert.match(f.html, /^<!doctype html>/i);
    assert.match(f.html, new RegExp(`color-scheme[^;]*${theme}`));
    const csp = f.html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
    for (const directive of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", 'img-src data: blob:']) {
      assert.ok(csp?.includes(directive), `missing CSP directive: ${directive}`);
    }
    assert.ok(!csp.includes('unsafe-eval'));
  }
});

test('generated scripts can read the initial theme before rendering their own content', () => {
  for (const theme of ['light', 'dark']) {
    const f = frame({ theme, script: 'window.initialTheme = ColdX.theme;' });
    assert.equal(f.sandbox.initialTheme, theme);
    assert.match(f.html, new RegExp(`<html[^>]*data-theme="${theme}"`));
  }
});

test('authenticated live theme changes preserve page state and pending submissions', async () => {
  const f = frame({ script: 'window.renderCount = (window.renderCount || 0) + 1; window.draft = "user draft"; window.changes = []; window.addEventListener("coldx:themechange", event => changes.push({ theme: event.detail.theme, current: ColdX.theme, draft }));' });
  const pending = f.sandbox.ColdX.submit({ draft: 'user draft' });
  const request = f.sent[0].message;
  f.dispatch({ type: 'coldx:theme', channel: 'page-one', theme: 'dark' });
  assert.equal(f.sandbox.ColdX.theme, 'dark');
  assert.equal(f.documentElement.dataset.theme, 'dark');
  assert.equal(f.documentElement.style.colorScheme, 'dark');
  assert.equal(f.colorScheme.content, 'dark');
  assert.equal(f.sandbox.renderCount, 1);
  assert.equal(f.sandbox.draft, 'user draft');
  assert.deepEqual(JSON.parse(JSON.stringify(f.sandbox.changes)), [{ theme: 'dark', current: 'dark', draft: 'user draft' }]);
  f.dispatch({ type: 'coldx:theme', channel: 'page-one', theme: 'dark' });
  assert.equal(f.sandbox.changes.length, 1, 'duplicate delivery must not rerun page theme handlers');
  f.dispatch({ type: 'coldx:theme', channel: 'page-one', theme: 'light' });
  assert.equal(f.sandbox.ColdX.theme, 'light');
  assert.equal(f.documentElement.dataset.theme, 'light');
  assert.equal(f.sandbox.changes.length, 2);
  assert.equal(f.timers.size, 1, 'theme updates must leave the submit bridge intact');
  f.dispatch(result(request));
  assert.equal(await pending, 'saved');
});

test('theme messages reject foreign windows, channels and unsupported schemes', () => {
  const f = frame();
  const valid = { type: 'coldx:theme', channel: 'page-one', theme: 'dark' };
  f.dispatch(valid, {});
  f.dispatch({ ...valid, channel: 'another-page' });
  f.dispatch({ ...valid, theme: 'system' });
  f.dispatch({ ...valid, theme: { colorScheme: 'dark' } });
  f.dispatch({ ...valid, type: 'theme' });
  assert.equal(f.sandbox.ColdX.theme, 'light');
  assert.equal(f.documentElement.dataset.theme, 'light');
});

test('legacy exact CSS color queries follow the host without changing other conditions or page state', () => {
  const media = (text, rules = []) => ({ media: { mediaText: text }, cssRules: rules });
  const dark = media('(prefers-color-scheme: dark)');
  const light = media('( PREFERS-COLOR-SCHEME : light )');
  const compound = media('screen and (prefers-color-scheme: dark)');
  const combined = media('(prefers-color-scheme: dark), (max-width: 900px)');
  const motion = media('(prefers-reduced-motion: reduce)');
  const width = media('(max-width: 900px)');
  const inaccessible = { get cssRules() { throw new Error('restricted sheet'); } };
  const f = frame({ theme: 'dark', styleSheets: [inaccessible, { cssRules: [dark, { cssRules: [light] }, compound, combined, motion, width] }], script: 'window.executions = (window.executions || 0) + 1; window.draft = "unsaved";' });
  f.loaded();
  assert.equal(dark.media.mediaText, 'all');
  assert.equal(light.media.mediaText, 'not all');
  const unchanged = [compound, combined, motion, width].map(rule => rule.media.mediaText);
  for (const theme of ['light', 'dark', 'light']) {
    f.dispatch({ type: 'coldx:theme', channel: 'page-one', theme });
    assert.equal(dark.media.mediaText, theme === 'dark' ? 'all' : 'not all');
    assert.equal(light.media.mediaText, theme === 'light' ? 'all' : 'not all');
    assert.deepEqual([compound, combined, motion, width].map(rule => rule.media.mediaText), unchanged);
  }
  assert.equal(f.sandbox.executions, 1);
  assert.equal(f.sandbox.draft, 'unsaved');
  const late = media('(prefers-color-scheme: dark)');
  f.styleSheets.push({ cssRules: [late] });
  f.dispatch({ type: 'coldx:theme', channel: 'page-one', theme: 'light' });
  assert.equal(late.media.mediaText, 'not all', 'duplicate host delivery also synchronizes newly inserted styles');
});

test('raw file documents preserve parser-executed scripts and receive initial and live theme support', () => {
  const f = frame({ rawDocument: true, theme: 'dark', html: '<!doctype html><html lang="en"><head><style>body{font-size:23px}</style></head><body><input value="draft"><script>window.executions = (window.executions || 0) + 1; window.initialTheme = ColdX.theme;</script></body></html>' });
  assert.equal(f.sandbox.executions, 1);
  assert.equal(f.sandbox.initialTheme, 'dark');
  assert.match(f.html, /<input value="draft">/);
  assert.doesNotMatch(f.html, /app\.innerHTML|font-size:15px|#app\{/);
  f.loaded(); f.tickFrame(); f.tickFrame();
  assert.equal(f.sent.filter(({ message }) => message.type === 'coldx:ready').length, 1);
  f.dispatch({ type: 'coldx:theme', channel: 'page-one', theme: 'light' });
  assert.equal(f.sandbox.ColdX.theme, 'light');
  assert.equal(f.sandbox.executions, 1);
});
