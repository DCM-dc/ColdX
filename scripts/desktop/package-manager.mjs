import { copyFile, mkdir, readFile, writeFile, chmod, access, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const sourceDirectory = fileURLToPath(new URL('./tools/', import.meta.url));
export const PNPM_VERSION = '11.19.0';

function inside(root, path) {
  const part = relative(root, path);
  if (!part || isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`)) throw new Error('Package manager entry escapes its package.');
  return path;
}

/** Both shims use the adjacent Node, including when PATH contains no developer tools. */
export async function writePackageManagerLaunchers(runtimeDirectory, { version = PNPM_VERSION, platform = process.platform } = {}) {
  const packageRoot = join(runtimeDirectory, 'tools/node_modules/pnpm');
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  if (manifest.name !== 'pnpm' || manifest.version !== version || !/^\d+\.\d+\.\d+$/u.test(version)) throw new Error('Unexpected bundled pnpm package/version.');
  const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.pnpm;
  if (typeof entry !== 'string' || !/^[a-zA-Z0-9_./-]+$/u.test(entry)) throw new Error('Invalid bundled pnpm entry.');
  const entryPath = inside(await realpath(packageRoot), await realpath(inside(resolve(packageRoot), resolve(packageRoot, entry))));
  const runtimeEntry = relative(await realpath(runtimeDirectory), entryPath).split(sep).join('/');
  // Keep package-manager selection local: a profile's packageManager field must
  // not silently download and execute a different pnpm on first launch.
  const windows = `@echo off\r\nsetlocal\r\nset "pnpm_config_pm_on_fail=ignore"\r\n"%~dp0node.exe" "%~dp0${runtimeEntry.replaceAll('/', '\\')}" %*\r\nexit /b %ERRORLEVEL%\r\n`;
  const unix = `#!/bin/sh\nbasedir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexport pnpm_config_pm_on_fail=ignore\nexec "$basedir/node" "$basedir/${runtimeEntry}" "$@"\n`;
  const launcher = platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  await writeFile(join(runtimeDirectory, launcher), platform === 'win32' ? windows : unix);
  if (platform !== 'win32') await chmod(join(runtimeDirectory, launcher), 0o755);
  await copyFile(join(packageRoot, 'LICENSE'), join(runtimeDirectory, 'PNPM-LICENSE'));
  return { name: 'pnpm', version, entry: runtimeEntry, launcher, license: 'PNPM-LICENSE' };
}

/** npm ci verifies the pinned distribution integrity from this separate lock. */
export async function stagePackageManager({ runtimeDirectory, npmPath, run }) {
  const directory = join(runtimeDirectory, 'tools');
  await mkdir(directory, { recursive: true });
  for (const file of ['package.json', 'package-lock.json']) await copyFile(join(sourceDirectory, file), join(directory, file));
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (manifest.dependencies?.pnpm !== PNPM_VERSION) throw new Error('Desktop pnpm dependency must match its pinned version.');
  await run(process.execPath, [npmPath, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], directory);
  return writePackageManagerLaunchers(runtimeDirectory);
}

/** Real native CLI probe, with only the shipped runtime and OS commands on PATH. */
export async function verifyPackagedPackageManager(runtimeDirectory, { home, cwd, timeoutMs = 30_000 } = {}) {
  const manifest = JSON.parse(await readFile(join(runtimeDirectory, 'manifest.json'), 'utf8'));
  const executable = join(runtimeDirectory, process.platform === 'win32' ? 'node.exe' : 'node');
  const bin = join(runtimeDirectory, 'app/node_modules/@deepseek-ai/dsh/lib/bin.js');
  await Promise.all([access(executable), access(bin)]);
  const env = { ...process.env, DSH_HOME: home, CI: 'true' };
  for (const key of Object.keys(env)) if (/^(?:path|node_path|node_options|pnpm_home|npm_config_userconfig|npm_config_globalconfig)$/iu.test(key)) delete env[key];
  // The native Windows CLI invokes cmd.exe; no external Node/pnpm directory is
  // admitted. HOME/config are isolated so the probe cannot read user registries.
  env.PATH = process.platform === 'win32' ? `${runtimeDirectory};${join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')}` : `${runtimeDirectory}:/usr/bin:/bin`;
  env.HOME = home; env.USERPROFILE = home;
  env.npm_config_userconfig = join(home, '.npmrc');
  env.npm_config_globalconfig = join(home, 'global.npmrc');
  await mkdir(home, { recursive: true });
  const output = await new Promise((done, reject) => {
    const child = spawn(executable, [bin, 'plugin', '--profile', 'web', '--version'], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-8192); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-8192); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Bundled pnpm probe timed out.')); }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? done(stdout.trim()) : reject(new Error(`Bundled native plugin CLI failed (${code}): ${stderr}`)); });
  });
  if (output !== manifest.packageManager?.version) throw new Error(`Native plugin CLI did not run the pinned pnpm (${output}).`);
  return { version: output, nativeCli: true, isolatedPath: true };
}
