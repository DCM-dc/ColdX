import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dshRequire } from './page-native.mjs';

const semver = dshRequire('semver');
const PAGE_SIZE = 20;
const MAX_PACKAGES = 12;
const MAX_BYTES = 3 * 1024 * 1024;
const SEARCH_TTL = 5 * 60_000;
const DETAIL_TTL = 60 * 60_000;
const CACHE_LIMIT = 120;
const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const REGISTRY = 'https://registry.npmjs.org';
const hosts = new Set([new URL(API).host, new URL(RAW).host, new URL(REGISTRY).host]);
const cleanText = (value, max = 600) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, max) : '';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validName = value => typeof value === 'string' && value.length <= 214 && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value);
const isNative = name => name === 'react' || name === '@deepseek-ai/cordis' || name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-');

export function nativePackageVersion(name, resolver = dshRequire) {
  try { return resolver(name + '/package.json').version; } catch { /* package.json may be excluded from exports. */ }
  try {
    let directory = dirname(resolver.resolve(name));
    for (let depth = 0; depth < 6; depth++) {
      try { const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')); if (manifest.name === name) return manifest.version; } catch { /* Look above nested lib/dist entries. */ }
      const parent = dirname(directory); if (parent === directory) break; directory = parent;
    }
  } catch { /* The native runtime does not provide this package. */ }
  return undefined;
}

function repoId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]{1,100}$/.test(value) || ['.', '..'].includes(value.split('/')[1])) throw new Error('无效的 GitHub 仓库标识。');
  return value;
}
function packagePath(value) {
  if (typeof value !== 'string' || value.length > 240 || /[\\:\u0000-\u001f?#%]/.test(value)) return undefined;
  const path = value.replace(/^\.\//, '');
  if (!path || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) return undefined;
  return path;
}
function githubRepository(value) {
  let url = typeof value === 'string' ? value : value?.url;
  if (typeof url !== 'string') return undefined;
  if (url.startsWith('github:')) url = 'https://github.com/' + url.slice(7);
  url = url.replace(/^git\+/, '').replace(/^git@github\.com:/, 'https://github.com/');
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'github.com' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.port) return undefined;
    return repoId(parsed.pathname.replace(/^\//, '').replace(/\.git\/?$/, '').replace(/\/$/, '')).toLowerCase();
  } catch { return undefined; }
}
function repository(data, expected) {
  if (!object(data)) throw new Error('GitHub 仓库信息不可用。');
  const id = repoId(data.full_name ?? expected);
  return { id, name: cleanText(data.name || id.split('/')[1], 100), description: cleanText(data.description), url: 'https://github.com/' + id,
    stars: Number.isSafeInteger(data.stargazers_count) ? Math.max(0, data.stargazers_count) : 0, updatedAt: cleanText(data.updated_at, 40),
    archived: data.archived === true, defaultBranch: cleanText(data.default_branch, 240), topics: Array.isArray(data.topics) ? data.topics.filter(x => typeof x === 'string').slice(0, 30) : [] };
}
function compatibility(manifest) {
  const reasons = [];
  if (manifest.engines?.node && (!semver.validRange(manifest.engines.node) || !semver.satisfies(process.versions.node, manifest.engines.node))) reasons.push('Node 版本不兼容：需要 ' + cleanText(manifest.engines.node, 100) + '。');
  if (manifest.dsh?.client?.platform && manifest.dsh.client.platform !== 'web') reasons.push('插件客户端平台不是 Web，无法在 ColdX 中启用。');
  for (const section of ['peerDependencies', 'dependencies', 'optionalDependencies']) {
    for (const [name, range] of Object.entries(object(manifest[section]) ? manifest[section] : {})) {
      if (!isNative(name)) continue;
      const actual = nativePackageVersion(name);
      if (!actual && (section === 'optionalDependencies' || manifest.peerDependenciesMeta?.[name]?.optional)) continue;
      if (!actual) { reasons.push('当前 DSH 未提供依赖 ' + name + '，兼容性未确认。'); continue; }
      if (typeof range !== 'string' || !semver.validRange(range) || !semver.satisfies(actual, range)) reasons.push('与当前原生运行时不兼容：' + name + ' ' + actual + ' 不满足 ' + cleanText(range, 100) + '。');
    }
  }
  return reasons;
}
function selectedManifest(manifest) {
  return Object.fromEntries(['name', 'version', 'description', 'main', 'exports', 'dsh', 'engines', 'peerDependencies', 'peerDependenciesMeta', 'dependencies', 'optionalDependencies', 'scripts', 'repository'].filter(key => manifest[key] !== undefined).map(key => [key, manifest[key]]));
}

// Discovery reads only metadata. Installing and activating code belongs to the native installer.
export function createMarketplaceCatalog({ fetchImpl = fetch, cacheDir } = {}) {
  const cache = new Map();
  const blocked = new Map();
  const lifetime = new AbortController();
  let writeChain = Promise.resolve();
  let queue = Promise.resolve();
  const ready = (async () => {
    if (!cacheDir) return;
    try {
      const content = await readFile(join(cacheDir, 'catalog-v1.json'), 'utf8');
      if (content.length > 8 * MAX_BYTES) return;
      const data = JSON.parse(content);
      if (data.version !== 1 || !Array.isArray(data.entries)) return;
      for (const [key, row] of data.entries.slice(-CACHE_LIMIT)) {
        if (!object(row) || typeof key !== 'string' || !Number.isFinite(row.time) || ![200, 404].includes(row.status)) continue;
        try { if (hosts.has(new URL(key).host)) cache.set(key, { ...row, disk: true }); } catch { /* Ignore corrupt cache entries. */ }
      }
    } catch { /* No cache or interrupted prior write is a cache miss. */ }
  })();
  function persist() {
    if (!cacheDir) return;
    const content = JSON.stringify({ version: 1, entries: [...cache].slice(-CACHE_LIMIT) });
    if (content.length > 8 * MAX_BYTES) return;
    writeChain = writeChain.then(async () => {
      await mkdir(cacheDir, { recursive: true });
      const temp = join(cacheDir, 'catalog-' + randomUUID() + '.tmp');
      await writeFile(temp, content, 'utf8'); await rename(temp, join(cacheDir, 'catalog-v1.json'));
    }).catch(() => {});
  }
  const signalFor = signal => signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
  function note(context, message) { if (!context.notices.includes(message)) context.notices.push(message); }
  async function limitedBody(response, signal) {
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('目录响应过大，已停止读取。');
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks = []; let length = 0;
    try {
      while (true) {
        signal.throwIfAborted(); const { done, value } = await reader.read(); if (done) break;
        length += value.byteLength; if (length > MAX_BYTES) throw new Error('目录响应过大，已停止读取。');
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally { await reader.cancel().catch(() => {}); }
  }
  async function read(url, { context, signal, json = true, ttl = DETAIL_TTL, refresh = false, strict = false } = {}) {
    await ready; signal.throwIfAborted();
    const prior = cache.get(url);
    if (!refresh && !strict && prior && Date.now() - prior.time < ttl) return prior.status === 404 ? null : structuredClone(prior.value);
    const parsed = new URL(url);
    const bucket = parsed.host === 'api.github.com' ? (parsed.pathname.startsWith('/search/') ? 'search' : 'core') : parsed.host;
    const staleOrThrow = error => {
      signal.throwIfAborted();
      if (!strict && prior?.status === 200) { context.stale = true; note(context, error.message + ' 正在显示上次获取的目录。'); return structuredClone(prior.value); }
      throw error;
    };
    if ((blocked.get(bucket) ?? 0) > Date.now()) return staleOrThrow(new Error('GitHub 请求次数受限，请稍后再试。'));
    const run = async () => {
      signal.throwIfAborted();
      if ((blocked.get(bucket) ?? 0) > Date.now()) throw new Error('GitHub 请求次数受限，请稍后再试。');
      // Another queued caller may have populated the same cache entry while this call waited.
      const current = cache.get(url);
      if (!refresh && !strict && current && Date.now() - current.time < ttl) return current.status === 404 ? null : structuredClone(current.value);
      const headers = { Accept: json ? 'application/json' : 'text/plain', 'User-Agent': 'ColdX-Plugin-Catalog' };
      if (parsed.host === 'api.github.com') { headers.Accept = 'application/vnd.github+json'; headers['X-GitHub-Api-Version'] = '2022-11-28'; }
      if (prior?.etag && !(strict && prior.disk)) headers['If-None-Match'] = prior.etag;
      const timeout = AbortSignal.timeout(15_000);
      const combined = AbortSignal.any([signal, timeout]);
      // No arbitrary origins or credential forwarding from repository metadata.
      const response = await fetchImpl(url, { headers, signal: combined, redirect: 'error' });
      if (response.status === 304 && prior) { prior.time = Date.now(); prior.disk = false; persist(); return prior.status === 404 ? null : structuredClone(prior.value); }
      if (response.status === 403 || response.status === 429) {
        const retry = Number(response.headers.get('retry-after'));
        const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
        blocked.set(bucket, Math.max(Date.now() + (Number.isFinite(retry) && retry > 0 ? retry * 1000 : 60_000), Number.isFinite(reset) ? reset : 0));
        throw new Error('GitHub 请求次数受限，请稍后再试。');
      }
      if (!response.ok && response.status !== 404) throw new Error('目录服务暂不可用（HTTP ' + response.status + '）。');
      const body = response.status === 404 ? '' : await limitedBody(response, combined);
      let value = null;
      if (response.status !== 404) {
        try { value = json ? JSON.parse(body) : body; } catch { throw new Error('目录服务返回了无效数据。'); }
      }
      cache.delete(url); cache.set(url, { value, status: response.status, time: Date.now(), etag: response.headers.get('etag') });
      while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
      persist(); return structuredClone(value);
    };
    // Keep GitHub metadata requests serial; a caller's cancellation does not cancel other callers.
    const result = queue.then(run); queue = result.catch(() => {});
    try { return await result; } catch (error) { return staleOrThrow(error instanceof Error ? error : new Error('目录服务暂不可用。')); }
  }

  async function search(request = {}, signal) {
    const active = signalFor(signal); active.throwIfAborted();
    const { query = '', page = 1, refresh = false } = request ?? {};
    if (typeof query !== 'string' || query.length > 160 || !Number.isSafeInteger(page) || page < 1 || page > 50) throw new Error('无效的目录搜索词或页码 page（1–50）。');
    const words = query.match(/[\p{L}\p{N}_.-]+/gu) ?? [];
    const q = ['topic:dsh-plugin', ...words.map(word => '"' + word + '"')].join(' ');
    if (q.length > 256) throw new Error('搜索词过长，请使用简短的插件名称或能力关键词。');
    const params = new URLSearchParams({ q, sort: 'stars', order: 'desc', per_page: String(PAGE_SIZE), page: String(page) });
    const context = { stale: false, notices: [] };
    const data = await read(API + '/search/repositories?' + params, { context, signal: active, ttl: SEARCH_TTL, refresh });
    if (!object(data) || !Array.isArray(data.items)) throw new Error('GitHub 搜索结果不可用。');
    const items = [];
    for (const item of data.items.slice(0, PAGE_SIZE)) { try { items.push(repository(item)); } catch { /* A malformed entry is not a plugin. */ } }
    const total = Number.isSafeInteger(data.total_count) ? data.total_count : undefined;
    if (total > 1000) note(context, 'GitHub 单次搜索最多返回 1000 个结果；可缩小搜索词继续查找。');
    if (data.incomplete_results === true) note(context, 'GitHub 搜索超时，当前结果可能不完整。');
    return { items, page, hasMore: page < 50 && (total === undefined ? items.length === PAGE_SIZE : page * PAGE_SIZE < total), ...(total !== undefined ? { total } : {}), stale: context.stale, ...(context.notices.length ? { notice: context.notices.join(' ') } : {}) };
  }

  async function getDetail(request, signal, strict = false) {
    const id = repoId(request?.id); const active = signalFor(signal); active.throwIfAborted();
    const context = { stale: false, notices: [] };
    const options = { context, signal: active, strict, refresh: strict || request?.refresh === true };
    const data = await read(API + '/repos/' + id, options);
    if (!data) throw new Error('找不到公开的 GitHub 仓库。');
    const repo = repository(data, id);
    if (!repo.topics.includes('dsh-plugin')) note(context, '此仓库未声明 dsh-plugin topic，不能从市场安装。');
    const ref = await read(API + '/repos/' + repo.id + '/git/ref/heads/' + encodeURIComponent(repo.defaultBranch), options);
    const commit = ref?.object?.type === 'commit' && /^[a-f0-9]{40}$/i.test(ref.object.sha) ? ref.object.sha : undefined;
    if (!commit) return { ...repo, packages: [], notice: '无法确定仓库的固定版本，暂不能验证安装包。' };
    const raw = path => RAW + '/' + repo.id + '/' + commit + '/' + path.split('/').map(encodeURIComponent).join('/');
    const rootManifest = await read(raw('package.json'), options);
    const candidates = [];
    if (object(rootManifest) && !rootManifest.private) candidates.push({ manifest: rootManifest, path: 'package.json' });
    const patterns = Array.isArray(rootManifest?.workspaces) ? rootManifest.workspaces : rootManifest?.workspaces?.packages;
    if (Array.isArray(patterns) && patterns.length) {
      const matches = [];
      for (const pattern of patterns.slice(0, 20)) {
        if (typeof pattern !== 'string' || !packagePath(pattern) || pattern.includes('**') || pattern.startsWith('!')) { note(context, '部分 workspace 通配路径暂不支持，目录仅显示已验证包。'); continue; }
        matches.push(new RegExp('^' + pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+') + '/package\\.json$'));
      }
      if (matches.length) {
        const tree = await read(API + '/repos/' + repo.id + '/git/trees/' + commit + '?recursive=1', options);
        if (tree?.truncated) note(context, '仓库文件树不完整，仅显示已发现的 workspace 包。');
        const paths = (Array.isArray(tree?.tree) ? tree.tree : []).filter(row => row.type === 'blob' && packagePath(row.path) && matches.some(pattern => pattern.test(row.path))).map(row => row.path).sort();
        if (paths.length > MAX_PACKAGES) note(context, '此仓库含多个包，本次仅验证前 ' + MAX_PACKAGES + ' 个。');
        for (const path of paths.slice(0, MAX_PACKAGES)) { const manifest = await read(raw(path), options); if (object(manifest) && !manifest.private) candidates.push({ manifest, path }); }
      }
    }
    if (!candidates.length) note(context, '未找到可验证的 npm package.json；技能目录或普通项目不会自动视为 DSH 组合包。');
    const packages = []; const targets = new Map(); const names = new Set();
    for (const { manifest, path } of candidates.slice(0, MAX_PACKAGES)) {
      const name = cleanText(manifest.name, 214);
      const version = cleanText(manifest.version, 100);
      const bundle = manifest.dsh?.bundle;
      const item = { id: validName(name) ? name : path, name: name || path, version, description: cleanText(manifest.description), sourceUrl: repo.url + '/blob/' + commit + '/' + path,
        manifestPath: path, kind: bundle ? 'bundle' : manifest.dsh?.client ? 'plugin' : 'unknown', installable: false };
      const reasons = [];
      if (!validName(name) || !semver.valid(version) || semver.valid(version) !== version) reasons.push('包名或精确版本无效。');
      if (name.startsWith('@deepseek-ai/') || ['coldx-client', 'coldx-distribution'].includes(name)) reasons.push('此包属于受管理的 ColdX 或原生运行时，不能通过插件市场替换。');
      if (!bundle) reasons.push('未声明 dsh.bundle.patch，无法作为组合包自动启用。');
      const patch = packagePath(bundle?.patch);
      if (bundle && !patch) reasons.push('组合包 patch 路径无效。');
      if (repo.archived) reasons.push('仓库已经归档。');
      if (!repo.topics.includes('dsh-plugin')) reasons.push('仓库未声明 dsh-plugin topic。');
      if (names.has(name)) reasons.push('仓库内存在同名 package，无法唯一确定安装入口。');
      names.add(name);
      if (!reasons.length) {
        try {
          const published = await read(REGISTRY + '/' + encodeURIComponent(name) + '/' + encodeURIComponent(version), options);
          if (!published) reasons.push('此精确版本未发布到 npm；本轮仅支持 npm 发行包的一键安装。');
          else {
            if (published.name !== name || published.version !== version) reasons.push('npm 包名或版本与仓库 manifest 不一致。');
            if (githubRepository(published.repository) !== repo.id.toLowerCase()) reasons.push('npm 包的来源仓库不匹配或尚未声明。');
            const publishedPatch = packagePath(published.dsh?.bundle?.patch);
            if (!published.dsh?.bundle) reasons.push('npm 发行版未声明 dsh.bundle 组合包。');
            else if (!publishedPatch || publishedPatch !== patch) reasons.push('npm 发行版 patch 路径与仓库声明不一致。');
            if (published.private || published.deprecated) reasons.push('npm 发行包已标记私有或弃用。');
            if (published.main && !packagePath(published.main)) reasons.push('npm 包入口路径无效。');
            let tarball;
            try { tarball = new URL(published.dist?.tarball); } catch { /* Invalid distribution has no install target. */ }
            if (!tarball || tarball.protocol !== 'https:' || tarball.hostname !== 'registry.npmjs.org' || tarball.username || tarball.password || tarball.port || tarball.search || tarball.hash || !tarball.pathname.endsWith('.tgz')) reasons.push('npm 发行 tarball 来源无效。');
            const integrity = published.dist?.integrity;
            if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) reasons.push('npm 发行版缺少可验证的完整性 integrity。');
            reasons.push(...compatibility(published));
            if (!reasons.length) {
              const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
              const patchContent = await read(raw(directory + patch), { ...options, json: false });
              if (typeof patchContent !== 'string' || !patchContent.trim()) reasons.push('仓库中未找到声明的组合包 patch 文件。');
            }
            if (!reasons.length) targets.set(item.id, { id: repo.id, repoId: repo.id, packageId: name, version, installSpec: name + '@' + version, repositoryUrl: repo.url,
              sourceUrl: item.sourceUrl, manifestPath: path, kind: 'bundle', compatibility: 'declared-compatible', commit, verifiedAt: new Date().toISOString(),
              distribution: { tarball: tarball.href, integrity }, manifest: selectedManifest(published) });
          }
        } catch (error) { active.throwIfAborted(); reasons.push(cleanText(error.message) || '无法验证 npm 发行版。'); }
      }
      if (reasons.length) item.reason = reasons.join(' ');
      item.installable = reasons.length === 0;
      item.compatibility = item.installable ? 'declared-compatible' : reasons.some(reason => /不兼容/.test(reason)) ? 'incompatible' : 'unknown';
      packages.push(item);
    }
    // Same-name workspaces are ambiguous even if the first one looked valid.
    for (const item of packages) if (packages.filter(other => other.id === item.id).length > 1) { item.installable = false; item.reason = '仓库内存在同名 package，无法唯一确定安装入口。'; targets.delete(item.id); }
    let readme;
    if (!strict) {
      try { const text = await read(raw('README.md'), { ...options, json: false }); if (typeof text === 'string') readme = cleanText(text, 24_000); }
      catch (error) { active.throwIfAborted(); note(context, 'README 暂不可用。'); }
    }
    note(context, '验证仅确认发行元数据与声明兼容性；实际加载状态以安装后的原生运行结果为准。');
    if (context.stale) for (const item of packages) { item.installable = false; item.reason = '当前为缓存目录，联网重新验证后才能安装。'; }
    const detail = { ...repo, commit, packages, ...(readme ? { readme } : {}), stale: context.stale, notice: context.notices.join(' ') };
    return { ...detail, _targets: targets };
  }
  async function detail(request, signal) { const { _targets, ...result } = await getDetail(request, signal); return result; }
  async function resolvePackage(request, signal) {
    if (!validName(request?.packageId)) throw new Error('无效的 npm 包名。');
    const result = await getDetail({ id: request?.id, refresh: true }, signal, true);
    const item = result.packages.find(row => row.id === request.packageId);
    if (!item?.installable || !result._targets?.has(request.packageId)) throw new Error(item?.reason || '仓库内未找到可安装的对应包。');
    return structuredClone(result._targets.get(request.packageId));
  }
  async function dispose() { lifetime.abort(); await queue; await ready; await writeChain; }
  return { search, detail, resolvePackage, dispose };
}
