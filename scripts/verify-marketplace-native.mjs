// Manual network acceptance. Installs one published plugin into a NEW temporary
// DSH profile; never uses the user's profile, provider settings, or a paid model.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {dshRequire,nativeImport} from '../plugin/page-native.mjs';
import * as marketplace from '../plugin/marketplace-host.mjs';

const native=await nativeImport('@deepseek-ai/dsh-app-boot');
assert.equal(typeof native.createProfileComposition,'function','Apply the pinned ColdX native patches before this check.');
const home=await mkdtemp(join(tmpdir(),'coldx-marketplace-native-'));
const profileDir=join(home,'profiles','web'),anchor=dshRequire.resolve('@deepseek-ai/dsh/package.json');
native.initProfile(profileDir,[]);native.healProfilesModuleFallback(anchor,home);
const config=join(profileDir,'cordis.yml');await writeFile(config,'[]\n');
const ctx=await native.boot('marketplace-acceptance',config,[]);
try {
  const snapshot=()=>{
    const profile=native.loadProfile('marketplace-acceptance','web',anchor,home);
    return {patches:profile.layers.flatMap(layer=>layer.patches),bundles:profile.layers.map(layer=>layer.packageName),disabledBundles:native.readProfileManifest('marketplace-acceptance',profileDir).dsh?.profile?.disabledBundles??[],
      versions:Object.fromEntries(profile.layers.map(layer=>[layer.packageName,native.readProfileManifest('marketplace-acceptance',layer.packageDir).version]))};
  };
  ctx.provide('profileComposition',native.createProfileComposition(ctx,snapshot,snapshot()));
  for(const name of ['dsh-system-prompt','dsh-tools','dsh-typert-registry','dsh-session','dsh-agent','dsh-llm','dsh-agent-loop','dsh-api-gateway']){
    const mod=await nativeImport('@deepseek-ai/'+name);await ctx.plugin(mod.default??mod,{});
  }
  // Only settings storage and the explicitly permitted isolated session policy
  // are fixtures; tools, Agents, RPC, catalog, CLI and bundle loading are native.
  const settings=new Map();
  await ctx.plugin({name:'isolated-marketplace-policy',apply(owner){
    owner.provide('settings',{register(ns,_schema,{base}){settings.set(ns,{...base});return{get:()=>settings.get(ns)};},async update(ns,patch){settings.set(ns,{...settings.get(ns),...patch});}});
    owner.provide('sandboxPolicy',{resolve:()=>({mode:'danger-full-access'})});
  }});
  await ctx.plugin(marketplace,{home,profile:'web',profileDir});
  const {agent}=await ctx.agents.create({sessionId:'marketplace-native-acceptance',meta:{cwd:profileDir}});
  const controller=new AbortController();
  const run=(name,args)=>ctx.tools.execute({agent,name,arguments:args,callId:'acceptance-'+name,signal:controller.signal});
  const repository='01Virex/dsh-status-rotator',packageId='dsh-status-rotator';
  console.log('Searching published plugin through the native AI tool.');
  const search=await run('coldx_plugins_search',{query:'dsh-status-rotator'});
  assert.equal(search.isError,false);assert.ok(search.value.items.some(repo=>repo.id===repository));
  const inspection=await run('coldx_plugins_inspect',{id:repository});
  assert.equal(inspection.isError,false);
  const candidate=inspection.value.packages.find(pkg=>pkg.id===packageId);assert.equal(candidate?.installable,true);
  console.log('Installing into isolated profile through the native AI tool.');
  const result=await run('coldx_plugins_install',{id:repository,packageId,reason:'Verify requested plugin marketplace in an isolated profile.'});
  assert.equal(result.isError,false,JSON.stringify(result.content));assert.equal(result.value.status,'active',result.value.message);
  const rpc=await ctx.typertGateway.invokeRpc('coldxMarketplace/state',{args:{request:{}}},controller.signal);
  assert.equal(rpc.ok,true);assert.equal(rpc.value.installs[0].jobId,result.value.jobId);assert.equal(rpc.value.installs[0].status,'active');
  assert.equal(ctx.agents.get(agent.id),agent,'Installing must preserve the current live Agent.');
  const entry=[...ctx.loader.entries()].find(row=>row.options?.name===packageId);assert.equal(entry?.fiber?.state,2);
  const status=await run('coldx_plugins_status',{});assert.equal(status.isError,false);assert.equal(status.value.installs[0].status,'active');
  const evidence={home,repository,packageId,version:candidate.version,status:result.value.status,nativeRpcMatches:true,liveAgentPreserved:true,loaderState:entry.fiber.state,paidModelCalls:0};
  await writeFile(join(home,'acceptance.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
} finally {await ctx.fiber.dispose();}
