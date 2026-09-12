import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';

import * as implementation from '../.github/scripts/attach-desktop-release.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const commit = '29f96accf8c643158c43021e25ea88ec5607226a';
const name = 'ColdX-0.1.2-win-x64.exe';
const env = {
  GITHUB_TOKEN: 'synthetic-token', COLDX_BUILD_RUN_ID: '123',
  COLDX_RELEASE_TAG: 'v0.1.2', COLDX_RELEASE_COMMIT: commit,
  COLDX_DRAFT_RELEASE_ID: '456',
};

function zipFixture({ filename = name, method = 0, descriptor = false, extra = Buffer.alloc(0) } = {}) {
  const executable = Buffer.alloc(128);
  executable.write('MZ');
  executable.writeUInt32LE(64, 0x3c);
  executable.writeUInt32LE(0x4550, 64);
  const payload = method === 8 ? deflateRawSync(executable) : executable;
  const filenameBytes = Buffer.from(filename);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(descriptor ? 8 : 0, 6);
  local.writeUInt16LE(method, 8);
  if (!descriptor) {
    local.writeUInt32LE(crc32(executable), 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(executable.length, 22);
  }
  local.writeUInt16LE(filenameBytes.length, 26);
  local.writeUInt16LE(extra.length, 28);
  const trailer = Buffer.alloc(descriptor ? 16 : 0);
  if (descriptor) {
    trailer.writeUInt32LE(0x08074b50);
    trailer.writeUInt32LE(crc32(executable), 4);
    trailer.writeUInt32LE(payload.length, 8);
    trailer.writeUInt32LE(executable.length, 12);
  }
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(0x314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(descriptor ? 8 : 0, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc32(executable), 16);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(executable.length, 24);
  central.writeUInt16LE(filenameBytes.length, 28);
  central.writeUInt16LE(extra.length, 30);
  const centralOffset = local.length + filenameBytes.length + extra.length + payload.length + trailer.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + filenameBytes.length + extra.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return {
    archive: Buffer.concat([local, filenameBytes, extra, payload, trailer, central, filenameBytes, extra, eocd]),
    executable, centralOffset,
  };
}

function fixture() {
  const { archive, executable } = zipFixture();
  const release = { id: 456, tag_name: 'v0.1.2', target_commitish: commit, draft: true };
  const run = {
    id: 123, status: 'completed', conclusion: 'success', head_sha: commit,
    path: '.github/workflows/desktop.yml', head_repository: { full_name: 'DCM-dc/ColdX' },
  };
  const artifact = {
    id: 789, name: 'ColdX-Windows-x64', expired: false, expires_at: '2099-01-01T00:00:00Z',
    size_in_bytes: archive.length, digest: `sha256:${sha(archive)}`,
    workflow_run: { id: 123, head_sha: commit },
  };
  const assets = [], calls = [], uploads = [];
  const state = { release, run, artifact, assets, calls, uploads, archive, executable, tagObject: { type: 'commit', sha: commit } };
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  state.fetch = async (input, options = {}) => {
    const url = new URL(input);
    const call = { url, options };
    calls.push(call);
    state.before?.(call);
    if (url.hostname === 'synthetic.blob.core.windows.net') {
      assert.equal(new Headers(options.headers).get('authorization'), null, 'signed storage must never receive token');
      assert.equal(options.redirect, 'error');
      return new Response(state.archive);
    }
    assert.ok(['api.github.com', 'uploads.github.com'].includes(url.hostname));
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer synthetic-token');
    const path = url.pathname.replace('/repos/DCM-dc/ColdX', '');
    if (url.hostname === 'uploads.github.com') {
      assert.equal(options.method, 'POST');
      assert.equal(path, '/releases/456/assets');
      const body = Buffer.from(options.body);
      const asset = { id: 1000 + assets.length, name: url.searchParams.get('name'), size: body.length, digest: `sha256:${sha(body)}`, state: 'uploaded' };
      state.uploadResult?.(asset);
      assets.push(asset);
      uploads.push({ asset, body });
      return json(asset, 201);
    }
    assert.ok(!options.method || options.method === 'GET', 'metadata API must never mutate');
    if (path === '/git/ref/tags/v0.1.2') return json({ ref: 'refs/tags/v0.1.2', object: state.tagObject });
    if (path.startsWith('/git/tags/')) return json({ sha: path.split('/').at(-1), object: { type: 'commit', sha: commit } });
    if (path === '/actions/runs/123') return json(run);
    if (path === '/actions/runs/123/artifacts') return json({ total_count: 1, artifacts: [artifact] });
    if (path === '/actions/artifacts/789') return json(artifact);
    if (path === '/actions/artifacts/789/zip') return new Response(null, { status: 302, headers: { location: state.location ?? 'https://synthetic.blob.core.windows.net/artifact?signed=synthetic' } });
    if (path === '/releases/456') return json(release);
    if (path === '/releases/456/assets') return json(assets);
    if (path.startsWith('/releases/assets/')) return json(assets.find(asset => asset.id === Number(path.split('/').at(-1))));
    throw new Error(`Unexpected synthetic request: ${path}`);
  };
  return state;
}

async function attach(state, overrides = {}) {
  assert.equal(typeof implementation.attachDesktopRelease, 'function');
  return implementation.attachDesktopRelease({ env: { ...env, ...overrides }, fetchImpl: state.fetch });
}

test('uploads only the verified installer and checksum to the same draft', async () => {
  const state = fixture();
  const result = await attach(state);
  assert.equal(state.uploads.length, 2);
  assert.equal(state.uploads[0].asset.name, name);
  assert.deepEqual(state.uploads[0].body, state.executable);
  assert.equal(state.uploads[1].body.toString(), `${sha(state.executable)}  ${name}\n`);
  assert.equal(result.commit, commit);
  assert.equal(result.assets.length, 2);
  assert.ok(result.assets.every(asset => asset.reused === false));
  for (const upload of state.calls.filter(call => call.options.method === 'POST')) {
    const earlier = state.calls.slice(0, state.calls.indexOf(upload));
    assert.equal(earlier.at(-1)?.url.pathname, '/repos/DCM-dc/ColdX/releases/456', 'draft recheck must immediately precede each mutation');
  }
});

test('reuses only uploaded assets with exactly matching size and SHA256', async () => {
  const state = fixture();
  await attach(state);
  state.uploads.length = 0;
  const result = await attach(state);
  assert.equal(state.uploads.length, 0);
  assert.ok(result.assets.every(asset => asset.reused));
});

for (const [label, alter] of [
  ['wrong digest', asset => { asset.digest = `sha256:${'0'.repeat(64)}`; }],
  ['missing digest', asset => { delete asset.digest; }],
  ['wrong size', asset => { asset.size++; }],
  ['unfinished upload', asset => { asset.state = 'starter'; }],
]) {
  test(`refuses existing ${label} without replacing or uploading anything`, async () => {
    const state = fixture();
    await attach(state);
    state.uploads.length = 0;
    alter(state.assets[1]);
    await assert.rejects(attach(state), /asset/i);
    assert.equal(state.uploads.length, 0);
  });
}

for (const [label, alter] of [
  ['wrong tag commit', state => { state.tagObject.sha = '0'.repeat(40); }],
  ['unsuccessful run', state => { state.run.conclusion = 'failure'; }],
  ['foreign head repository', state => { state.run.head_repository.full_name = 'other/ColdX'; }],
  ['different workflow', state => { state.run.path = '.github/workflows/other.yml'; }],
  ['wrong run commit', state => { state.run.head_sha = '0'.repeat(40); }],
  ['wrong artifact commit', state => { state.artifact.workflow_run.head_sha = '0'.repeat(40); }],
  ['expired artifact', state => { state.artifact.expired = true; }],
  ['oversized archive', state => { state.artifact.size_in_bytes = 512 * 1024 * 1024 + 1; }],
  ['missing archive digest', state => { delete state.artifact.digest; }],
  ['wrong archive digest', state => { state.artifact.digest = `sha256:${'0'.repeat(64)}`; }],
  ['wrong archive length', state => { state.artifact.size_in_bytes++; }],
  ['unsafe storage host', state => { state.location = 'https://attacker.invalid/artifact'; }],
  ['non-draft release', state => { state.release.draft = false; }],
  ['wrong release tag', state => { state.release.tag_name = 'v0.1.1'; }],
  ['wrong release target', state => { state.release.target_commitish = 'main'; }],
]) {
  test(`rejects ${label} before upload`, async () => {
    const state = fixture();
    alter(state);
    await assert.rejects(attach(state));
    assert.equal(state.uploads.length, 0);
  });
}

test('resolves an annotated tag to the exact commit', async () => {
  const state = fixture();
  state.tagObject = { type: 'tag', sha: 'a'.repeat(40) };
  await attach(state);
  assert.equal(state.uploads.length, 2);
});

test('rechecks draft after download and before the first mutation', async () => {
  const state = fixture();
  state.before = ({ url }) => { if (url.hostname === 'synthetic.blob.core.windows.net') state.release.draft = false; };
  await assert.rejects(attach(state), /draft/i);
  assert.equal(state.uploads.length, 0);
});

test('rechecks draft before the second mutation and never publishes', async () => {
  const state = fixture();
  state.uploadResult = () => { state.release.draft = false; };
  await assert.rejects(attach(state), /draft/i);
  assert.equal(state.uploads.length, 1);
});

test('rejects an incorrect server digest after upload', async () => {
  const state = fixture();
  state.uploadResult = asset => { asset.digest = `sha256:${'f'.repeat(64)}`; };
  await assert.rejects(attach(state), /asset/i);
  assert.equal(state.uploads.length, 1);
});

test('independently verifies the uploaded asset through the read API', async () => {
  const state = fixture();
  state.before = ({ url }) => {
    if (url.pathname === '/repos/DCM-dc/ColdX/releases/assets/1000') state.assets[0].size++;
  };
  await assert.rejects(attach(state), /asset byte count/i);
  assert.equal(state.uploads.length, 1);
});

test('does not retry a POST with an uncertain transport outcome', async () => {
  const state = fixture();
  state.before = ({ options }) => { if (options.method === 'POST') throw new Error('synthetic connection lost'); };
  await assert.rejects(attach(state), /no automatic mutation retry/i);
  assert.equal(state.calls.filter(call => call.options.method === 'POST').length, 1);
});

test('refuses duplicate existing asset names', async () => {
  const state = fixture();
  await attach(state);
  state.assets.push({ ...state.assets[0], id: 2000 });
  state.uploads.length = 0;
  await assert.rejects(attach(state), /Duplicate release asset/i);
  assert.equal(state.uploads.length, 0);
});

test('validates environment before any network request', async () => {
  for (const overrides of [
    { GITHUB_TOKEN: '' }, { COLDX_BUILD_RUN_ID: '123/other' },
    { COLDX_DRAFT_RELEASE_ID: '9007199254740993' },
    { COLDX_RELEASE_TAG: '../v0.1.2' }, { COLDX_RELEASE_COMMIT: 'main' },
  ]) {
    const state = fixture();
    await assert.rejects(attach(state, overrides));
    assert.equal(state.calls.length, 0);
  }
});

test('ZIP parser accepts stored/deflated executables, with and without data descriptor', () => {
  assert.equal(typeof implementation.extractSingleInstaller, 'function');
  for (const method of [0, 8]) for (const descriptor of [false, true]) {
    const { archive, executable } = zipFixture({ method, descriptor });
    assert.deepEqual(implementation.extractSingleInstaller(archive, name), executable);
  }
});

for (const [label, make] of [
  ['nested path', () => zipFixture({ filename: `nested/${name}` }).archive],
  ['ZIP64 extra', () => zipFixture({ extra: Buffer.from([1, 0, 0, 0]) }).archive],
  ['symlink', () => { const f = zipFixture(); f.archive.writeUInt32LE(0xa0000000, f.centralOffset + 38); return f.archive; }],
  ['encrypted entry', () => { const f = zipFixture(); f.archive.writeUInt16LE(1, f.centralOffset + 8); return f.archive; }],
  ['extra entries', () => { const f = zipFixture(); f.archive.writeUInt16LE(2, f.archive.length - 12); return f.archive; }],
  ['bad CRC', () => { const f = zipFixture(); f.archive[30 + Buffer.byteLength(name) + 100]++; return f.archive; }],
  ['bad descriptor', () => { const f = zipFixture({ descriptor: true }); f.archive[f.centralOffset - 8]++; return f.archive; }],
  ['truncated archive', () => zipFixture().archive.subarray(0, 50)],
]) {
  test(`ZIP parser rejects ${label}`, () => {
    assert.equal(typeof implementation.extractSingleInstaller, 'function');
    assert.throws(() => implementation.extractSingleInstaller(make(), name));
  });
}
