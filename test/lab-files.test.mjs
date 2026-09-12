import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, symlink, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';

async function fixture() {
  const { createLabFiles } = await import('../plugin/lab-files.mjs');
  const root = await mkdtemp(join(tmpdir(), 'coldx-lab-test-'));
  return { root, labRoot: join(root, 'runtime'), outputRoot: join(root, 'outputs'), lab: createLabFiles({ labRoot: join(root, 'runtime'), outputRoot: join(root, 'outputs') }) };
}
const hash = data => createHash('sha256').update(data).digest('hex');

test('lab creates twelve real samples, previews four plans, and verifies immutable output versions', async () => {
  const { lab, labRoot, outputRoot } = await fixture();
  const run = await lab.create({ ownerId: 'session-a', requestId: 'create-1' });
  assert.equal(run.files.length, 12);
  assert.deepEqual(run.plans.map(p => p.id), ['project', 'type', 'time', 'mixed']);
  for (const file of run.files) {
    assert.ok(file.path.startsWith(resolve(labRoot)));
    assert.equal(hash(await readFile(file.path)), file.hash);
  }
  for (const plan of run.plans) assert.equal(plan.entries.length, 12);
  const args = { ownerId: 'session-a', runId: run.runId, requestId: 'apply-1', planId: 'mixed', overrides: { [run.files[0].id]: '优先处理' } };
  const version = await lab.apply(args);
  assert.equal(version.verified, true);
  assert.ok(version.outputPath.startsWith(resolve(outputRoot)));
  assert.ok(version.files.find(f => f.id === run.files[0].id).relativePath.startsWith('优先处理/'));
  for (const file of version.files) assert.equal(hash(await readFile(file.path)), file.hash);
  const manifest = await readFile(version.manifestPath, 'utf8');
  const next = await lab.apply({ ...args, requestId: 'apply-2', planId: 'type', overrides: {} });
  assert.notEqual(next.versionId, version.versionId);
  assert.equal(await readFile(version.manifestPath, 'utf8'), manifest);
  for (const file of run.files) assert.equal(hash(await readFile(file.path)), file.hash, 'sources remain unchanged');
  assert.equal((await lab.inspect({ ownerId: 'session-a', runId: run.runId })).versions.length, 2);
});

test('lab deduplicates concurrent requests and rejects changed payloads, invalid paths and wrong owners', async () => {
  const { lab, labRoot, outputRoot } = await fixture();
  const created = await Promise.all([1, 2].map(() => lab.create({ ownerId: 'session-a', requestId: 'create-once' })));
  assert.equal(created[0].runId, created[1].runId);
  const run = created[0];
  const args = { ownerId: 'session-a', runId: run.runId, requestId: 'once', planId: 'project' };
  const versions = await Promise.all([lab.apply(args), lab.apply(args)]);
  assert.equal(versions[0].versionId, versions[1].versionId);
  const { createLabFiles } = await import('../plugin/lab-files.mjs');
  const restarted = createLabFiles({ labRoot, outputRoot });
  assert.equal((await restarted.apply(args)).versionId, versions[0].versionId);
  await assert.rejects(lab.apply({ ...args, planId: 'time' }), /request|请求/i);
  await assert.rejects(lab.inspect({ ownerId: 'session-other', runId: run.runId }), /owner|所属/i);
  for (const group of ['../outside', 'a/b', 'C:\\outside', '.', 'CON', 'x.']) {
    await assert.rejects(lab.apply({ ...args, requestId: `bad-${group}`, overrides: { [run.files[0].id]: group } }));
  }
  await assert.rejects(lab.apply({ ...args, requestId: 'unknown-file', overrides: { unknown: '其他' } }));
  await assert.rejects(lab.apply({ ...args, requestId: 'unknown-plan', planId: 'arbitrary' }));
  await assert.rejects(lab.inspect({ ownerId: 'session-a', runId: '../outside' }));
});

test('lab rejects cancellation and tampered input before publishing a version', async () => {
  const { lab, outputRoot } = await fixture();
  const signal = AbortSignal.abort('fixture cancelled');
  await assert.rejects(lab.create({ ownerId: 'session-a', requestId: 'cancelled', signal }));
  const run = await lab.create({ ownerId: 'session-a', requestId: 'real' });
  await assert.rejects(lab.apply({ ownerId: 'session-a', runId: run.runId, requestId: 'cancelled', planId: 'project', signal }));
  await writeFile(run.files[0].path, 'tampered');
  await assert.rejects(lab.apply({ ownerId: 'session-a', runId: run.runId, requestId: 'tampered', planId: 'project' }), /hash|内容|modified/i);
  assert.deepEqual(await readdir(outputRoot).catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e)), []);
});

test('lab rejects symlink roots and output descendants', async () => {
  const { createLabFiles } = await import('../plugin/lab-files.mjs');
  const { root, lab, outputRoot } = await fixture();
  const outside = join(root, 'outside');
  await mkdir(outside);
  const link = join(root, 'linked');
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createLabFiles({ labRoot: link, outputRoot }).create({ ownerId: 'a', requestId: 'x' }), /symlink|link|链接/i);
  const run = await lab.create({ ownerId: 'a', requestId: 'normal' });
  await mkdir(outputRoot);
  await symlink(outside, join(outputRoot, run.runId), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(lab.apply({ ownerId: 'a', runId: run.runId, requestId: 'x', planId: 'type' }), /symlink|link|链接/i);
  assert.deepEqual(await readdir(outside), []);
});

test('cancellation after staging starts publishes no version and a retry uses a fresh staging directory', { timeout: 5000 }, async () => {
  const { lab, outputRoot } = await fixture();
  const run = await lab.create({ ownerId: 'a', requestId: 'create' });
  await mkdir(outputRoot);
  const controller = new AbortController();
  // Windows TEMP may use an 8.3 alias; libuv compares events against the long path.
  const observer = watch(await realpath(outputRoot), { recursive: true }, (_event, path) => {
    if (path?.includes('.pending-')) controller.abort('cancel while staging');
  });
  const args = { ownerId: 'a', runId: run.runId, requestId: 'cancel-retry', planId: 'mixed' };
  try { await assert.rejects(lab.apply({ ...args, signal: controller.signal })); }
  finally { observer.close(); }
  assert.equal(controller.signal.aborted, true);
  assert.equal((await readdir(join(outputRoot, run.runId))).filter(name => name.startsWith('v-')).length, 0);
  const retry = await lab.apply(args);
  assert.equal(retry.verified, true);
  assert.equal((await lab.inspect({ ownerId: 'a', runId: run.runId })).versions.length, 1);
});

test('completed output tampering is detected instead of being reported as verified', async () => {
  const { lab } = await fixture();
  const run = await lab.create({ ownerId: 'a', requestId: 'create' });
  const version = await lab.apply({ ownerId: 'a', runId: run.runId, requestId: 'apply', planId: 'time' });
  await writeFile(version.files[0].path, 'modified output');
  await assert.rejects(lab.inspect({ ownerId: 'a', runId: run.runId }), /hash verification/);
});
