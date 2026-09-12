import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, writeFile, rename, realpath, mkdir, lstat, readlink, symlink } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { dshRequire, nativeImport } from './page-native.mjs';

const semver = dshRequire('semver');
const { initProfile, loadOverlayPatches } = await nativeImport('@deepseek-ai/dsh-app-boot');
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const managedNames = ['coldx-client', 'coldx-distribution'];
const failure = (code, message) => Object.assign(new Error(message), { code });
const aborted = signal => { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('安装已取消', 'AbortError'); };
const progress = (listener, phase, message) => { try { listener?.({ phase, message }); } catch {} };
async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
function contained(root, path) {
  const part = relative(root, path);
  if (isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`)) throw failure('invalid-package', '插件路径无效。');
  return path;
}

function metadata(meta) {
  const { packageId, version, manifest } = meta ?? {};
  if (typeof packageId !== 'string' || !PACKAGE.test(packageId) || packageId.length > 214 || packageId.startsWith('@deepseek-ai/') || managedNames.includes(packageId)) throw failure('invalid-package', '请选择目录中已核验的扩展包。');
  if (typeof version !== 'string' || semver.valid(version) !== version) throw failure('invalid-package', '插件需要确定的版本号。');
  if (manifest?.name !== packageId || manifest?.version !== version || typeof manifest?.dsh?.bundle?.patch !== 'string') throw failure('invalid-package', '插件缺少已核验的原生 bundle 声明。');
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (!name.startsWith('@deepseek-ai/')) continue;
    let installed;
    try { installed = dshRequire(`${name}/package.json`).version; }
    catch {
      // Some pinned packages deliberately do not export package.json.
      try { installed = dshRequire(join(dirname(dshRequire.resolve(name)), '..', 'package.json')).version; }
      catch { if (manifest.peerDependenciesMeta?.[name]?.optional) continue; throw failure('incompatible', `当前 DSH 不提供插件所需的 ${name}。`); }
    }
    if (!semver.satisfies(installed, range)) throw failure('incompatible', `${name} 与插件声明的版本范围不兼容。`);
  }
  if (manifest.engines?.node && !semver.satisfies(process.versions.node, manifest.engines.node)) throw failure('incompatible', '插件需要不同版本的 Node.js。');
  return { packageId, version };
}

/** Execute the shipped CLI in a separate child: never block the Host event loop. */
export function runMarketplaceCommand(command, args, { cwd, env, signal, timeoutMs = 300_000 } = {}) {
  aborted(signal);
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, env, stdio:['ignore','pipe','pipe'], windowsHide:true, shell:false, detached:process.platform !== 'win32' });
    // Drain both pipes without retaining npm output, which can contain credential-bearing registry URLs.
    child.stdout?.resume(); child.stderr?.resume();
    let cancellation, timer, settled = false;
    const stop = () => {
      if (!child.pid || settled) return;
      if (process.platform === 'win32') {
        const kill = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio:'ignore', windowsHide:true, shell:false });
        kill.on('error', () => child.kill());
      } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const cancel = () => { cancellation = signal.reason instanceof Error ? signal.reason : new DOMException('安装已取消', 'AbortError'); stop(); };
    signal?.addEventListener('abort', cancel, { once:true });
    if (signal?.aborted) cancel();
    timer = setTimeout(() => { cancellation = failure('install-timeout', '插件安装超时，请检查网络后重试。'); stop(); }, timeoutMs);
    const done = (error, exitCode) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      if (cancellation || error) reject(cancellation ?? error); else resolveResult({ exitCode:exitCode ?? 1 });
    };
    child.once('error', error => done(error));
    child.once('close', code => done(undefined, code));
  });
}

async function rememberManagedLinks(profileDir, manifest) {
  const saved = [];
  for (const name of new Set([...managedNames, ...(manifest.dsh?.profile?.bundles ?? [])])) {
    if (!PACKAGE.test(name)) continue;
    const path = join(profileDir, 'node_modules', name);
    try { if ((await lstat(path)).isSymbolicLink()) saved.push({ path, target:await readlink(path) }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return saved;
}
async function restoreManagedLinks(saved) {
  for (const { path, target } of saved) {
    try { await lstat(path); continue; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(dirname(path), { recursive:true });
    await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');
  }
}
function insertedEntries(patches) {
  return patches.flatMap(patch => (Array.isArray(patch.insert) ? patch.insert : [])).filter(row => typeof row?.id === 'string' && typeof row?.name === 'string');
}

async function packageRoot(resolver, name) {
  for (const search of resolver.resolve.paths(name) ?? []) {
    const path=join(search,name);
    try { if ((await json(join(path,'package.json'))).name===name) return realpath(path); }
    catch (error) { if(error.code!=='ENOENT' && error.code!=='ENOTDIR') throw error; }
  }
}

/** Verify actual module identity, not only a compatible range in registry metadata. */
async function validateRuntimeDependencies(packageDir) {
  const queue=[packageDir],seen=new Set();
  while(queue.length) {
    const root=await realpath(queue.shift());if(seen.has(root))continue;seen.add(root);
    if(seen.size>256)throw failure('dependency-limit','插件依赖图过大，无法完成本次运行时兼容性校验。');
    const manifest=await json(join(root,'package.json')),resolver=createRequire(join(root,'package.json'));
    for(const section of ['dependencies','optionalDependencies','peerDependencies']) {
      for(const name of Object.keys(manifest[section]??{})) {
        if(!PACKAGE.test(name))throw failure('invalid-dependency','插件包含无法核验的依赖名称。');
        const actual=await packageRoot(resolver,name);
        const optional=section==='optionalDependencies'||(section==='peerDependencies'&&manifest.peerDependenciesMeta?.[name]?.optional);
        if(!actual) { if(optional||(!name.startsWith('@deepseek-ai/')&&section==='peerDependencies'))continue;throw failure('missing-dependency',`插件缺少依赖 ${name}。`); }
        if(name.startsWith('@deepseek-ai/')) {
          const expected=await packageRoot(dshRequire,name);
          if(!expected||actual!==expected)throw failure('native-runtime-conflict',`插件解析到了独立的 ${name} 运行时，未予启用。`);
        } else if(section!=='peerDependencies')queue.push(actual);
      }
    }
  }
}

async function writeManifest(path, manifest) {
  const temporary=path+'.coldx-install.tmp';
  await writeFile(temporary,JSON.stringify(manifest,null,2)+'\n');
  await rename(temporary,path);
}

/** A failed version stays disabled even when a later native CLI add reconciles all dependencies. */
async function setBundleEnabled(profileDir, packageId, enabled, oldPosition=-1) {
  const path=join(profileDir,'package.json'),manifest=await json(path);
  manifest.dsh??={};manifest.dsh.profile??={};
  const profile=manifest.dsh.profile;
  const bundles=Array.isArray(profile.bundles)?profile.bundles:[];
  const disabled=Array.isArray(profile.disabledBundles)?profile.disabledBundles:[];
  profile.bundles=bundles.filter(name=>name!==packageId);
  profile.disabledBundles=disabled.filter(name=>name!==packageId);
  if(enabled)profile.bundles.splice(oldPosition<0?profile.bundles.length:Math.min(oldPosition,profile.bundles.length),0,packageId);
  else profile.disabledBundles.push(packageId);
  await writeManifest(path,manifest);
}

/** Permanent packages remain owned by the native DSH profile and Cordis loader. */
export function createMarketplaceInstaller({ ctx, home, profile = 'web', profileDir = join(home, 'profiles', profile), runCommand = runMarketplaceCommand } = {}) {
  if (!home || !ctx || profile !== 'web' || resolve(profileDir) !== resolve(home, 'profiles', profile)) throw failure('invalid-profile', '插件安装必须指向当前 ColdX Web profile。');
  profileDir = resolve(profileDir);
  const cli = join(dirname(dshRequire.resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js');
  const hook = () => ctx.get?.('profileComposition') ?? ctx.profileComposition;
  let tail = Promise.resolve();
  async function describe(packageId, profileManifest) {
    const packageDir = contained(join(profileDir, 'node_modules'), join(profileDir, 'node_modules', packageId));
    let manifest;
    try { manifest = await json(join(packageDir, 'package.json')); }
    catch { return { packageId, status:'installed', message:'依赖记录存在，包文件尚未完整安装。' }; }
    const base = { packageId, version:manifest.version };
    if (profileManifest.dsh?.profile?.disabledBundles?.includes(packageId)) return { ...base, status:'needs-config', message:'此插件尚未通过安装校验，已从启动列表中停用；重新安装并通过校验后可启用。' };
    if (manifest.name !== packageId || !manifest.dsh?.bundle?.patch) return { ...base, status:'installed', message:'普通依赖，未作为原生插件启用。' };
    if (!profileManifest.dsh?.profile?.bundles?.includes(packageId)) return { ...base, status:'installed', message:'已安装，尚未登记为当前 profile 的插件。' };
    let rows;
    try {
      const patchPath = contained(packageDir, resolve(packageDir, manifest.dsh.bundle.patch));
      rows = insertedEntries(loadOverlayPatches('ColdX', patchPath));
    } catch { return { ...base, status:'needs-config', message:'插件 bundle 配置无法读取，请检查插件配置。' }; }
    const snapshot = hook()?.snapshot?.();
    const committed = snapshot?.bundles ?? [];
    if (!committed.includes(packageId)) return { ...base, status:'needs-restart', message:'已安装，尚未加入当前运行中的插件层。' };
    if (snapshot?.versions?.[packageId] && snapshot.versions[packageId] !== manifest.version) return { ...base, status:'needs-restart', message:'已安装版本与当前运行版本不同，重启后生效。' };
    const loaded = [...(ctx.loader?.entries?.() ?? [])];
    const entries = rows.map(row => {
      const entry = loaded.find(item => item.options?.id === row.id && item.options?.name === row.name);
      return { id:row.id, state:entry?.disabled ? 'disabled' : entry?.fiber?.state === 2 ? 'active' : entry?.fiber?.state === 4 ? 'failed' : 'waiting' };
    });
    if (!entries.length) return { ...base, status:'installed', message:'插件层已合成；此包没有可独立确认的运行条目。', entries };
    if (entries.every(entry => entry.state === 'active')) return { ...base, status:'active', message:'已安装并在当前任务中启用。', entries };
    return { ...base, status:'needs-config', message:entries.some(entry => entry.state === 'disabled') ? '插件在当前配置中被禁用。' : '插件已安装，仍需完成配置或提供依赖服务。', entries };
  }
  async function listInstalled() {
    let manifest;
    try { manifest = await json(join(profileDir, 'package.json')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return Promise.all(Object.keys(manifest.dependencies ?? {}).filter(name => PACKAGE.test(name)).map(name => describe(name, manifest)));
  }
  async function perform(meta, { signal, onProgress } = {}) {
    aborted(signal);
    const { packageId, version } = metadata(meta);
    progress(onProgress, 'preparing', '正在检查插件与当前 DSH 的兼容性…');
    initProfile(profileDir, []);
    const before = await json(join(profileDir, 'package.json'));
    const saved = await rememberManagedLinks(profileDir, before);
    let previous;
    try { previous = await json(join(profileDir, 'node_modules', packageId, 'package.json')); } catch {}
    aborted(signal);
    progress(onProgress, 'installing', '正在安装插件依赖…');
    const release = hook()?.hold?.();
    let verified = false;
    let installError;
    try {
      await setBundleEnabled(profileDir,packageId,false);
      const result = await runCommand(process.execPath, [cli, 'plugin', '--profile', profile, 'add', '--save-exact', '--ignore-scripts', '--registry=https://registry.npmjs.org', `${packageId}@${version}`], { cwd:profileDir, env:{ ...process.env, DSH_HOME:home, CI:'true' }, signal });
      aborted(signal);
      if (result.exitCode !== 0) throw failure('package-manager-failed', '原生包管理器安装失败；请检查网络、包版本或 pnpm 是否可用后重试。');
      await restoreManagedLinks(saved);
      const installed = await json(join(profileDir, 'node_modules', packageId, 'package.json'));
      if (installed.name !== packageId || installed.version !== version || installed.dsh?.bundle?.patch !== meta.manifest.dsh.bundle.patch) throw failure('package-mismatch', '实际安装包与已核验的目录元数据不一致。');
      const packageDir = join(profileDir, 'node_modules', packageId);
      loadOverlayPatches('ColdX', contained(packageDir, resolve(packageDir, installed.dsh.bundle.patch)));
      if (meta.distribution?.integrity) {
        const lock = dshRequire('yaml').parse(await readFile(join(profileDir, 'pnpm-lock.yaml'), 'utf8'));
        if (lock.packages?.[`${packageId}@${version}`]?.resolution?.integrity !== meta.distribution.integrity) throw failure('integrity-mismatch', '实际安装包的完整性校验与已核验发行版不一致。');
      }
      await validateRuntimeDependencies(packageDir);
      aborted(signal);
      await setBundleEnabled(profileDir,packageId,true,before.dsh?.profile?.bundles?.indexOf(packageId)??-1);
      verified = true;
    } catch(error) {
      installError=error;
      throw error;
    } finally {
      try {
        await restoreManagedLinks(saved);
        if (!verified) {
          await setBundleEnabled(profileDir,packageId,false);
          if(before.dsh?.profile?.bundles?.includes(packageId)&&installError instanceof Error)installError.message+=' 该插件已从下次启动列表中停用，当前运行实例未被替换。';
        }
      } finally { release?.({ discard:!verified }); }
    }
    const manifest = await json(join(profileDir, 'package.json'));
    if (previous && previous.version !== version) return { packageId, version, status:'needs-restart', message:'版本已更新；已导入的模块需要重启后加载新版。' };
    if (!hook()?.refresh) return { packageId, version, status:'needs-restart', message:'已安装；当前后端尚未提供原生热加载接口。' };
    aborted(signal);
    progress(onProgress, 'activating', '正在通过原生加载器启用插件…');
    try { await hook().refresh(); }
    catch (error) { return { packageId, version, status:error?.code === 'profile-restart-required' ? 'needs-restart' : 'needs-config', message:error?.code === 'profile-restart-required' ? '插件会变更正在运行的模块，需要重启后生效。' : '安装完成，原生加载器未能启用插件；请检查新插件的配置与依赖。' }; }
    return describe(packageId, manifest);
  }
  return {
    install(meta, options) {
      const task = tail.then(() => perform(meta, options)); tail = task.catch(() => {}); return task;
    },
    listInstalled,
  };
}
