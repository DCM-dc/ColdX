// Official Playwright MCP transport with a dedicated context. This avoids the
// CLI's browser-channel override and lets Playwright choose its headless binary.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createConnection } from '@playwright/mcp';
import { dshRequire } from './page-native.mjs';
import { browserRuntime } from './computer-preset.mjs';

const driverRequire = createRequire(import.meta.resolve('@playwright/mcp'));
const sdkRequire = createRequire(dshRequire.resolve('@deepseek-ai/dsh-mcp-client'));
const { StdioServerTransport } = await import(pathToFileURL(sdkRequire.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href);
const { chromium } = driverRequire('playwright');
let browser;
let context;
let opening;
let closing = false;
const connection = await createConnection({
  // The getter already supplies one fresh in-memory context. In MCP 0.0.80,
  // isolated:true asks its SimpleBrowser wrapper to create a second context,
  // which that public adapter cannot do. This does not enable a disk profile.
  browser: { browserName: 'chromium', isolated: false, launchOptions: { headless: true }, contextOptions: { viewport: { width: 1280, height: 720 } } },
  capabilities: ['core', 'vision'], imageResponses: 'allow', snapshot: { mode: 'none' }, codegen: 'none',
  outputDir: process.argv[2], timeouts: { action: 5000, navigation: 30_000 },
}, async () => {
  if (closing) throw new Error('Browser driver is closing.');
  if (context && browser?.isConnected()) return context;
  if (!opening) opening = (async () => {
    browser = await chromium.launch({ headless: true, executablePath: browserRuntime().executable });
    context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
    const ownedBrowser = browser;
    context.on('close', () => { context = undefined; void ownedBrowser.close().catch(() => {}); });
    return context;
  })().finally(() => { opening = undefined; });
  return opening;
});
async function stop() {
  if (closing) return;
  closing = true;
  try { await opening; } catch {}
  await browser?.close().catch(() => {});
  await connection.close().catch(() => {});
}
process.stdin.once('end', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
await connection.connect(new StdioServerTransport());
