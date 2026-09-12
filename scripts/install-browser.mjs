import { spawn } from 'node:child_process';
import { browserRuntime } from '../plugin/computer-preset.mjs';
const task = spawn(process.execPath, [browserRuntime().installer, 'install', '--only-shell', 'chromium'], { stdio: 'inherit', windowsHide: true });
task.on('error', error => { console.error(error.message); process.exitCode = 1; });
task.on('exit', code => { process.exitCode = code ?? 1; });
