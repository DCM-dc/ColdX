import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { groupMembers } from './linux-process-group.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const linuxOnly = { skip: process.platform !== 'linux', timeout: 20000 };

async function launchFixture(t, script) {
  const folder = await mkdtemp(join(tmpdir(), 'coldx-owned-group-'));
  const entry = join(folder, 'fixture.mjs');
  await writeFile(entry, script);
  const child = spawn(process.execPath, [entry], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } });
  const pidFile = join(folder, 'owner.pid');
  await writeFile(pidFile, String(child.pid));
  return { folder, entry, child, exited, pidFile, output: () => ({ stdout, stderr }) };
}

test('owned launcher cleans stubborn background tools after the native root exits', linuxOnly, async t => {
  const helper = pathToFileURL(join(directory, 'linux-process-group.mjs')).href;
  const fixture = await launchFixture(t, `
    import { spawn } from 'node:child_process';
    import { requireOwnedGroup, terminateOwnedMembers } from ${JSON.stringify(helper)};
    const owner = await requireOwnedGroup(process.pid, process.argv[1]);
    const root = spawn(process.execPath, ['-e', \
      "const {spawn}=require('node:child_process'); spawn(process.execPath,['-e',\\\"process.on('SIGTERM',()=>{}); console.log('TOOL_READY'); setInterval(()=>{},1000)\\\"],{stdio:'inherit'}); setTimeout(()=>process.exit(0),150);"], {stdio:'inherit'});
    await new Promise(resolve => root.once('exit', resolve));
    await terminateOwnedMembers(owner, {graceMs:100});
    console.log('CLEANED');
  `);
  const result = await fixture.exited;
  assert.equal(result.code, 0, fixture.output().stderr);
  assert.match(fixture.output().stdout, /TOOL_READY/);
  assert.match(fixture.output().stdout, /CLEANED/);
  assert.deepEqual(await groupMembers(fixture.child.pid), []);
});

test('external cancellation kills the whole validated group and rejects a wrong entry', linuxOnly, async t => {
  const fixture = await launchFixture(t, `
    import {spawn} from 'node:child_process';
    process.on('SIGTERM',()=>{});
    spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],{stdio:'ignore'});
    console.log('READY'); setInterval(()=>{},1000);
  `);
  for (let i = 0; i < 50 && !fixture.output().stdout.includes('READY'); i++) await sleep(50);
  assert.match(fixture.output().stdout, /READY/);
  async function stop(entry) {
    const helper = spawn(process.execPath, [join(directory, 'stop-owned-process.mjs'), fixture.pidFile, entry], { stdio: 'ignore' });
    return new Promise(resolve => helper.once('exit', resolve));
  }
  assert.notEqual(await stop('/wrong/entry.mjs'), 0);
  assert.ok((await groupMembers(fixture.child.pid)).length >= 2);
  assert.equal(await stop(fixture.entry), 0);
  await fixture.exited;
  assert.deepEqual(await groupMembers(fixture.child.pid), []);
  // An exited group, including possible unreaped zombies, is safe to collect.
  assert.equal(await stop(fixture.entry), 0);
});
