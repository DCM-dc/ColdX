import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeImport,nativeRuntime} from './native-helpers.mjs';
import * as kernel from '../plugin/kernel-host.mjs';
import * as agentKernel from '../plugin/kernel-agent.mjs';

async function fixture(t,{limit=1,respond}={}){
  const ctx=await nativeRuntime();t.after(()=>ctx.fiber.dispose());
  for(const name of ['dsh-typert-registry','dsh-session','dsh-agent','dsh-llm','dsh-agent-loop','dsh-api-gateway']){
    const mod=await nativeImport('@deepseek-ai/'+name);await ctx.plugin(mod.default??mod,{});
  }
  const kernelFiber=await ctx.plugin(kernel,{limit});
  const {LlmAdapter,createUserMessage,markAgentLoopRequest}=await nativeImport('@deepseek-ai/dsh-llm');
  const requests=[];
  class Adapter extends LlmAdapter{async *stream(request){requests.push(request);if(respond)yield*respond(request);else{
    yield{type:'block-start',index:0,blockType:'text'};yield{type:'text-delta',index:0,text:'done'};
    yield{type:'block-end',index:0,block:{type:'text',text:'done'}};
    yield{type:'usage',usage:{inputTokens:10,outputTokens:2,cacheReadTokens:7}};yield{type:'finish',reason:{kind:'stop'}};
  }}}
  ctx.llm.registerAdapter(['kernel-fixture'],new Adapter());
  const create=async(id,enabled=true)=>{const {agent}=await ctx.agents.create({sessionId:id,agentOptions:{provider:'kernel-fixture',model:'fixture'}});if(enabled)await agent.ctx.plugin(agentKernel);return agent;};
  const run=async agent=>{agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'private-task'}]}));await agent.whenIdle();};
  const rpc=(agent)=>ctx.typertGateway.invokeRpc('coldxKernel/read',{args:{agentId:agent.id,request:{}}},new AbortController().signal);
  return{ctx,kernelFiber,create,run,rpc,requests,markAgentLoopRequest};
}

test('kernel participates in native requests, preserves responses and exposes exact-owner numeric metrics',async t=>{
  const f=await fixture(t),one=await f.create('kernel-one'),two=await f.create('kernel-two');await f.run(one);
  const oneResult=await f.rpc(one);assert.equal(oneResult.ok,true);
  assert.equal(oneResult.value.session.completed,1);assert.deepEqual(oneResult.value.session.last.usage,{inputTokens:10,outputTokens:2,cacheReadTokens:7});
  assert.equal((await f.rpc(two)).value.session.requestCount,0);assert.equal(f.requests.length,1);
  assert.doesNotMatch(JSON.stringify(oneResult),/private-task|kernel-one|fixture|system-reminder/);
  assert.equal(f.ctx.coldxKernel.scheduler.snapshot().active,0);
});

test('unrelated presets bypass ColdX admission and reporting',async t=>{
  const f=await fixture(t),agent=await f.create('other-preset',false);await f.run(agent);
  assert.equal(f.ctx.coldxKernel.ledger.ownerCount,0);assert.equal((await f.rpc(agent)).ok,false);
});

test('concurrent native requests queue and an aborted queued request never calls its provider',async t=>{
  let release;const hold=new Promise(resolve=>{release=resolve;});let started;const start=new Promise(resolve=>{started=resolve;});
  const f=await fixture(t,{respond:async function*(){started();await hold;yield{type:'finish',reason:{kind:'stop'}};}});
  const a=await f.create('queue-a'),b=await f.create('queue-b');const sa=new AbortController(),sb=new AbortController();
  const request=(agent,signal)=>f.markAgentLoopRequest({provider:'kernel-fixture',model:'fixture',sessionId:agent.id,messages:[],signal});
  const consume=async stream=>{for await(const _ of stream){}};
  const first=consume(f.ctx.llm.stream(request(a,sa.signal)));await start;
  const second=consume(f.ctx.llm.stream(request(b,sb.signal)));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.ctx.coldxKernel.scheduler.snapshot().queued,1);
  const cancelled=assert.rejects(second,/cancel queued/);sb.abort(new Error('cancel queued'));await cancelled;
  release();await first;assert.equal(f.requests.length,1);assert.equal(f.ctx.coldxKernel.ledger.snapshot(b.id).cancelled,1);
  assert.equal(f.ctx.coldxKernel.scheduler.snapshot().active,0);
});

test('breaking a native stream closes the producer and releases capacity',async t=>{
  let closed=false;const f=await fixture(t,{respond:async function*(){try{yield{type:'block-start',index:0,blockType:'text'};yield{type:'text-delta',index:0,text:'partial'};}finally{closed=true;}}});
  const agent=await f.create('consumer-return');
  const options=f.markAgentLoopRequest({provider:'kernel-fixture',model:'fixture',sessionId:agent.id,messages:[],signal:new AbortController().signal});
  for await(const chunk of f.ctx.llm.stream(options)){if(chunk.type==='text-delta')break;}
  assert.equal(closed,true);assert.equal(f.ctx.coldxKernel.scheduler.snapshot().active,0);
  assert.equal(f.ctx.coldxKernel.ledger.snapshot(agent.id).cancelled,1);
});

test('unloading the kernel aborts the actual native provider before releasing its permit',async t=>{
  let entered;const started=new Promise(resolve=>{entered=resolve;});let providerSignal,closed=false;
  const f=await fixture(t,{respond:async function*(request){
    providerSignal=request.signal;entered();
    try{await new Promise((resolve,reject)=>{request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true});});}
    finally{closed=true;}
  }});
  const agent=await f.create('unload-active'),service=f.ctx.coldxKernel;
  const run=f.run(agent);await started;
  // Bound a failed test without leaving the native fixture hanging during teardown.
  const fallback=setTimeout(()=>agent.cancel({kind:'disposed'},{keepInbox:true}),500);
  try{
    await f.kernelFiber.dispose();
    assert.equal(providerSignal.aborted,true);await run;assert.equal(closed,true);
    assert.equal(service.scheduler.snapshot().active,0);
  }finally{clearTimeout(fallback);agent.cancel({kind:'disposed'},{keepInbox:true});await run;}
});

test('native provider aborted finishes are cancelled rather than successful requests',async t=>{
  const {LlmError}=await nativeImport('@deepseek-ai/dsh-llm');
  const f=await fixture(t,{respond:async function*(){throw new LlmError('fixture aborted','ABORTED');}});
  const agent=await f.create('provider-aborted');await f.run(agent);
  const row=(await f.rpc(agent)).value.session;assert.equal(row.completed,0);assert.equal(row.cancelled,1);
});

test('tool accounting follows denied and failed post-execution final results',async t=>{
  const f=await fixture(t),agent=await f.create('tool-results');
  const {defineTool}=await nativeImport('@deepseek-ai/dsh-tools');
  agent.ctx.tools.register(defineTool({name:'kernel_probe',description:'fixture',parameters:{},execute:async()=>({ok:true}),output:{schema:{type:'json'},render:()=>[{type:'text',text:'ok'}]}}));
  const call=()=>f.ctx.tools.execute({agent,name:'kernel_probe',arguments:{},callId:'reused-id',signal:new AbortController().signal});
  const denied=agent.ctx.on('tools/pre-execute',()=>({kind:'deny',reason:'fixture'}));
  assert.equal((await call()).isError,true);denied();
  const failedPost=agent.ctx.on('tools/post-execute',()=>{throw Error('fixture post failure');});
  assert.equal((await call()).isError,true);failedPost();
  assert.equal((await call()).isError,false);
  const row=(await f.rpc(agent)).value.session;assert.equal(row.toolCount,3);assert.equal(row.toolFailures,2);
});

test('kernel unload cancels the native activity even between model requests while a tool runs',async t=>{
  let entered;const started=new Promise(resolve=>{entered=resolve;});let toolSignal;
  const f=await fixture(t,{respond:async function*(){
    yield{type:'block-start',index:0,blockType:'tool-call'};
    yield{type:'block-end',index:0,block:{type:'tool-call',name:'blocking_probe',id:'fixture-call',arguments:'{}'}};
    yield{type:'finish',reason:{kind:'tool-calls'}};
  }});
  const agent=await f.create('unload-tool'),service=f.ctx.coldxKernel;
  const {defineContentToolFixture}=await nativeImport('@deepseek-ai/dsh-tools');
  agent.ctx.tools.register(defineContentToolFixture({name:'blocking_probe',description:'fixture',parameters:{},execute:async(_args,exec)=>{
    toolSignal=exec.signal;entered();await new Promise((resolve,reject)=>exec.signal.addEventListener('abort',()=>reject(exec.signal.reason),{once:true}));return[];
  }}));
  const run=f.run(agent);await started;
  const fallback=setTimeout(()=>agent.cancel({kind:'disposed'},{keepInbox:true}),500);
  try{await f.kernelFiber.dispose();assert.equal(toolSignal.aborted,true);await run;assert.equal(f.requests.length,1);assert.equal(service.scheduler.snapshot().active,0);}
  finally{clearTimeout(fallback);agent.cancel({kind:'disposed'},{keepInbox:true});await run;}
});

test('kernel unload parks a follow-up latched during earlier user-abort cleanup',async t=>{
  let entered,release;const started=new Promise(resolve=>{entered=resolve;}),cleanup=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,{respond:async function*(request){
    entered();await new Promise(resolve=>request.signal.addEventListener('abort',resolve,{once:true}));
    await cleanup;request.signal.throwIfAborted();
  }});
  const agent=await f.create('unload-wake');const run=f.run(agent);await started;
  agent.cancel({kind:'user'},{keepInbox:true});
  const {createUserMessage}=await nativeImport('@deepseek-ai/dsh-llm');
  agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'keep queued input'}]}));
  const disposing=f.kernelFiber.dispose();release();
  const fallback=setTimeout(()=>agent.cancel({kind:'disposed'},{keepInbox:true}),500);
  try{await disposing;await run;assert.equal(f.requests.length,1);assert.equal(agent.inbox.hasPending,true);}
  finally{clearTimeout(fallback);agent.cancel({kind:'disposed'},{keepInbox:true});}
});
