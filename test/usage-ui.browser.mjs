// Explicit real-React UI acceptance with synthetic metrics; never reads a user profile or provider key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createUsageComponents } from '../plugin/client/usage-source.mjs';
import { foldSessionUsage, summarizeUsage } from '../plugin/usage-model.mjs';

test('usage dialog supports real React, heatmap keyboard, filters, thresholds, themes and compact layouts', async () => {
  const playwright = createRequire(realpathSync(new URL('../node_modules/@playwright/mcp/package.json', import.meta.url)))('playwright');
  const assets = new URL('../node_modules/.pnpm/@deepseek-ai+dsh-web-frontend@0.1.1-rc.2/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/', import.meta.url);
  const frontend = await readFile(new URL('index-ClqxG24t.js', assets), 'utf8'), boot = frontend.lastIndexOf('const da=document.getElementById("root");');
  assert.ok(boot > 0);
  const runtime = frontend.slice(0, boot) + '\nwindow.nativeModules=Jd();';
  const css = (await Promise.all(['workbench.css', 'usage.css'].map(file => readFile(new URL('../plugin/client/' + file, import.meta.url), 'utf8')))).join('\n');
  const now = Date.parse('2026-09-18T10:00:00Z');
  const logs = Array.from({ length: 30 }, (_, index) => ({ session: { id: 'fixture-' + index, createdAt: now - index * 86400000 }, events: [
    { seq: 0, time: now - index * 86400000, type: 'turn/start', data: { turn: 0 } },
    { seq: 1, time: now - index * 86400000, type: 'request/header', data: { header: { config: { reasoningEffort: index % 4 ? 'max' : 'high' } } } },
    { seq: 2, time: now - index * 86400000 + 30000, type: 'assistant/message', data: { turn: 0, step: 0, usage: { inputTokens: 100 + index * 10, outputTokens: 300 + index * 50, cacheReadTokens: 4000, reasoningTokens: 100 } } },
    { seq: 3, time: now - index * 86400000 + 30000, type: 'tool/call', data: { callId: 'tool-' + index, name: index % 2 ? 'coldx_computer' : 'skill', arguments: '{"name":"superpowers:debugging"}' } },
    { seq: 4, time: now - index * 86400000 + 60000, type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } },
  ] }));
  const metrics = { ...summarizeUsage(logs.map(log => foldSessionUsage(log, { timeZone: 'UTC' })), { now, timeZone: 'UTC' }), limitations: '测试夹具：本地会话记录，不等于上游账单。' };
  const server = createServer(async (request, response) => {
    const route = new URL(request.url, 'http://localhost').pathname;
    try {
      if (route === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end('<!doctype html><html class="coldx-shell"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#202124;--dsw-alias-label-secondary:#74767c;color-scheme:light;font-family:Segoe UI,sans-serif}body{margin:20px}#fixture>div:first-child{width:200px}</style><div id="fixture"></div><script type="module" src="/runtime.js"></script>'); return; }
      response.setHeader('Content-Type', 'text/javascript');
      if (route === '/runtime.js') response.end(runtime);
      else if (/^\/[a-zA-Z0-9_-]+\.js$/.test(route)) response.end(await readFile(new URL(route.slice(1), assets)));
      else { response.statusCode = 404; response.end(); }
    } catch { response.statusCode = 404; response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForFunction(() => window.nativeModules); await page.addStyleTag({ content: css });
    await page.evaluate(({ factory, metrics }) => {
      const modules = window.nativeModules, React = modules.react;
      window.calls = []; window.settings = { balanceEnabled: true, thresholds: { CNY: '10', USD: '2' } };
      window.failUsage = false;
      const rpc = async (method, request) => {
        window.calls.push({ method, request });
        if (method === 'read') { if (window.failUsage) throw Error('fixture offline'); return metrics; }
        if (method === 'settings') { window.settings = { ...window.settings, ...request }; return window.settings; }
        if (method === 'balance') return window.settings.balanceEnabled ? { status: 'ok', checkedAt: Date.now(), stale: false, available: true, balances: [{ currency: 'CNY', total: '3.25', granted: '0', toppedUp: '3.25', low: true }], alert: 'low', origin: 'https://provider.example', thresholds: window.settings.thresholds } : { status: 'disabled', checkedAt: null, balances: [], alert: null, message: '自动余额查询已关闭。' };
      };
      window.components = new Function(`return (${factory});`)()(React, rpc);
      modules['react-dom/client'].createRoot(document.getElementById('fixture')).render(React.createElement(React.Fragment, null, React.createElement(window.components.UsageEntry), React.createElement(window.components.BalanceNotice)));
    }, { factory: createUsageComponents.toString(), metrics });
    await page.getByText('上游余额较低', { exact: true }).waitFor();
    await page.getByRole('button', { name: '用量与活动', exact: true }).click();
    await page.getByRole('heading', { name: '用量与活动', exact: true }).waitFor();
    await page.locator('.cx-usage-heatmap button').first().waitFor();
    assert.equal(await page.locator('.cx-usage-stats > div').count(), 5);
    assert.ok(await page.locator('.cx-usage-heatmap button').count() >= 365);
    const selected = page.locator('.cx-usage-heatmap button[aria-pressed="true"]');
    await selected.focus(); const label = await selected.getAttribute('aria-label');
    await page.keyboard.press('ArrowLeft'); assert.notEqual(await selected.getAttribute('aria-label'), label);
    await page.getByRole('button', { name: '每周', exact: true }).click(); assert.ok(await page.locator('.cx-usage-heatmap button').count() < 60);
    await page.getByRole('button', { name: '累计', exact: true }).click();
    assert.match(await page.locator('.cx-usage-selected').innerText(), /截至当日累计/);
    await page.getByRole('button', { name: '每日', exact: true }).click();
    await page.locator('.cx-usage-body').evaluate(node => node.scrollTop = 0);
    const screenshotDir = process.env.COLDX_USAGE_SCREENSHOT_DIR;
    if (screenshotDir) { await mkdir(screenshotDir, { recursive: true }); await page.screenshot({ path: join(screenshotDir, 'usage-light.png') }); }
    await page.evaluate(() => { const root = document.documentElement; root.style.setProperty('--dsw-alias-bg-base', '#18191b'); root.style.setProperty('--dsw-alias-label-primary', '#eeeeef'); root.style.setProperty('--dsw-alias-label-secondary', '#9a9ba3'); root.style.colorScheme = 'dark'; });
    assert.equal(await page.locator('.cx-usage-dialog').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(24, 25, 27)');
    await page.waitForFunction(() => { const color = getComputedStyle(document.querySelector('.cx-usage-heatmap [data-level="0"]')).backgroundColor; return color.startsWith('color(srgb ') && Number(color.split(' ')[1]) < .3; });
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, 'usage-dark.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.cx-usage-body').evaluate(node => node.scrollTop = 0);
    await page.waitForFunction(() => document.querySelector('.cx-usage-heatmap-scroll').scrollLeft > 0);
    assert.equal(await page.locator('.cx-usage-body').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, 'usage-compact.png') });
    await page.getByText('余额提醒设置', { exact: true }).click();
    await page.getByRole('checkbox', { name: '自动查询并提醒' }).uncheck();
    await page.getByRole('textbox', { name: 'CNY 低余额阈值' }).fill('6.25');
    await page.getByRole('button', { name: '保存设置' }).click();
    await page.getByText('自动余额查询已关闭。', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.settings.thresholds.CNY), '6.25');
    await page.evaluate(() => window.failUsage = true);
    await page.getByRole('button', { name: '刷新用量统计' }).click(); await page.getByText('用量记录暂时无法加载，请重试。').waitFor();
    assert.equal(await page.locator('.cx-usage-stats > div').count(), 5, 'failed refresh retains previous valid data');
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('button', { name: '用量与活动', exact: true }).evaluate(node => node === document.activeElement), true);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});
