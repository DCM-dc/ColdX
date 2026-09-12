import { app, BrowserWindow, dialog, Menu, shell } from 'electron';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBackend } from './backend.mjs';
import {
  classifyNavigation,
  configureDesktopWindowChrome,
  createBackendLifecycle,
  desktopPaths,
  ensureDesktopWindow,
  externalUrlForNavigation,
  isSmokeReady,
} from './window-policy.mjs';

app.setName('ColdX');
if (process.env.COLDX_DESKTOP_DATA) app.setPath('userData', process.env.COLDX_DESKTOP_DATA);
const smoke = process.argv.includes('--smoke-test');
const smokeReport = process.env.COLDX_SMOKE_REPORT;
const ownDirectory = dirname(fileURLToPath(import.meta.url));
const loadingPages = new WeakMap();
let window, paths, workspace, lifecycle, startup;
let quitting = false;
let stopped = false;
let choosingWorkspace = false;

function trace(message) {
  if (process.env.COLDX_DESKTOP_TRACE) console.log(`[ColdX desktop] ${message}`);
}

function currentBackend() {
  return lifecycle?.current;
}

function makeWindow() {
  const next = new BrowserWindow({
    title: 'ColdX', width: 1400, height: 960, minWidth: 820, minHeight: 620,
    // Native chrome reserves its own space outside the renderer, including
    // fullscreen and theme changes. No extra toolbar or overlay obscures DSH.
    frame: true, titleBarStyle: 'default', autoHideMenuBar: false,
    backgroundColor: '#f8fafb', show: !smoke, icon: join(ownDirectory, 'assets/icon.png'),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false },
  });
  const disposeChrome = configureDesktopWindowChrome(next, { openWorkspace: chooseWorkspace, onError: showStartupError });
  next.webContents.setWindowOpenHandler(({ url }) => {
    const active = currentBackend();
    const external = active && externalUrlForNavigation(url, active.url, 'new-window');
    if (external) void shell.openExternal(external).catch(error => console.error('ColdX external link:', error.message));
    return { action: 'deny' };
  });
  next.webContents.on('will-navigate', (event, deprecatedUrl) => {
    const url = event.url ?? deprecatedUrl;
    const active = currentBackend();
    if (!active || classifyNavigation(url, active.url) !== 'internal') event.preventDefault();
  });
  next.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  next.webContents.session.setPermissionCheckHandler(() => false);
  next.on('closed', () => { disposeChrome(); if (window === next) window = undefined; });
  const loading = { error: undefined };
  loading.done = next.loadFile(join(ownDirectory, 'loading.html')).catch(error => { loading.error = error; });
  loadingPages.set(next, loading);
  window = next;
  return next;
}

async function loadBackendInWindow(target, instance) {
  const loading = loadingPages.get(target);
  if (loading) await loading.done;
  if (target.isDestroyed() || !lifecycle?.isCurrent(instance)) return;
  if (loading?.error) throw loading.error;
  try { await target.loadURL(instance.url); }
  catch (error) {
    if (target.isDestroyed() || !lifecycle?.isCurrent(instance)) return;
    throw error;
  }
}

async function loadWorkspace(nextWorkspace) {
  workspace = nextWorkspace;
  if (quitting) return undefined;
  const instance = await lifecycle.switchTo(nextWorkspace);
  if (!instance || !lifecycle.isCurrent(instance) || quitting) return undefined;
  const target = window;
  if (target && !target.isDestroyed()) await loadBackendInWindow(target, instance);
  return instance;
}

async function revealWindow() {
  await app.whenReady();
  if (!paths || quitting) return;
  const active = currentBackend();
  window = await ensureDesktopWindow({
    current: window,
    create: makeWindow,
    load: active ? target => loadBackendInWindow(target, active) : undefined,
  });
}

async function chooseWorkspace() {
  if (choosingWorkspace || quitting) return;
  choosingWorkspace = true;
  try {
    const owner = window && !window.isDestroyed() ? window : undefined;
    const openOptions = { properties: ['openDirectory', 'createDirectory'], defaultPath: workspace };
    const selection = owner ? await dialog.showOpenDialog(owner, openOptions) : await dialog.showOpenDialog(openOptions);
    if (selection.canceled || !selection.filePaths[0]) return;
    const messageOptions = { type: 'question', message: '切换工作区会停止当前正在运行的任务。', buttons: ['切换工作区', '取消'], defaultId: 1, cancelId: 1 };
    const answer = owner ? await dialog.showMessageBox(owner, messageOptions) : await dialog.showMessageBox(messageOptions);
    if (answer.response !== 0) return;
    await writeFile(join(app.getPath('userData'), 'desktop.json'), JSON.stringify({ workspace: selection.filePaths[0] }));
    startup = loadWorkspace(selection.filePaths[0]);
    await startup;
  } finally { choosingWorkspace = false; }
}

function installMenu() {
  const mac = process.platform === 'darwin';
  // autoHideMenuBar only hides the labels until Alt. Remove the application
  // menu entirely on Windows/Linux before the first window is constructed.
  if (!mac) { Menu.setApplicationMenu(null); return; }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ label: 'ColdX', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: '文件', submenu: [
      { label: '打开工作区…', accelerator: 'CmdOrCtrl+O', click: () => void chooseWorkspace().catch(showStartupError) },
      { label: '打开数据文件夹', click: () => void shell.openPath(app.getPath('userData')).catch(error => console.error('ColdX data folder:', error.message)) },
      ...(!mac ? [{ type: 'separator' }, { role: 'quit', label: '退出' }] : []),
    ] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'reload', label: '重新加载' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }, ...(!app.isPackaged ? [{ role: 'toggleDevTools' }] : [])] },
    { role: 'windowMenu' },
  ]));
}

function showStartupError(error) {
  if (quitting && error?.name === 'AbortError') return;
  console.error('ColdX desktop startup:', error?.message ?? error);
  if (!smoke && !quitting) dialog.showErrorBox('ColdX 启动失败', error?.message ?? String(error));
  process.exitCode = 1;
  if (!quitting) app.quit();
}

async function smokeSnapshot() {
  return window.webContents.executeJavaScript(`(() => {
    const boot = globalThis.__DSH_BOOT__;
    return {
      url: location.href,
      readyState: document.readyState,
      rootChildren: document.querySelector('#root')?.childElementCount ?? 0,
      bootEntryIds: Array.isArray(boot?.entries) ? boot.entries.map(entry => entry?.id).filter(Boolean) : [],
      coldxShell: document.documentElement.classList.contains('coldx-shell'),
      uiText: document.body?.innerText ?? '',
      rendererGlobals: { require: typeof globalThis.require, process: typeof globalThis.process },
    };
  })()`);
}

async function waitForSmoke(instance) {
  const deadline = Date.now() + 45_000;
  let snapshot;
  let lastError;
  while (Date.now() < deadline) {
    if (!lifecycle.isCurrent(instance)) throw new Error('Desktop backend changed before renderer readiness.');
    try {
      snapshot = await smokeSnapshot();
      if (isSmokeReady(snapshot, instance.url)) return snapshot;
      lastError = undefined;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const detail = lastError ? ` Last renderer error: ${lastError.message}` : '';
  throw new Error(`Desktop renderer did not reach the ColdX DSH UI.${detail}`);
}

async function boot() {
  if (smokeReport) await rm(smokeReport, { force: true });
  trace('waiting for app readiness');
  await app.whenReady();
  trace('app ready');
  paths = desktopPaths({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath(), userData: app.getPath('userData'), documents: app.getPath('documents'), execPath: process.env.COLDX_NODE_PATH });
  if (!paths.nodePath) throw new Error('Run desktop development through pnpm desktop:dev so the Node sidecar path is explicit.');
  lifecycle = createBackendLifecycle({
    start: async ({ workspace: nextWorkspace, signal }) => {
      await mkdir(nextWorkspace, { recursive: true });
      if (signal.aborted) {
        const error = new Error('ColdX backend startup was superseded.');
        error.name = 'AbortError';
        throw error;
      }
      return startBackend({ ...paths, workspace: nextWorkspace, signal });
    },
    onUnexpectedExit: () => {
      if (!quitting) dialog.showErrorBox('ColdX 后端已停止', '请退出并重新打开 ColdX。会话记录保存在本机数据目录中。');
    },
  });
  trace('backend lifecycle created');
  await mkdir(app.getPath('userData'), { recursive: true });
  let saved = {};
  try { saved = JSON.parse(await readFile(join(app.getPath('userData'), 'desktop.json'), 'utf8')); } catch {}
  workspace = process.env.COLDX_DESKTOP_WORKSPACE || saved.workspace || paths.workspace;
  installMenu();
  makeWindow();
  trace('window created');
  startup = loadWorkspace(workspace);
  const instance = await startup;
  trace('backend and window loaded');
  if (!smoke) return;
  if (!instance || !lifecycle.isCurrent(instance)) throw new Error('Desktop backend was not current after startup.');
  const snapshot = await waitForSmoke(instance);
  const preferences = window.webContents.getLastWebPreferences();
  const chrome = {
    kind: 'native-titlebar',
    applicationMenuPresent: Boolean(Menu.getApplicationMenu()),
    menuBarVisible: process.platform === 'darwin' ? false : window.isMenuBarVisible(),
    menuBarAutoHide: process.platform === 'darwin' ? false : window.isMenuBarAutoHide(),
    minimizable: window.isMinimizable(), maximizable: window.isMaximizable(), closable: window.isClosable(),
    bounds: window.getBounds(), contentBounds: window.getContentBounds(),
    rendererGlobals: snapshot.rendererGlobals,
    webPreferences: { nodeIntegration: preferences.nodeIntegration, contextIsolation: preferences.contextIsolation, sandbox: preferences.sandbox, webSecurity: preferences.webSecurity, webviewTag: preferences.webviewTag },
  };
  if (process.platform !== 'darwin' && (chrome.applicationMenuPresent || chrome.menuBarVisible || chrome.menuBarAutoHide)) throw new Error('Desktop application menu was not fully removed.');
  if (!chrome.minimizable || !chrome.maximizable || !chrome.closable) throw new Error('Native desktop window controls are unavailable.');
  if (preferences.nodeIntegration || !preferences.contextIsolation || !preferences.sandbox || !preferences.webSecurity || preferences.webviewTag || snapshot.rendererGlobals.require !== 'undefined' || snapshot.rendererGlobals.process !== 'undefined') throw new Error('Desktop renderer isolation was weakened.');
  if (smokeReport) await writeFile(smokeReport, JSON.stringify({
    ok: true,
    platform: process.platform,
    arch: process.arch,
    url: instance.url,
    backendPid: instance.child.pid,
    nodePath: paths.nodePath,
    runtimeRoot: paths.runtimeRoot,
    dataHome: paths.dataHome,
    chrome,
    readiness: {
      url: snapshot.url,
      readyState: snapshot.readyState,
      rootChildren: snapshot.rootChildren,
      bootEntryIds: snapshot.bootEntryIds,
      coldxShell: snapshot.coldxShell,
    },
    uiText: snapshot.uiText.slice(0, 2000),
  }, null, 2));
  console.log('COLDX_DESKTOP_SMOKE_OK');
  app.quit();
}

trace('module initialized');
if (!app.requestSingleInstanceLock()) {
  trace('single-instance lock declined');
  app.quit();
}
else {
  trace('single-instance lock acquired');
  app.on('second-instance', () => { void revealWindow().catch(showStartupError); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' || smoke) app.quit(); });
  app.on('before-quit', event => {
    trace(`before quit: stopped=${stopped}, quitting=${quitting}`);
    if (stopped) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void (lifecycle?.quit() ?? Promise.resolve()).then(() => {
      trace('backend shutdown complete; exiting desktop');
      stopped = true;
      app.exit(process.exitCode || 0);
    }, error => {
      console.error('ColdX desktop shutdown:', error.message);
      stopped = true;
      app.exit(1);
    });
  });
  app.on('activate', () => { void revealWindow().catch(showStartupError); });
  void boot().catch(showStartupError);
}
