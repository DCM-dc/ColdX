import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, access, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopElectronEnvironment } from '../../desktop/window-policy.mjs';
import { verifyPackagedPackageManager } from './package-manager.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));
const output = join(project, 'dist/desktop');
const sourceExecutable = process.argv[2] ? resolve(process.argv[2]) : process.platform === 'win32'
  ? join(output, 'win-unpacked/ColdX.exe')
  : process.platform === 'darwin' ? join(output, process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'ColdX.app/Contents/MacOS/ColdX')
    : join(output, 'linux-unpacked/coldx');
await access(sourceExecutable);
const data = await mkdtemp(join(tmpdir(), 'coldx desktop smoke '));
// Relocate the complete app outside the checkout. Otherwise missing runtime
// dependencies can accidentally resolve from the developer's node_modules.
const sourceDirectory = process.platform === 'darwin' ? resolve(dirname(sourceExecutable), '../..') : dirname(sourceExecutable);
const appDirectory = join(data, process.platform === 'darwin' ? 'ColdX.app' : 'application');
await cp(sourceDirectory, appDirectory, { recursive: true });
const executable = process.platform === 'darwin' ? join(appDirectory, 'Contents/MacOS/ColdX') : join(appDirectory, process.platform === 'win32' ? 'ColdX.exe' : 'coldx');
const workspace = join(data, 'workspace');
const reportPath = join(data, 'smoke.json');
await mkdir(workspace);
const resources = process.platform === 'darwin' ? join(appDirectory, 'Contents/Resources') : join(appDirectory, 'resources');
const packageManager = await verifyPackagedPackageManager(join(resources, 'runtime'), { home: join(data, 'package-manager-home'), cwd: workspace });
const env = desktopElectronEnvironment({ ...process.env, COLDX_DESKTOP_DATA: join(data, 'data'), COLDX_DESKTOP_WORKSPACE: workspace, COLDX_SMOKE_REPORT: reportPath });
const child = spawn(executable, ['--smoke-test'], { env, stdio: 'inherit', windowsHide: true });
const timer = setTimeout(() => child.kill(), 120000);
const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); }).finally(() => clearTimeout(timer));
if (code !== 0) throw new Error(`Packaged app smoke failed (${code}); evidence directory: ${data}`);
const report = JSON.parse(await readFile(reportPath, 'utf8'));
if (!report.ok || report.readiness.coldxShell !== true || !report.readiness.bootEntryIds.includes('coldx-client')) throw new Error('ColdX renderer readiness was not verified');
try { process.kill(report.backendPid, 0); throw new Error('Backend process remained after application quit'); }
catch (error) { if (error.code !== 'ESRCH') throw error; }
console.log(JSON.stringify({ ok: true, platform: process.platform, arch: process.arch, packageManager, reportPath, backendStopped: true }, null, 2));
