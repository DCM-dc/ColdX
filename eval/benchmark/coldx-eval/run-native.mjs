#!/usr/bin/env node
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, realpath, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { availableParallelism, cpus } from 'node:os';
import { isolatedExecutionEnvironment, cpuClampConfiguration } from './execution-environment.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
function parse(args) {
  const result = { 'max-steps': '500', 'timeout-ms': '1800000' };
  const allowed = new Set(['source', 'workspace', 'output', 'task-file', 'base-url', 'max-steps', 'timeout-ms', 'playwright-browsers-path']);
  for (let i = 0; i < args.length; i++) {
    const name = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !allowed.has(name) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid argument: ${args[i]}`);
    result[name] = args[++i];
  }
  for (const name of ['source', 'workspace', 'output', 'task-file', 'base-url']) if (!result[name]) throw new Error(`--${name} is required`);
  for (const name of ['max-steps', 'timeout-ms']) if (!/^\d+$/.test(result[name]) || !Number.isSafeInteger(Number(result[name])) || Number(result[name]) < 1) throw new Error(`--${name} must be a positive integer`);
  return result;
}

try {
  const options = parse(process.argv.slice(2));
  const kept = isolatedExecutionEnvironment(process.env);
  let browsersPath = null;
  if (options['playwright-browsers-path']) {
    if (!isAbsolute(options['playwright-browsers-path'])) throw new Error('--playwright-browsers-path must be an absolute preinstalled cache path');
    browsersPath = await realpath(options['playwright-browsers-path']);
    if (!(await lstat(browsersPath)).isDirectory()) throw new Error('The explicit Playwright cache must be a directory');
    // Set before importing ColdX or Playwright, whose registry caches the path.
    process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  } else if (process.platform === 'linux') throw new Error('Linux evaluation requires --playwright-browsers-path; implicit user caches are not reproducible');
  const source = await realpath(resolve(options.source));
  const workspace = await realpath(resolve(options.workspace));
  const output = resolve(options.output);
  const taskFile = await realpath(resolve(options['task-file']));
  const endpoint = new URL(options['base-url']);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('--base-url must be a credential-free HTTP(S) endpoint');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) throw new Error('The native driver requires a local evaluation proxy; direct provider endpoints are not accepted.');
  const apiKey = process.env.COLDX_EVAL_API_KEY;
  if (!apiKey) throw new Error('COLDX_EVAL_API_KEY must contain the local proxy token. Do not pass an upstream provider key.');
  if (await lstat(output).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw new Error('Output must not exist; every evaluation needs a fresh isolated home.');
  await mkdir(output, { recursive: true });
  const home = join(output, 'dsh-home');
  const userHome = join(output, 'user-home');
  await mkdir(userHome, { recursive: true });
  const require = createRequire(join(source, 'package.json'));
  const dshPackage = await realpath(require.resolve('@deepseek-ai/dsh/package.json'));
  const dshRoot = dirname(dshPackage);
  const nativeRequire = createRequire(dshPackage);
  const nativeImport = name => import(pathToFileURL(nativeRequire.resolve(name)).href);
  const policyPath = join(source, 'plugin', 'policy.mjs');
  const { PERSONA } = await import(pathToFileURL(policyPath).href);
  const { ensureProfile } = await import(pathToFileURL(join(source, 'lib', 'profile.mjs')).href);
  const profile = await ensureProfile({ home, dshRoot, projectRoot: source, persona: PERSONA });
  const distribution = JSON.parse(await readFile(profile.patchPath, 'utf8'));
  const adapter = distribution.find(row => row.id === 'llm-deepseek').config;
  const request = {
    version: 1, source, workspace, output, home, taskFile,
    maxSteps: Number(options['max-steps']), timeoutMs: Number(options['timeout-ms']),
    provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max', temperature: 1,
    contextWindow: 1000000, policySha256: createHash('sha256').update(await readFile(policyPath)).digest('hex'),
    coldxVersion: JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).version,
    dshVersion: JSON.parse(await readFile(dshPackage, 'utf8')).version,
    browserRuntime: { browsersPath, executable: null, available: false },
    processParallelism: { cpuClamp: cpuClampConfiguration(kept), cpus: cpus().length, availableParallelism: availableParallelism() },
  };
  if (browsersPath) {
    const { browserRuntime } = await import(pathToFileURL(join(source, 'plugin', 'computer-preset.mjs')).href);
    const runtime = browserRuntime();
    if (!runtime.available) throw new Error('The explicit Playwright cache does not contain the pinned Chromium headless shell');
    request.browserRuntime = { browsersPath, executable: runtime.executable, available: true };
  }
  const requestPath = join(output, 'request.json');
  await writeFile(requestPath, JSON.stringify(request, null, 2) + '\n');
  const overlay = [
    { id: 'llm-deepseek', config: { ...adapter, apiKeyEnv: 'COLDX_EVAL_API_KEY', baseURL: endpoint.href.replace(/\/$/, ''), thinking: 'enabled', reasoningEffort: 'max', defaultContextWindow: 1000000 } },
    { insert: [{ id: 'coldx-evaluation-driver', name: pathToFileURL(join(directory, 'native-driver.mjs')).href, config: { requestPath } }] },
  ];
  const patchPath = join(output, 'evaluation.patch.json');
  await writeFile(patchPath, JSON.stringify(overlay, null, 2) + '\n');
  // Native boot gets an explicit environment snapshot, so no project/user .env
  // or pre-existing DSH settings/credentials are discovered by the CLI fallback.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, kept, { HOME: userHome, USERPROFILE: userHome, APPDATA: join(userHome, 'AppData', 'Roaming'), LOCALAPPDATA: join(userHome, 'AppData', 'Local'), DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: 'danger-full-access', COLDX_EVAL_API_KEY: apiKey });
  if (browsersPath) process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  process.chdir(workspace);
  const binSource = await readFile(join(dshRoot, 'lib', 'bin.js'), 'utf8');
  const nativeBootFile = binSource.match(/const \{ runProfile \} = await import\("([^"\n]+)"\)/)?.[1];
  if (!nativeBootFile || !nativeBootFile.startsWith('./profile-boot-')) throw new Error('Pinned DSH native profile-boot entry changed; refusing an unverified fallback.');
  const { runProfile } = await import(pathToFileURL(resolve(dshRoot, 'lib', nativeBootFile)).href);
  const { createLaunchEnvironmentSnapshot } = await nativeImport('@deepseek-ai/dsh-launch-environment');
  await runProfile({ environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: { ...process.env } }]), profile: 'web', patchFiles: [patchPath], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] });
} catch (error) {
  console.error(`ColdX evaluation: ${error.message}`);
  process.exitCode = 1;
}
