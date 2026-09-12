import { spawn } from 'node:child_process';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const BROWSER_DIRECTORY = 'browsers';
const BROWSER_NAME = 'chromium-headless-shell';
const INSPECT_RUNTIME = `
  import {createRequire} from 'node:module';
  import {readFileSync} from 'node:fs';
  import {browserRuntime} from './plugin/computer-preset.mjs';
  const require=createRequire(new URL('./package.json',import.meta.url));
  const read=path=>JSON.parse(readFileSync(path,'utf8'));
  const mcpPath=require.resolve('@playwright/mcp/package.json');
  const mcp=read(mcpPath), driverRequire=createRequire(mcpPath);
  const playwright=read(driverRequire.resolve('playwright/package.json'));
  const core=read(driverRequire.resolve('playwright-core/package.json'));
  const runtime=browserRuntime();
  console.log(JSON.stringify({
    executable:runtime.executable,available:runtime.available,installer:runtime.installer,
    mcpVersion:mcp.version,playwrightVersion:playwright.version,playwrightCoreVersion:core.version,
    expectedMcp:read(new URL('./package.json',import.meta.url)).dependencies?.['@playwright/mcp'],
    expectedPlaywright:mcp.dependencies?.playwright,expectedCore:mcp.dependencies?.['playwright-core']
  }));
`;

function inside(root, target) {
  const part = relative(root, target);
  if (!part || isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`)) throw new Error('Bundled browser path escapes its runtime.');
  return part.split(sep).join('/');
}

function browserEnvironment(browsersPath) {
  const env = { ...process.env };
  // Windows environment names are case-insensitive, including inherited names.
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PLAYWRIGHT_BROWSERS_PATH') delete env[key];
  env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  return env;
}

async function bundleDirectory(runtimeDirectory, create = false) {
  const root = resolve(runtimeDirectory);
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Browser runtime cannot be a redirected link.');
  const directory = join(root, BROWSER_DIRECTORY);
  if (create) await mkdir(directory, { recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Bundled browser directory cannot be a redirected link.');
  inside(await realpath(root), await realpath(directory));
  return { root, directory };
}

function runNode(nodePath, args, { cwd, env, capture = false, timeoutMs = 30_000 }) {
  return new Promise((done, reject) => {
    const child = spawn(nodePath, args, { cwd, env, windowsHide: true, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let stdout = '', stderr = '', failure;
    const timer = setTimeout(() => {
      failure = new Error('Bundled browser operation timed out.');
      child.kill();
    }, timeoutMs);
    if (capture) {
      child.stdout.on('data', data => {
        stdout += data;
        if (stdout.length > 16_384) { failure = new Error('Bundled browser inspection returned excessive output.'); child.kill(); }
      });
      child.stderr.on('data', data => { stderr = (stderr + data).slice(-8192); });
    }
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Bundled browser operation failed (${code}). ${stderr}`.trim()));
      else done(stdout.trim());
    });
  });
}

async function inspectRuntime(root, nodePath, directory) {
  const app = join(root, 'app');
  // Eval's module URL is rooted in cwd; imports resolve only in the staged app.
  const info = JSON.parse(await runNode(nodePath, ['--input-type=module', '--eval', INSPECT_RUNTIME], { cwd: app, env: browserEnvironment(directory), capture: true }));
  for (const [actual, expected] of [['mcpVersion', 'expectedMcp'], ['playwrightVersion', 'expectedPlaywright'], ['playwrightCoreVersion', 'expectedCore']]) {
    if (typeof info[actual] !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(info[actual]) || info[actual] !== info[expected]) {
      throw new Error('Bundled browser package version does not match the pinned runtime dependencies.');
    }
  }
  return info;
}

async function browserManifest(root, directory, info) {
  if (typeof info.executable !== 'string' || !isAbsolute(info.executable)) throw new Error('Bundled browser executable path is invalid.');
  inside(directory, info.executable);
  const file = await lstat(info.executable);
  if (!file.isFile() || file.isSymbolicLink() || file.size === 0 || info.available !== true) throw new Error('Bundled browser executable is missing or not a regular file.');
  inside(await realpath(directory), await realpath(info.executable));
  return {
    name: BROWSER_NAME,
    directory: BROWSER_DIRECTORY,
    executable: inside(root, info.executable),
    mcpVersion: info.mcpVersion,
    playwrightVersion: info.playwrightVersion,
    playwrightCoreVersion: info.playwrightCoreVersion,
  };
}

/** Download the exact runtime's headless Chromium without reading a global cache. */
export async function stageBrowserBundle({ runtimeDirectory, nodePath = process.execPath }) {
  const { root, directory } = await bundleDirectory(runtimeDirectory, true);
  const before = await inspectRuntime(root, nodePath, directory);
  if (typeof before.installer !== 'string' || !isAbsolute(before.installer)) throw new Error('Bundled browser installer path is invalid.');
  inside(await realpath(join(root, 'app')), await realpath(before.installer));
  await runNode(nodePath, [before.installer, 'install', '--only-shell', 'chromium'], {
    cwd: join(root, 'app'), env: browserEnvironment(directory), timeoutMs: 600_000,
  });
  return browserManifest(root, directory, await inspectRuntime(root, nodePath, directory));
}

/** Fail packaging when its manifest, pinned browser version or owned binary drifts. */
export async function verifyBrowserBundle({ runtimeDirectory, browser, nodePath = process.execPath }) {
  if (!browser || browser.name !== BROWSER_NAME || browser.directory !== BROWSER_DIRECTORY
    || typeof browser.executable !== 'string' || !browser.executable.startsWith('browsers/')
    || browser.executable.split('/').some(part => !part || part === '.' || part === '..') || browser.executable.includes('\\')) {
    throw new Error('Bundled browser manifest or executable path is missing or invalid.');
  }
  const { root, directory } = await bundleDirectory(runtimeDirectory);
  const actual = await browserManifest(root, directory, await inspectRuntime(root, nodePath, directory));
  if (JSON.stringify(actual) !== JSON.stringify(browser)) throw new Error('Bundled browser manifest does not match the installed package version or executable.');
  return actual;
}
