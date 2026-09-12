import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const source = await readFile(new URL('../desktop/titlebar-preload.cjs', import.meta.url), 'utf8');

test('desktop chrome preload does nothing in generated-page and other subframes', () => {
  let required = false;
  vm.runInNewContext(source, { process: { isMainFrame: false }, require() { required = true; throw new Error('subframe required Electron'); } });
  assert.equal(required, false);
});

test('desktop preload requests bounded host state and removes its listener on navigation', async () => {
  const calls = [], hostListeners = new Map(), windowListeners = new Map(), documentListeners = new Map();
  const window = { addEventListener: (name, fn) => windowListeners.set(name, fn), removeEventListener: name => windowListeners.delete(name) };
  const document = { documentElement: null, readyState: 'loading', addEventListener: (name, fn) => documentListeners.set(name, fn), removeEventListener: name => documentListeners.delete(name) };
  const electron = { ipcRenderer: {
    invoke: async (channel, payload) => { calls.push({ channel, payload }); return { fullScreen: false, canGoBack: false, canGoForward: false }; },
    on: (name, fn) => hostListeners.set(name, fn),
    removeListener: name => hostListeners.delete(name),
  } };
  const context = { process: { isMainFrame: true }, require: name => { assert.equal(name, 'electron'); return electron; }, window, document };
  vm.runInNewContext(source, context);
  await Promise.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ channel: 'coldx:desktop-chrome', payload: { type: 'state' } }]);
  assert.equal(hostListeners.has('coldx:desktop-chrome-state'), true);
  assert.deepEqual(Object.keys(window), ['addEventListener', 'removeEventListener']);
  windowListeners.get('pagehide')();
  assert.equal(hostListeners.size, 0);
  assert.equal(documentListeners.size, 0);
});

// Browser geometry is opt-in so a clean `pnpm test` does not require downloading
// Chromium. Run: COLDX_TITLEBAR_BROWSER=1 node --test test/desktop-titlebar-ui.test.mjs
test('desktop chrome browser interactions, theme, layout, modal and fullscreen', { skip: process.env.COLDX_TITLEBAR_BROWSER !== '1' }, async t => {
  const require = createRequire(await realpath(new URL('../node_modules/@playwright/mcp/package.json', import.meta.url)));
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, ...(process.env.COLDX_TEST_CHROMIUM ? { executablePath: process.env.COLDX_TEST_CHROMIUM } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(`<!doctype html><html><head><style>
html,body,#root{height:100%;margin:0}body{--dsw-alias-bg-base:#fff;--dsw-specific-sidebar-fill:#f8f9fa;--dsw-alias-label-primary:#1b1d20;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
body[data-ds-dark-theme]{--dsw-alias-bg-base:#17191c;--dsw-specific-sidebar-fill:#141618;--dsw-alias-label-primary:#eff1f4}
.pI_x6G_frame{height:100%;display:flex}.hHd-Xa_root{width:220px;background:var(--dsw-specific-sidebar-fill)}main{display:flex;flex:1;min-height:0;flex-direction:column}article{flex:1;overflow:auto}textarea{height:80px;box-sizing:border-box;resize:none}
dialog.cx-marketplace-dialog{width:700px;height:calc(100dvh - 32px);margin:auto;box-sizing:border-box}
</style></head><body><div id="root"><div data-slot="root" style="height:100dvh"><div class="pI_x6G_frame"><aside class="hHd-Xa_root"><button class="hHd-Xa_toggle" aria-label="收起侧边栏">原生切换</button></aside><main><article>任务</article><textarea aria-label="输入消息"></textarea></main></div></div></div><dialog class="cx-marketplace-dialog">插件市场</dialog></body></html>`);
    await page.evaluate(preload => {
      window.chromeRequests = [];
      window.chromeState = { platform: 'win32', fullScreen: false, maximized: false, canGoBack: false, canGoForward: false, height: 40, theme: { scheme: 'light', background: '#f8f9fa', foreground: '#1b1d20' } };
      window.chromeHandlers = {};
      const ipcRenderer = {
        on: (name, handler) => { window.chromeHandlers[name] = handler; },
        removeListener: name => { delete window.chromeHandlers[name]; },
        invoke: async (channel, payload) => {
          window.chromeRequests.push({ channel, payload });
          if (payload.type === 'theme') window.chromeState.theme = payload;
          if (payload.type === 'menu') await new Promise(resolve => { window.closeChromeMenu = resolve; });
          return structuredClone(window.chromeState);
        },
      };
      window.pushChromeState = patch => { Object.assign(window.chromeState, patch); window.chromeHandlers['coldx:desktop-chrome-state']({}, structuredClone(window.chromeState)); };
      window.sidebarToggles = 0;
      document.querySelector('.hHd-Xa_toggle').addEventListener('click', () => { window.sidebarToggles += 1; });
      new Function('require', 'process', preload)(name => { if (name !== 'electron') throw new Error(name); return { ipcRenderer }; }, { isMainFrame: true });
    }, source);
    const header = page.locator('#coldx-desktop-titlebar');
    await header.waitFor();

    await t.test('reserves exactly 40px and keeps the composer inside the viewport', async () => {
      const geometry = await page.evaluate(() => Object.fromEntries(['#coldx-desktop-titlebar', '#root', '.pI_x6G_frame', 'textarea'].map(selector => {
        const r = document.querySelector(selector).getBoundingClientRect(); return [selector, { top: r.top, bottom: r.bottom, height: r.height, right: r.right }];
      })));
      assert.equal(geometry['#coldx-desktop-titlebar'].height, 40);
      assert.equal(geometry['#coldx-desktop-titlebar'].right, 1100 - 138);
      assert.equal(geometry['#root'].top, 40);
      assert.equal(geometry['.pI_x6G_frame'].bottom, 720);
      assert.equal(geometry.textarea.bottom, 720);
      await page.getByRole('textbox', { name: '输入消息' }).fill('正常输入');
      assert.equal(await page.getByRole('textbox', { name: '输入消息' }).inputValue(), '正常输入');
    });

    await t.test('native sidebar toggle, host navigation and synthetic-click rejection', async () => {
      await header.getByRole('button', { name: '收起侧边栏' }).click();
      assert.equal(await page.evaluate(() => window.sidebarToggles), 1);
      assert.equal(await header.getByRole('button', { name: '后退', exact: true }).isDisabled(), true);
      await page.evaluate(() => window.pushChromeState({ canGoBack: true, canGoForward: true }));
      await header.getByRole('button', { name: '后退', exact: true }).click();
      const before = await page.evaluate(() => window.chromeRequests.length);
      await page.evaluate(() => document.querySelector('[data-coldx-chrome="forward"]').click());
      assert.equal(await page.evaluate(() => window.chromeRequests.length), before);
      await header.getByRole('button', { name: '前进', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.chromeRequests.filter(row => ['back', 'forward'].includes(row.payload.type)).map(row => row.payload.type)), ['back', 'forward']);
    });

    await t.test('native menu remains active until the host closes it', async () => {
      await header.getByRole('button', { name: '文件', exact: true }).click();
      assert.equal(await header.getByRole('button', { name: '文件', exact: true }).getAttribute('aria-expanded'), 'true');
      const request = await page.evaluate(() => window.chromeRequests.find(row => row.payload.type === 'menu'));
      assert.equal(request.channel, 'coldx:desktop-chrome');
      assert.equal(request.payload.id, 'file');
      assert.ok(request.payload.x > 0 && request.payload.y <= 40);
      await page.evaluate(() => window.closeChromeMenu());
      await page.waitForFunction(() => document.querySelector('[data-coldx-chrome="file"]').getAttribute('aria-expanded') === 'false');
    });

    await t.test('pointer menus preserve editor focus and selection while keyboard menus remain focusable', async () => {
      const editor = page.getByRole('textbox', { name: '输入消息' });
      await editor.fill('保留这段文字的选区');
      for (const label of ['文件', '编辑', '视图', '帮助']) {
        await editor.focus();
        await editor.evaluate(element => element.setSelectionRange(2, 6));
        await header.getByRole('button', { name: label, exact: true }).click();
        assert.deepEqual(await editor.evaluate(element => ({ focused: document.activeElement === element, start: element.selectionStart, end: element.selectionEnd })), { focused: true, start: 2, end: 6 });
        await page.evaluate(() => window.closeChromeMenu());
        await page.waitForFunction(() => !document.querySelector('#coldx-desktop-titlebar button[aria-expanded="true"]'));
      }
      // Pointer focus suppression must not make the menu disappear from tab order.
      await header.getByRole('button', { name: '文件', exact: true }).focus();
      await page.keyboard.press('Tab');
      assert.equal(await header.getByRole('button', { name: '编辑', exact: true }).evaluate(element => document.activeElement === element), true);
      await page.keyboard.press('Enter');
      assert.equal(await header.getByRole('button', { name: '编辑', exact: true }).getAttribute('aria-expanded'), 'true');
      assert.equal(await header.getByRole('button', { name: '编辑', exact: true }).evaluate(element => document.activeElement === element), true);
      await page.evaluate(() => window.closeChromeMenu());
      await page.waitForFunction(() => !document.querySelector('#coldx-desktop-titlebar button[aria-expanded="true"]'));
    });

    await t.test('tracks the actual application palette without locking OS preference', async () => {
      await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''));
      await page.waitForFunction(() => document.querySelector('#coldx-desktop-titlebar').dataset.desktopTheme === 'dark');
      assert.equal(await header.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(20, 22, 24)');
      assert.equal(await page.evaluate(() => window.chromeState.theme.background), '#141618');
      await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'));
      await page.waitForFunction(() => document.querySelector('#coldx-desktop-titlebar').dataset.desktopTheme === 'light');
      assert.equal(await page.evaluate(() => window.chromeState.theme.background), '#f8f9fa');
    });

    await t.test('native dialog and short viewport stay below the titlebar', async () => {
      await page.setViewportSize({ width: 820, height: 620 });
      await page.evaluate(() => document.querySelector('dialog').showModal());
      const rect = await page.locator('dialog').boundingBox();
      assert.ok(rect.y >= 40 && rect.y + rect.height <= 620);
      await page.evaluate(() => document.querySelector('dialog').close());
    });

    await t.test('fullscreen removes titlebar and restores the entire content height', async () => {
      await page.evaluate(() => window.pushChromeState({ fullScreen: true }));
      assert.equal(await header.isVisible(), false);
      assert.equal(await page.locator('#root').evaluate(element => element.getBoundingClientRect().top), 0);
      assert.equal(await page.locator('textarea').evaluate(element => element.getBoundingClientRect().bottom), 620);
      assert.equal(await page.locator('.hHd-Xa_toggle').isVisible(), true);
      await page.evaluate(() => window.pushChromeState({ fullScreen: false }));
      assert.equal(await page.locator('#root').evaluate(element => element.getBoundingClientRect().top), 40);
    });

    await t.test('reduced motion and IPC remain bounded', async () => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(await header.locator('button').first().evaluate(element => getComputedStyle(element).transitionDuration), '0s');
      const requests = await page.evaluate(() => window.chromeRequests);
      assert.ok(requests.every(row => row.channel === 'coldx:desktop-chrome' && ['state', 'theme', 'menu', 'back', 'forward'].includes(row.payload.type)));
      assert.deepEqual(errors, []);
    });

    await t.test('resize refreshes host geometry and standalone loading page reserves chrome', async () => {
      const previous = await page.evaluate(() => window.chromeRequests.filter(row => row.payload.type === 'state').length);
      await page.setViewportSize({ width: 900, height: 650 });
      await page.waitForFunction(before => window.chromeRequests.filter(row => row.payload.type === 'state').length > before, previous);
      const loading = await browser.newPage({ viewport: { width: 900, height: 650 } });
      await loading.setContent(await readFile(new URL('../desktop/loading.html', import.meta.url), 'utf8'));
      await loading.evaluate(preload => {
        const ipcRenderer = { on() {}, removeListener() {}, invoke: async () => ({ platform: 'win32', fullScreen: false, canGoBack: false, canGoForward: false }) };
        new Function('require', 'process', preload)(() => ({ ipcRenderer }), { isMainFrame: true });
      }, source);
      assert.equal(await loading.locator('#coldx-desktop-titlebar').evaluate(element => element.getBoundingClientRect().height), 40);
      assert.equal(await loading.locator('body').evaluate(element => getComputedStyle(element).paddingTop), '40px');
      assert.equal(await loading.locator('[data-coldx-chrome="sidebar"]').isDisabled(), true);
      assert.ok(await loading.locator('main').evaluate(element => element.getBoundingClientRect().top > 40 && element.getBoundingClientRect().bottom < innerHeight));
      await loading.close();
    });

    await t.test('loading uses persisted host dark theme under a light OS without sending fallback colors', async () => {
      const loading = await browser.newPage({ viewport: { width: 900, height: 650 }, colorScheme: 'light' });
      await loading.setContent(await readFile(new URL('../desktop/loading.html', import.meta.url), 'utf8'));
      await loading.evaluate(preload => {
        window.loadingRequests = [];
        const state = { platform: 'win32', fullScreen: false, canGoBack: false, canGoForward: false, theme: { scheme: 'dark', background: '#141618', foreground: '#eff1f4' } };
        const ipcRenderer = { on() {}, removeListener() {}, invoke: async (_channel, request) => {
          window.loadingRequests.push(request);
          if (request.type === 'state') await new Promise(resolve => { window.releaseLoadingState = resolve; });
          return state;
        } };
        new Function('require', 'process', preload)(() => ({ ipcRenderer }), { isMainFrame: true });
      }, source);
      assert.deepEqual(await loading.evaluate(() => window.loadingRequests.map(request => request.type)), ['state']);
      await loading.evaluate(() => window.releaseLoadingState());
      await loading.waitForFunction(() => document.querySelector('#coldx-desktop-titlebar').dataset.desktopTheme === 'dark');
      assert.equal(await loading.locator('body').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(20, 22, 24)');
      assert.equal(await loading.locator('body').evaluate(element => getComputedStyle(element).colorScheme), 'dark');
      assert.equal(await loading.locator('#coldx-desktop-titlebar').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(20, 22, 24)');
      assert.deepEqual(await loading.evaluate(() => window.loadingRequests.map(request => request.type)), ['state']);
      // A subsequently mounted application must regain authority over its palette.
      await loading.evaluate(() => {
        const root = document.createElement('div'); root.id = 'root';
        root.style.setProperty('--dsw-specific-sidebar-fill', '#f8f9fa');
        root.style.setProperty('--dsw-alias-label-primary', '#1b1d20');
        root.setAttribute('data-slot', 'root'); document.body.append(root);
      });
      await loading.waitForFunction(() => document.querySelector('#coldx-desktop-titlebar').dataset.desktopTheme === 'light');
      assert.deepEqual(await loading.locator('body').evaluate(element => ['background-color', 'color', 'color-scheme'].map(name => element.style.getPropertyValue(name))), ['', '', '']);
      assert.equal(await loading.evaluate(() => window.loadingRequests.at(-1).type), 'theme');
      await loading.close();
    });

    await t.test('native div settings dialog remains below chrome in small and zoom-equivalent viewports', async () => {
      const nativeRequire = createRequire(await realpath(new URL('../node_modules/@deepseek-ai/dsh/package.json', import.meta.url)));
      const settingsSource = await readFile(nativeRequire.resolve('@deepseek-ai/dsh-client-ui-settings-general/client'), 'utf8');
      const nativeCss = settingsSource.match(/const css\$3 = ("(?:\\.|[^"\\])*");/);
      assert.ok(nativeCss, 'pinned native settings CSS must be present');
      await page.addStyleTag({ content: JSON.parse(nativeCss[1]) + '\n' + await readFile(new URL('../plugin/client/native.css', import.meta.url), 'utf8') });
      await page.evaluate(() => {
        document.documentElement.classList.add('coldx-shell');
        const overlay = document.createElement('div'); overlay.className = 'VOzbGW_overlay';
        overlay.innerHTML = '<div class="VOzbGW_mask"></div><div class="VOzbGW_panel" role="dialog" aria-label="设置"><nav class="VOzbGW_nav"><div class="VOzbGW_navTitle">设置</div></nav><section class="VOzbGW_content"><div class="VOzbGW_header"><button class="VOzbGW_close" aria-label="关闭设置">×</button></div><div class="VOzbGW_options"><input aria-label="设置输入"></div></section></div>';
        document.body.append(overlay);
      });
      for (const viewport of [{ width: 820, height: 620 }, { width: 547, height: 413 }]) {
        await page.setViewportSize(viewport);
        await page.evaluate(() => window.pushChromeState({ fullScreen: false }));
        const rects = await page.evaluate(() => Object.fromEntries(['.VOzbGW_overlay', '.VOzbGW_panel', '.VOzbGW_navTitle', '.VOzbGW_close'].map(selector => { const rect = document.querySelector(selector).getBoundingClientRect(); return [selector, { top: rect.top, bottom: rect.bottom }]; })));
        assert.equal(rects['.VOzbGW_overlay'].top, 40);
        assert.ok(rects['.VOzbGW_panel'].top >= 40 && rects['.VOzbGW_panel'].bottom <= viewport.height);
        assert.ok(rects['.VOzbGW_navTitle'].top >= 40 && rects['.VOzbGW_close'].top >= 40);
        await page.evaluate(() => window.pushChromeState({ fullScreen: true }));
        assert.equal(await page.locator('.VOzbGW_overlay').evaluate(element => element.getBoundingClientRect().top), 0);
      }
    });
  } finally { await browser.close(); }
});
