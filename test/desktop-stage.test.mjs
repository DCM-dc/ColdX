import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, copyFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

test('runtime staging copies only executable sources and cannot include user credentials', async () => {
  const module = await import('../scripts/desktop/stage.mjs').catch(() => ({}));
  assert.equal(typeof module.stageSources, 'function');
  const projectRoot = await mkdtemp(join(tmpdir(), 'coldx-stage-'));
  try {
    for (const dir of ['bin', 'lib', 'plugin/client', 'plugin/.runtime', 'plugin/uploads', 'scripts', 'desktop/runtime', '.runtime', 'work', '.git', '.desktop-stage/runtime']) await mkdir(join(projectRoot, dir), { recursive: true });
    for (const file of ['bin/coldx-web.mjs', 'lib/profile.mjs', 'plugin/client/client.js', 'scripts/install-browser.mjs', 'desktop/backend-entry.mjs', 'desktop/runtime/package.json', 'desktop/runtime/package-lock.json', '.runtime/.credentials.yaml', '.env', 'work/private.txt', 'plugin/.env.local', 'plugin/.runtime/private.json', 'plugin/uploads/private.pdf', 'lib/private.pem', 'lib/credentials.yaml', '.desktop-stage/runtime/stale-user-file']) await writeFile(join(projectRoot, file), '{}');
    const root = await module.stageSources({ projectRoot });
    const files = (await readdir(root)).sort();
    assert.deepEqual(files, ['bin', 'desktop', 'lib', 'package-lock.json', 'package.json', 'plugin', 'scripts']);
    assert.deepEqual(await readdir(join(root, 'scripts')), ['install-browser.mjs']);
    assert.equal(await readFile(join(root, 'bin/coldx-web.mjs'), 'utf8'), '{}');
    assert.deepEqual(await readdir(join(root, 'plugin')), ['client']);
    assert.deepEqual(await readdir(join(root, 'lib')), ['profile.mjs']);
    assert.deepEqual(await readdir(dirname(root)), ['app']);
  } finally { await rm(projectRoot, { recursive: true, force: true }); }
});

test('staging rejects source links and staging junctions without touching their targets', async t => {
  const api = await import('../scripts/desktop/stage.mjs');
  const projectRoot = await patchFixture(); t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const outside = await mkdtemp(join(tmpdir(), 'coldx-stage-outside-')); t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'preserve.txt'), 'private');
  await symlink(outside, join(projectRoot, 'plugin/external'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(api.stageSources({ projectRoot }), /source cannot be a link/i);
  await rm(join(projectRoot, 'plugin/external'));
  await rm(join(projectRoot, '.desktop-stage'), { recursive: true, force: true });
  await symlink(outside, join(projectRoot, '.desktop-stage'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(api.stageSources({ projectRoot }), /staging directory cannot be a link/i);
  assert.equal(await readFile(join(outside, 'preserve.txt'), 'utf8'), 'private');
});

async function packageManagerFixture(t) {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), 'coldx shipped tools 中文 '));
  t.after(() => rm(runtimeDirectory, { recursive: true, force: true }));
  const packageRoot = join(runtimeDirectory, 'tools/node_modules/pnpm');
  await mkdir(join(packageRoot, 'bin'), { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'pnpm', version: '11.19.0', bin: { pnpm: 'bin/pnpm.mjs' } }));
  await writeFile(join(packageRoot, 'LICENSE'), 'fixture license');
  await writeFile(join(packageRoot, 'bin/pnpm.mjs'), 'if (process.argv[2] !== "--version" || process.env.pnpm_config_pm_on_fail !== "ignore") process.exit(71); console.log("11.19.0");');
  const node = join(runtimeDirectory, process.platform === 'win32' ? 'node.exe' : 'node');
  await copyFile(process.execPath, node);
  if (process.platform !== 'win32') await chmod(node, 0o755);
  return { runtimeDirectory, packageRoot };
}

test('shipped pnpm launcher works through the actual native plugin CLI with a clean PATH and spaces', async t => {
  const api = await import('../scripts/desktop/package-manager.mjs');
  const { runtimeDirectory } = await packageManagerFixture(t);
  const packageManager = await api.writePackageManagerLaunchers(runtimeDirectory);
  await writeFile(join(runtimeDirectory, 'manifest.json'), JSON.stringify({ packageManager }));
  const bin = join(runtimeDirectory, 'app/node_modules/@deepseek-ai/dsh/lib/bin.js');
  await mkdir(dirname(bin), { recursive: true });
  const require = createRequire(import.meta.url);
  const nativeBin = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js');
  // Reuse the installed native CLI parser/forwarder, not a mock of its command.
  await writeFile(bin, `import ${JSON.stringify(pathToFileURL(nativeBin).href)};`);
  const result = await api.verifyPackagedPackageManager(runtimeDirectory, { home: join(runtimeDirectory, 'isolated-home'), cwd: runtimeDirectory });
  assert.deepEqual(result, { version: '11.19.0', nativeCli: true, isolatedPath: true });
  assert.equal(await readFile(join(runtimeDirectory, 'PNPM-LICENSE'), 'utf8'), 'fixture license');
});

test('package manager launchers reject version drift and package entry escapes', async t => {
  const api = await import('../scripts/desktop/package-manager.mjs');
  const { runtimeDirectory, packageRoot } = await packageManagerFixture(t);
  await assert.rejects(api.writePackageManagerLaunchers(runtimeDirectory, { version: '11.18.0' }), /package\/version/i);
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'pnpm', version: '11.19.0', bin: { pnpm: '../../../escape.mjs' } }));
  await assert.rejects(api.writePackageManagerLaunchers(runtimeDirectory), /escapes/i);
});

test('dependency executable links must point into the copied dependency graph', async t => {
  const { assertNoLinks } = await import('../scripts/desktop/stage.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'coldx-stage-deps-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'node_modules/.bin'), { recursive: true });
  await mkdir(join(directory, 'external'), { recursive: true });
  // Directory junctions model the same escape on Windows without requiring
  // developer-mode privileges for creating file symlinks.
  await symlink(join(directory, 'external'), join(directory, 'node_modules/.bin/escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(assertNoLinks(join(directory, 'node_modules')), /points outside/i);
});

async function browserFixture(t, runtimeDirectory) {
  if (!runtimeDirectory) {
    runtimeDirectory = await mkdtemp(join(tmpdir(), 'coldx bundled browser 中文 '));
    t.after(() => rm(runtimeDirectory, { recursive: true, force: true }));
  }
  const app = join(runtimeDirectory, 'app');
  const mcp = join(app, 'node_modules/@playwright/mcp');
  const playwright = join(app, 'node_modules/playwright');
  const core = join(app, 'node_modules/playwright-core');
  for (const directory of [join(app, 'plugin'), mcp, playwright, core]) await mkdir(directory, { recursive: true });
  await writeFile(join(app, 'package.json'), JSON.stringify({ type: 'module', dependencies: { '@playwright/mcp': '0.0.80' } }));
  await writeFile(join(mcp, 'package.json'), JSON.stringify({ name: '@playwright/mcp', version: '0.0.80', dependencies: { playwright: '1.63.0-alpha-2026-08-31', 'playwright-core': '1.63.0-alpha-2026-08-31' } }));
  for (const [directory, name] of [[playwright, 'playwright'], [core, 'playwright-core']]) await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '1.63.0-alpha-2026-08-31' }));
  const binary = 'chromium_headless_shell-1234/chrome-headless-shell/headless_shell.exe';
  await writeFile(join(app, 'plugin/computer-preset.mjs'), `
    import {existsSync} from 'node:fs'; import {join} from 'node:path'; import {fileURLToPath} from 'node:url';
    export function browserRuntime() {
      const executable=join(process.env.PLAYWRIGHT_BROWSERS_PATH ?? 'global-cache',${JSON.stringify(binary)});
      return {executable, available:existsSync(executable), installer:fileURLToPath(new URL('../node_modules/playwright/cli.js',import.meta.url))};
    }
  `);
  // Only the external download is synthetic: the production staging function
  // launches a real Node process, and the CLI requires the exact flags/path.
  await writeFile(join(playwright, 'cli.js'), `
    const {mkdirSync,writeFileSync}=require('node:fs'); const {isAbsolute,join,dirname}=require('node:path');
    if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['install','--only-shell','chromium']))process.exit(71);
    const root=process.env.PLAYWRIGHT_BROWSERS_PATH;if(!root || !isAbsolute(root))process.exit(72);
    const binary=join(root,${JSON.stringify(binary)});mkdirSync(dirname(binary),{recursive:true});writeFileSync(binary,'fixture browser');
  `);
  return { runtimeDirectory, app, binary, executable: join(runtimeDirectory, 'browsers', binary) };
}

test('desktop stages its pinned headless browser with a clean bundle and a foreign global cache', async t => {
  const api = await import('../scripts/desktop/browser-bundle.mjs').catch(() => ({}));
  assert.equal(typeof api.stageBrowserBundle, 'function', 'desktop staging must install its own browser bundle');
  const fixture = await browserFixture(t);
  const original = process.env.PLAYWRIGHT_BROWSERS_PATH;
  t.after(() => { if (original === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH; else process.env.PLAYWRIGHT_BROWSERS_PATH = original; });
  process.env.PLAYWRIGHT_BROWSERS_PATH = join(fixture.runtimeDirectory, 'foreign-cache');
  const browser = await api.stageBrowserBundle({ runtimeDirectory: fixture.runtimeDirectory, nodePath: process.execPath });
  assert.equal(await readFile(fixture.executable, 'utf8'), 'fixture browser');
  assert.equal(browser.name, 'chromium-headless-shell');
  assert.equal(browser.directory, 'browsers');
  assert.equal(browser.executable, `browsers/${fixture.binary}`);
  assert.equal(browser.mcpVersion, '0.0.80');
  assert.equal(browser.playwrightVersion, '1.63.0-alpha-2026-08-31');
  assert.equal(browser.playwrightCoreVersion, '1.63.0-alpha-2026-08-31');
  assert.deepEqual(await api.verifyBrowserBundle({ runtimeDirectory: fixture.runtimeDirectory, nodePath: process.execPath, browser }), browser);
  await assert.rejects(api.verifyBrowserBundle({ runtimeDirectory: fixture.runtimeDirectory, nodePath: process.execPath, browser: { ...browser, playwrightVersion: '0.0.0' } }), /version|manifest|match/i);
  await assert.rejects(api.verifyBrowserBundle({ runtimeDirectory: fixture.runtimeDirectory, nodePath: process.execPath, browser: { ...browser, executable: '../outside.exe' } }), /escape|path|manifest/i);
  await rm(fixture.executable);
  await assert.rejects(api.verifyBrowserBundle({ runtimeDirectory: fixture.runtimeDirectory, nodePath: process.execPath, browser }), /browser|ENOENT/i);
});

test('browser staging refuses redirected bundle roots before invoking its installer', async t => {
  const api = await import('../scripts/desktop/browser-bundle.mjs').catch(() => ({}));
  assert.equal(typeof api.stageBrowserBundle, 'function');
  const fixture = await browserFixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'coldx browser outside '));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(fixture.runtimeDirectory, 'browsers'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(api.stageBrowserBundle({ runtimeDirectory: fixture.runtimeDirectory, nodePath: process.execPath }), /link|redirect/i);
  assert.deepEqual(await readdir(outside), []);
});

test('packaging gate rejects incomplete tools, wrong architectures and leftover runtime files', async t => {
  const { verifyStagedRuntime } = await import('../scripts/desktop/stage.mjs');
  const { PNPM_VERSION } = await import('../scripts/desktop/package-manager.mjs');
  const project = await mkdtemp(join(tmpdir(), 'coldx-package-gate-')); t.after(() => rm(project, { recursive: true, force: true }));
  const runtime = join(project, '.desktop-stage/runtime');
  const node = process.platform === 'win32' ? 'node.exe' : 'node';
  const launcher = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const entry = 'tools/node_modules/pnpm/bin/pnpm.mjs';
  for (const file of [node, launcher, 'NODE-LICENSE', 'PNPM-LICENSE', entry, 'app/bin/coldx-web.mjs', 'app/desktop/backend-entry.mjs', 'app/plugin/client/client.js', 'app/node_modules/@deepseek-ai/dsh/lib/bin.js']) {
    await mkdir(dirname(join(runtime, file)), { recursive: true }); await writeFile(join(runtime, file), 'fixture');
  }
  await writeFile(join(runtime, 'tools/node_modules/pnpm/package.json'), JSON.stringify({ name: 'pnpm', version: PNPM_VERSION }));
  await writeFile(join(runtime, 'app/desktop/native-patches.json'), JSON.stringify({ version: 1, patches: [] }));
  const manifest = { node: process.versions.node, platform: process.platform, arch: process.arch, packageManager: { version: PNPM_VERSION, entry }, nativePatches: [] };
  await writeFile(join(runtime, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(verifyStagedRuntime(project), /browser/i, 'a runtime without a bundled browser must not ship');
  const { stageBrowserBundle } = await import('../scripts/desktop/browser-bundle.mjs');
  await browserFixture(t, runtime);
  await copyFile(process.execPath, join(runtime, node));
  manifest.browser = await stageBrowserBundle({ runtimeDirectory: runtime, nodePath: join(runtime, node) });
  await writeFile(join(runtime, 'manifest.json'), JSON.stringify(manifest));
  assert.equal((await verifyStagedRuntime(project)).packageManager.version, PNPM_VERSION);
  const builder = createRequire(import.meta.url)('../desktop/electron-builder.cjs');
  assert.ok(builder.extraResources.some(resource => resource.to === 'runtime' && resource.filter.includes('browsers/**/*')), 'electron-builder must copy the verified browser directory');
  await assert.rejects(verifyStagedRuntime(project, { arch: 'wrong' }), /OS and CPU/i);
  await writeFile(join(runtime, 'user-data.json'), 'private');
  await assert.rejects(verifyStagedRuntime(project), /Unexpected file/i);
  await rm(join(runtime, 'user-data.json'));
  await rm(join(runtime, launcher));
  await assert.rejects(verifyStagedRuntime(project), { code: 'ENOENT' });
});

async function patchFixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), 'coldx-stage-patches-'));
  for (const dir of ['bin', 'lib', 'plugin/client', 'desktop/runtime', 'patches']) await mkdir(join(projectRoot, dir), { recursive: true });
  for (const file of ['desktop/backend-entry.mjs', 'desktop/runtime/package.json', 'desktop/runtime/package-lock.json']) await writeFile(join(projectRoot, file), '{}');
  await writeFile(join(projectRoot, 'pnpm-workspace.yaml'), "patchedDependencies:\n  '@fixture/native@1.2.3': patches/native.patch\n");
  await writeFile(join(projectRoot, 'patches/native.patch'), 'diff --git a/lib/index.js b/lib/index.js\n--- a/lib/index.js\n+++ b/lib/index.js\n@@ -1,3 +1,3 @@\n first\n-old route\n+current route\n last\n');
  return projectRoot;
}

test('npm desktop stage applies exactly the same pinned patches as pnpm and records their hashes', async t => {
  const api = await import('../scripts/desktop/stage.mjs');
  const projectRoot = await patchFixture(); t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const runtimeRoot = await api.stageSources({ projectRoot });
  const dependency = join(runtimeRoot, 'node_modules/@fixture/native');
  await mkdir(join(dependency, 'lib'), { recursive: true });
  await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: '@fixture/native', version: '1.2.3' }));
  await writeFile(join(dependency, 'lib/index.js'), 'first\r\nold route\r\nlast\r\n');
  const applied = await api.applyStagedNativePatches(runtimeRoot);
  assert.equal(await readFile(join(dependency, 'lib/index.js'), 'utf8'), 'first\r\ncurrent route\r\nlast\r\n');
  assert.equal(applied.length, 1);
  assert.equal(applied[0].specifier, '@fixture/native@1.2.3');
  assert.match(applied[0].sha256, /^[a-f0-9]{64}$/u);
});

test('desktop patching fails closed on version or source drift before mutating installed dependencies', async t => {
  const api = await import('../scripts/desktop/stage.mjs');
  const projectRoot = await patchFixture(); t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const runtimeRoot = await api.stageSources({ projectRoot });
  const dependency = join(runtimeRoot, 'node_modules/@fixture/native');
  await mkdir(join(dependency, 'lib'), { recursive: true });
  const original = 'first\nold route\nlast\n';
  await writeFile(join(dependency, 'lib/index.js'), original);
  await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: '@fixture/native', version: '1.2.4' }));
  await assert.rejects(api.applyStagedNativePatches(runtimeRoot), /version/i);
  assert.equal(await readFile(join(dependency, 'lib/index.js'), 'utf8'), original);
  await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: '@fixture/native', version: '1.2.3' }));
  await writeFile(join(dependency, 'lib/index.js'), 'upstream changed\n');
  await assert.rejects(api.applyStagedNativePatches(runtimeRoot), /context|source|hunk/i);
  assert.equal(await readFile(join(dependency, 'lib/index.js'), 'utf8'), 'upstream changed\n');
});

test('desktop patching checks missing packages and patch hashes, and patches every nested npm copy', async t => {
  const api = await import('../scripts/desktop/stage.mjs');
  const projectRoot = await patchFixture(); t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const runtimeRoot = await api.stageSources({ projectRoot });
  await assert.rejects(api.applyStagedNativePatches(runtimeRoot), /missing/i);
  const dependencies = [join(runtimeRoot, 'node_modules/@fixture/native'), join(runtimeRoot, 'node_modules/parent/node_modules/@fixture/native')];
  await mkdir(join(runtimeRoot, 'node_modules/parent'), { recursive: true });
  await writeFile(join(runtimeRoot, 'node_modules/parent/package.json'), JSON.stringify({ name: 'parent', version: '1.0.0' }));
  for (const dependency of dependencies) {
    await mkdir(join(dependency, 'lib'), { recursive: true });
    await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: '@fixture/native', version: '1.2.3' }));
    await writeFile(join(dependency, 'lib/index.js'), 'first\nold route\nlast\n');
  }
  const manifest = JSON.parse(await readFile(join(runtimeRoot, 'desktop/native-patches.json'), 'utf8'));
  const patchPath = join(runtimeRoot, manifest.patches[0].path);
  const patch = await readFile(patchPath, 'utf8');
  await writeFile(patchPath, patch + '# tampered\n');
  await assert.rejects(api.applyStagedNativePatches(runtimeRoot), /digest/i);
  for (const dependency of dependencies) assert.match(await readFile(join(dependency, 'lib/index.js'), 'utf8'), /old route/);
  await writeFile(patchPath, patch);
  await api.applyStagedNativePatches(runtimeRoot);
  for (const dependency of dependencies) assert.match(await readFile(join(dependency, 'lib/index.js'), 'utf8'), /current route/);
});

test('patch staging rejects patch paths outside the project and non-pinned package versions', async t => {
  const api = await import('../scripts/desktop/stage.mjs');
  const projectRoot = await patchFixture(); t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await writeFile(join(projectRoot, 'pnpm-workspace.yaml'), "patchedDependencies:\n  '@fixture/native@^1.2.3': patches/native.patch\n");
  await assert.rejects(api.stageSources({ projectRoot }), /exact package version/i);
  await writeFile(join(projectRoot, 'pnpm-workspace.yaml'), "patchedDependencies:\n  '@fixture/native@1.2.3': ../outside.patch\n");
  await assert.rejects(api.stageSources({ projectRoot }), /escapes/i);
});
