import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const project = fileURLToPath(new URL('../', import.meta.url));
const exists = path => access(path).then(() => true, () => false);

async function compiler() {
  if (process.env.COLDX_MAKENSIS && await exists(process.env.COLDX_MAKENSIS)) return process.env.COLDX_MAKENSIS;
  if (!process.env.LOCALAPPDATA) return;
  const cache = join(process.env.LOCALAPPDATA, 'electron-builder/Cache');
  for (const version of await readdir(cache).catch(() => [])) {
    if (!/^nsis-\d/u.test(version)) continue;
    const directory = join(cache, version);
    const children = await readdir(directory).catch(() => []);
    for (const child of ['', ...children]) {
      const path = join(directory, child, 'Bin/makensis.exe');
      if (await exists(path)) return path;
    }
  }
}

const nsisString = value => value.replaceAll('$', '$$').replaceAll('"', '$\\"');
async function run(executable, args, cwd) {
  return new Promise((done, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output = (output + data).slice(-8192); });
    child.stderr.on('data', data => { output = (output + data).slice(-8192); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('NSIS fixture timed out.')); }, 30_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? done(output) : reject(new Error(`NSIS fixture failed (${code}): ${output}`)); });
  });
}

test('Windows NSIS hook removes long runtime paths while preserving outside data and native update paths', { skip: process.platform !== 'win32' }, async t => {
  const makensis = await compiler();
  if (!makensis) { t.skip('Run after desktop packaging, or set COLDX_MAKENSIS to the bundled NSIS compiler.'); return; }
  const config = createRequire(import.meta.url)('../desktop/electron-builder.cjs');
  const include = resolve(project, config.nsis.include);
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
  const root = await mkdtemp(join(tmpdir(), 'coldx nsis 中文 long-path-'));
  // Only this uniquely created fixture tree is ever removed by test cleanup.
  const withinTemp = relative(resolve(tmpdir()), resolve(root));
  assert.ok(withinTemp && !isAbsolute(withinTemp) && withinTemp !== '..' && !withinTemp.startsWith(`..${sep}`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ordinary = join(root, 'without-hook');
  const installation = join(root, 'application');
  for (const directory of [ordinary, installation]) {
    const file = join(directory, 'resources/runtime/app/node_modules', 'package'.repeat(12), 'operation'.repeat(12), 'long-generated-type.d.ts');
    assert.ok(file.length > 300);
    await mkdir(dirname(file), { recursive: true }); await writeFile(file, 'dependency fixture');
  }
  const userData = join(root, 'user-data');
  await mkdir(userData); await writeFile(join(userData, 'preserve.json'), 'user data');
  const update = join(root, 'updating');
  await mkdir(update); await writeFile(join(update, 'keep.txt'), 'native update owns this');
  const report = join(root, 'update-path.txt');
  const executable = join(root, 'fixture.exe');
  const script = join(root, 'fixture.nsi');
  await writeFile(script, `\uFEFFUnicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "${nsisString(executable)}"
!include "LogicLib.nsh"
Var updating
!define isUpdated '"$updating" == "1"'
!include "${nsisString(include)}"
Section
  SetOutPath "$TEMP"
  StrCpy $updating "0"
  StrCpy $INSTDIR "${nsisString(ordinary)}"
  RMDir /r "$INSTDIR"
  StrCpy $INSTDIR "${nsisString(installation)}"
  !insertmacro customUnInstall
  RMDir /r "$INSTDIR"
  StrCpy $updating "1"
  StrCpy $INSTDIR "${nsisString(update)}"
  !insertmacro customUnInstall
  FileOpen $0 "${nsisString(report)}" w
  FileWriteUTF16LE $0 "$INSTDIR"
  FileClose $0
SectionEnd
`);
  await run(makensis, ['/V2', script], root);
  await run(executable, ['/S'], root);
  assert.equal(await exists(ordinary), true, 'fixture must reproduce the native MAX_PATH failure');
  assert.equal(await exists(installation), false, 'the production hook must remove every long path');
  assert.equal(await readFile(join(userData, 'preserve.json'), 'utf8'), 'user data');
  assert.equal(await readFile(join(update, 'keep.txt'), 'utf8'), 'native update owns this');
  assert.equal(await readFile(report, 'utf16le'), update);
});
