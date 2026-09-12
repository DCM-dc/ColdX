import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { desktopElectronEnvironment } from '../../desktop/window-policy.mjs';
const require = createRequire(import.meta.url);
const child = spawn(require('electron'), [fileURLToPath(new URL('../../desktop', import.meta.url)), ...process.argv.slice(2)], {
  stdio: 'inherit', windowsHide: true,
  env: desktopElectronEnvironment({ ...process.env, COLDX_NODE_PATH: process.execPath }),
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
