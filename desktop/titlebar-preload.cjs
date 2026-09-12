'use strict';

// This preload runs in Electron's sandboxed, isolated main frame. It owns only
// window chrome; no Electron, Node, or generic IPC API is exposed to the page.
(() => {
  if (!process.isMainFrame) return;
  const { ipcRenderer } = require('electron');
  const channel = 'coldx:desktop-chrome';
  const stateChannel = 'coldx:desktop-chrome-state';
  const sidebarSelector = '.hHd-Xa_root button.hHd-Xa_toggle';
  let html;
  let disposed = false;
  let refreshFrame = 0;
  let refreshHostState = false;
  let state = null;
  let themeKey = '';
  let loadingColors = null;
  let openMenu = null;
  let header;
  let style;
  let observer;
  let media;
  const buttons = {};
  const removers = [];

  function listen(target, name, callback, options) {
    target.addEventListener(name, callback, options);
    removers.push(() => target.removeEventListener(name, callback, options));
  }

  async function request(payload) {
    try {
      const result = await ipcRenderer.invoke(channel, payload);
      if (!disposed && result && typeof result.fullScreen === 'boolean') acceptState(result);
      return result;
    } catch {
      // Navigation can destroy this preload while a native menu is open.
      return null;
    }
  }

  function acceptState(next) {
    state = next;
    if (!header) return;
    const fullScreen = next.fullScreen || Boolean(document.fullscreenElement);
    html.setAttribute('data-coldx-desktop-fullscreen', String(fullScreen));
    header.hidden = fullScreen;
    header.dataset.platform = next.platform === 'darwin' ? 'darwin' : 'other';
    buttons.back.disabled = !next.canGoBack;
    buttons.forward.disabled = !next.canGoForward;
    if (!document.getElementById('root')) scheduleRefresh();
  }

  function icon(paths) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 20 20', width: '18', height: '18', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
    for (const d of paths) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  }

  function button(id, label, paths, callback) {
    const element = document.createElement('button');
    element.type = 'button';
    element.dataset.coldxChrome = id;
    element.setAttribute('aria-label', label);
    element.title = label;
    if (paths) element.append(icon(paths));
    else element.textContent = label;
    // The shared DOM does not turn programmatic page clicks into privileged IPC.
    listen(element, 'click', event => {
      if (!event.isTrusted || element.disabled) return;
      callback(element);
    });
    buttons[id] = element;
    return element;
  }

  async function showMenu(id, element) {
    if (openMenu) return;
    openMenu = id;
    element.setAttribute('aria-expanded', 'true');
    const bounds = element.getBoundingClientRect();
    await request({ type: 'menu', id, x: Math.round(bounds.left), y: Math.round(bounds.bottom + 3) });
    element.setAttribute('aria-expanded', 'false');
    openMenu = null;
  }

  // Chromium's computed style resolves CSS variables and color-mix to rgb or
  // color(srgb). Only opaque colors are sent to the host's strict color parser.
  function opaqueHex(value) {
    const hex = String(value).trim().match(/^#([a-f\d]{3}|[a-f\d]{6})$/i);
    if (hex) return '#' + (hex[1].length === 3 ? [...hex[1]].map(c => c + c).join('') : hex[1]).toLowerCase();
    const rgb = String(value).match(/^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i);
    if (rgb && (rgb[4] === undefined || Number(rgb[4]) === 1)) return '#' + rgb.slice(1, 4).map(n => Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, '0')).join('');
    const srgb = String(value).match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/i);
    if (srgb && (srgb[4] === undefined || Number(srgb[4]) === 1)) return '#' + srgb.slice(1, 4).map(n => Math.max(0, Math.min(255, Math.round(Number(n) * 255))).toString(16).padStart(2, '0')).join('');
    return null;
  }

  function showTheme(scheme, background, foreground) {
    const nextKey = [scheme, background, foreground].join(':');
    if (nextKey === themeKey) return false;
    themeKey = nextKey;
    header.dataset.desktopTheme = scheme;
    header.style.setProperty('--cx-chrome-bg', background);
    header.style.setProperty('--cx-chrome-text', foreground);
    header.style.colorScheme = scheme;
    return true;
  }

  function refresh() {
    refreshFrame = 0;
    if (disposed || !header?.isConnected) return;
    if (refreshHostState) {
      refreshHostState = false;
      void request({ type: 'state' });
    }
    const nativeToggle = document.querySelector(sidebarSelector);
    buttons.sidebar.disabled = !nativeToggle || nativeToggle.disabled;
    const nativeLabel = nativeToggle?.getAttribute('aria-label') || '切换侧边栏';
    if (buttons.sidebar.title !== nativeLabel) {
      buttons.sidebar.title = nativeLabel;
      buttons.sidebar.setAttribute('aria-label', nativeLabel);
    }
    // The loading document has no application theme presenter. Its OS fallback
    // must never replace the host's last saved application palette on startup.
    if (!document.getElementById('root')) {
      const theme = state?.theme;
      const background = opaqueHex(theme?.background);
      const foreground = opaqueHex(theme?.foreground);
      if (!background || !foreground || !['light', 'dark'].includes(theme?.scheme)) return;
      const bodyStyle = document.body.style;
      loadingColors ??= ['background-color', 'color', 'color-scheme'].map(name => ({ name, value: bodyStyle.getPropertyValue(name), priority: bodyStyle.getPropertyPriority(name) }));
      for (const [name, value] of [['background-color', background], ['color', foreground], ['color-scheme', theme.scheme]]) {
        // CSSOM normalizes colors to rgb(), so compare normalized values first.
        const current = bodyStyle.getPropertyValue(name);
        if ((name === 'color-scheme' ? current : opaqueHex(current)) !== value) bodyStyle.setProperty(name, value);
      }
      showTheme(theme.scheme, background, foreground);
      return;
    }
    // Normally navigation replaces the document. Also handle a shell that mounts
    // #root in place: remove only the temporary loading styles before reading it.
    if (loadingColors) {
      for (const { name, value, priority } of loadingColors) {
        if (value) document.body.style.setProperty(name, value, priority);
        else document.body.style.removeProperty(name);
      }
      loadingColors = null;
      themeKey = '';
    }
    // The native theme presenter shades [data-slot=root], including portals.
    // Body is the pre-plugin fallback inside the actual application document.
    const root = document.querySelector('#root [data-slot="root"]') || document.querySelector('[data-slot="root"]') || document.body;
    const rootStyle = getComputedStyle(root);
    const bodyStyle = getComputedStyle(document.body);
    const token = name => opaqueHex(rootStyle.getPropertyValue(name)) || opaqueHex(bodyStyle.getPropertyValue(name));
    const background = token('--dsw-specific-sidebar-fill') || token('--dsw-alias-bg-base') || opaqueHex(rootStyle.backgroundColor) || opaqueHex(bodyStyle.backgroundColor) || '#ffffff';
    const foreground = token('--dsw-alias-label-primary') || opaqueHex(rootStyle.color) || opaqueHex(bodyStyle.color) || '#1b1d20';
    const channels = background.slice(1).match(/../g).map(n => parseInt(n, 16));
    const scheme = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722 < 140 ? 'dark' : 'light';
    if (showTheme(scheme, background, foreground)) void request({ type: 'theme', scheme, background, foreground });
  }

  function scheduleRefresh() {
    if (!disposed && !refreshFrame) refreshFrame = requestAnimationFrame(refresh);
  }

  function mount() {
    if (disposed || !document.body || document.getElementById('coldx-desktop-titlebar')) return;
    html = document.documentElement;
    html.setAttribute('data-coldx-desktop-chrome', '');
    html.setAttribute('data-coldx-desktop-fullscreen', 'false');
    style = document.createElement('style');
    style.id = 'coldx-desktop-titlebar-style';
    style.textContent = `
html[data-coldx-desktop-chrome] { --cx-desktop-titlebar-height:40px; }
html[data-coldx-desktop-fullscreen="true"] { --cx-desktop-titlebar-height:0px; }
html[data-coldx-desktop-chrome], html[data-coldx-desktop-chrome] body { height:100%; overflow:hidden; }
html[data-coldx-desktop-chrome] body { box-sizing:border-box; padding-top:var(--cx-desktop-titlebar-height) !important; }
html[data-coldx-desktop-chrome] #root { height:100% !important; min-height:0; }
html[data-coldx-desktop-chrome] #root > [data-slot="root"] { height:100% !important; min-height:0; }
html[data-coldx-desktop-chrome] .pI_x6G_frame { height:100% !important; min-height:0; }
html[data-coldx-desktop-chrome] dialog:modal { max-height:calc(100dvh - var(--cx-desktop-titlebar-height) - 24px); }
html[data-coldx-desktop-chrome] dialog.cx-marketplace-dialog { top:var(--cx-desktop-titlebar-height); height:min(720px,calc(100dvh - var(--cx-desktop-titlebar-height) - 32px)); }
html[data-coldx-desktop-chrome] .VOzbGW_overlay { top:var(--cx-desktop-titlebar-height); }
html[data-coldx-desktop-chrome] .VOzbGW_panel { box-sizing:border-box; max-height:calc(100dvh - var(--cx-desktop-titlebar-height) - 48px); }
@media(max-width:640px) { html[data-coldx-desktop-chrome] .VOzbGW_panel { max-height:calc(100dvh - var(--cx-desktop-titlebar-height) - 24px); } }
#coldx-desktop-titlebar { --cx-chrome-bg:#f8f9fa; --cx-chrome-text:#1b1d20; position:fixed; inset:0 auto auto env(titlebar-area-x,0px); width:env(titlebar-area-width,calc(100% - 138px)); height:40px; box-sizing:border-box; z-index:2147483000; display:flex; align-items:center; gap:2px; padding:0 10px; background:var(--cx-chrome-bg); color:var(--cx-chrome-text); font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; user-select:none; -webkit-app-region:drag; }
#coldx-desktop-titlebar[data-platform="darwin"] { left:env(titlebar-area-x,80px); width:env(titlebar-area-width,calc(100% - 80px)); }
#coldx-desktop-titlebar[hidden] { display:none; }
#coldx-desktop-titlebar button { appearance:none; box-sizing:border-box; border:0; background:transparent; color:inherit; display:inline-flex; justify-content:center; align-items:center; gap:0; height:28px; min-width:30px; margin:0; padding:0 9px; border-radius:6px; font:inherit; line-height:1; white-space:nowrap; cursor:default; -webkit-app-region:no-drag; transition:background-color 120ms ease,color 120ms ease; }
#coldx-desktop-titlebar button[data-coldx-chrome="sidebar"] { margin-right:5px; }
#coldx-desktop-titlebar button:disabled { opacity:.3; }
#coldx-desktop-titlebar button:hover:not(:disabled), #coldx-desktop-titlebar button[aria-expanded="true"] { background:color-mix(in srgb,var(--cx-chrome-text) 8%,transparent); }
#coldx-desktop-titlebar button:active:not(:disabled) { background:color-mix(in srgb,var(--cx-chrome-text) 13%,transparent); }
#coldx-desktop-titlebar button:focus-visible { outline:2px solid color-mix(in srgb,var(--cx-chrome-text) 48%,transparent); outline-offset:-2px; }
#coldx-desktop-titlebar svg { display:block; pointer-events:none; flex-shrink:0; }
#coldx-desktop-titlebar [data-coldx-chrome="file"] { margin-left:7px; }
@media(prefers-reduced-motion:reduce) { #coldx-desktop-titlebar button { transition:none; } }
`;
    document.head.append(style);
    header = document.createElement('header');
    header.id = 'coldx-desktop-titlebar';
    header.setAttribute('data-coldx-desktop-titlebar', '');
    header.setAttribute('aria-label', 'ColdX 窗口');
    header.append(button('sidebar', '切换侧边栏', ['M4 3.5h12a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 15V5A1.5 1.5 0 0 1 4 3.5Z', 'M7.5 3.5v13'], () => document.querySelector(sidebarSelector)?.click()));
    header.append(button('back', '后退', ['M11.5 5 6.5 10l5 5', 'M6.5 10h10'], () => void request({ type: 'back' })));
    header.append(button('forward', '前进', ['m8.5 5 5 5-5 5', 'M3.5 10h10'], () => void request({ type: 'forward' })));
    buttons.back.disabled = true;
    buttons.forward.disabled = true;
    for (const [id, label] of [['file', '文件'], ['edit', '编辑'], ['view', '视图'], ['help', '帮助']]) {
      const element = button(id, label, null, current => void showMenu(id, current));
      // Native edit-menu roles act on the focused editor. Pointer activation of
      // a menu must not blur it or discard its selection. Keyboard activation
      // keeps normal button focus/tab order; no focus is stolen while tabbing.
      listen(element, 'pointerdown', event => {
        if (event.isTrusted && event.button === 0) event.preventDefault();
      });
      element.setAttribute('aria-haspopup', 'menu');
      element.setAttribute('aria-expanded', 'false');
      header.append(element);
    }
    document.body.append(header);
    if (state) acceptState(state);
    refresh();

    observer = new MutationObserver(records => {
      if (records.some(record => !header.contains(record.target) && record.target !== style && !(record.type === 'attributes' && record.attributeName.startsWith('data-coldx-desktop')))) scheduleRefresh();
    });
    observer.observe(html, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'data-ds-dark-theme', 'aria-label', 'disabled'] });
    media = window.matchMedia('(prefers-color-scheme: dark)');
    listen(media, 'change', scheduleRefresh);
    listen(window, 'focus', () => { scheduleRefresh(); void request({ type: 'state' }); });
    listen(window, 'resize', () => { refreshHostState = true; scheduleRefresh(); });
    listen(document, 'fullscreenchange', () => { if (state) acceptState(state); });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    observer?.disconnect();
    if (refreshFrame) cancelAnimationFrame(refreshFrame);
    ipcRenderer.removeListener(stateChannel, onState);
    for (const remove of removers) remove();
  }

  const onState = (_event, next) => { if (!disposed && next && typeof next.fullScreen === 'boolean') acceptState(next); };
  ipcRenderer.on(stateChannel, onState);
  listen(window, 'pagehide', dispose, { once: true });
  if (document.readyState === 'loading') listen(document, 'DOMContentLoaded', mount, { once: true });
  else mount();
  void request({ type: 'state' });
})();
