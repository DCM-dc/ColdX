import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeImport,nativeRuntime} from './native-helpers.mjs';
import * as host from '../plugin/updates-host.mjs';
test('updates load and dispose through native Typert without creating a session or launching an installer',async t=>{
  const ctx=await nativeRuntime();t.after(()=>ctx.fiber.dispose());
  for(const name of ['dsh-typert-registry','dsh-session','dsh-agent','dsh-llm','dsh-agent-loop','dsh-api-gateway']){const mod=await nativeImport('@deepseek-ai/'+name);await ctx.plugin(mod.default??mod,{});}
  const data=new Map();let disposed=false,launched=false;
  await ctx.plugin({name:'updates-test-settings',apply(owner){owner.provide('settings',{register(ns,_schema,{base}){data.set(ns,{...base});return{get:()=>data.get(ns)};},async update(ns,patch){data.set(ns,{...data.get(ns),...patch});}});}});
  const updater={platform:'win32',state:()=>({status:'current',currentVersion:'0.1.2'}),check:async()=>{},install:async()=>{launched=true;},dispose(){disposed=true;}};
  const fiber=await ctx.plugin(host,{updater});
  const rpc=(method,request={})=>ctx.typertGateway.invokeRpc('coldxUpdates/'+method,{args:{request}},new AbortController().signal);
  assert.equal((await rpc('state')).value.currentVersion,'0.1.2');
  assert.equal((await rpc('setting',{autoDownload:false})).value.settings.autoDownload,false);
  assert.equal((await rpc('setting',{autoDownload:'false'})).ok,false);
  assert.equal((await rpc('install',{version:'0.1.3',confirmed:true})).ok,false);
  assert.equal(launched,false);assert.equal(ctx.sessions.list().length,0);
  await fiber.dispose();assert.equal(disposed,true);assert.equal((await rpc('state')).ok,false);
});
