// Serialized by the client build: keep helpers and defaults inside this function.
// The owner must mount this document in an iframe with sandbox="allow-scripts".
export function buildPageDocument({ html, css = '', script = '', channel, theme = 'light', rawDocument = false }) {
  if (typeof channel !== 'string' || channel.length === 0) throw new TypeError('A page channel is required.');
  if (typeof html !== 'string' || typeof css !== 'string' || typeof script !== 'string') {
    throw new TypeError('Page html, css and script must be strings.');
  }
  const json = (value) => JSON.stringify(value)
    .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const dark = theme === 'dark';
  const policy = "default-src 'none'; connect-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; frame-src 'none'; child-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
  const head = `<!doctype html>
<html lang="zh-CN" data-theme="${dark ? 'dark' : 'light'}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="${dark ? 'dark' : 'light'}">
<title>ColdX</title>
<style>
:root{color-scheme:light;--page-bg:#fff;--page-surface:#f8f9fb;--page-text:#202329;--page-muted:#626975;--page-line:#dce1e7;--page-field:#f8f9fb;--page-accent:#6554c4;--page-on-accent:#fff;${rawDocument ? '' : 'font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;font-size:15px;line-height:1.6;'}color:var(--page-text);background:var(--page-bg)}
:root[data-theme="dark"]{color-scheme:dark;--page-bg:#17191c;--page-surface:#1d2025;--page-text:#eef0f3;--page-muted:#b3b9c2;--page-line:#3a4049;--page-field:#22262c;--page-accent:#c5bdff;--page-on-accent:#252038}
${rawDocument ? '' : '*{box-sizing:border-box}body{margin:0;min-width:0}#app{min-height:0;padding:clamp(20px,4vw,44px)}h1,h2,h3{line-height:1.25;letter-spacing:-.025em}h1{font-size:clamp(26px,4vw,38px)}p{margin:0 0 1em}small{color:var(--page-muted)}a{color:var(--page-accent);text-underline-offset:3px}img,svg,canvas,video{max-width:100%}img{height:auto}button,input,select,textarea{font:inherit}button,input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]),select,textarea{border:1px solid var(--page-line);border-radius:10px;padding:10px 13px;color:var(--page-text);background:var(--page-field)}input,select,textarea{max-width:100%;accent-color:var(--page-accent)}input::placeholder,textarea::placeholder{color:var(--page-muted);opacity:1}button{cursor:pointer;min-height:40px;background:var(--page-accent);color:var(--page-on-accent);border-color:transparent;font-weight:600}button:disabled{opacity:.5;cursor:not-allowed}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,a:focus-visible{outline:2px solid var(--page-accent);outline-offset:3px}textarea{resize:vertical;min-height:100px}label{display:block;margin-bottom:6px}table{border-collapse:collapse;width:100%}td,th{padding:10px 12px;border-bottom:1px solid var(--page-line);text-align:left}pre{overflow:auto;border-radius:10px;padding:16px;background:var(--page-field)}code,pre{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}'}
</style>
<script>
(() => {
  const channel = ${json(channel)};
  let theme = ${json(dark ? 'dark' : 'light')};
  // Legacy pages often contain both palettes behind an OS media query. Only
  // exact single-scheme queries can safely be mapped to the host preference.
  // Keep author declarations, compound queries and other media untouched.
  const schemes = new WeakMap();
  const syncMedia = media => {
    if (!media) return;
    const text = media.mediaText;
    let scheme = schemes.get(media);
    if (!scheme || (text !== 'all' && text !== 'not all')) {
      scheme = /^\\(\\s*prefers-color-scheme\\s*:\\s*(light|dark)\\s*\\)$/i.exec(text)?.[1]?.toLowerCase();
      if (!scheme) { schemes.delete(media); return; }
      schemes.set(media, scheme);
    }
    const next = scheme === theme ? 'all' : 'not all';
    if (media.mediaText !== next) media.mediaText = next;
  };
  const syncRules = owner => {
    try {
      syncMedia(owner.media);
      for (const rule of owner.cssRules || []) syncRules(rule);
    } catch { /* Inaccessible stylesheets keep their authored behavior. */ }
  };
  const syncStyles = () => { for (const sheet of document.styleSheets || []) syncRules(sheet); };
  // The host owns theme selection; the sandbox owns its DOM and local state.
  // Updating one root attribute changes the shared CSS tokens without reload.
  const applyTheme = next => {
    if (next !== 'light' && next !== 'dark') return;
    const changed = next !== theme;
    theme = next;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.content = theme;
    syncStyles();
    if (changed) window.dispatchEvent(new CustomEvent('coldx:themechange', { detail: { theme } }));
  };
  const frame = window.requestAnimationFrame.bind(window);
  document.addEventListener('DOMContentLoaded', () => {
    applyTheme(theme);
    if (${json(Boolean(rawDocument))}) frame(() => frame(() => {
      try { parent.postMessage({ type: 'coldx:ready', channel }, '*'); } catch {}
    }));
  }, { once: true });
  if (typeof MutationObserver === 'function') {
    const isStyle = node => node?.nodeType === 1 && node.matches?.('style,link[rel="stylesheet"]');
    const hasStyle = node => isStyle(node) || (node?.nodeType === 1 && node.querySelector?.('style,link[rel="stylesheet"]'));
    new MutationObserver(records => {
      if (records.some(record => isStyle(record.target) || record.target?.parentElement?.closest?.('style') || [...record.addedNodes].some(hasStyle))) syncStyles();
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['media'] });
  }
  const waiters = new Map();
  const prefix = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  let sequence = 0;
  for (const type of ['pointerdown', 'keydown', 'input', 'wheel', 'touchstart']) window.addEventListener(type, () => {
    parent.postMessage({ type: 'coldx:engage', channel }, '*');
  }, { passive: true });
  const release = (requestId) => {
    const waiter = waiters.get(requestId);
    if (!waiter) return;
    waiters.delete(requestId);
    clearTimeout(waiter.timer);
    return waiter;
  };
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== parent || !data || typeof data !== 'object' || data.channel !== channel) return;
    if (data.type === 'coldx:theme') { applyTheme(data.theme); return; }
    if (data.type !== 'coldx:result' || typeof data.requestId !== 'string' || typeof data.ok !== 'boolean') return;
    const waiter = release(data.requestId);
    if (!waiter) return;
    if (data.ok) waiter.resolve(data.value);
    else {
      const detail = typeof data.error === 'string' ? data.error : data.error?.message;
      waiter.reject(new Error(typeof detail === 'string' && detail ? detail : '提交失败，请重试。'));
    }
  });
  window.ColdX = Object.freeze({
    get theme() { return theme; },
    submit(value) {
      return new Promise((resolve, reject) => {
        // postMessage accepts cycles and BigInt, but the host's answer transport is JSON.
        // Normalize before allocating a waiter so invalid values fail immediately.
        let normalized;
        try {
          const serialized = JSON.stringify(value);
          if (serialized === undefined) throw new TypeError('请提交可保存的 JSON 值。');
          if (serialized.length > 65536) {
            throw new RangeError('提交内容不能超过 65,536 个字符。');
          }
          normalized = JSON.parse(serialized);
        } catch (error) { reject(error); return; }
        const requestId = prefix + '-' + (++sequence);
        const timer = setTimeout(() => {
          const waiter = release(requestId);
          if (!waiter) return;
          const error = new Error('提交超时，请重试。');
          error.name = 'TimeoutError';
          waiter.reject(error);
        }, 30000);
        waiters.set(requestId, { resolve, reject, timer });
        try { parent.postMessage({ type: 'coldx:submit', channel, requestId, value: normalized }, '*'); }
        catch (error) { release(requestId)?.reject(error); }
      });
    }
  });
})();
</script>
</head>`;
  // Preserve inline script execution for file previews, inside the same CSP and
  // opaque-origin sandbox as generated pages. No innerHTML reconstruction.
  if (rawDocument) return `${head}<body>${html}</body></html>`;
  return `${head}<body>
<main id="app"></main>
<script>
(() => {
  const app = document.getElementById('app');
  const post = message => { try { parent.postMessage(message, '*'); } catch {} };
  const measure = () => {
    try {
      const height = Math.ceil(app.getBoundingClientRect().height);
      return Number.isFinite(height) && height > 0 ? height : undefined;
    } catch { return undefined; }
  };
  // Capture the scheduler before generated code runs. A page is ready only
  // after its synchronous setup and two actual layout/paint opportunities.
  const frame = window.requestAnimationFrame.bind(window);
  frame(() => frame(() => {
    const height = measure();
    post({ type: 'coldx:ready', channel: ${json(channel)}, ...(height ? { height } : {}) });
  }));
  app.innerHTML = ${json(html)};
  const style = document.createElement('style');
  style.textContent = ${json(css)};
  document.head.appendChild(style);
  const script = document.createElement('script');
  script.textContent = ${json(script)};
  try { document.body.appendChild(script); } catch {}
  const reducedMotion = document.createElement('style');
  reducedMotion.textContent = '@media (prefers-reduced-motion: reduce){*,*::before,*::after{scroll-behavior:auto!important;animation-duration:0.001ms!important;animation-delay:0ms!important;animation-iteration-count:1!important;transition-duration:0.001ms!important;transition-delay:0ms!important}}';
  document.head.appendChild(reducedMotion);
  if (typeof ResizeObserver === 'function') {
    try {
      new ResizeObserver(() => {
        const height = measure();
        if (height) post({ type: 'coldx:resize', channel: ${json(channel)}, height });
      }).observe(app);
    } catch {}
  }
})();
</script>
</body>
</html>`;
}
