import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rmdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {nativeRuntime,nativeImport} from './native-helpers.mjs';
import * as marketplace from '../plugin/marketplace-host.mjs';

async function fixture(t){
  const ctx=await nativeRuntime();t.after(()=>ctx.fiber.dispose());
  const {default:Loader}=await nativeImport('@deepseek-ai/cordis-plugin-loader');await ctx.plugin(Loader);
  for(const name of ['dsh-typert-registry','dsh-session','dsh-agent','dsh-llm','dsh-agent-loop','dsh-api-gateway']){const mod=await nativeImport('@deepseek-ai/'+name);await ctx.plugin(mod.default??mod,{});}
  const data=new Map();
  await ctx.plugin({name:'test-market-settings',apply(owner){owner.provide('settings',{register(ns,schema,{base}){data.set(ns,{...base});return{get:()=>data.get(ns)};},get:ns=>data.get(ns),async update(ns,patch){data.set(ns,{...data.get(ns),...patch});}});}});
  await ctx.plugin({name:'test-market-permissions',apply(owner){owner.provide('sandboxPolicy',{resolve:()=>({mode:'danger-full-access'})});}});
  const {agent}=await ctx.agents.create({sessionId:'marketplace-agent',meta:{cwd:process.cwd()}});
  let installs=0;const calls=[];
  const catalog={async search(request){calls.push(request);return{items:[{id:'owner/plugin',name:'Fixture',url:'https://github.com/owner/plugin'}],page:1,hasMore:false};},async detail({id}){return{id,packages:[{id:'dsh-fixture',installable:true,version:'1.0.0'}]};},async resolvePackage({id,packageId}){if(id!=='owner/plugin'||packageId!=='dsh-fixture')throw Error('Plugin not verified');return{packageId,version:'1.0.0'};}};
  const installer={async install(_meta,{onProgress}){installs++;onProgress({phase:'activating',message:'Loading native bundle'});return{status:'active',version:'1.0.0',message:'Ready',tools:['fixture_tool']};}};
  const root=await mkdtemp(join(tmpdir(),'coldx-market-host-'));
  const fiber=await ctx.plugin(marketplace,{catalog,installer,profileDir:root});
  const rpc=(method,request={})=>ctx.typertGateway.invokeRpc('coldxMarketplace/'+method,{args:{request}},new AbortController().signal);
  const run=(name,args={})=>ctx.tools.execute({agent,name,arguments:args,callId:'market-'+name,signal:new AbortController().signal});
  return{ctx,agent,rpc,run,calls,fiber,get installs(){return installs;}};
}

test('native marketplace RPC opens without a session and native AI tools share verified installs',async t=>{
  const f=await fixture(t);
  const search=await f.rpc('search',{query:'pdf',page:1});assert.equal(search.ok,true);assert.equal(search.value.items[0].id,'owner/plugin');
  const detail=await f.run('coldx_plugins_inspect',{id:'owner/plugin'});assert.equal(detail.isError,false);assert.equal(detail.value.packages[0].installable,true);
  const result=await f.run('coldx_plugins_install',{id:'owner/plugin',packageId:'dsh-fixture',reason:'Create requested PDF'});
  assert.equal(result.isError,false);assert.equal(result.value.status,'active');assert.deepEqual(result.value.tools,['fixture_tool']);
  const state=await f.rpc('state');assert.equal(state.ok,true);assert.equal(state.value.installs[0].jobId,result.value.jobId);
  await f.rpc('install',{id:'owner/plugin',packageId:'dsh-fixture'});assert.equal(f.installs,1);
  assert.equal((await f.run('coldx_plugins_search',{query:'pdf'})).isError,false);
});

test('AI opt-out prevents installation but leaves direct user installation and discovery working',async t=>{
  const f=await fixture(t);assert.equal((await f.rpc('setting',{agentInstallEnabled:false})).value.agentInstallEnabled,false);
  const denied=await f.run('coldx_plugins_install',{id:'owner/plugin',packageId:'dsh-fixture',reason:'Needed'});
  assert.equal(denied.isError,true);assert.equal(f.installs,0);assert.match(denied.content[0].text,/关闭|disabled/);
  assert.equal((await f.run('coldx_plugins_search',{query:'pdf'})).isError,false);
  assert.equal((await f.rpc('install',{id:'owner/plugin',packageId:'dsh-fixture'})).ok,true);
});

test('unverified packages, forged callers and invalid RPC mutations fail before side effects',async t=>{
  const f=await fixture(t);
  assert.equal((await f.rpc('install',{id:'owner/plugin',packageId:'other'})).ok,false);
  assert.equal((await f.rpc('setting',{agentInstallEnabled:'yes'})).ok,false);
  assert.equal((await f.rpc('state',{extra:true})).ok,false);
  await assert.rejects(f.ctx.coldxMarketplace.installForAgent({id:f.agent.id},{id:'owner/plugin',packageId:'dsh-fixture'},new AbortController().signal),/live Agent/);
  assert.equal(f.installs,0);
});

test('unloading removes RPC and tools instead of leaving a second runtime behind',async t=>{
  const f=await fixture(t);await f.fiber.dispose();
  assert.equal(f.ctx.tools.get('coldx_plugins_install',f.agent),undefined);
  assert.equal((await f.rpc('search',{query:''})).ok,false);
});

test('a stale active receipt is rechecked against installed files before AI can reuse it',async t=>{
  const f=await fixture(t),args={id:'owner/plugin',packageId:'dsh-fixture',reason:'Needed'};
  assert.equal((await f.run('coldx_plugins_install',args)).value.status,'active');
  f.ctx.coldxMarketplace.installer.listInstalled=async()=>[];
  await f.run('coldx_plugins_install',args);
  assert.equal(f.installs,2,'removed package must be installed again rather than replaying stale success');
});

test('profile-wide AI installation cannot bypass the calling session sandbox mode',async t=>{
  const f=await fixture(t);f.ctx.sandboxPolicy.resolve=()=>({mode:'read-only'});
  const denied=await f.run('coldx_plugins_install',{id:'owner/plugin',packageId:'dsh-fixture',reason:'Needed'});
  assert.equal(denied.isError,true);assert.equal(f.installs,0);assert.match(denied.content[0].text,/权限|Full access/);
  assert.equal((await f.rpc('install',{id:'owner/plugin',packageId:'dsh-fixture'})).ok,true,'direct user install remains available');
});

test('runtime inspection does not erase an unresolved persistence failure or mislabel verified activation',async t=>{
  const f=await fixture(t),service=f.ctx.coldxMarketplace;
  await f.run('coldx_plugins_install',{id:'owner/plugin',packageId:'dsh-fixture',reason:'Needed'});
  service.installer.listInstalled=async()=>[{packageId:'dsh-fixture',version:'1.0.0',status:'active',message:'Ready'}];
  const obstruction=service.jobs.statePath+'.tmp';await mkdir(obstruction);
  try {
    await assert.rejects(service.jobs.persist());
    const state=await f.rpc('state');assert.equal(state.ok,true);
    assert.match(state.value.notice,/安装记录保存失败/,'a read-only inspection does not acknowledge an unsaved receipt');
    assert.equal(state.value.installs[0].status,'active','a write failure is distinct from an unverified runtime');
  } finally {await rmdir(obstruction);}
  await service.jobs.persist();service.lastInspection=0;
  assert.equal((await f.rpc('state')).value.notice,undefined,'only a successful write clears the persistence notice');
  service.installer.listInstalled=async()=>{throw Error('Loader unavailable');};service.lastInspection=0;
  const unknown=await f.rpc('state');assert.match(unknown.value.notice,/核实插件加载状态/);assert.equal(unknown.value.installs[0].status,'installed');
});
