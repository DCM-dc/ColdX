import { classifyNavigation } from './window-policy.mjs';

export const CHROME_CHANNEL = 'coldx:desktop-chrome';
export const CHROME_STATE_CHANNEL = 'coldx:desktop-chrome-state';
export const TITLEBAR_HEIGHT = 40;
const MENU_IDS = new Set(['file', 'edit', 'view', 'help']);
const HELP_URLS = Object.freeze({
  readme: 'https://github.com/DCM-dc/ColdX#readme',
  issues: 'https://github.com/DCM-dc/ColdX/issues',
  releases: 'https://github.com/DCM-dc/ColdX/releases',
});

export function normalizeChromeTheme(value) {
  if (!value || !['light', 'dark'].includes(value.scheme)
    || !/^#[\da-f]{6}$/iu.test(value.background) || !/^#[\da-f]{6}$/iu.test(value.foreground)) return undefined;
  return { scheme: value.scheme, background: value.background.toLowerCase(), foreground: value.foreground.toLowerCase() };
}

export function defaultChromeTheme(dark = false) {
  return dark ? { scheme: 'dark', background: '#18181b', foreground: '#f4f4f5' }
    : { scheme: 'light', background: '#fafafa', foreground: '#18181b' };
}

export function desktopTitlebarOptions({ platform = process.platform, theme = defaultChromeTheme() } = {}) {
  const colors = normalizeChromeTheme(theme) ?? defaultChromeTheme();
  return {
    frame: true, titleBarStyle: 'hidden', autoHideMenuBar: false,
    backgroundColor: colors.background,
    ...(platform === 'darwin' ? { trafficLightPosition: { x: 12, y: 12 } }
      : { titleBarOverlay: { height: TITLEBAR_HEIGHT, color: colors.background, symbolColor: colors.foreground } }),
  };
}

function validSource(url, backendUrl, loadingUrl) {
  if (url === loadingUrl) return true;
  return Boolean(backendUrl && classifyNavigation(url, backendUrl) === 'internal');
}

export function isOwnedChromeSender(event, window, backendUrl, loadingUrl) {
  try {
    const contents = window.webContents;
    return !window.isDestroyed() && !contents.isDestroyed()
      && event.sender === contents && event.senderFrame === contents.mainFrame
      && validSource(event.senderFrame.url, backendUrl, loadingUrl)
      && (event.senderFrame.url === loadingUrl || event.senderFrame.origin === new URL(backendUrl).origin);
  } catch { return false; }
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

/** Find a real history entry in the current workspace, excluding the loading
 * file and old backend ports left in Chromium history after workspace switches. */
export function chromeHistoryTarget(contents, backendUrl, direction) {
  if (!backendUrl || classifyNavigation(contents.getURL(), backendUrl) !== 'internal') return undefined;
  const history = contents.navigationHistory;
  const entries = history.getAllEntries();
  const step = direction === 'back' ? -1 : 1;
  for (let index = history.getActiveIndex() + step; index >= 0 && index < entries.length; index += step) {
    if (classifyNavigation(entries[index].url, backendUrl) === 'internal') return index;
  }
}

/** A single-window IPC handler. No renderer-supplied URL, filesystem path,
 * executable, menu template, or nativeTheme override crosses this boundary. */
export function createDesktopTitlebarHost({ window, ipcMain, Menu, getBackendUrl, loadingUrl,
  platform = process.platform, initialTheme = defaultChromeTheme(), onTheme = () => {},
  openWorkspace = () => {}, openDataDirectory = () => {}, openExternal = () => {},
  showAbout = () => {}, onError = () => {}, development = false }) {
  const contents = window.webContents;
  let theme = normalizeChromeTheme(initialTheme) ?? defaultChromeTheme();
  let disposed = false;
  let lastOverlay = { height: TITLEBAR_HEIGHT, color: theme.background, symbolColor: theme.foreground };
  const menus = new Map();
  const alive = () => !disposed && !window.isDestroyed() && !contents.isDestroyed();
  const trusted = event => alive() && isOwnedChromeSender(event, window, getBackendUrl(), loadingUrl);
  const syncOverlay = () => {
    const factor = contents.getZoomFactor();
    const zoomFactor = Number.isFinite(factor) && factor > 0 ? factor : 1;
    const overlayHeight = Math.max(1, Math.round(TITLEBAR_HEIGHT * zoomFactor));
    const overlay = { height: overlayHeight, color: theme.background, symbolColor: theme.foreground };
    if (platform !== 'darwin' && JSON.stringify(overlay) !== JSON.stringify(lastOverlay)) window.setTitleBarOverlay(overlay);
    lastOverlay = overlay;
    return { zoomFactor, overlayHeight };
  };
  const snapshot = () => {
    const geometry = syncOverlay();
    return { platform, fullScreen: window.isFullScreen(), maximized: window.isMaximized(),
      canGoBack: chromeHistoryTarget(contents, getBackendUrl(), 'back') !== undefined,
      canGoForward: chromeHistoryTarget(contents, getBackendUrl(), 'forward') !== undefined,
      height: TITLEBAR_HEIGHT, ...geometry, theme: { ...theme } };
  };
  const publish = () => {
    if (!alive() || !trusted({ sender: contents, senderFrame: contents.mainFrame })) return;
    contents.send(CHROME_STATE_CHANNEL, snapshot());
  };
  const call = (event, action) => () => {
    if (!trusted(event)) return;
    try { Promise.resolve(action()).catch(onError); } catch (error) { onError(error); }
  };
  const template = (id, event) => {
    if (id === 'file') return [
      { label: '打开工作区…', accelerator: 'CmdOrCtrl+O', click: call(event, openWorkspace) },
      { label: '打开数据文件夹', click: call(event, openDataDirectory) },
      { type: 'separator' }, { role: 'close', label: '关闭窗口' },
    ];
    if (id === 'edit') return [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' },
      { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }];
    if (id === 'view') return [{ role: 'reload', label: '重新加载' }, { type: 'separator' },
      { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' },
      { type: 'separator' }, { role: 'togglefullscreen', label: '切换全屏' },
      ...(development ? [{ role: 'toggleDevTools', label: '开发者工具' }] : [])];
    return [
      { label: '使用说明', click: call(event, () => openExternal(HELP_URLS.readme)) },
      { label: '反馈问题', click: call(event, () => openExternal(HELP_URLS.issues)) },
      { label: '版本下载', click: call(event, () => openExternal(HELP_URLS.releases)) },
      { type: 'separator' }, { label: '关于 ColdX', click: call(event, showAbout) },
    ];
  };
  async function handle(event, request) {
    if (!trusted(event)) throw new Error('Desktop chrome request is not from the active main frame.');
    if (exactKeys(request, ['type']) && ['state', 'back', 'forward'].includes(request.type)) {
      if (request.type !== 'state') {
        const target = chromeHistoryTarget(contents, getBackendUrl(), request.type);
        if (target !== undefined) contents.navigationHistory.goToIndex(target);
      }
      return snapshot();
    }
    if (request?.type === 'theme' && exactKeys(request, ['type', 'scheme', 'background', 'foreground'])) {
      const colors = normalizeChromeTheme(request);
      if (!colors) throw new Error('Invalid desktop chrome theme.');
      if (JSON.stringify(colors) !== JSON.stringify(theme)) {
        theme = colors;
        window.setBackgroundColor(theme.background);
        syncOverlay();
        // Do not assign nativeTheme.themeSource from a computed DOM scheme: that
        // would latch "follow system" to its last value and create feedback.
        try { Promise.resolve(onTheme({ ...theme })).catch(onError); } catch (error) { onError(error); }
        publish();
      }
      return snapshot();
    }
    if (request?.type === 'menu' && exactKeys(request, ['type', 'id', 'x', 'y']) && MENU_IDS.has(request.id)
      && Number.isFinite(request.x) && Number.isFinite(request.y) && request.x >= 0 && request.y >= 0) {
      // IPC positions are renderer CSS pixels; native Menu.popup consumes DIP.
      const zoom = contents.getZoomFactor();
      const [width, height] = window.getContentSize();
      const x = Math.max(0, Math.min(width - 1, Math.round(request.x * zoom)));
      const y = Math.max(0, Math.min(height - 1, Math.round(request.y * zoom)));
      const menu = Menu.buildFromTemplate(template(request.id, event));
      await new Promise((done, reject) => {
        const finish = () => {
          menus.delete(menu);
          // Native zoom roles have completed when their popup closes. Explicit
          // sync plus the DOM resize/state handshake covers both menu and
          // keyboard zoom; zoom-changed alone misses programmatic role changes.
          publish();
          done();
        };
        menus.set(menu, finish);
        try { menu.popup({ window, x, y, callback: finish }); }
        catch (error) { menus.delete(menu); reject(error); }
      });
      return alive() ? snapshot() : undefined;
    }
    throw new Error('Unsupported desktop chrome request.');
  }
  ipcMain.handle(CHROME_CHANNEL, handle);
  const windowEvents = ['enter-full-screen', 'leave-full-screen', 'maximize', 'unmaximize', 'resize'];
  const contentsEvents = ['did-navigate', 'did-navigate-in-page', 'did-stop-loading', 'zoom-changed'];
  for (const event of windowEvents) window.on(event, publish);
  for (const event of contentsEvents) contents.on(event, publish);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    ipcMain.removeHandler(CHROME_CHANNEL);
    for (const event of windowEvents) window.off(event, publish);
    for (const event of contentsEvents) contents.off(event, publish);
    for (const [menu, finish] of menus) { try { menu.closePopup(window); } catch {} finally { finish(); } }
  };
  return { snapshot, publish, dispose };
}
