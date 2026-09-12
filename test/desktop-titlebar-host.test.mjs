import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CHROME_CHANNEL, CHROME_STATE_CHANNEL, createDesktopTitlebarHost, defaultChromeTheme, desktopTitlebarOptions, normalizeChromeTheme } from '../desktop/titlebar-host.mjs';

const loadingUrl = 'file:///C:/ColdX/loading.html';
const backendUrl = 'http://127.0.0.1:45678/';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, options = {}) {
  const contents = new EventEmitter();
  const window = new EventEmitter();
  const calls = [], sent = [], menus = [], handlers = new Map();
  let origin = backendUrl, fullscreen = false, maximized = false, destroyed = false, zoom = 1;
  let entries = [{ url: loadingUrl }, { url: backendUrl }], index = 1;
  const frame = { url: backendUrl, origin: new URL(backendUrl).origin };
  Object.assign(contents, {
    mainFrame: frame, isDestroyed: () => destroyed, getURL: () => frame.url,
    getZoomFactor: () => zoom, send: (channel, value) => sent.push({ channel, value }),
    navigationHistory: {
      getAllEntries: () => entries, getActiveIndex: () => index,
      goToIndex: value => { calls.push(['navigate', value]); index = value; frame.url = entries[value].url; frame.origin = new URL(frame.url).origin; },
    },
  });
  Object.assign(window, { webContents: contents, isDestroyed: () => destroyed,
    isFullScreen: () => fullscreen, isMaximized: () => maximized, getContentSize: () => [900, 700],
    setBackgroundColor: value => calls.push(['background', value]),
    setTitleBarOverlay: value => calls.push(['overlay', value]),
  });
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: channel => handlers.delete(channel) };
  const Menu = { buildFromTemplate(template) {
    const menu = { template, popup: value => { menu.options = value; }, closePopup: () => { throw new Error('window is already closed'); } };
    menus.push(menu); return menu;
  } };
  const event = { sender: contents, senderFrame: frame };
  const host = createDesktopTitlebarHost({ window, ipcMain, Menu, getBackendUrl: () => origin, loadingUrl,
    platform: 'win32', onTheme: value => calls.push(['save-theme', value]),
    openWorkspace: () => calls.push(['workspace']), openDataDirectory: () => calls.push(['data-directory']),
    openExternal: url => calls.push(['external', url]), showAbout: () => calls.push(['about']), ...options });
  t.after(host.dispose);
  return { host, contents, window, calls, sent, menus, frame, event, handlers,
    invoke: (request, from = event) => handlers.get(CHROME_CHANNEL)(from, request),
    setBackend: value => { origin = value; }, setZoom: value => { zoom = value; },
    setHistory: (value, active) => { entries = value; index = active; frame.url = value[active].url; frame.origin = new URL(frame.url).origin; },
    setFullScreen: value => { fullscreen = value; window.emit(value ? 'enter-full-screen' : 'leave-full-screen'); },
    setMaximized: value => { maximized = value; window.emit(value ? 'maximize' : 'unmaximize'); },
    destroy: () => { destroyed = true; window.webContents = null; },
  };
}

test('hidden titlebar reserves 40 DIP for native controls without disabling the native frame', () => {
  const theme = { scheme: 'dark', background: '#111122', foreground: '#fefefe' };
  const options = desktopTitlebarOptions({ platform: 'win32', theme });
  assert.equal(options.frame, true);
  assert.equal(options.titleBarStyle, 'hidden');
  assert.deepEqual(options.titleBarOverlay, { height: 40, color: theme.background, symbolColor: theme.foreground });
  assert.equal(options.backgroundColor, theme.background);
  assert.equal(desktopTitlebarOptions({ platform: 'linux' }).titleBarOverlay.height, 40);
  assert.equal(desktopTitlebarOptions({ platform: 'darwin' }).titleBarOverlay, undefined);
  assert.equal(normalizeChromeTheme({ scheme: 'dark', background: 'url(file:///secret)', foreground: '#ffffff' }), undefined);
});

test('chrome IPC rejects child frames, other contents, old workspace ports and opaque origins', async t => {
  const f = fixture(t);
  assert.equal((await f.invoke({ type: 'state' })).height, 40);
  for (const event of [
    { sender: {}, senderFrame: f.frame },
    { sender: f.contents, senderFrame: { ...f.frame } },
    { sender: f.contents, senderFrame: null },
  ]) await assert.rejects(f.invoke({ type: 'state' }, event), /active main frame/);
  f.frame.origin = 'null';
  await assert.rejects(f.invoke({ type: 'state' }), /active main frame/);
  f.frame.origin = new URL(backendUrl).origin;
  f.setBackend('http://127.0.0.1:45679/');
  await assert.rejects(f.invoke({ type: 'state' }), /active main frame/);
  f.frame.url = 'file:///C:/ColdX/other.html';
  await assert.rejects(f.invoke({ type: 'state' }), /active main frame/);
  f.frame.url = loadingUrl;
  assert.equal((await f.invoke({ type: 'state' })).canGoBack, false, 'only the exact local loading page is trusted');
});

test('chrome navigation uses current-workspace history entries and skips stale origins', async t => {
  const f = fixture(t);
  const entries = [{ url: loadingUrl }, { url: backendUrl + '?session=a' },
    { url: 'http://127.0.0.1:44444/?old' }, { url: backendUrl + '?session=b' },
    { url: 'https://example.com/' }, { url: backendUrl + '?session=c' }];
  f.setHistory(entries, 3);
  assert.equal((await f.invoke({ type: 'state' })).canGoBack, true);
  assert.equal((await f.invoke({ type: 'state' })).canGoForward, true);
  const back = await f.invoke({ type: 'back' });
  assert.deepEqual(f.calls.at(-1), ['navigate', 1]); assert.equal(back.canGoBack, false);
  f.setHistory(entries, 3);
  const forward = await f.invoke({ type: 'forward' });
  assert.deepEqual(f.calls.at(-1), ['navigate', 5]); assert.equal(forward.canGoForward, false);
  const count = f.calls.length;
  await f.invoke({ type: 'forward' }); assert.equal(f.calls.length, count);
});

test('theme messages update native overlay, deduplicate and reject arbitrary colors/actions', async t => {
  const f = fixture(t);
  const dark = { type: 'theme', scheme: 'dark', background: '#17191F', foreground: '#F1F2F3' };
  const state = await f.invoke(dark);
  assert.deepEqual(state.theme, { scheme: 'dark', background: '#17191f', foreground: '#f1f2f3' });
  assert.deepEqual(f.calls[1], ['overlay', { height: 40, color: '#17191f', symbolColor: '#f1f2f3' }]);
  assert.equal(f.sent.at(-1).channel, CHROME_STATE_CHANNEL);
  const count = f.calls.length; await f.invoke(dark); assert.equal(f.calls.length, count);
  for (const request of [
    { ...dark, background: 'transparent' }, { ...dark, scheme: 'system' }, { ...dark, path: 'C:/private' },
    { type: 'execute', command: 'calc.exe' }, { type: 'back', url: 'https://example.com' },
    { type: 'menu', id: 'shell', x: 10, y: 40 }, { type: 'menu', id: 'file', x: Infinity, y: 40 },
  ]) await assert.rejects(f.invoke(request), /Invalid|Unsupported/);
  await f.invoke({ type: 'theme', ...defaultChromeTheme() });
  assert.equal(f.host.snapshot().theme.scheme, 'light');
});

test('native menu closes before invoke resolves, uses zoomed DIP coordinates and fixed help URLs', async t => {
  const f = fixture(t); f.setZoom(1.5);
  let resolved = false;
  const pending = f.invoke({ type: 'menu', id: 'help', x: 120, y: 40 }).then(() => { resolved = true; });
  await tick(); assert.equal(resolved, false);
  const menu = f.menus[0];
  assert.equal(menu.options.window, f.window); assert.equal(menu.options.x, 180); assert.equal(menu.options.y, 60);
  menu.template[0].click(); await tick();
  assert.deepEqual(f.calls.at(-1), ['external', 'https://github.com/DCM-dc/ColdX#readme']);
  menu.options.callback(); await pending; assert.equal(resolved, true);
  const clamped = f.invoke({ type: 'menu', id: 'file', x: 5000, y: 4000 });
  assert.equal(f.menus[1].options.x, 899); assert.equal(f.menus[1].options.y, 699);
  f.menus[1].template[0].click(); await tick(); assert.deepEqual(f.calls.at(-1), ['workspace']);
  f.menus[1].options.callback(); await clamped;
});

test('window changes push state and closing a window disposes IPC, listeners and pending menus', async t => {
  const f = fixture(t);
  f.setFullScreen(true); assert.equal(f.sent.at(-1).value.fullScreen, true);
  f.setFullScreen(false); assert.equal(f.sent.at(-1).value.fullScreen, false);
  f.setMaximized(true); assert.equal(f.sent.at(-1).value.maximized, true);
  const pending = f.invoke({ type: 'menu', id: 'edit', x: 80, y: 40 });
  f.destroy(); assert.doesNotThrow(f.host.dispose);
  assert.equal(await pending, undefined);
  assert.equal(f.handlers.has(CHROME_CHANNEL), false);
  assert.equal(f.contents.listenerCount('did-navigate-in-page'), 0);
  assert.equal(f.window.listenerCount('enter-full-screen'), 0);
});

test('native caption geometry follows logical titlebar zoom on state, resize and native menu completion', async t => {
  const f = fixture(t);
  for (const factor of [0.8, 1, 1.25]) {
    f.setZoom(factor);
    const state = await f.invoke({ type: 'state' });
    assert.equal(state.height, 40); assert.equal(state.overlayHeight, Math.round(40 * factor));
    assert.equal(state.zoomFactor, factor);
    assert.equal(f.calls.filter(call => call[0] === 'overlay').at(-1)[1].height, state.overlayHeight);
  }
  const pending = f.invoke({ type: 'menu', id: 'view', x: 140, y: 40 });
  assert.ok(f.menus[0].template.some(item => item.role === 'zoomIn'));
  f.setZoom(1.5); // Electron's native menu role applies zoom before popup close.
  f.menus[0].options.callback(); await pending;
  assert.equal(f.sent.at(-1).value.overlayHeight, 60);
  const count = f.calls.length; f.window.emit('resize'); assert.equal(f.calls.length, count, 'unchanged resize must not loop setTitleBarOverlay');
  f.setZoom(1); f.window.emit('resize'); assert.equal(f.sent.at(-1).value.overlayHeight, 40);
});

test('a menu left open across a navigation cannot invoke privileged callbacks from its stale frame', async t => {
  const f = fixture(t);
  const pending = f.invoke({ type: 'menu', id: 'file', x: 80, y: 40 });
  f.setBackend('http://127.0.0.1:55555/');
  f.menus[0].template[0].click(); await tick();
  assert.deepEqual(f.calls, []);
  f.menus[0].options.callback(); await pending;
});
