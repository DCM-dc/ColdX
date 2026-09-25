import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import path from 'node:path';

test('docked workbench and summary leave the reading column usable and aligned', async t => {
  const packagePath = process.env.COLDX_BROWSER_PACKAGES
    ? path.join(process.env.COLDX_BROWSER_PACKAGES, 'package.json')
    : realpathSync(new URL('../node_modules/@playwright/mcp/package.json', import.meta.url));
  const { chromium } = createRequire(packagePath)('playwright');
  const css = (await Promise.all(['layout.css', 'workbench-rebuild.css', 'summary-redesign.css']
    .map(name => readFile(new URL(`../plugin/client/${name}`, import.meta.url), 'utf8')))).join('\n');
  const browser = await chromium.launch({ headless:true,
    ...process.env.COLDX_TEST_CHROMIUM ? { executablePath:process.env.COLDX_TEST_CHROMIUM } : {},
  });
  try {
    for (const width of [960, 1200, 1440]) await t.test(`conversation ${width}px`, async () => {
      const page = await browser.newPage({ viewport:{ width:1800, height:850 } });
      try {
        await page.setContent(`<main class="coldx-shell"><div class="wSkVaW_root" style="width:${width}px;height:700px"><div class="wSkVaW_header" style="height:46px"></div><div class="wSkVaW_scrollBody" style="height:654px"><div class="reading-card" style="max-width:760px;width:calc(100% - 40px);margin-inline:auto;height:100px"></div></div><dialog class="cx-workbench-panel" data-mode="docked" data-open="true" open aria-label="工作面板"></dialog></div></main>`);
        await page.addStyleTag({ content:css });
        const geometry = async selector => page.evaluate(selector => {
          const root = document.querySelector('.wSkVaW_root').getBoundingClientRect();
          const body = document.querySelector('.wSkVaW_scrollBody').getBoundingClientRect();
          const pane = document.querySelector(selector).getBoundingClientRect();
          const card = document.querySelector('.reading-card').getBoundingClientRect();
          return { rootWidth:root.width, bodyWidth:body.width, bodyRight:body.right,
            paneLeft:pane.left, paneWidth:pane.width, cardRight:card.right };
        }, selector);
        const workbench = await geometry('.cx-workbench-panel');
        assert.ok(Math.abs(workbench.bodyRight - workbench.paneLeft) <= 1,
          `inspector and reading column must meet without a blank strip: ${JSON.stringify(workbench)}`);
        assert.ok(workbench.bodyWidth >= 600,
          `inspector must leave at least a 600px reading column: ${JSON.stringify(workbench)}`);
        assert.ok(workbench.cardRight <= workbench.paneLeft + 1,
          `the composer-sized reading card must not sit under the inspector: ${JSON.stringify(workbench)}`);

        await page.locator('.cx-workbench-panel').evaluate(panel => panel.remove());
        await page.locator('.wSkVaW_root').evaluate(root => root.insertAdjacentHTML('beforeend',
          '<aside class="cx-rebuild-summary" data-open="true" aria-label="任务摘要"></aside>'));
        await page.locator('.cx-rebuild-summary').evaluate(panel => panel.getAnimations().forEach(animation => animation.finish()));
        const summary = await geometry('.cx-rebuild-summary');
        assert.ok(Math.abs(summary.bodyRight - summary.paneLeft) <= 1,
          `summary and reading column must meet without a blank strip: ${JSON.stringify(summary)}`);
        assert.ok(summary.bodyWidth >= 600,
          `summary must leave at least a 600px reading column: ${JSON.stringify(summary)}`);
      } finally { await page.close(); }
    });
    await t.test('narrow drawer preserves the full conversation width', async () => {
      const page = await browser.newPage({ viewport:{ width:800, height:850 } });
      try {
        await page.setContent('<main class="coldx-shell"><div class="wSkVaW_root" style="width:800px;height:700px"><div class="wSkVaW_header" style="height:46px"></div><div class="wSkVaW_scrollBody" style="height:654px"></div><dialog class="cx-workbench-panel" data-mode="drawer" data-open="true" open aria-label="工作面板"></dialog></div></main>');
        await page.addStyleTag({ content:css });
        const bodyWidth = await page.locator('.wSkVaW_scrollBody').evaluate(body => body.getBoundingClientRect().width);
        assert.equal(bodyWidth, 800);
      } finally { await page.close(); }
    });
  } finally { await browser.close(); }
});
