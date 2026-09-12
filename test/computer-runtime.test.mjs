import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const exec = promisify(execFile);
const moduleUrl = new URL('../plugin/computer-preset.mjs', import.meta.url).href;

async function inCache(cache, source, { cwd, env = {} } = {}) {
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cache, ...env },
    cwd,
    windowsHide: true,
  });
  return JSON.parse(stdout);
}

async function fixture(t) {
  const cache = await mkdtemp(join(tmpdir(), 'coldx-browser-runtime-'));
  t.after(() => rm(cache, { recursive: true, force: true }));
  const paths = await inCache(cache, `
    import {createRequire} from 'node:module';
    const req=createRequire(${JSON.stringify(moduleUrl)});
    const pw=createRequire(req.resolve('@playwright/mcp/package.json'));
    const {registry}=pw('playwright-core/lib/coreBundle').registry;
    console.log(JSON.stringify({headless:registry.findExecutable('chromium-headless-shell').executablePath(),full:pw('playwright').chromium.executablePath()}));
  `);
  return { cache, paths };
}

async function touch(path) {
  await mkdir(dirname(path), { recursive: true });
  // Availability-only fixture; never executed as a browser.
  await writeFile(path, 'synthetic executable presence');
}

test('a headless-only browser install is available without full Chrome or user cache', async t => {
  const { cache, paths } = await fixture(t);
  await touch(paths.headless);
  const runtime = await inCache(cache, `const {browserRuntime}=await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(browserRuntime()));`);
  assert.equal(runtime.available, true);
  assert.equal(runtime.executable, paths.headless);
});

test('full Chrome alone does not claim the required headless browser is available', async t => {
  const { cache, paths } = await fixture(t);
  await touch(paths.full);
  const runtime = await inCache(cache, `const {browserRuntime}=await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(browserRuntime()));`);
  assert.equal(runtime.available, false);
  assert.equal(runtime.executable, paths.headless);
});

test('the configured browser directory is explicitly forwarded to the MCP process', async t => {
  const { cache } = await fixture(t);
  const preset = await inCache(cache, `const {browserPreset}=await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(browserPreset({id:'fixture',session:{header:{cwd:process.cwd()}}},['synthetic-driver.mjs'])));`);
  assert.equal(preset.env.PLAYWRIGHT_BROWSERS_PATH, cache);
});

for (const useInitialDirectory of [false, true]) test(`relative browser cache survives changed MCP cwd with ${useInitialDirectory ? 'INIT_CWD' : 'current cwd'} as its origin`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'coldx relative browser '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hostCwd = join(root, 'host'), childCwd = join(root, 'child'), initialCwd = join(root, 'initial');
  await Promise.all([hostCwd, childCwd, initialCwd].map(path => mkdir(path)));
  const parent = await inCache('browser-cache', `
    const {browserRuntime,browserPreset}=await import(${JSON.stringify(moduleUrl)});
    console.log(JSON.stringify({runtime:browserRuntime(),preset:browserPreset({id:'relative-fixture',session:{header:{cwd:process.cwd()}}},['synthetic-driver.mjs'])}));
  `, { cwd: hostCwd, env: { INIT_CWD: useInitialDirectory ? initialCwd : undefined } });
  await touch(parent.runtime.executable);
  // MCP intentionally changes cwd and does not forward INIT_CWD. Its explicit
  // browser env must still select the binary the Host checked beforehand.
  const child = await inCache(parent.preset.env.PLAYWRIGHT_BROWSERS_PATH, `
    const {browserRuntime}=await import(${JSON.stringify(moduleUrl)});console.log(JSON.stringify(browserRuntime()));
  `, { cwd: childCwd, env: { INIT_CWD: undefined } });
  assert.equal(child.executable, parent.runtime.executable);
  assert.equal(child.available, true);
  assert.equal(parent.preset.env.PLAYWRIGHT_BROWSERS_PATH, join(useInitialDirectory ? initialCwd : hostCwd, 'browser-cache'));
});

test('Playwright package-local browser sentinel zero stays zero when forwarded', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'coldx browser sentinel '));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const preset = await inCache('0', `
    const {browserPreset}=await import(${JSON.stringify(moduleUrl)});
    console.log(JSON.stringify(browserPreset({id:'zero-fixture',session:{header:{cwd:process.cwd()}}},['synthetic-driver.mjs'])));
  `, { cwd, env: { INIT_CWD: undefined } });
  assert.equal(preset.env.PLAYWRIGHT_BROWSERS_PATH, '0');
});
