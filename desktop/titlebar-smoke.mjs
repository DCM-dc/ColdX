import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function pageSnapshot(window) {
  return window.webContents.executeJavaScript(`(() => {
    const bar = document.getElementById('coldx-desktop-titlebar');
    const root = document.getElementById('root');
    const rect = element => { const r = element?.getBoundingClientRect(); return r ? {top:r.top,bottom:r.bottom,height:r.height,width:r.width} : null; };
    return {
      bar: rect(bar), root: rect(root), viewport: {width:innerWidth,height:innerHeight},
      background: bar ? getComputedStyle(bar).backgroundColor : null,
      foreground: bar ? getComputedStyle(bar).color : null,
      dark: document.body.hasAttribute('data-ds-dark-theme'),
      buttons: bar ? [...bar.querySelectorAll('button')].map(button => ({label:button.getAttribute('aria-label') || button.textContent.trim(),disabled:button.disabled,color:getComputedStyle(button).color,transition:getComputedStyle(button).transition,opacity:getComputedStyle(button).opacity})) : [],
    };
  })()`);
}

function hexColor(value) {
  const parts = /^rgba?\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)/i.exec(value ?? '');
  if (!parts) return String(value).toLowerCase();
  return '#' + parts.slice(1, 4).map(part => Number(part).toString(16).padStart(2, '0')).join('');
}

async function until(check, message) {
  const deadline = Date.now() + 8000;
  let latest;
  do {
    latest = await check();
    if (latest) return latest;
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error(message);
}

/** Real renderer / native overlay acceptance; only run by --smoke-test opt-in. */
export async function runTitlebarSmoke({ window, host, reportPath, nativeTheme }) {
  const originalFullScreen = window.isFullScreen();
  const originalThemeSource = nativeTheme.themeSource;
  const originalBounds = window.getBounds();
  const originalZoom = window.webContents.getZoomFactor();
  const originalThrottling = window.webContents.getBackgroundThrottling();
  window.webContents.setBackgroundThrottling(false);
  const evidence = [];
  const directory = reportPath ? dirname(reportPath) : undefined;
  if (directory) await mkdir(directory, { recursive: true });
  async function capture(name) {
    if (!directory) return;
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await delay(750);
    // The first capture wakes an otherwise hidden compositor. Request another
    // painted frame after it, rather than storing its stale transition layer.
    await window.webContents.capturePage();
    await delay(150);
    await writeFile(join(directory, `${name}.json`), JSON.stringify(await pageSnapshot(window),null,2));
    await writeFile(join(directory, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  }
  async function clickText(text) {
    return window.webContents.executeJavaScript(`(() => { const target=[...document.querySelectorAll('button')].find(button => (button.textContent.trim() === ${JSON.stringify(text)} || button.getAttribute('aria-label') === ${JSON.stringify(text)}) && button.getBoundingClientRect().height > 0); if(!target)return false;target.click();return true; })()`);
  }
  async function openAppearance() {
    await clickText('设置');
    await until(() => window.webContents.executeJavaScript("document.querySelectorAll('._8HJdBW_themeCube').length === 3"), 'Appearance settings did not open.');
  }
  async function chooseTheme(scheme) {
    const index = ['light', 'dark', 'system'].indexOf(scheme);
    await window.webContents.executeJavaScript(`document.querySelectorAll('._8HJdBW_themeCube')[${index}].click()`);
    await until(() => window.webContents.executeJavaScript(`document.querySelectorAll('._8HJdBW_themeCube')[${index}]?.getAttribute('aria-pressed') === 'true'`), 'Theme preference did not change.');
  }
  async function closeAppearance() {
    await window.webContents.executeJavaScript("document.querySelector('.VOzbGW_panel .VOzbGW_close')?.click()");
    await until(() => window.webContents.executeJavaScript("!document.querySelector('.VOzbGW_panel')"), 'Settings did not close.');
  }
  let originalPreference;
  try {
    if (originalFullScreen) window.setFullScreen(false);
    // Dismiss first-run onboarding in this isolated smoke profile, then exercise
    // the actual persisted appearance controls. A body marker alone bypasses
    // DSH's theme presenter and cannot validate real light/dark synchronization.
    await delay(750);
    await clickText('继续');
    await until(() => clickText('稍后配置'), 'First-run model setup did not appear.');
    await openAppearance();
    originalPreference = await window.webContents.executeJavaScript("['light','dark','system'][[...document.querySelectorAll('._8HJdBW_themeCube')].findIndex(button=>button.getAttribute('aria-pressed')==='true')]");
    for (const scheme of ['light', 'dark', 'light']) {
      await chooseTheme(scheme);
      const snapshot = await until(async () => {
        const page = await pageSnapshot(window);
        const native = host.snapshot();
        return page.bar?.height >= 39 && page.root?.top >= 39
          && page.dark === (scheme === 'dark') && native.theme?.scheme === scheme
          && hexColor(page.background) === native.theme.background.toLowerCase()
          && page.buttons.filter(button=>!button.disabled).every(button=>hexColor(button.color) === native.theme.foreground)
          ? {page, native} : undefined;
      }, `Titlebar did not follow ${scheme} theme or reserve its space.`);
      assert.ok(snapshot.page.bar.height <= 41, 'Titlebar should remain compact.');
      assert.ok(snapshot.page.root.bottom <= snapshot.page.viewport.height + 1, 'Application root overflowed the viewport.');
      for (const label of ['文件', '编辑', '视图', '帮助']) assert.ok(snapshot.page.buttons.some(button => button.label === label), `Missing ${label} menu.`);
      assert.equal(nativeTheme.themeSource, originalThemeSource, 'Theme synchronization must not lock the system theme.');
      evidence.push({scheme,background:snapshot.native.theme.background,foreground:snapshot.native.theme.foreground,bar:snapshot.page.bar,root:snapshot.page.root});
      await closeAppearance();
      await capture(`titlebar-${scheme}`);
      await openAppearance();
    }
    await chooseTheme(originalPreference || 'system');
    await closeAppearance();
    assert.notEqual(evidence[0].background, evidence[1].background, 'Light and dark titlebars should visibly differ.');
    const zoomEvidence = [];
    for (const zoom of [0.8, 1, 1.25]) {
      window.webContents.setZoomFactor(zoom);
      const page = await until(async () => {
        const current = await pageSnapshot(window);
        const state = host.snapshot();
        const [contentWidth] = window.getContentSize();
        return current.bar?.height >= 39 && current.bar.height <= 41
          && current.root?.top >= 39 && current.root.bottom <= current.viewport.height + 1
          && Math.abs(current.viewport.width - contentWidth / zoom) <= 2
          && Math.abs((state.overlayHeight ?? 40 * state.zoomFactor) - Math.round(40 * zoom)) <= 1
          ? current : undefined;
      }, `Titlebar and native caption geometry diverged at zoom ${zoom}.`);
      zoomEvidence.push({zoom,bar:page.bar,root:page.root});
    }
    window.webContents.setZoomFactor(1);
    window.setSize(820, 620);
    await until(async () => {
      const page = await pageSnapshot(window);
      return page.viewport.width < 850 && page.root?.top >= 39 && page.root.bottom <= page.viewport.height + 1;
    }, 'Minimum-size window clipped the application root.');
    await openAppearance();
    const settingsEvidence = [];
    for (const zoom of [1, 1.5]) {
      window.webContents.setZoomFactor(zoom);
      const panel = await until(async () => {
        const rect = await window.webContents.executeJavaScript(`(() => { const panel=document.querySelector('.VOzbGW_panel');if(!panel)return;const r=panel.getBoundingClientRect();return {top:r.top,bottom:r.bottom,viewportWidth:innerWidth,viewportHeight:innerHeight}; })()`);
        return rect?.top >= 39 && rect.bottom <= rect.viewportHeight + 1
          && Math.abs(rect.viewportWidth - window.getContentSize()[0] / zoom) <= 2 ? rect : undefined;
      }, `Settings overlapped the titlebar at minimum window size and zoom ${zoom}.`);
      settingsEvidence.push({zoom,...panel});
    }
    window.webContents.setZoomFactor(1);
    await closeAppearance();
    await capture('titlebar-compact');
    window.setBounds(originalBounds);
    window.setFullScreen(true);
    await until(async () => {
      const page = await pageSnapshot(window);
      return window.isFullScreen() && (!page.bar || page.bar.height < 1) && page.root?.top < 1 && page.root?.bottom <= page.viewport.height + 1;
    }, 'Fullscreen retained the titlebar or its reserved space.');
    await capture('titlebar-fullscreen');
    window.setFullScreen(false);
    await until(async () => {
      const page = await pageSnapshot(window);
      return !window.isFullScreen() && page.bar?.height >= 39 && page.root?.top >= 39;
    }, 'Titlebar did not return after leaving fullscreen.');
    return {ok:true,themes:evidence,zoom:zoomEvidence,minimumWindow:true,settings:settingsEvidence,fullScreenRoundTrip:true,systemThemeSourcePreserved:true};
  } catch (error) {
    if (directory) {
      await writeFile(join(directory, 'titlebar-failure.json'), JSON.stringify({message:error.message,page:await pageSnapshot(window),native:host.snapshot(),ui:await window.webContents.executeJavaScript('document.body.innerText')}, null, 2));
      await capture('titlebar-failure');
    }
    throw error;
  } finally {
    if (window.isFullScreen() !== originalFullScreen) window.setFullScreen(originalFullScreen);
    window.webContents.setZoomFactor(originalZoom);
    window.webContents.setBackgroundThrottling(originalThrottling);
    if (!originalFullScreen) window.setBounds(originalBounds);
    await delay(100);
  }
}
