import { cp, copyFile, mkdir, readFile, readdir, rm, writeFile, chmod, lstat, unlink, realpath, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageNativePatches, applyStagedNativePatches } from './native-patches.mjs';
import { PNPM_VERSION, stagePackageManager } from './package-manager.mjs';
import { stageBrowserBundle, verifyBrowserBundle } from './browser-bundle.mjs';
export { applyStagedNativePatches } from './native-patches.mjs';

const sourceDirectories = ['bin', 'lib', 'plugin', 'vendor'];
const privateSource = part => part.startsWith('.') || ['node_modules', 'work', 'sessions', 'uploads', 'credentials'].includes(part.toLowerCase()) || /(?:\.(?:log|pem|p12|pfx|key)|(?:^|[._-])credentials?(?:\.[^.]+)?)$/iu.test(part);

async function resetStage(project) {
  // Validate each ancestor before deleting the generated directory: a junction
  // at .desktop-stage must never turn this into a deletion outside the checkout.
  const runtimeDirectory = resolve(project, '.desktop-stage/runtime');
  if (relative(project, runtimeDirectory) !== join('.desktop-stage', 'runtime')) throw new Error('Invalid staging path');
  for (const path of [join(project, '.desktop-stage'), runtimeDirectory]) {
    try { if ((await lstat(path)).isSymbolicLink()) throw new Error('Staging directory cannot be a link.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await rm(runtimeDirectory, { recursive: true, force: true });
  await mkdir(join(runtimeDirectory, 'app'), { recursive: true });
  return join(runtimeDirectory, 'app');
}

export async function stageSources({ projectRoot }) {
  const project = await realpath(resolve(projectRoot));
  const runtimeRoot = await resetStage(project);
  for (const directory of sourceDirectories) await cp(join(project, directory), join(runtimeRoot, directory), { recursive: true, filter: async source => {
    const parts = relative(project, source).split(sep);
    if (parts.some(privateSource)) return false;
    if ((await lstat(source)).isSymbolicLink()) throw new Error(`Runtime source cannot be a link: ${parts.join('/')}`);
    return true;
  } });
  for (const file of ['package.json', 'package-lock.json']) await copyFile(join(project, 'desktop/runtime', file), join(runtimeRoot, file));
  await mkdir(join(runtimeRoot, 'desktop'), { recursive: true });
  await copyFile(join(project, 'desktop/backend-entry.mjs'), join(runtimeRoot, 'desktop/backend-entry.mjs'));
  try {
    const installer = join(project, 'scripts/install-browser.mjs');
    await lstat(installer);
    await mkdir(join(runtimeRoot, 'scripts'), { recursive: true });
    await copyFile(installer, join(runtimeRoot, 'scripts/install-browser.mjs'));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await stageNativePatches(project, runtimeRoot);
  return runtimeRoot;
}

function run(command, args, cwd, env = process.env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`${command} exited with ${code}`)));
  });
}

export async function assertNoLinks(directory, root = directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if ((await lstat(path)).isSymbolicLink()) {
      // Only npm's executable shims may link, and their real targets must remain
      // within this copied dependency graph (not a developer's pnpm store).
      const part = relative(await realpath(root), await realpath(path));
      if (directory.split(/[\\/]/).at(-1) === '.bin' && part && !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)) continue;
      throw new Error(`A distribution dependency points outside its package: ${path}`);
    }
    if (entry.isDirectory()) await assertNoLinks(path, root);
  }
}

/** Called again by electron-builder so incomplete/stale staging cannot ship. */
export async function verifyStagedRuntime(projectRoot, { platform = process.platform, arch = process.arch } = {}) {
  const runtimeDirectory = join(resolve(projectRoot), '.desktop-stage/runtime');
  const manifest = JSON.parse(await readFile(join(runtimeDirectory, 'manifest.json'), 'utf8'));
  if (manifest.platform !== platform || manifest.arch !== arch) throw new Error('Build ColdX on the target OS and CPU architecture; the Node sidecar and native modules must match.');
  if (Number(manifest.node?.split('.')[0]) !== 24 || manifest.packageManager?.version !== PNPM_VERSION) throw new Error('Incomplete desktop Node/pnpm runtime. Run desktop:stage again.');
  const node = platform === 'win32' ? 'node.exe' : 'node';
  const launcher = platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const allowed = new Set(['app', 'tools', 'browsers', node, launcher, 'NODE-LICENSE', 'PNPM-LICENSE', 'manifest.json']);
  for (const name of await readdir(runtimeDirectory)) if (!allowed.has(name)) throw new Error(`Unexpected file in desktop runtime: ${name}`);
  const entry = manifest.packageManager.entry;
  if (typeof entry !== 'string' || !/^tools\/node_modules\/pnpm\/bin\/[a-z.]+$/u.test(entry)) throw new Error('Invalid staged package manager entry.');
  await Promise.all([node, launcher, 'NODE-LICENSE', 'PNPM-LICENSE', entry, 'app/bin/coldx-web.mjs', 'app/desktop/backend-entry.mjs', 'app/plugin/client/client.js', 'app/node_modules/@deepseek-ai/dsh/lib/bin.js', 'app/vendor/superpowers/manifest.json', 'app/vendor/superpowers/LICENSE', 'app/plugin/windows/computer-worker.ps1', 'app/plugin/windows/computer-native.cs'].map(file => access(join(runtimeDirectory, file))));
  const pnpm = JSON.parse(await readFile(join(runtimeDirectory, 'tools/node_modules/pnpm/package.json'), 'utf8'));
  if (pnpm.name !== 'pnpm' || pnpm.version !== PNPM_VERSION) throw new Error('Staged pnpm version mismatch.');
  const patches = JSON.parse(await readFile(join(runtimeDirectory, 'app/desktop/native-patches.json'), 'utf8'));
  if (JSON.stringify(patches.patches.map(({ specifier, sha256 }) => ({ specifier, sha256 }))) !== JSON.stringify(manifest.nativePatches)) throw new Error('Staged native patches were not applied completely.');
  for (const patch of patches.patches) {
    if (!/^desktop\/native-patches\/\d+\.patch$/u.test(patch.path)) throw new Error('Invalid staged native patch path.');
    const hash = createHash('sha256').update(await readFile(join(runtimeDirectory, 'app', patch.path))).digest('hex');
    if (hash !== patch.sha256) throw new Error('Staged native patch digest mismatch.');
  }
  await verifyBrowserBundle({ runtimeDirectory, nodePath: join(runtimeDirectory, node), browser: manifest.browser });
  return manifest;
}

export async function stageDesktop(projectRoot) {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Build ColdX with Node 24 so native addons match the shipped sidecar.');
  const project = resolve(projectRoot);
  const runtimeRoot = await stageSources({ projectRoot: project });
  const npmPath = process.platform === 'win32' ? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js') : resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
  // npm's locked, hoisted production install avoids shipping pnpm's machine-local junctions.
  await run(process.execPath, [npmPath, 'ci', '--omit=dev', '--install-links', '--legacy-peer-deps', '--no-audit', '--no-fund'], runtimeRoot);
  const clientPath = join(runtimeRoot, 'node_modules/coldx-client');
  if ((await lstat(clientPath)).isSymbolicLink()) {
    await unlink(clientPath);
    await cp(join(runtimeRoot, 'plugin/client'), clientPath, { recursive: true });
  }
  await assertNoLinks(join(runtimeRoot, 'node_modules'));
  const nativePatches = await applyStagedNativePatches(runtimeRoot);
  const runtimeDirectory = dirname(runtimeRoot);
  const packageManager = await stagePackageManager({ runtimeDirectory, npmPath, run });
  await assertNoLinks(join(runtimeDirectory, 'tools/node_modules'));
  const nodePath = join(runtimeDirectory, process.platform === 'win32' ? 'node.exe' : 'node');
  await copyFile(process.execPath, nodePath);
  if (process.platform !== 'win32') await chmod(nodePath, 0o755);
  const browser = await stageBrowserBundle({ runtimeDirectory, nodePath });
  const license = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`, { signal: AbortSignal.timeout(30_000) });
  if (!license.ok) throw new Error('Could not retrieve the bundled Node license');
  await writeFile(join(runtimeDirectory, 'NODE-LICENSE'), await license.text());
  const runtimePackage = JSON.parse(await readFile(join(runtimeRoot, 'package.json'), 'utf8'));
  await writeFile(join(runtimeDirectory, 'manifest.json'), JSON.stringify({ node: process.versions.node, platform: process.platform, arch: process.arch, dsh: runtimePackage.dependencies['@deepseek-ai/dsh'], packageManager, browser, nativePatches }, null, 2) + '\n');
  await verifyStagedRuntime(project);
  console.log(`ColdX runtime staged for ${process.platform}/${process.arch}: ${runtimeDirectory}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await stageDesktop(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
