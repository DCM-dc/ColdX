// Isolated visual contract: no installed app, session, browser profile or model API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { createWorkspaceShell } from '../plugin/client/workspace-shell-source.mjs';

test('workspace shell keeps reading, composer and metrics usable at wide, 820px and 390px in both themes', async () => {
  const require = createRequire(realpathSync(new URL('../node_modules/@playwright/mcp/package.json', import.meta.url)));
  const { chromium } = require('playwright');
  const assets = new URL('../node_modules/.pnpm/@deepseek-ai+dsh-web-frontend@0.1.1-rc.2/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/', import.meta.url);
  const frontend = await readFile(new URL('index-ClqxG24t.js', assets), 'utf8');
  const boot = frontend.lastIndexOf('const da=document.getElementById("root");');
  assert.ok(boot > 0);
  const runtime = frontend.slice(0, boot) + '\nwindow.nativeModules=Jd();';
  const styles = await Promise.all(['workbench.css', 'layout.css', 'ui-consistency.css', 'composer.css', 'workspace-shell.css'].map(name => readFile(new URL(`../plugin/client/${name}`, import.meta.url), 'utf8')));
  const fixtureCss = `html,body{margin:0;min-height:100%;font-family:Arial,"Microsoft YaHei",sans-serif}
    [data-slot=root]{--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#202124;--dsw-alias-label-secondary:#5b5c60;--dsw-alias-label-tertiary:#777;--dsw-alias-state-error-primary:#b42334;--dsw-specific-input-major:#fff;--cx-wb-accent:#6256ad;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);min-height:100dvh}
    [data-slot=root][data-theme=dark]{--dsw-alias-bg-base:#1b1c1e;--dsw-alias-label-primary:#eee;--dsw-alias-label-secondary:#b1b2b5;--dsw-alias-label-tertiary:#929398;--dsw-specific-input-major:#242527;--cx-wb-accent:#a6a0e8}
    .pI_x6G_frame{display:grid;grid-template-columns:240px minmax(0,1fr);min-height:100dvh}.pI_x6G_sidebarCol{border-right:1px solid #ddd}.hHd-Xa_root{height:100%}.hHd-Xa_logoRow{display:flex;align-items:center}.hHd-Xa_newSession{display:block;width:calc(100% - 24px);text-align:left}.YDXeBa_sessionRow{display:block;width:calc(100% - 24px);margin:3px 12px;padding:6px 10px;box-sizing:border-box;text-align:left;border:0;background:transparent;color:inherit}.YDXeBa_selected{font-weight:600}.wSkVaW_root{display:flex;flex-direction:column;min-width:0;min-height:100dvh}.wSkVaW_header{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:56px;padding:0 20px}.wSkVaW_titleRow{flex:1;min-width:0;font-weight:600;white-space:nowrap}.wSkVaW_headerUtilities{display:flex;flex:0 0 auto}.workspace-content{flex:1;display:grid;grid-template-columns:minmax(0,1fr) 360px;min-height:0}.conversation{display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:0;padding:24px}.conversation>.cx-workspace-home{margin-block:auto 24px}.composer{width:min(760px,100%);margin-block:0 auto}.composer textarea{display:block;width:100%;height:96px;box-sizing:border-box;border:0;resize:none;padding:16px;background:transparent;color:inherit;font:inherit}.composer-actions{display:flex;gap:8px;padding:8px}.composer-actions button{min-height:32px}.coldx-shell .cx-workbench-panel{position:static;display:flex;flex-direction:column;width:auto;height:auto;border-left:1px solid var(--cx-workspace-line)}.result-content{flex:1;padding:20px;line-height:1.6}.result-content p{margin:0 0 16px}.cx-workbench-tabs button{flex:none}.cx-workbench-header strong{font-size:14px}@media(max-width:900px){.workspace-content{grid-template-columns:minmax(0,1fr)}.coldx-shell .cx-workbench-panel[open]{display:none}}@media(max-width:600px){.pI_x6G_frame{grid-template-columns:1fr}.pI_x6G_sidebarCol{display:none}.wSkVaW_header{padding:0 12px}.conversation{padding:16px}.composer-actions{flex-wrap:wrap}.cx-workspace-home{padding-inline:0}}`;
  const server = createServer(async (request, response) => {
    const route = new URL(request.url, 'http://localhost').pathname;
    try {
      if (route === '/') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end('<!doctype html><html class="coldx-shell"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="fixture" data-slot="root"></div><script type="module" src="/runtime.js"></script></body></html>');
      } else if (route === '/runtime.js') {
        response.setHeader('Content-Type', 'text/javascript'); response.end(runtime);
      } else if (/^\/[a-zA-Z0-9_-]+\.js$/.test(route)) {
        response.setHeader('Content-Type', 'text/javascript'); response.end(await readFile(new URL(route.slice(1), assets)));
      } else { response.statusCode = 404; response.end(); }
    } catch { response.statusCode = 404; response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  const capture = new URL('../outputs/ui-review/', import.meta.url);
  try {
    browser = await chromium.launch({ headless: true, ...process.env.COLDX_TEST_CHROMIUM ? { executablePath: process.env.COLDX_TEST_CHROMIUM } : {} });
    await mkdir(capture, { recursive: true });
    for (const scenario of [
      { name: 'wide-light', width: 1440, theme: 'light' },
      { name: 'desktop-820', width: 820, theme: 'light' },
      { name: 'phone-390', width: 390, theme: 'light' },
      { name: 'wide-dark', width: 1440, theme: 'dark' },
      { name: 'phone-dark-reduced', width: 390, theme: 'dark', reduced: true },
    ]) {
      const page = await browser.newPage({ viewport: { width: scenario.width, height: 860 }, colorScheme: scenario.theme, reducedMotion: scenario.reduced ? 'reduce' : 'no-preference' });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.waitForFunction(() => window.nativeModules);
        await page.addStyleTag({ content: styles.join('\n') + '\n' + fixtureCss + '\n.fixture-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}.fixture-status{flex:none}.composer textarea:focus{outline:none}.composer-actions button{border:0;border-radius:8px;padding:0 10px;background:var(--cx-workspace-soft);color:inherit}.composer-actions button:hover{background:var(--cx-workspace-selected)}' });
        await page.evaluate(({ factory, theme }) => {
          const React = window.nativeModules.react, h = React.createElement;
          const { Home, KernelStatus } = new Function(`return (${factory})`)()(React);
          function Fixture() {
            const status = h(KernelStatus, { onOpenChange: open => window.toggleEvents.push(open), snapshot: { version: 1, scheduler: { active: 1, queued: 0 }, session: { requestCount: 2, completed: 1, failed: 0, cancelled: 0, toolCount: 3, last: { state: 'running', queueMs: 17, firstChunkMs: 250, durationMs: 1280, context: { totalChars: 1850 } } } } });
            const sidebar = h('aside', { className: 'pI_x6G_sidebarCol' }, h('div', { className: 'hHd-Xa_root' },
              h('div', { className: 'hHd-Xa_logoRow' }, h('span', { className: 'cx-brand-name' }, 'ColdX')),
              h('button', { className: 'hHd-Xa_newSession' }, '＋ 新任务'),
              h('button', { className: 'YDXeBa_sessionRow YDXeBa_selected' }, '改进工作区布局'),
              h('button', { className: 'YDXeBa_sessionRow' }, '检查页面结果')));
            const composer = h('div', { className: 'composer', 'data-composer-card': '' },
              h('textarea', { 'aria-label': '描述任务', placeholder: '描述你想构建的内容' }),
              h('div', { className: 'composer-actions' }, ...['＋', 'Goal', 'Plan', '模型与推理', '发送'].map(label => h('button', { type: 'button', key: label }, label))));
            const results = h('section', { className: 'cx-workbench-panel', open: true },
              h('div', { className: 'cx-workbench-header' }, h('strong', null, '工作结果')),
              h('div', { className: 'cx-workbench-tabs' }, ...['结果', '文件', '浏览器'].map(label => h('button', { key: label, 'aria-selected': label === '结果' }, label))),
              h('div', { className: 'result-content' }, h('p', null, '工作结果会显示在这里。'), h('p', null, '文件、浏览器与终端由当前任务管理。')));
            return h('div', { className: 'pI_x6G_frame' }, sidebar,
              h('main', { className: 'wSkVaW_root' },
                h('header', { className: 'wSkVaW_header', style:{flexWrap:'wrap'} }, h('span', { className: 'fixture-title', style:{flexBasis:'100%'} }, '改进工作区布局'), h('div', { className: 'fixture-status', style:{flexBasis:'100%'} }, status)),
                h('div', { className: 'workspace-content' }, h('section', { className: 'conversation', 'data-phase': 'hero' }, h(Home), composer), results)));
          }
          window.toggleEvents = [];
          document.getElementById('fixture').dataset.theme = theme;
          window.nativeModules['react-dom/client'].createRoot(document.getElementById('fixture')).render(h(Fixture));
        }, { factory: createWorkspaceShell.toString(), theme: scenario.theme });
        await page.getByRole('heading', { name: '今天想完成什么？' }).waitFor();
        await page.getByRole('textbox', { name: '描述任务' }).fill('修复布局并保留草稿');
        await page.screenshot({ path: new URL(`workspace-${scenario.name}.png`, capture).pathname.slice(1), fullPage: true });
        await page.getByText('运行详情', { exact: true }).click();
        assert.equal(await page.getByText('1,850').isVisible(), true);
        await page.waitForFunction(() => window.toggleEvents.length > 0);
        assert.deepEqual(await page.evaluate(() => window.toggleEvents), [true]);
        assert.equal(await page.locator('textarea').inputValue(), '修复布局并保留草稿');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, scenario.name);
        if (scenario.width >= 1000) assert.equal(await page.getByText('工作结果会显示在这里。').isVisible(), true);
        if (scenario.width <= 390) assert.equal(await page.locator('.cx-workbench-panel').isVisible(), false, scenario.name);
        assert.deepEqual(errors, []);
        if (scenario.name === 'wide-light' || scenario.name === 'phone-dark-reduced')
          await page.screenshot({ path: new URL(`workspace-${scenario.name}-metrics.png`, capture).pathname.slice(1), fullPage: true });
        await page.locator('.cx-kernel-status > summary').press('Escape');
        assert.equal(await page.locator('.cx-kernel-status').getAttribute('open'),null);
        assert.equal(await page.locator('.cx-kernel-status > summary').evaluate(element=>element===document.activeElement),true);
      } finally { await page.close(); }
    }
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});
