#!/usr/bin/env node
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parseArguments, buildDshArguments } from '../lib/launcher.mjs';
import { ensureProfile } from '../lib/profile.mjs';

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(`ColdX Web — native DeepSeek Harness generative workspace

Usage: pnpm start [--cwd <workspace>] [--port <0-65535>] [--no-open]

  --cwd <path>     Workspace for file and shell tools (default: current directory)
  --home <path>    DSH data directory (default: this project's .runtime)
  --port <number>  Loopback port (default: 3086; 0 chooses an available port)
  --no-open       Start the server without opening the browser
  --dump-config   Inspect the composed native DSH tree and exit

Configure model providers through Settings in the Web UI. The server stays
running when the browser closes. Ctrl+C in this terminal stops the server.`);
  } else {
    const require = createRequire(import.meta.url);
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const dshRoot = dirname(require.resolve('@deepseek-ai/dsh/package.json'));
    const policy = await import('../plugin/policy.mjs');
    const persona = policy.PERSONA ?? policy.COLDX_PERSONA ?? policy.persona;
    if (typeof persona !== 'string' || !persona.trim()) throw new Error('ColdX persona is missing.');
    const profile = await ensureProfile({
      home: options.home ?? process.env.COLDX_HOME ?? join(projectRoot, '.runtime'),
      projectRoot, dshRoot, persona,
    });
    const cwd = resolve(options.cwd ?? process.cwd());
    process.chdir(cwd);
    process.env.DSH_HOME = profile.home;
    process.env.DSH_TELEMETRY_DISABLED = '1';
    process.env.DSH_PERMISSION_MODE ??= 'danger-full-access';
    const args = buildDshArguments({ ...options, ...profile, dshRoot });
    process.argv = [process.execPath, ...args];
    // DSH owns signals and disposal directly. Windows child.kill(SIGINT)
    // terminates a child instead of delivering its JavaScript cleanup handler.
    await import(pathToFileURL(args[0]).href);
  }
} catch (error) { console.error(`ColdX: ${error.message}`); process.exitCode = 1; }
