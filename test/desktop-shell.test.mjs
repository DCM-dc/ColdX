import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';

function fakeBackend(id, stopCode = 0) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  let stops = 0;
  return {
    id, child,
    get stops() { return stops; },
    async stop() {
      stops += 1;
      if (child.exitCode === null && child.signalCode === null) {
        child.exitCode = stopCode;
        child.emit('exit', stopCode, null);
      }
    },
  };
}

async function nextTurn() {
  await new Promise(resolveTurn => setImmediate(resolveTurn));
}

test('desktop navigation stays on its owned origin and external links are limited to web URLs', async () => {
  const policy = await import('../desktop/window-policy.mjs').catch(() => ({}));
  assert.equal(typeof policy.classifyNavigation, 'function');
  const origin = 'http://127.0.0.1:43123';
  assert.equal(policy.classifyNavigation(origin + '/?session=one#part', origin), 'internal');
  assert.equal(policy.classifyNavigation('http://127.0.0.1:3086/', origin), 'external');
  assert.equal(policy.classifyNavigation('https://api-docs.deepseek.com/', origin), 'external');
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,test', 'coldx://run', 'https://user:password@example.com', 'nonsense']) {
    assert.equal(policy.classifyNavigation(url, origin), 'blocked', url);
  }
});

test('packaged runtime resolves outside asar while data and workspace remain user-owned', async () => {
  const policy = await import('../desktop/window-policy.mjs').catch(() => ({}));
  assert.equal(typeof policy.desktopPaths, 'function');
  const paths = policy.desktopPaths({ packaged: true, resourcesPath: resolve('bundle/resources'), appPath: resolve('bundle/resources/app.asar'), userData: resolve('user/ColdX'), documents: resolve('user/Documents'), platform: 'win32' });
  assert.equal(paths.runtimeRoot, resolve('bundle/resources/runtime/app'));
  assert.equal(paths.nodePath, resolve('bundle/resources/runtime/node.exe'));
  assert.equal(paths.browsersPath, resolve('bundle/resources/runtime/browsers'));
  assert.equal(paths.dataHome, resolve('user/ColdX/dsh'));
  assert.equal(paths.workspace, resolve('user/Documents/ColdX'));
  const dev = policy.desktopPaths({ packaged: false, appPath: resolve('desktop'), userData: resolve('user/ColdX'), documents: resolve('docs'), platform: 'linux', execPath: '/opt/node/bin/node' });
  assert.equal(dev.runtimeRoot, resolve('.'));
  assert.equal(dev.nodePath, '/opt/node/bin/node');
  assert.equal(dev.browsersPath, undefined, 'development keeps Playwright default browser discovery');
});

test('desktop Electron launch removes inherited run-as-node flags instead of assigning an empty value', async () => {
  const { desktopElectronEnvironment } = await import('../desktop/window-policy.mjs');
  assert.equal(typeof desktopElectronEnvironment, 'function');
  assert.deepEqual(desktopElectronEnvironment({
    Path: 'C:/tools',
    ELECTRON_RUN_AS_NODE: '1',
    electron_run_as_node: '',
    COLDX_NODE_PATH: 'C:/node.exe',
  }), {
    Path: 'C:/tools',
    COLDX_NODE_PATH: 'C:/node.exe',
  });
});

test('backend lifecycle serializes switches and never reports the intentionally stopped instance', async () => {
  const { createBackendLifecycle } = await import('../desktop/window-policy.mjs');
  assert.equal(typeof createBackendLifecycle, 'function');
  const first = fakeBackend('first', 9);
  const second = fakeBackend('second');
  const unexpected = [];
  const instances = [first, second];
  const lifecycle = createBackendLifecycle({
    start: async () => instances.shift(),
    onUnexpectedExit: detail => unexpected.push(detail),
  });

  assert.equal(await lifecycle.switchTo('workspace-a'), first);
  assert.equal(await lifecycle.switchTo('workspace-b'), second);
  assert.equal(first.stops, 1);
  assert.equal(lifecycle.current, second);
  assert.deepEqual(unexpected, [], 'an intentional non-zero stop must not be reported as a crash');

  second.child.exitCode = 7;
  second.child.emit('exit', 7, null);
  assert.equal(lifecycle.current, undefined);
  assert.deepEqual(unexpected.map(item => ({ code: item.code, backend: item.backend.id })), [{ code: 7, backend: 'second' }]);
});

test('backend lifecycle reports an unexpected clean exit because the renderer has lost its backend', async () => {
  const { createBackendLifecycle } = await import('../desktop/window-policy.mjs');
  const backend = fakeBackend('clean-exit');
  const unexpected = [];
  const lifecycle = createBackendLifecycle({
    start: async () => backend,
    onUnexpectedExit: detail => unexpected.push(detail),
  });

  await lifecycle.switchTo('workspace-a');
  backend.child.exitCode = 0;
  backend.child.emit('exit', 0, null);

  assert.equal(lifecycle.current, undefined);
  assert.deepEqual(unexpected.map(item => ({ code: item.code, backend: item.backend.id })), [
    { code: 0, backend: 'clean-exit' },
  ]);
});

test('a repeated switch aborts the pending start before launching the latest workspace', async () => {
  const { createBackendLifecycle } = await import('../desktop/window-policy.mjs');
  const second = fakeBackend('second');
  let firstSignal;
  const starts = [];
  const lifecycle = createBackendLifecycle({
    start: ({ workspace, signal }) => {
      starts.push(workspace);
      if (workspace === 'workspace-b') return Promise.resolve(second);
      firstSignal = signal;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
        const error = new Error('superseded');
        error.name = 'AbortError';
        reject(error);
      }, { once: true }));
    },
  });

  const firstSwitch = lifecycle.switchTo('workspace-a');
  await nextTurn();
  const secondSwitch = lifecycle.switchTo('workspace-b');
  assert.equal(await firstSwitch, undefined);
  assert.equal(await secondSwitch, second);
  assert.equal(firstSignal.aborted, true);
  assert.deepEqual(starts, ['workspace-a', 'workspace-b']);
  assert.equal(lifecycle.current, second);
});

test('quit aborts a pending backend start instead of waiting for its readiness timeout', async () => {
  const { createBackendLifecycle } = await import('../desktop/window-policy.mjs');
  let startSignal;
  const lifecycle = createBackendLifecycle({
    start: ({ signal }) => {
      startSignal = signal;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
        const error = new Error('quit');
        error.name = 'AbortError';
        reject(error);
      }, { once: true }));
    },
  });
  const starting = lifecycle.switchTo('workspace-a');
  await nextTurn();
  await Promise.race([
    lifecycle.quit(),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('quit deadlocked')), 500)),
  ]);
  assert.equal(startSignal.aborted, true);
  assert.equal(await starting, undefined);
  assert.equal(lifecycle.current, undefined);
});

test('window recovery creates a missing macOS window and restores an existing minimized window', async () => {
  const { ensureDesktopWindow } = await import('../desktop/window-policy.mjs');
  assert.equal(typeof ensureDesktopWindow, 'function');
  const calls = [];
  const created = {
    isDestroyed: () => false, isMinimized: () => false,
    show: () => calls.push('show'), focus: () => calls.push('focus'),
  };
  const result = await ensureDesktopWindow({
    current: undefined,
    create: () => { calls.push('create'); return created; },
    load: async window => { assert.equal(window, created); calls.push('load'); },
  });
  assert.equal(result, created);
  assert.deepEqual(calls, ['create', 'load', 'show', 'focus']);

  calls.length = 0;
  const existing = {
    isDestroyed: () => false, isMinimized: () => true,
    restore: () => calls.push('restore'), show: () => calls.push('show'), focus: () => calls.push('focus'),
  };
  assert.equal(await ensureDesktopWindow({ current: existing, create: () => assert.fail('must not create') }), existing);
  assert.deepEqual(calls, ['restore', 'show', 'focus']);
});

test('automatic top-level navigation never opens an external browser and smoke needs structural DSH evidence', async () => {
  const { externalUrlForNavigation, isSmokeReady } = await import('../desktop/window-policy.mjs');
  const backendUrl = 'http://127.0.0.1:43123/';
  assert.equal(externalUrlForNavigation('https://example.com/', backendUrl, 'will-navigate'), undefined);
  assert.equal(externalUrlForNavigation('https://example.com/', backendUrl, 'new-window'), 'https://example.com/');
  assert.equal(externalUrlForNavigation('javascript:alert(1)', backendUrl, 'new-window'), undefined);

  const evidence = {
    url: backendUrl,
    readyState: 'complete',
    rootChildren: 2,
    bootEntryIds: ['@deepseek-ai/dsh-client-runtime', 'coldx-client'],
    coldxShell: true,
  };
  assert.equal(isSmokeReady({ ...evidence, url: 'file:///error.html', uiText: 'ColdX 新会话 DeepSeek' }, backendUrl), false);
  assert.equal(isSmokeReady({ ...evidence, rootChildren: 0, uiText: 'ColdX 新会话 DeepSeek' }, backendUrl), false);
  assert.equal(isSmokeReady({ ...evidence, bootEntryIds: [], uiText: 'ColdX 新会话 DeepSeek' }, backendUrl), false);
  assert.equal(isSmokeReady({ ...evidence, coldxShell: false, uiText: 'ColdX 新会话 DeepSeek' }, backendUrl), false);
  assert.equal(isSmokeReady(evidence, backendUrl), true);
});

test('clean desktop chrome removes menu activation while preserving native window and workspace shortcuts', async () => {
  const {configureDesktopWindowChrome}=await import('../desktop/window-policy.mjs');
  assert.equal(typeof configureDesktopWindowChrome,'function');
  const contents=new EventEmitter(),calls=[];let fullscreen=false;
  const window={webContents:contents,removeMenu:()=>calls.push('remove-menu'),setAutoHideMenuBar:value=>calls.push(['auto-hide',value]),setMenuBarVisibility:value=>calls.push(['visible',value]),isFullScreen:()=>fullscreen,setFullScreen:value=>{fullscreen=value;}};
  const dispose=configureDesktopWindowChrome(window,{platform:'win32',openWorkspace:()=>calls.push('workspace')});
  assert.deepEqual(calls,['remove-menu',['auto-hide',false],['visible',false]]);
  const key=input=>{let prevented=false;contents.emit('before-input-event',{preventDefault(){prevented=true;}},{type:'keyDown',...input});return prevented;};
  assert.equal(key({key:'Alt',alt:true}),false,'Alt has no application menu to reveal');
  assert.equal(key({key:'c',control:true}),false,'editing remains owned by Chromium');
  assert.equal(key({key:'F11'}),true);assert.equal(fullscreen,true);
  assert.equal(key({key:'F11'}),true);assert.equal(fullscreen,false);
  assert.equal(key({key:'o',control:true}),true);assert.equal(calls.at(-1),'workspace');
  const count=calls.length;assert.equal(key({key:'o',control:true,isAutoRepeat:true}),false);assert.equal(calls.length,count);
  assert.equal(key({key:'o',control:true,alt:true}),false);
  window.webContents=null;assert.doesNotThrow(dispose,'closed BrowserWindow no longer exposes webContents');assert.equal(contents.listenerCount('before-input-event'),0);
  calls.length=0;configureDesktopWindowChrome(window,{platform:'darwin'});assert.deepEqual(calls,[],'macOS keeps its system menu conventions');
});
