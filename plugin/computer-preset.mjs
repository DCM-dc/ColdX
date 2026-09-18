import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir, lstat } from 'node:fs/promises';

export const COMPUTER_PREFIX = 'mcp__coldx_browser__';
export const COMPUTER_TOOLS = Object.freeze(['browser_navigate', 'browser_navigate_back', 'browser_snapshot',
  'browser_take_screenshot', 'browser_click', 'browser_type', 'browser_press_key', 'browser_select_option',
  'browser_mouse_click_xy', 'browser_mouse_move_xy', 'browser_mouse_drag_xy', 'browser_mouse_wheel', 'browser_tabs', 'browser_close',
  'browser_forward', 'browser_reload', 'browser_state', 'browser_type_focused']);

export function browserRuntime() {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve('@playwright/mcp/package.json');
  const driverRequire = createRequire(packagePath);
  // The pinned driver launches headless shell, not full Chrome. Playwright's
  // public chromium.executablePath() reports the headed binary even when only
  // shell is installed. Keep this pinned registry lookup aligned with launch.
  const { registry } = driverRequire('playwright-core/lib/coreBundle').registry;
  const executable = registry.findExecutable('chromium-headless-shell')?.executablePath();
  if (!executable) throw new Error('The installed Playwright version does not expose its Chromium headless shell.');
  return { executable, available: existsSync(executable), cli: join(dirname(packagePath), 'cli.js'),
    installer: join(dirname(driverRequire.resolve('playwright/package.json')), 'cli.js') };
}

export function browserPreset(agent, driverArgs) {
  const runtime = browserRuntime();
  if (!driverArgs && !runtime.available) throw new Error('浏览器组件尚未安装。请运行 pnpm computer:install，然后重试。');
  const sessionKey = createHash('sha256').update(agent.id).digest('hex').slice(0, 20);
  const outputDirectory = join(agent.session.header.cwd, '.coldx', 'browser', sessionKey);
  const configuredBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  // Playwright resolves a relative cache against INIT_CWD or the Host cwd.
  // Freeze that directory before MCP changes cwd; '0' means package-local.
  const browsersPath = configuredBrowsersPath && configuredBrowsersPath !== '0' && !isAbsolute(configuredBrowsersPath)
    ? resolve(process.env.INIT_CWD || process.cwd(), configuredBrowsersPath)
    : configuredBrowsersPath;
  return { transport: 'stdio', serverName: 'coldx_browser', command: process.execPath,
    args: driverArgs ?? [fileURLToPath(new URL('./browser-driver.mjs', import.meta.url)), outputDirectory],
    // MCP stdio's default environment does not forward arbitrary variables.
    // Preserve the desktop's bundled directory explicitly in its child.
    env: browsersPath ? { PLAYWRIGHT_BROWSERS_PATH: browsersPath } : {},
    cwd: outputDirectory, toolCallTimeoutMs: 40_000, failOnStartupError: true,
    allowedTools: [...COMPUTER_TOOLS], reconnect: { enabled: false } };
}

export async function prepareBrowserPreset(agent, driverArgs) {
  const preset = browserPreset(agent, driverArgs);
  // Screenshot filenames are resolved by upstream MCP against cwd. Keep cwd
  // and outputDir identical, and refuse redirection through symbolic links.
  let directory = agent.session.header.cwd;
  for (const segment of ['.coldx', 'browser', createHash('sha256').update(agent.id).digest('hex').slice(0, 20)]) {
    directory = join(directory, segment);
    try { await mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The browser output directory must be an owned directory, not a symbolic link.');
  }
  return preset;
}

export function validateBrowserArguments(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'Browser arguments must be an object.';
  if ('filename' in args) {
    const filename = args.filename;
    if (name !== 'browser_take_screenshot' || typeof filename !== 'string'
      || !/^[\p{L}\p{N}][\p{L}\p{N}._ -]{0,119}\.(?:png|jpe?g|webp)$/iu.test(filename)
      || filename.includes('..') || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/iu.test(filename.split('.')[0].trim())) {
      return 'ColdX screenshot filename must be a single safe PNG/JPEG/WebP basename, without paths or reserved device names; it is saved inside the owned output directory.';
    }
  }
  if (name === 'browser_navigate' || name === 'browser_tabs' && args.url !== undefined) {
    try { const url = new URL(args.url); if (!['http:', 'https:'].includes(url.protocol) && url.href !== 'about:blank') return 'ColdX browser accepts HTTP(S) URLs or about:blank only.'; }
    catch { return 'A complete valid browser URL is required.'; }
  }
}
