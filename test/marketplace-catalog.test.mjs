import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMarketplaceCatalog } from '../plugin/marketplace-catalog.mjs';

const repo = { full_name: 'example/dsh-notes', name: 'dsh-notes', description: 'Notes', html_url: 'https://github.com/example/dsh-notes', default_branch: 'main', topics: ['dsh-plugin'], stargazers_count: 42, updated_at: '2026-09-12T00:00:00Z' };
const sha = 'a'.repeat(40);
const manifest = { name: 'dsh-notes', version: '1.2.3', description: 'Notes bundle', main: './lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } }, peerDependencies: { '@deepseek-ai/cordis': '^4.0.1' } };
const published = { ...manifest, repository: { url: 'git+https://github.com/example/dsh-notes.git' }, dist: { tarball: 'https://registry.npmjs.org/dsh-notes/-/dsh-notes-1.2.3.tgz', integrity: 'sha512-' + Buffer.alloc(64, 1).toString('base64') } };
const response = (value, status = 200, headers = {}) => new Response(typeof value === 'string' ? value : JSON.stringify(value), { status, headers });

function network(overrides = {}) {
  const calls = [];
  const routes = {
    '/repos/example/dsh-notes': repo,
    '/repos/example/dsh-notes/git/ref/heads/main': { object: { type: 'commit', sha } },
    [`/example/dsh-notes/${sha}/package.json`]: manifest,
    [`/example/dsh-notes/${sha}/cordis.patch.yml`]: '- insert:\n    - id: notes\n      name: dsh-notes\n',
    [`/example/dsh-notes/${sha}/README.md`]: '# Notes\nRead-only documentation.',
    '/dsh-notes/1.2.3': published,
    ...overrides,
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), headers: options?.headers });
    options?.signal?.throwIfAborted();
    const u = new URL(url); const value = routes[u.pathname];
    if (typeof value === 'function') return value(u, options);
    if (u.pathname === '/search/repositories' && value === undefined) return response({ total_count: 45, incomplete_results: false, items: [repo] });
    if (value === undefined) return response({ message: 'Not found' }, 404);
    return response(value);
  };
  return { fetchImpl, calls, routes };
}

test('search preserves topic scope, paginates metadata and does not validate every result', async () => {
  const net = network(); const catalog = createMarketplaceCatalog(net);
  const result = await catalog.search({ query: 'notes', page: 2 });
  assert.equal(result.items[0].id, 'example/dsh-notes');
  assert.equal(result.items[0].stars, 42); assert.equal(result.page, 2); assert.equal(result.hasMore, true);
  assert.equal(result.total, 45); assert.equal(net.calls.length, 1);
  const request = new URL(net.calls[0].url);
  assert.equal(request.searchParams.get('q'), 'topic:dsh-plugin "notes"');
  assert.equal(request.searchParams.get('page'), '2'); assert.equal(request.searchParams.get('per_page'), '20');
  const hostile = await catalog.search({ query: 'OR repo:other/site topic:other' });
  assert.ok(hostile.items.length); const q = new URL(net.calls[1].url).searchParams.get('q');
  assert.equal(q, 'topic:dsh-plugin "OR" "repo" "other" "site" "topic" "other"');
  await assert.rejects(catalog.search({ page: 51 }), /page|页/i);
});

test('search marks the GitHub 1000-result ceiling and incomplete results honestly', async () => {
  const net = network({ '/search/repositories': () => response({ total_count: 14636, incomplete_results: true, items: [repo] }) });
  const result = await createMarketplaceCatalog(net).search({ page: 50 });
  assert.equal(result.hasMore, false); assert.match(result.notice, /1000/); assert.match(result.notice, /完整|超时/);
});

test('search caches success and returns marked stale data during rate limit without retrying', async () => {
  const net = network(); const catalog = createMarketplaceCatalog(net);
  await catalog.search({}); await catalog.search({}); assert.equal(net.calls.length, 1);
  net.routes['/search/repositories'] = () => response({ message: 'rate limit' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60) });
  const stale = await catalog.search({ refresh: true });
  assert.equal(stale.stale, true); assert.equal(stale.items.length, 1); assert.match(stale.notice, /限流|请求次数/);
  await catalog.search({ refresh: true }); assert.equal(net.calls.length, 2);
});

test('ETag refresh reuses the body on HTTP 304', async () => {
  const net = network({ '/search/repositories': () => response({ total_count: 1, items: [repo] }, 200, { etag: '"first"' }) });
  const catalog = createMarketplaceCatalog(net); await catalog.search({});
  net.routes['/search/repositories'] = (_u, options) => { assert.equal(options.headers['If-None-Match'], '"first"'); return new Response(null, { status: 304 }); };
  const result = await catalog.search({ refresh: true }); assert.equal(result.stale, false); assert.equal(result.items[0].name, 'dsh-notes');
});

test('only matching exact published bundles produce an install target', async () => {
  const net = network(); const catalog = createMarketplaceCatalog(net);
  const detail = await catalog.detail({ id: repo.full_name });
  assert.equal(detail.packages.length, 1); assert.equal(detail.packages[0].kind, 'bundle'); assert.equal(detail.packages[0].installable, true);
  assert.equal(detail.readme, '# Notes\nRead-only documentation.');
  const result = await catalog.resolvePackage({ id: repo.full_name, packageId: 'dsh-notes' });
  assert.equal(result.packageId, 'dsh-notes'); assert.equal(result.version, '1.2.3'); assert.equal(result.installSpec, 'dsh-notes@1.2.3');
  assert.equal(result.distribution.integrity, published.dist.integrity); assert.deepEqual(result.manifest.dsh, manifest.dsh);
  await assert.rejects(catalog.resolvePackage({ id: repo.full_name, packageId: 'unrelated' }), /包|package/i);
});

for (const [name, patch, reason] of [
  ['repository mismatch', { repository: { url: 'git+https://github.com/other/notes.git' } }, /仓库|repository/i],
  ['version mismatch', { version: '1.2.4' }, /版本|version/i],
  ['missing bundle manifest', { dsh: {} }, /bundle|组合包/i],
  ['untrusted tarball origin', { dist: { ...published.dist, tarball: 'https://attacker.invalid/pkg.tgz' } }, /发行|tarball|registry/i],
  ['missing integrity', { dist: { tarball: published.dist.tarball } }, /完整性|integrity/i],
  ['deprecated package', { deprecated: 'No longer supported' }, /弃用|deprecated/i],
  ['incompatible native peer', { peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.0-rc.6' } }, /不兼容|incompatible/i],
  ['different native runtime dependency', { dependencies: { '@deepseek-ai/dsh-tools': '0.1.0-rc.6' } }, /不兼容|incompatible/i],
  ['unsafe patch path', { dsh: { bundle: { patch: '../outside.yml' } } }, /路径|patch/i],
]) test(`detail disables ${name} and resolver refuses it`, async () => {
  const net = network({ '/dsh-notes/1.2.3': { ...published, ...patch } }); const catalog = createMarketplaceCatalog(net);
  const detail = await catalog.detail({ id: repo.full_name }); assert.equal(detail.packages[0].installable, false); assert.match(detail.packages[0].reason, reason);
  await assert.rejects(catalog.resolvePackage({ id: repo.full_name, packageId: 'dsh-notes' }), reason);
});

test('GitHub-only and ordinary repositories remain viewable without an install action', async () => {
  for (const [override, expected] of [
    [{ '/dsh-notes/1.2.3': () => response({}, 404) }, /npm|发布/],
    [{ [`/example/dsh-notes/${sha}/package.json`]: { name: 'ordinary-app', version: '1.0.0' } }, /bundle|组合包/],
  ]) { const result = await createMarketplaceCatalog(network(override)).detail({ id: repo.full_name }); assert.equal(result.packages[0].installable, false); assert.match(result.packages[0].reason, expected); }
});

test('workspace manifests are limited to declared paths and cannot install a private monorepo root', async () => {
  const net = network({
    [`/example/dsh-notes/${sha}/package.json`]: { name: 'private-repo', private: true, workspaces: ['packages/*'] },
    [`/repos/example/dsh-notes/git/trees/${sha}`]: { tree: [{ path: 'packages/notes/package.json', type: 'blob' }, { path: 'unrelated/package.json', type: 'blob' }] },
    [`/example/dsh-notes/${sha}/packages/notes/package.json`]: manifest,
    [`/example/dsh-notes/${sha}/packages/notes/cordis.patch.yml`]: '- insert: []',
  });
  const detail = await createMarketplaceCatalog(net).detail({ id: repo.full_name });
  assert.deepEqual(detail.packages.map(p => p.id), ['dsh-notes']); assert.equal(detail.packages[0].manifestPath, 'packages/notes/package.json');
  assert.equal(detail.packages[0].installable, true); assert.ok(!net.calls.some(c => c.url.includes('/unrelated/')));
});

test('unbounded repo paths and archived repos cannot be resolved for installation', async () => {
  const net = network({ '/repos/example/dsh-notes': { ...repo, archived: true } }); const catalog = createMarketplaceCatalog(net);
  await assert.rejects(catalog.detail({ id: '../secrets' }), /仓库|repository/i);
  await assert.rejects(catalog.detail({ id: 'https://evil.invalid/repo' }), /仓库|repository/i);
  const detail = await catalog.detail({ id: repo.full_name }); assert.equal(detail.packages[0].installable, false); assert.match(detail.packages[0].reason, /归档|archived/i);
});

test('aborted operations never fall back to cached success', async () => {
  const net = network(); const catalog = createMarketplaceCatalog(net); await catalog.search({});
  const abort = new AbortController(); abort.abort();
  await assert.rejects(catalog.search({}, abort.signal), { name: 'AbortError' });
});

test('persistent cache lets an offline restart show explicitly stale discovery results', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'coldx-catalog-'));
  try {
    const catalog = createMarketplaceCatalog({ ...network(), cacheDir }); await catalog.search({}); await catalog.dispose();
    const offline = createMarketplaceCatalog({ cacheDir, fetchImpl: async () => { throw new Error('offline'); } });
    const result = await offline.search({ refresh: true }); assert.equal(result.items[0].id, repo.full_name); assert.equal(result.stale, true);
    await offline.dispose();
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});

test('simultaneous identical discovery reads share the completed cached response', async () => {
  const net = network(); const catalog = createMarketplaceCatalog(net);
  const results = await Promise.all([catalog.search({}), catalog.search({}), catalog.search({})]);
  assert.equal(results[2].items[0].id, repo.full_name); assert.equal(net.calls.length, 1);
});

test('native version detection works when package.json is deliberately not exported', async () => {
  const { nativePackageVersion } = await import('../plugin/marketplace-catalog.mjs');
  assert.equal(typeof nativePackageVersion, 'function');
  const root = await mkdtemp(join(tmpdir(), 'coldx-hidden-manifest-'));
  try {
    const dir = join(root, 'node_modules', '@deepseek-ai', 'dsh-fixture'); await mkdir(join(dir, 'dist'), { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-fixture', version: '0.1.1-rc.2', exports: { '.': './dist/index.js' } }));
    await writeFile(join(dir, 'dist', 'index.js'), 'throw new Error("Version detection must not execute plugin code");');
    const resolver = createRequire(join(root, 'entry.cjs'));
    assert.throws(() => resolver('@deepseek-ai/dsh-fixture/package.json'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    assert.equal(nativePackageVersion('@deepseek-ai/dsh-fixture', resolver), '0.1.1-rc.2');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('installation fails closed when registry verification is offline even with cached metadata', async () => {
  const net = network(); const catalog = createMarketplaceCatalog(net); await catalog.detail({ id: repo.full_name });
  net.routes['/dsh-notes/1.2.3'] = () => { throw new Error('offline'); };
  await assert.rejects(catalog.resolvePackage({ id: repo.full_name, packageId: 'dsh-notes' }), /offline/);
});

test('marketplace never offers to replace managed ColdX or native runtime packages', async () => {
  for (const name of ['coldx-client', 'coldx-distribution', '@deepseek-ai/dsh-tools']) {
    const result = await createMarketplaceCatalog(network({ [`/example/dsh-notes/${sha}/package.json`]: { ...manifest, name }, [`/${encodeURIComponent(name)}/1.2.3`]: { ...published, name } })).detail({ id: repo.full_name });
    assert.equal(result.packages[0].installable, false); assert.match(result.packages[0].reason, /受管理|原生运行时/);
  }
});

test('tokenized searches exceeding GitHub query length are rejected before requesting', async () => {
  const net = network();
  await assert.rejects(createMarketplaceCatalog(net).search({ query: ('a ').repeat(79) }), /过长/);
  assert.equal(net.calls.length, 0);
});
