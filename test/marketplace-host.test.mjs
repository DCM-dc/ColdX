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

test('repair admits once into the original live native agent and retains its failed job',async t=>{
  const f=await fixture(t);f.ctx.coldxMarketplace.installer.install=async()=>{throw Error('Registry unavailable');};
  const accepted=await f.rpc('install',{id:'owner/plugin',packageId:'dsh-fixture',sessionId:f.agent.id});
  assert.equal(accepted.ok,true);await f.ctx.coldxMarketplace.jobs.wait(accepted.value.jobId);
  const seen=[];f.agent.ctx.on('agent/pre-step',async({messages})=>{seen.push(...messages);return{kind:'reject'};});
  const input={jobId:accepted.value.jobId,sessionId:f.agent.id,requestId:'repair-click-1'};
  const [first,again]=await Promise.all([f.rpc('repair',input),f.rpc('repair',input)]);
  assert.equal(first.ok,true);assert.equal(again.ok,true);assert.equal(first.value.repairId,again.value.repairId);
  await f.agent.whenIdle();assert.equal(seen.length,1);assert.match(seen[0].content[0].text,/owner\/plugin/);
  assert.match(seen[0].content[0].text,/Registry unavailable/);assert.equal(first.value.ownerSessionId,f.agent.id);
  assert.equal((await f.rpc('state')).value.installs[0].status,'failed');assert.equal(f.ctx.agents.list().length,1);
});

test('repair cannot create a missing session or cross a failed job owner and respects AI opt-out',async t=>{
  const f=await fixture(t);f.ctx.coldxMarketplace.installer.install=async()=>{throw Error('Failed');};
  const record=await f.ctx.coldxMarketplace.jobs.start({id:'owner/plugin',packageId:'dsh-fixture'},{version:'1.0.0'},{ownerSessionId:'another-task'});await f.ctx.coldxMarketplace.jobs.wait(record.jobId);
  assert.equal((await f.rpc('repair',{jobId:record.jobId,sessionId:f.agent.id,requestId:'repair-foreign'})).ok,false);
  assert.equal((await f.rpc('repair',{jobId:record.jobId,sessionId:'missing',requestId:'repair-missing'})).ok,false);
  await f.rpc('setting',{agentInstallEnabled:false});assert.equal((await f.rpc('repair',{jobId:record.jobId,sessionId:f.agent.id,requestId:'repair-disabled'})).ok,false);
  assert.equal(f.ctx.agents.list().length,1);
});

test('concurrent repair clicks with different request IDs still queue one native followup',async t=>{
  const f=await fixture(t),service=f.ctx.coldxMarketplace;service.installer.install=async()=>{throw Error('Failed');};
  const record=await service.jobs.start({id:'owner/plugin',packageId:'dsh-fixture'},{version:'1.0.0'},{ownerSessionId:f.agent.id});await service.jobs.wait(record.jobId);
  const seen=[];f.agent.ctx.on('agent/pre-step',async({messages})=>{seen.push(...messages);return{kind:'reject'};});
  let release;const gate=new Promise(resolve=>{release=resolve;}),update=service.jobs.updateRepair.bind(service.jobs);service.jobs.updateRepair=async(id,value)=>{if(value.messageId)await gate;return update(id,value);};
  const pending=['repair-window-a','repair-window-b'].map(requestId=>f.rpc('repair',{jobId:record.jobId,sessionId:f.agent.id,requestId}));
  await new Promise(resolve=>setTimeout(resolve,25));release();const results=await Promise.all(pending);assert.ok(results.every(result=>result.ok));
  await f.agent.whenIdle();assert.equal(seen.length,1);assert.equal(results[0].value.repairId,results[1].value.repairId);
});

test('unavailable published packages can request a bounded AI installation diagnosis',async t=>{
  const f=await fixture(t);f.ctx.coldxMarketplace.catalog.detail=async({id})=>({id,packages:[{id:'dsh-fixture',version:'1.0.0',installable:false,reason:'No compatible native bundle'}]});
  const seen=[];f.agent.ctx.on('agent/pre-step',async({messages})=>{seen.push(...messages);return{kind:'reject'};});
  const response=await f.rpc('repair',{id:'owner/plugin',packageId:'dsh-fixture',sessionId:f.agent.id,requestId:'assist-click-1'});
  assert.equal(response.ok,true);await f.agent.whenIdle();assert.equal(seen.length,1);assert.equal(f.installs,0);
  const record=(await f.rpc('state')).value.installs[0];assert.equal(record.status,'failed');assert.equal(record.failureCode,'assisted-install-required');assert.equal(record.ownerSessionId,f.agent.id);
});

test('a native child installation retains its source but parent can repair after child disposal',async t=>{
  const f=await fixture(t),service=f.ctx.coldxMarketplace;service.installer.install=async()=>{throw Error('Child registry failed');};
  const handle=await f.agent.ctx.agents.create({sessionId:'market-child',meta:{cwd:process.cwd(),origin:'subagent'}}),child=handle.agent;
  const failed=await service.installForAgent(child,{id:'owner/plugin',packageId:'dsh-fixture'},new AbortController().signal);
  assert.equal(failed.ownerSessionId,child.id);assert.equal(failed.rootSessionId,f.agent.id);await handle.dispose();
  const other=await f.ctx.agents.create({sessionId:'other-root',meta:{cwd:process.cwd()}});
  assert.equal((await f.rpc('repair',{jobId:failed.jobId,sessionId:other.agent.id,requestId:'child-wrong-root'})).ok,false);
  const seen=[];f.agent.ctx.on('agent/pre-step',async({messages})=>{seen.push(...messages);return{kind:'reject'};});
  const response=await f.rpc('repair',{jobId:failed.jobId,sessionId:f.agent.id,requestId:'child-owner-root'});assert.equal(response.ok,true);await f.agent.whenIdle();
  assert.equal(response.value.ownerSessionId,f.agent.id);assert.equal(seen.length,1);assert.match(seen[0].content[0].text,/market-child/);assert.match(seen[0].content[0].text,/Child registry failed/);
  const record=service.jobs.snapshot()[0];assert.equal(record.ownerSessionId,child.id);assert.equal(record.rootSessionId,f.agent.id);
});

test('legacy child records acquire a root repair route only from exact live native ownership',async t=>{
  const f=await fixture(t),service=f.ctx.coldxMarketplace;service.installer.install=async()=>{throw Error('Legacy child failure');};
  const {agent:child}=await f.agent.ctx.agents.create({sessionId:'legacy-child',meta:{cwd:process.cwd(),origin:'subagent'}});
  const failed=await service.jobs.start({id:'owner/plugin',packageId:'dsh-fixture'},{version:'1.0.0'},{ownerSessionId:child.id});await service.jobs.wait(failed.jobId);
  assert.equal((await f.rpc('state')).value.installs[0].rootSessionId,f.agent.id);
  const seen=[];f.agent.ctx.on('agent/pre-step',async({messages})=>{seen.push(...messages);return{kind:'reject'};});
  assert.equal((await f.rpc('repair',{jobId:failed.jobId,sessionId:f.agent.id,requestId:'legacy-root-repair'})).ok,true);await f.agent.whenIdle();assert.equal(seen.length,1);
  assert.equal(service.jobs.snapshot()[0].ownerSessionId,child.id);assert.equal(service.jobs.snapshot()[0].rootSessionId,f.agent.id);
});
