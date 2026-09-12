import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, readFile, writeFile, readdir, rename, utimes } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join, parse, dirname, sep } from 'node:path';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const PLANS = [
  { id: 'project', label: '按项目', description: '把同一件事的文档、图片与数据放在一起。' },
  { id: 'type', label: '按文件类型', description: '文档、数据和图片各归其位。' },
  { id: 'time', label: '按时间', description: '按样例文件的真实修改月份归档。' },
  { id: 'mixed', label: '混合整理', description: '先分项目，再区分内容类型。', recommended: true },
];
const SAMPLES = [
  ['极光-需求.md', '极光计划', '文档', '2026-09-02', '# 极光计划\n这是人工样例：一款帮助人们记录灵感的小应用。\n'],
  ['极光-里程碑.md', '极光计划', '文档', '2026-08-19', '# 里程碑\n- 草图\n- 原型\n- 验证\n'],
  ['极光-预算.csv', '极光计划', '数据', '2026-09-01', '项目,预算\n设计,1200\n制作,800\n'],
  ['极光-封面.svg', '极光计划', '图片', '2026-08-23', '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300"><rect width="480" height="300" rx="32" fill="#c4e5ec"/><circle cx="300" cy="120" r="72" fill="#729da9"/></svg>'],
  ['山间-行程.md', '山间旅行', '文档', '2026-07-12', '# 山间旅行\n人工样例：步行、野餐、看日落。\n'],
  ['山间-清单.json', '山间旅行', '数据', '2026-08-02', '{"items":["水壶","外套","相机"],"sample":true}\n'],
  ['山间-路线.svg', '山间旅行', '图片', '2026-07-15', '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300"><rect width="480" height="300" rx="32" fill="#e5e8dc"/><path d="M30 260L170 70L300 240L390 100L470 260" fill="none" stroke="#758b69" stroke-width="18"/></svg>'],
  ['山间-花费.csv', '山间旅行', '数据', '2026-08-04', '项目,金额\n交通,80\n餐食,45\n'],
  ['日常-读书.md', '日常记录', '文档', '2026-09-03', '# 读书笔记\n人工样例：留意细节，让复杂事情变简单。\n'],
  ['日常-灵感.md', '日常记录', '文档', '2026-08-30', '# 灵感\n一块冰的形状，一段轻快的交互。\n'],
  ['日常-习惯.csv', '日常记录', '数据', '2026-07-24', '习惯,次数\n散步,4\n阅读,3\n'],
  ['日常-色卡.svg', '日常记录', '图片', '2026-09-04', '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300"><rect width="480" height="300" rx="32" fill="#f1e2d4"/><circle cx="150" cy="150" r="65" fill="#afcbd5"/><circle cx="320" cy="150" r="65" fill="#a1b39a"/></svg>'],
].map(([name, project, type, date, content], index) => ({ id: `file-${String(index + 1).padStart(2, '0')}`, name, project, type, modifiedAt: `${date}T12:00:00.000Z`, content, hash: hash(Buffer.from(content)) }));

function token(value, label, pattern = /^[A-Za-z0-9_-]{1,128}$/) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Invalid ${label}.`);
  return value;
}
function owner(value) {
  if (typeof value !== 'string' || !value || value.length > 512) throw new Error('Invalid owner.');
  return value;
}
function groupName(value) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > 48
    || /[<>:"/\\|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value)
    || /^(?:\.{1,2}|con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i.test(value)) throw new Error('Invalid group name.');
  return value;
}
function under(root, target) {
  const path = resolve(target), rel = relative(root, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Path escapes the lab root.');
  return path;
}
async function noLinks(target) {
  const absolute = resolve(target), root = parse(absolute).root;
  let cursor = root;
  for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    let info;
    try { info = await lstat(cursor); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (info.isSymbolicLink()) throw new Error('Symbolic links are not allowed in the lab path.');
  }
}
async function checked(root, target) { const path = under(root, target); await noLinks(path); return path; }
async function directory(root, target) { const path = await checked(root, target); await mkdir(path, { recursive: true }); await checked(root, path); return path; }
async function jsonFile(root, path) { return JSON.parse(await readFile(await checked(root, path), 'utf8')); }
const abort = signal => signal?.throwIfAborted();

/** File-only production capability. Every accepted path is Host-derived. */
export function createLabFiles({ labRoot, outputRoot }) {
  if (!isAbsolute(labRoot) || !isAbsolute(outputRoot)) throw new Error('Lab roots must be absolute.');
  labRoot = resolve(labRoot); outputRoot = resolve(outputRoot);
  if (labRoot === outputRoot) throw new Error('Source and output lab roots must differ.');
  const queues = new Map();
  function serial(key, job) {
    const operation = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(job);
    queues.set(key, operation);
    void operation.finally(() => { if (queues.get(key) === operation) queues.delete(key); }).catch(() => {});
    return operation;
  }
  async function readRun(ownerId, runId, signal) {
    owner(ownerId); token(runId, 'run ID', /^lab-[a-f0-9]{24}$/); abort(signal);
    const root = under(labRoot, join(labRoot, runId));
    const saved = await jsonFile(labRoot, join(root, 'run.json'));
    if (saved.ownerId !== ownerId || saved.runId !== runId) throw new Error('This lab run belongs to another owner.');
    const files = [];
    for (const sample of SAMPLES) {
      abort(signal);
      const path = await checked(labRoot, join(root, 'source', sample.name));
      const info = await lstat(path);
      if (!info.isFile() || info.nlink !== 1) throw new Error('Sample must be a regular unlinked file.');
      const bytes = await readFile(path);
      if (hash(bytes) !== sample.hash) throw new Error('Sample content hash changed; modified source cannot be applied.');
      files.push({ id: sample.id, name: sample.name, path, project: sample.project, type: sample.type, modifiedAt: info.mtime.toISOString(), bytes: bytes.length, hash: sample.hash });
    }
    return { runId, sourcePath: join(root, 'source'), files };
  }
  function preview(files, planId, overrides = {}) {
    const plan = PLANS.find(p => p.id === planId);
    if (!plan) throw new Error('Unknown organization plan.');
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('Overrides must be a file-to-group object.');
    for (const [id, group] of Object.entries(overrides)) {
      if (!files.some(f => f.id === id)) throw new Error('Unknown file ID in overrides.');
      groupName(group);
    }
    const entries = files.map(file => {
      const group = Object.hasOwn(overrides, file.id) ? overrides[file.id]
        : planId === 'project' ? file.project : planId === 'type' ? file.type
          : planId === 'time' ? file.modifiedAt.slice(0, 7) : `${file.project}/${file.type}`;
      return { fileId: file.id, name: file.name, sourcePath: file.path, group, targetRelativePath: `${group}/${file.name}`, bytes: file.bytes, hash: file.hash };
    });
    const groups = [...new Set(entries.map(f => f.group))].map(group => ({ id: group, label: group, count: entries.filter(f => f.group === group).length }));
    return { ...plan, fileCount: files.length, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), groups, entries };
  }
  async function verifiedVersion(run, versionPath, signal) {
    const manifestPath = join(versionPath, 'manifest.json');
    const manifest = await jsonFile(outputRoot, manifestPath);
    if (manifest.runId !== run.runId || manifest.files?.length !== SAMPLES.length) throw new Error('Invalid output manifest.');
    const files = [];
    for (const source of run.files) {
      abort(signal);
      const entry = manifest.files.find(f => f.id === source.id);
      if (!entry || typeof entry.relativePath !== 'string') throw new Error('Missing file in output manifest.');
      const path = under(versionPath, join(versionPath, entry.relativePath));
      await checked(outputRoot, path);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.nlink !== 1 || hash(await readFile(path)) !== source.hash) throw new Error('Output hash verification failed.');
      files.push({ id: source.id, name: source.name, relativePath: entry.relativePath, path, bytes: source.bytes, hash: source.hash });
    }
    return { runId: run.runId, requestId: manifest.requestId, versionId: manifest.versionId, planId: manifest.planId, overrides: manifest.overrides, createdAt: manifest.createdAt, outputPath: versionPath, manifestPath, files, verified: true };
  }
  async function inspect({ ownerId, runId, signal }) {
    const run = await readRun(ownerId, runId, signal);
    const parent = await checked(outputRoot, join(outputRoot, runId));
    const names = await readdir(parent).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    const versions = [];
    for (const name of names.filter(name => /^v-[a-f0-9]{24}$/.test(name))) versions.push(await verifiedVersion(run, join(parent, name), signal));
    versions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { ...run, sample: true, plans: PLANS.map(plan => preview(run.files, plan.id)), versions };
  }
  async function create({ ownerId, requestId, signal }) {
    owner(ownerId); token(requestId, 'request ID'); abort(signal);
    const runId = `lab-${hash(`${ownerId}\0${requestId}`).slice(0, 24)}`;
    return serial(runId, async () => {
      abort(signal);
      const source = await directory(labRoot, join(labRoot, runId, 'source'));
      for (const sample of SAMPLES) {
        abort(signal);
        const path = await checked(labRoot, join(source, sample.name));
        try { await writeFile(path, sample.content, { flag: 'wx' }); await utimes(path, new Date(sample.modifiedAt), new Date(sample.modifiedAt)); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      abort(signal);
      const path = await checked(labRoot, join(labRoot, runId, 'run.json'));
      try { await writeFile(path, JSON.stringify({ runId, ownerId, sample: true }), { flag: 'wx' }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      return inspect({ ownerId, runId, signal });
    });
  }
  async function apply({ ownerId, runId, requestId, planId, overrides = {}, signal }) {
    owner(ownerId); token(requestId, 'request ID'); token(runId, 'run ID', /^lab-[a-f0-9]{24}$/); abort(signal);
    return serial(runId, async () => {
      const run = await readRun(ownerId, runId, signal);
      const plan = preview(run.files, planId, overrides);
      const normalizedOverrides = Object.fromEntries(Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b)));
      const versionId = `v-${hash(requestId).slice(0, 24)}`;
      const versionPath = await checked(outputRoot, join(outputRoot, runId, versionId));
      try {
        await lstat(versionPath);
        const existing = await verifiedVersion(run, versionPath, signal);
        if (existing.requestId !== requestId || existing.planId !== planId || JSON.stringify(existing.overrides) !== JSON.stringify(normalizedOverrides)) throw new Error('The request ID already belongs to another operation.');
        return existing;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      abort(signal);
      const parent = await directory(outputRoot, join(outputRoot, runId));
      const staging = await directory(outputRoot, join(parent, `.pending-${randomUUID()}`));
      for (const entry of plan.entries) {
        abort(signal);
        const source = await checked(labRoot, entry.sourcePath);
        const bytes = await readFile(source);
        if (hash(bytes) !== entry.hash) throw new Error('Source hash changed during apply.');
        const target = under(staging, join(staging, entry.targetRelativePath));
        await directory(outputRoot, dirname(target));
        await writeFile(await checked(outputRoot, target), bytes, { flag: 'wx' });
        if (hash(await readFile(await checked(outputRoot, target))) !== entry.hash) throw new Error('Output hash verification failed.');
      }
      const manifest = { runId, versionId, requestId, planId, overrides: normalizedOverrides, createdAt: new Date().toISOString(), files: plan.entries.map(entry => ({ id: entry.fileId, relativePath: entry.targetRelativePath, hash: entry.hash })) };
      await writeFile(await checked(outputRoot, join(staging, 'manifest.json')), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
      abort(signal);
      await checked(outputRoot, staging); await checked(outputRoot, versionPath);
      // Atomic publication on the output volume; an interrupted .pending
      // directory is never reported as a successful version and is not resumed.
      await rename(staging, versionPath);
      return verifiedVersion(run, versionPath);
    });
  }
  return Object.freeze({ create, inspect, apply });
}
