import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dshRequire } from '../plugin/page-native.mjs';
import { createMarketplaceInstaller, runMarketplaceCommand } from '../plugin/marketplace-installer.mjs';

const meta = { id:'fixture/plugin', packageId:'coldx-test-market-plugin', version:'1.0.0', manifest:{name:'coldx-test-market-plugin',version:'1.0.0',dsh:{bundle:{patch:'./cordis.patch.json'}}} };
test('failed package command retains bounded diagnostic text while redacting authentication',async()=>{
  const result=await runMarketplaceCommand(process.execPath,['-e',"process.stderr.write('ERR_PNPM_FETCH_404 missing package\\nhttps://fixture-user:fixture-password@registry.example/pkg?token=fixture-secret\\nAuthorization: Bearer fixture-secret\\n_authToken=fixture-hidden\\n'+ 'x'.repeat(6000));process.exitCode=1;"]);
  assert.equal(result.exitCode,1);assert.equal(typeof result.diagnostic,'string');assert.ok(result.diagnostic.length<=4000);
  assert.doesNotMatch(result.diagnostic,/fixture-password|fixture-secret|fixture-hidden/);
  const useful=await runMarketplaceCommand(process.execPath,['-e',"process.stderr.write('ERR_PNPM_FETCH_404 missing package\\nhttps://fixture-user:fixture-password@registry.example/pkg?token=fixture-secret\\nAuthorization: Bearer fixture-secret\\n_authToken=fixture-hidden');process.exitCode=1;"]);
  assert.match(useful.diagnostic,/ERR_PNPM_FETCH_404/);assert.match(useful.diagnostic,/registry.example/);assert.doesNotMatch(useful.diagnostic,/fixture-password|fixture-secret|fixture-hidden/);
  const truncated=await runMarketplaceCommand(process.execPath,['-e',"process.stderr.write('password='+ 'private-fragment'.repeat(1500)+'\\nERR_PNPM_NETWORK retry later');process.exitCode=1;"]);
  assert.doesNotMatch(truncated.diagnostic,/private-fragment/);assert.match(truncated.diagnostic,/ERR_PNPM_NETWORK/);
});
async function fixture(t, { failRefresh=false, active=true }={}) {
  const home=await mkdtemp(join(tmpdir(),'coldx-market-test-')), profileDir=join(home,'profiles','web');
  t.after(()=>rm(home,{recursive:true,force:true}));
  await mkdir(profileDir,{recursive:true});
  await writeFile(join(profileDir,'package.json'),JSON.stringify({name:'test-profile',private:true,dependencies:{},dsh:{profile:{bundles:[]}}}));
  const calls=[],entries=[];
  const ctx={get:name=>name==='profileComposition'?ctx.profileComposition:undefined,loader:{entries:()=>entries},profileComposition:{async refresh(){calls.push('refresh');if(failRefresh)throw new Error('required option missing');if(active)entries.push({id:'include:market-tool',options:{id:'market-tool',name:meta.packageId},disabled:false,fiber:{state:2}});return{bundles:[meta.packageId]};},snapshot:()=>({bundles:entries.length?[meta.packageId]:[]})}};
  const runCommand=async(command,args,options)=>{
    calls.push({command,args,cwd:options.cwd});
    const manifest=JSON.parse(await readFile(join(profileDir,'package.json'),'utf8'));
    manifest.dependencies[meta.packageId]=meta.version;manifest.dsh.profile.bundles.push(meta.packageId);
    await writeFile(join(profileDir,'package.json'),JSON.stringify(manifest));
    const dir=join(profileDir,'node_modules',meta.packageId);await mkdir(dir,{recursive:true});
    await writeFile(join(dir,'package.json'),JSON.stringify(meta.manifest));
    await writeFile(join(dir,'cordis.patch.json'),JSON.stringify([{insert:[{id:'market-tool',name:meta.packageId}]}]));
    return {exitCode:0};
  };
  const installer=createMarketplaceInstaller({ctx,home,profileDir,runCommand});
  return{home,profileDir,ctx,calls,installer,runCommand};
}

test('native registry installation waits for live loader evidence and is discoverable after service recreation',async t=>{
  const f=await fixture(t),progress=[];
  const result=await f.installer.install(meta,{onProgress:p=>progress.push(p.phase)});
  assert.equal(result.status,'active');assert.equal(result.version,'1.0.0');
  assert.deepEqual(f.calls[0].args.slice(-7),['--profile','web','add','--save-exact','--ignore-scripts','--registry=https://registry.npmjs.org',`${meta.packageId}@${meta.version}`]);
  assert.equal(f.calls.at(-1),'refresh');assert.deepEqual(progress,['preparing','installing','activating']);
  const installed=await createMarketplaceInstaller({ctx:f.ctx,home:f.home,profileDir:f.profileDir,runCommand:f.runCommand}).listInstalled();
  assert.equal(installed[0].status,'active');assert.equal(installed[0].packageId,meta.packageId);
  const workspace=await readFile(join(f.profileDir,'pnpm-workspace.yaml'),'utf8');
  assert.match(workspace,/nodeLinker: hoisted/);assert.match(workspace,/autoInstallPeers: false/);
});

test('a successful dependency install cannot claim an inactive bundle is active',async t=>{
  const f=await fixture(t,{active:false});
  const result=await f.installer.install(meta);
  assert.notEqual(result.status,'active');
  assert.equal((await f.installer.listInstalled())[0].status,'needs-restart');
});

test('configuration failure retains installed bytes and reports needs-config without restarting',async t=>{
  const f=await fixture(t,{failRefresh:true});
  const result=await f.installer.install(meta);
  assert.equal(result.status,'needs-config');assert.match(result.message,/配置|option/);
  assert.equal(JSON.parse(await readFile(join(f.profileDir,'node_modules',meta.packageId,'package.json'),'utf8')).name,meta.packageId);
});

test('unverified specs and incompatible native peers fail before any process starts',async t=>{
  const f=await fixture(t);
  for(const value of [{...meta,packageId:'fixture;echo bad'},{...meta,version:'latest'},{...meta,manifest:{...meta.manifest,name:'other-package'}},{...meta,manifest:{...meta.manifest,peerDependencies:{'@deepseek-ai/dsh-tools':'>=99.0.0'}}},...['coldx-client','coldx-distribution'].map(packageId=>({...meta,packageId,manifest:{...meta.manifest,name:packageId}}))])await assert.rejects(f.installer.install(value));
  assert.deepEqual(f.calls,[]);
});

test('an already cancelled install never invokes the native CLI',async t=>{
  const f=await fixture(t),abort=new AbortController();abort.abort();
  await assert.rejects(f.installer.install(meta,{signal:abort.signal}),{name:'AbortError'});assert.deepEqual(f.calls,[]);
});

test('managed client and distribution links survive pnpm pruning',async t=>{
  const f=await fixture(t);const target=join(f.home,'managed-client');await mkdir(target);await mkdir(join(f.profileDir,'node_modules'),{recursive:true});
  const link=join(f.profileDir,'node_modules','coldx-client');await symlink(target,link,'junction');
  const runCommand=async(...args)=>{await rm(link,{force:true,recursive:true});return f.runCommand(...args);};
  await createMarketplaceInstaller({ctx:f.ctx,home:f.home,profileDir:f.profileDir,runCommand}).install(meta);
  assert.equal(await realpath(link),await realpath(target));
});

test('failed or cancelled package-manager jobs never activate a partially installed bundle',async t=>{
  const f=await fixture(t);
  const runCommand=async()=>({exitCode:1});
  await assert.rejects(createMarketplaceInstaller({ctx:f.ctx,home:f.home,profileDir:f.profileDir,runCommand}).install(meta));
  assert.deepEqual(f.calls,[]);
});

test('post-install integrity failure removes only this new bundle and discards held watcher requests',async t=>{
  const f=await fixture(t);let held=false,discarded;
  f.ctx.profileComposition.hold=()=>{held=true;return({discard})=>{held=false;discarded=discard;};};
  const runCommand=async(...args)=>{
    assert.equal(held,true);const result=await f.runCommand(...args);
    await writeFile(join(f.profileDir,'pnpm-lock.yaml'),'packages:\n  coldx-test-market-plugin@1.0.0:\n    resolution:\n      integrity: sha512-different\n');
    return result;
  };
  await assert.rejects(createMarketplaceInstaller({ctx:f.ctx,home:f.home,profileDir:f.profileDir,runCommand}).install({...meta,distribution:{integrity:'sha512-verified'}}),{code:'integrity-mismatch'});
  assert.equal(discarded,true);assert.equal(held,false);assert.ok(!f.calls.includes('refresh'));
  const manifest=JSON.parse(await readFile(join(f.profileDir,'package.json'),'utf8'));
  assert.deepEqual(manifest.dsh.profile.bundles,[]);assert.equal(manifest.dependencies[meta.packageId],meta.version);
});

async function patchedBoot() {
  const parser=await readFile(new URL('../scripts/desktop/native-patches.mjs',import.meta.url),'utf8');
  const {parsePatch,patchText}=new Function('isAbsolute',parser.slice(parser.indexOf('function parsePatch('),parser.indexOf('async function installedPackages('))+';return{parsePatch,patchText};')(isAbsolute);
  let source=await readFile(dshRequire.resolve('@deepseek-ai/dsh-app-boot'),'utf8');
  // Restore just our managed insertion when an earlier patch revision is installed.
  // Always test the pending patch, not a stale already-imported helper.
  source=source.replace(/\/\*\* Recompose the boot include through its existing transactional Cordis lifecycle\. \*\/[\s\S]*?\nasync function watchUserPatches/u,'async function watchUserPatches').replace('export { createProfileComposition,','export {').replace('parseEnv, isDeepStrictEqual','parseEnv');
  const patch=await readFile(new URL('../patches/@deepseek-ai__dsh-app-boot@0.1.1-rc.2.patch',import.meta.url),'utf8');
  source=patchText(source,parsePatch(patch).find(file=>file.path==='lib/index.js').hunks);
  source=source.replace(/from "([^".][^"]*)"/gu,(_all,name)=>`from ${JSON.stringify(name.startsWith('node:')?name:pathToFileURL(dshRequire.resolve(name)).href)}`);
  return import(`data:text/javascript;base64,${Buffer.from(source+'\n//# sourceURL=coldx-native-app-boot-test.mjs\n').toString('base64')}`);
}

test('native profile refresh adds and removes a real plugin without replacing existing fibers; failed composition rolls back',async t=>{
  const {boot,createProfileComposition}=await patchedBoot();
  const home=await mkdtemp(join(tmpdir(),'coldx-native-profile-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const config=join(home,'cordis.yml');await writeFile(config,'[]\n');
  const base=join(home,'base.mjs'),extra=join(home,'extra.mjs');
  await writeFile(base,'export function apply(ctx){ctx.provide("baseFixture",{value:1});}\n');
  const toolsUrl=pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-tools')).href;
  await writeFile(extra,`import{defineTool}from${JSON.stringify(toolsUrl)};export const inject=['tools'];export function apply(ctx){ctx.provide("extraFixture",{value:2});ctx.tools.register(defineTool({name:'market_probe',description:'Live install test',parameters:{},output:{schema:{type:'json'}},execute:async()=>({ok:true})}));}\n`);
  const basePatch={insert:[{id:'base',name:pathToFileURL(base).href},{id:'system-prompt',name:pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-system-prompt')).href},{id:'tools',name:toolsUrl}]};
  const initial={patches:[basePatch],bundles:['base'],versions:{base:'1.0.0'}};
  const ctx=await boot('test',config,initial.patches);t.after(()=>ctx.fiber.dispose());
  const baseline=ctx.loader.resolve('include:base').fiber;
  let candidate=initial;
  const coordinator=createProfileComposition(ctx,()=>candidate,initial);
  candidate={patches:[basePatch,{insert:[{id:'extra',name:pathToFileURL(extra).href}]}],bundles:['base','extra'],versions:{base:'1.0.0',extra:'1.0.0'}};
  await coordinator.refresh();assert.equal(ctx.get('extraFixture').value,2);assert.equal(ctx.loader.resolve('include:base').fiber,baseline);
  assert.deepEqual(await ctx.tools.get('market_probe').execute({},{}),{ok:true},'the current native runtime can call the newly registered tool');
  candidate={...candidate,patches:[...candidate.patches,{insert:[{id:'broken',name:pathToFileURL(join(home,'absent.mjs')).href}]}]};
  await assert.rejects(coordinator.refresh());assert.equal(ctx.get('extraFixture').value,2);assert.equal(ctx.loader.resolve('include:base').fiber,baseline);
  candidate=initial;await coordinator.refresh();assert.equal(ctx.get('extraFixture'),undefined);assert.equal(ctx.loader.resolve('include:base').fiber,baseline);assert.equal(ctx.tools.get('market_probe'),undefined);
  assert.deepEqual(coordinator.snapshot().bundles,['base']);
});

test('the package-manager child drains output and returns the actual exit code',async()=>{
  const result=await runMarketplaceCommand(process.execPath,['-e',"process.stdout.write('x'.repeat(100000));process.stderr.write('y'.repeat(100000));process.exitCode=17"],{timeoutMs:5000});
  assert.equal(result.exitCode,17);
});

test('cancelling a running package-manager child waits until that owned process is terminated',async()=>{
  const controller=new AbortController();
  const task=runMarketplaceCommand(process.execPath,['-e','setInterval(()=>{},1000)'],{signal:controller.signal,timeoutMs:5000});
  const timer=setTimeout(()=>controller.abort(),150);
  try { await assert.rejects(task,{name:'AbortError'}); } finally {clearTimeout(timer);}
});

test('native profile refresh serializes overlapping updates and refuses cached-module version replacement',async t=>{
  const {boot,createProfileComposition}=await patchedBoot();
  const home=await mkdtemp(join(tmpdir(),'coldx-native-versions-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const config=join(home,'cordis.yml');await writeFile(config,'[]\n');const ctx=await boot('test',config,[]);t.after(()=>ctx.fiber.dispose());
  let candidate={patches:[],bundles:['existing'],versions:{existing:'1.0.0'}};
  const coordinator=createProfileComposition(ctx,()=>candidate,candidate);
  await Promise.all([coordinator.refresh(),coordinator.refresh()]);
  assert.equal(coordinator.snapshot().revision,2);
  candidate={...candidate,versions:{existing:'2.0.0'}};
  await assert.rejects(coordinator.refresh(),{code:'profile-restart-required'});
  assert.equal(coordinator.snapshot().versions.existing,'1.0.0');
});

test('profile holds prevent package watchers from observing intermediate installs and discard failed-install refresh requests',async t=>{
  const {boot,createProfileComposition}=await patchedBoot();
  const home=await mkdtemp(join(tmpdir(),'coldx-native-hold-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const config=join(home,'cordis.yml');await writeFile(config,'[]\n');const ctx=await boot('test',config,[]);t.after(()=>ctx.fiber.dispose());
  const initial={patches:[],bundles:[],versions:{}};let reads=0;
  const coordinator=createProfileComposition(ctx,()=>{reads++;return initial;},initial);
  const release=coordinator.hold();const watching=coordinator.refresh();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,0);
  release({discard:true});await watching;assert.equal(reads,0);
  const commit=coordinator.hold();const retry=coordinator.refresh();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,0);
  commit();await retry;assert.equal(reads,1);
});

test('failed verification of an existing bundle upgrade quarantines it for future boots',async t=>{
  const f=await fixture(t);await f.installer.install(meta);
  const next={...meta,version:'2.0.0',manifest:{...meta.manifest,version:'2.0.0'},distribution:{integrity:'sha512-verified'}};
  const runCommand=async()=>{
    const manifest=JSON.parse(await readFile(join(f.profileDir,'package.json'),'utf8'));
    manifest.dependencies[meta.packageId]='2.0.0';
    await writeFile(join(f.profileDir,'package.json'),JSON.stringify(manifest));
    await writeFile(join(f.profileDir,'node_modules',meta.packageId,'package.json'),JSON.stringify(next.manifest));
    await writeFile(join(f.profileDir,'pnpm-lock.yaml'),'packages:\n  coldx-test-market-plugin@2.0.0:\n    resolution:\n      integrity: sha512-wrong\n');
    return{exitCode:0};
  };
  await assert.rejects(createMarketplaceInstaller({ctx:f.ctx,home:f.home,profileDir:f.profileDir,runCommand}).install(next),{code:'integrity-mismatch'});
  const after=JSON.parse(await readFile(join(f.profileDir,'package.json'),'utf8'));
  assert.ok(!after.dsh.profile.bundles.includes(meta.packageId),'future boot cannot execute the failed version');
  assert.ok(after.dsh.profile.disabledBundles.includes(meta.packageId),'later native plugin installs cannot silently reactivate it');
});

test('an additional bundle cannot reconfigure a running service, while an ordinary user patch retains native update behavior',async t=>{
  const {boot,createProfileComposition}=await patchedBoot();const home=await mkdtemp(join(tmpdir(),'coldx-native-preserve-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const config=join(home,'cordis.yml'),base=join(home,'base.mjs');await writeFile(config,'[]\n');
  await writeFile(base,'export function apply(ctx,config){ctx.tracker.applies++;ctx.provide("baseFixture",{value:config.n});ctx.effect(()=>()=>ctx.tracker.disposals++);}\n');
  const tracker={applies:0,disposals:0},basePatch={insert:[{id:'base',name:pathToFileURL(base).href,config:{n:1}}]},initial={patches:[basePatch],bundles:['base'],versions:{base:'1.0.0'}};
  const ctx=await boot('test',config,initial.patches,host=>host.provide('tracker',tracker));t.after(()=>ctx.fiber.dispose());
  const instance=ctx.baseFixture;let candidate={patches:[basePatch,{id:'base',config:{n:2}}],bundles:['base','new'],versions:{base:'1.0.0',new:'1.0.0'}};
  const coordinator=createProfileComposition(ctx,()=>candidate,initial);
  await assert.rejects(coordinator.refresh(),{code:'profile-restart-required'});
  assert.equal(ctx.baseFixture,instance);assert.deepEqual(tracker,{applies:1,disposals:0});
  candidate={...candidate,bundles:['base'],versions:{base:'1.0.0'}};await coordinator.refresh();
  assert.equal(ctx.baseFixture.value,2);assert.deepEqual(tracker,{applies:2,disposals:1});
});

test('installed packages cannot introduce a second copy of the native runtime, even at the same version',async t=>{
  const f=await fixture(t);
  const runCommand=async(...args)=>{
    const result=await f.runCommand(...args),dir=join(f.profileDir,'node_modules',meta.packageId),native=join(dir,'node_modules','@deepseek-ai','cordis');
    await mkdir(native,{recursive:true});
    const own=JSON.parse(await readFile(join(dir,'package.json'),'utf8'));own.peerDependencies={'@deepseek-ai/cordis':'*'};
    await writeFile(join(dir,'package.json'),JSON.stringify(own));
    await writeFile(join(native,'package.json'),JSON.stringify({name:'@deepseek-ai/cordis',version:dshRequire('@deepseek-ai/cordis/package.json').version,main:'index.js'}));await writeFile(join(native,'index.js'),'');
    return result;
  };
  await assert.rejects(createMarketplaceInstaller({ctx:f.ctx,home:f.home,profileDir:f.profileDir,runCommand}).install(meta),{code:'native-runtime-conflict'});
  assert.ok(!f.calls.includes('refresh'));
});

test('native CLI reconciliation preserves quarantined bundles when installing an unrelated package',async()=>{
  const parser=await readFile(new URL('../scripts/desktop/native-patches.mjs',import.meta.url),'utf8');
  const {parsePatch,patchText}=new Function('isAbsolute',parser.slice(parser.indexOf('function parsePatch('),parser.indexOf('async function installedPackages('))+';return{parsePatch,patchText};')(isAbsolute);
  const pkg=dshRequire.resolve('@deepseek-ai/dsh/package.json');
  let source=await readFile(join(pkg,'..','lib','plugin-9h8shc4d.js'),'utf8');
  source=source.replace('\n\tconst disabled = new Set(after.dsh?.profile?.disabledBundles ?? []);','').replace('isBundle && !disabled.has(packageName) &&','isBundle &&').replace('const stillBundle = !disabled.has(packageName) &&','const stillBundle =');
  const patch=await readFile(new URL('../patches/@deepseek-ai__dsh@0.1.1-rc.2.patch',import.meta.url),'utf8');
  source=patchText(source,parsePatch(patch).find(file=>file.path==='lib/plugin-9h8shc4d.js').hunks);
  const body=source.slice(source.indexOf('function reconcilePlugins('),source.indexOf('/**\n* Rewrite relative'));
  let document={dependencies:{failed:'2.0.0',other:'1.0.0'},dsh:{profile:{bundles:['inbox','failed'],disabledBundles:['failed']}}};
  const reconcile=new Function('readProfileManifest','exportsPatch','writeProfileManifest','NAME',body+';return reconcilePlugins;')(()=>document,()=>true,(_dir,value)=>document=value,'test');
  reconcile({dependencies:{failed:'1.0.0'}},'fixture');
  assert.deepEqual(document.dsh.profile.bundles,['inbox','other']);assert.deepEqual(document.dsh.profile.disabledBundles,['failed']);
  reconcile(document,'fixture');assert.deepEqual(document.dsh.profile.bundles,['inbox','other']);
});

test('a delayed file event after failed upgrade cannot unload the old running instance',async t=>{
  const {boot,createProfileComposition}=await patchedBoot();const home=await mkdtemp(join(tmpdir(),'coldx-native-late-watch-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const config=join(home,'cordis.yml'),base=join(home,'base.mjs');await writeFile(config,'[]\n');
  await writeFile(base,'export function apply(ctx){ctx.provide("oldInstance",{});ctx.effect(()=>()=>ctx.tracker.disposals++);}\n');
  const tracker={disposals:0},initial={patches:[{insert:[{id:'base',name:pathToFileURL(base).href}]}],bundles:['base'],versions:{base:'1.0.0'},disabledBundles:[]};
  const ctx=await boot('test',config,initial.patches,host=>host.provide('tracker',tracker));t.after(()=>ctx.fiber.dispose());
  let candidate=initial;const coordinator=createProfileComposition(ctx,()=>candidate,initial),instance=ctx.oldInstance;
  const release=coordinator.hold();const queued=coordinator.refresh();candidate={patches:[],bundles:[],versions:{},disabledBundles:['base']};
  release({discard:true});await queued;
  await assert.rejects(coordinator.refresh(),{code:'profile-restart-required'});
  assert.equal(ctx.oldInstance,instance);assert.equal(tracker.disposals,0);
});
