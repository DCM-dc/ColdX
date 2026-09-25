import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {nativeImport,nativeRuntime} from './native-helpers.mjs';
import * as host from '../plugin/companion-host.mjs';
import * as kernel from '../plugin/kernel-host.mjs';
import * as agentKernel from '../plugin/kernel-agent.mjs';
import {TeamStore} from '../lib/companion/store.mjs';
async function fixture(t,respond){const ctx=await nativeRuntime();const dir=await mkdtemp(join(tmpdir(),'coldx-companion-'));t.after(async()=>{await ctx.fiber.dispose();await rm(dir,{recursive:true,force:true});});
 for(const name of ['dsh-typert-registry','dsh-session','dsh-session-projection','dsh-session-persistence-jsonl','dsh-agent','dsh-llm','dsh-agent-loop','dsh-subagent','dsh-subagent-spawn-in-process','dsh-api-gateway']){const m=await nativeImport('@deepseek-ai/'+name);await ctx.plugin(m.default??m,name==='dsh-session-persistence-jsonl'?{root:join(dir,'sessions')}:{});}
 await ctx.plugin(kernel,{});const hostFiber=await ctx.plugin(host,{profileDir:dir});
 // Production children join the standing ColdX preset. This compact runtime
 // has no preset loader, so compose the same kernel attachment at publication.
 const {scopeOf}=await nativeImport('@deepseek-ai/dsh-scope');
 ctx.subagents.registerContinuableSetup(childCtx=>ctx.coldxKernel.attach(scopeOf(childCtx)));
 const {LlmAdapter}=await nativeImport('@deepseek-ai/dsh-llm');const requests=[];
 class Adapter extends LlmAdapter{async *stream(request){requests.push(request);if(respond){yield*respond(request);return;}yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:'Actual peer answer'};yield {type:'block-end',index:0,block:{type:'text',text:'Actual peer answer'}};yield {type:'finish',reason:{kind:'stop'}};}}
 ctx.llm.registerAdapter(['companion-fixture'],new Adapter());const {agent:parent}=await ctx.agents.create({sessionId:'team-parent',agentOptions:{provider:'companion-fixture',model:'real-fixture'}});await parent.ctx.plugin(agentKernel);
 const service=ctx.coldxCompanion;return {ctx,service,parent,requests,dir,hostFiber};
}
function* answer(text){yield {type:'block-start',index:0,blockType:'text'};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}};}
const geneFence=(overrides={})=>'```coldx-gene\n'+JSON.stringify({title:'Compare constraints',when:'Before choosing an option',practice:'List the constraints before comparing options.',...overrides})+'\n```';
const latestPrompt=request=>request.messages.findLast(message=>message.role==='user')?.content.filter(block=>block.type==='text').map(block=>block.text).join('\n')??'';

test('round phases select the successful review child and retain an owned candidate source',{timeout:15000},async t=>{
 let releasePeers,releaseSynthesis,synthesisEntered;const peers=new Promise(resolve=>{releasePeers=resolve;});const synthesis=new Promise(resolve=>{releaseSynthesis=resolve;});const entered=new Promise(resolve=>{synthesisEntered=resolve;});let calls=0;
 t.after(()=>{releasePeers();releaseSynthesis();});
 const output='One supported conclusion.\n\n'+geneFence();
 const {ctx,service,parent,requests,dir}=await fixture(t,async function*(){if(++calls<=3){await peers;yield*answer('Peer findings.');return;}synthesisEntered();await synthesis;yield*answer(output);});
 const {teamId}=await service.createTeam({parentSessionId:parent.id,members:[{name:'Research',role:'research'},{name:'Design',role:'design'},{name:'Reviewer',role:'review'}]});
 await service.send({teamId,text:'Find a supported conclusion.'});assert.equal((await service.snapshot({})).teams[0].round?.phase,'exploring');
 releasePeers();await entered;const active=(await service.snapshot({})).teams[0];assert.equal(active.round.phase,'synthesizing');assert.equal(active.round.reviewerId,active.members[2].id);assert.equal(requests[3].sessionId,active.members[2].id);
 releaseSynthesis();await service.runs.get(teamId)?.promise;await parent.whenIdle();
 const team=(await service.snapshot({})).teams[0];assert.equal(team.status,'completed');assert.equal(team.round.phase,'settled');assert.ok(team.round.finishedAt>=team.round.startedAt);assert.equal(requests.length,4);
 assert.equal(team.genes.length,1);const gene=team.genes[0];assert.equal(gene.status,'candidate');assert.equal(gene.uses,0);assert.equal(gene.sourceTaskId,team.members[2].id);assert.equal(gene.roundId,team.round.id);
 const message=team.messages.find(m=>m.id===gene.sourceMessageId);assert.equal(message.taskId,gene.sourceTaskId);assert.equal(message.text,'One supported conclusion.');
 const child=ctx.agents.get(gene.sourceTaskId);assert.equal(child.session.events.findLast(e=>e.type==='assistant/message').data.message.content[0].text,output);
 assert.deepEqual((await new TeamStore(dir).load())[0].genes,team.genes);
});

test('gene activation is owned, bounded, persisted, and exposed only on later rounds',{timeout:15000},async t=>{
 let calls=0;const {ctx,service,parent,requests,dir}=await fixture(t,async function*(){yield*answer(++calls%3===0?'Synthesis.\n'+geneFence(): 'Peer.');});
 const {teamId}=await service.createTeam({parentSessionId:parent.id,members:[{name:'A',role:'research'},{name:'B',role:'review'}]});
 const run=async text=>{await service.send({teamId,text});await service.runs.get(teamId)?.promise;return (await service.snapshot({})).teams[0];};
 const first=await run('First round.');assert.equal(first.genes?.length,1);const gene=first.genes[0];
 const second=await run('Candidate is not active.');assert.doesNotMatch(latestPrompt(requests[3]),/coldx-team-experience/);assert.equal(second.genes[0].uses,0);
 const rpc=await ctx.typertGateway.invokeRpc('coldxCompanion/updateGene',{args:{request:{teamId,geneId:gene.id,status:'active'}}},new AbortController().signal);assert.equal(rpc.ok,true);assert.equal((await new TeamStore(dir).load())[0].genes[0].status,'active');
 await run('Use adopted experience.');assert.match(latestPrompt(requests[6]),/coldx-team-experience/);assert.match(latestPrompt(requests[6]),/List the constraints before comparing options\./);assert.match(latestPrompt(requests[6]),/low-priority advisory/);assert.equal(service.teams[0].genes[0].uses,1);
 await service.updateGene({teamId,geneId:gene.id,status:'paused'});await run('Experience is now paused.');assert.doesNotMatch(latestPrompt(requests[9]),/coldx-team-experience/);assert.equal(service.teams[0].genes[0].uses,1);
 await assert.rejects(service.updateGene({teamId,geneId:gene.id,status:'candidate'}),/status|状态/);
 await assert.rejects(service.updateGene({teamId,geneId:gene.id,status:'active',sourceTaskId:parent.id}),/Invalid/);
 const other=await service.createTeam({parentSessionId:parent.id,members:[{name:'Other',role:'review'}]});await assert.rejects(service.updateGene({teamId:other.teamId,geneId:gene.id,status:'active'}),/经验/);
 const state=service.teams[0];for(const item of state.genes.slice(0,3))await service.updateGene({teamId,geneId:item.id,status:'active'});await assert.rejects(service.updateGene({teamId,geneId:state.genes[3].id,status:'active'}),/3/);
 const start=requests.length;await run('Bounded use.');const prompt=latestPrompt(requests[start]);const context=prompt.match(/<coldx-team-experience>[\s\S]*?<\/coldx-team-experience>/)?.[0];assert.ok(context);assert.ok(context.length<=1200);assert.ok((context.match(/"practice"/g)??[]).length<=2);
 const originalGet=ctx.agents.get.bind(ctx.agents);ctx.agents.get=id=>id===parent.id?undefined:originalGet(id);await assert.rejects(service.updateGene({teamId,geneId:gene.id,status:'paused'}),/ColdX/);ctx.agents.get=originalGet;
});

test('malformed, unrequested, and unsuccessful synthesis metadata never becomes experience',{timeout:20000},async t=>{
 const {LlmError}=await nativeImport('@deepseek-ai/dsh-llm');let calls=0;let mode='malformed';
 const {service,parent}=await fixture(t,async function*(){const n=++calls%3;if(n!==0){yield*answer('Peer.\n'+geneFence());return;}if(mode==='failure')throw new LlmError('No synthesis','PROVIDER_ERROR');yield*answer('Synthesis.\n'+(mode==='malformed'?'```coldx-gene\n{"title":"bad"}\n```':mode==='forged'?geneFence({sourceTaskId:'forged'}):mode==='omitted'?'No metadata.':geneFence()));});
 const {teamId}=await service.createTeam({parentSessionId:parent.id,members:[{name:'A',role:'research'},{name:'B',role:'review'}]});
 for(mode of ['malformed','forged','omitted','failure']){await service.send({teamId,text:'Review.'});await service.runs.get(teamId)?.promise;const team=(await service.snapshot({})).teams[0];assert.equal(team.genes?.length??0,0);assert.equal(team.round?.phase,'settled');assert.equal(team.status,mode==='failure'?'failed':'completed');if(mode==='malformed')assert.match(team.messages.at(-1).text,/coldx-gene/);}
});

test('partial failure uses a successful fallback for synthesis but cannot produce a candidate',{timeout:15000},async t=>{
 let calls=0;const {LlmError}=await nativeImport('@deepseek-ai/dsh-llm');const {service,parent,requests}=await fixture(t,async function*(){if(++calls===1)throw new LlmError('reviewer failed','PROVIDER_ERROR');yield*answer(calls===4?'Partial synthesis.\n'+geneFence():'Peer findings.');});
 const {teamId}=await service.createTeam({parentSessionId:parent.id,members:[{name:'Review',role:'review'},{name:'Research',role:'research'},{name:'Design',role:'design'}]});
 await service.send({teamId,text:'Review options.'});await service.runs.get(teamId)?.promise;const team=(await service.snapshot({})).teams[0];
 assert.equal(team.status,'failed');assert.equal(team.round.phase,'settled');assert.equal(requests.length,4);assert.equal(team.round.reviewerId,team.members[1].id);assert.equal(requests[3].sessionId,team.members[1].id);assert.deepEqual(team.genes,[]);assert.equal(team.messages.at(-1).text,'Partial synthesis.');
});

test('stopping during synthesis settles the round without creating experience',{timeout:15000},async t=>{
 let calls=0,entered;const started=new Promise(resolve=>{entered=resolve;});const {service,parent,requests}=await fixture(t,async function*(request){if(++calls<3){yield*answer('Peer.');return;}entered();await new Promise((resolve,reject)=>request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true}));});
 const {teamId}=await service.createTeam({parentSessionId:parent.id,members:[{name:'A',role:'research'},{name:'B',role:'review'}]});await service.send({teamId,text:'Review.'});await started;await service.stop({teamId});
 const team=(await service.snapshot({})).teams[0];assert.equal(team.status,'stopped');assert.equal(team.round.phase,'settled');assert.deepEqual(team.genes,[]);assert.equal(requests.length,3);
});

test('bounded candidates preserve active records and a failed final save cannot advertise growth',{timeout:20000},async t=>{
 let calls=0;const {service,parent,dir}=await fixture(t,async function*(){yield*answer(++calls%3===0?'Synthesis.\n'+geneFence({title:`Practice ${calls/3}`}):'Peer.');});
 const {teamId}=await service.createTeam({parentSessionId:parent.id,members:[{name:'A',role:'research'},{name:'B',role:'review'}]});const run=async()=>{await service.send({teamId,text:'Compare.'});await service.runs.get(teamId)?.promise;};
 for(let i=0;i<12;i++){await run();if(i<3)await service.updateGene({teamId,geneId:service.teams[0].genes[i].id,status:'active'});}
 const before=structuredClone(service.teams[0].genes);const save=service.store.save.bind(service.store);service.store.save=teams=>teams[0].status==='completed'&&teams[0].round.phase==='settled'?Promise.reject(Error('disk full')):save(teams);
 await run();const failed=(await service.snapshot({})).teams[0];assert.equal(failed.status,'failed');assert.match(failed.error,/保存失败/);assert.deepEqual(failed.genes.map(g=>g.id),before.map(g=>g.id));assert.equal((await new TeamStore(dir).load())[0].genes.length,12);
 service.store.save=save;await run();const complete=(await service.snapshot({})).teams[0];assert.equal(complete.status,'completed');assert.equal(complete.genes.length,12);assert.deepEqual(complete.genes.slice(0,3).map(g=>g.id),before.slice(0,3).map(g=>g.id));assert.ok(!complete.genes.some(g=>g.id===before[3].id));
 const gene=complete.genes[3];service.store.save=()=>Promise.reject(Error('disk full'));await assert.rejects(service.updateGene({teamId,geneId:gene.id,status:'paused'}),/disk full/);assert.equal(gene.status,'candidate');service.store.save=save;
});

test('new candidates remain invisible until their final persistence succeeds',{timeout:15000},async t=>{
 let release,entered,calls=0;const held=new Promise(resolve=>{release=resolve;});const saving=new Promise(resolve=>{entered=resolve;});t.after(()=>release());
 const {service,parent}=await fixture(t,async function*(){yield*answer(++calls%3===0?'Summary.\n'+geneFence():'Peer.');});
 const {teamId}=await service.createTeam({parentSessionId:parent.id,members:[{name:'A',role:'research'},{name:'B',role:'review'}]});const save=service.store.save.bind(service.store);
 service.store.save=async teams=>{if(teams[0].status==='completed'){entered();await held;}return save(teams);};
 await service.send({teamId,text:'Review.'});await saving;assert.deepEqual((await service.snapshot({})).teams[0].genes,[]);release();await service.runs.get(teamId)?.promise;assert.equal((await service.snapshot({})).teams[0].genes.length,1);
});

test('experience exposure counts failed rounds honestly and never leaks to another team',{timeout:15000},async t=>{
 let calls=0,fail=false;const {LlmError}=await nativeImport('@deepseek-ai/dsh-llm');const {service,parent,requests}=await fixture(t,async function*(){calls++;if(fail)throw new LlmError('provider failed','PROVIDER_ERROR');yield*answer(calls%3===0?'Summary.\n'+geneFence():'Peer.');});
 const {teamId}=await service.createTeam({parentSessionId:parent.id,members:[{name:'A',role:'research'},{name:'B',role:'review'}]});await service.send({teamId,text:'First.'});await service.runs.get(teamId)?.promise;
 const gene=service.teams[0].genes[0];await service.updateGene({teamId,geneId:gene.id,status:'active'});fail=true;await service.send({teamId,text:'Provider failure next.'});await service.runs.get(teamId)?.promise;
 assert.equal(service.teams[0].status,'failed');assert.equal(gene.uses,1);assert.equal(service.teams[0].genes.length,1);assert.match(latestPrompt(requests[3]),/coldx-team-experience/);
 fail=false;const other=await service.createTeam({parentSessionId:parent.id,members:[{name:'Other',role:'review'}]});await service.send({teamId:other.teamId,text:'Independent team.'});await service.runs.get(other.teamId)?.promise;assert.doesNotMatch(latestPrompt(requests.at(-1)),/coldx-team-experience/);assert.deepEqual(service.teams[1].genes,[]);
});

test('cancellation arriving after a gene write cannot make memory contradict durable activation',{timeout:15000},async t=>{
 let calls=0;const {service,parent,dir}=await fixture(t,async function*(){yield*answer(++calls%3===0?'Summary.\n'+geneFence():'Peer.');});
 const {teamId}=await service.createTeam({parentSessionId:parent.id,members:[{name:'A',role:'research'},{name:'B',role:'review'}]});await service.send({teamId,text:'Review.'});await service.runs.get(teamId)?.promise;
 const gene=service.teams[0].genes[0];const save=service.store.save.bind(service.store);const controller=new AbortController();service.store.save=async teams=>{await save(teams);controller.abort();};
 await service.updateGene({teamId,geneId:gene.id,status:'active'},controller.signal).catch(()=>{});assert.equal((await new TeamStore(dir).load())[0].genes[0].status,'active');assert.equal(gene.status,'active');service.store.save=save;
});

test('a failed activation cannot leak through a concurrently settling round into durable state',{timeout:15000},async t=>{
 let calls=0,researchId,releasePeers,rejectWrite,writeEntered;const peers=new Promise(resolve=>{releasePeers=resolve;});const heldWrite=new Promise((resolve,reject)=>{rejectWrite=reject;});heldWrite.catch(()=>{});const writing=new Promise(resolve=>{writeEntered=resolve;});t.after(()=>{releasePeers();rejectWrite(Error('cleanup'));});
 const {LlmError}=await nativeImport('@deepseek-ai/dsh-llm');const {service,parent,dir}=await fixture(t,async function*(request){if(++calls>3){await peers;if(request.sessionId===researchId)throw new LlmError('peer failed','PROVIDER_ERROR');yield*answer('Partial peer.');return;}yield*answer(calls===3?'Summary.\n'+geneFence():'Peer.');});
 const {teamId}=await service.createTeam({parentSessionId:parent.id,members:[{name:'A',role:'research'},{name:'B',role:'review'}]});await service.send({teamId,text:'First round.'});await service.runs.get(teamId)?.promise;researchId=service.teams[0].members[0].childId;const gene=service.teams[0].genes[0];
 const save=service.store.save.bind(service.store);let held=false,tail=Promise.resolve();service.store.save=teams=>{const snapshot=structuredClone(teams);const operation=tail.then(async()=>{if(!held&&snapshot[0].genes.some(item=>item.id===gene.id&&item.status==='active')){held=true;writeEntered();await heldWrite;}await save(snapshot);});tail=operation.catch(()=>{});return operation;};
 await service.send({teamId,text:'Second round.'});const run=service.runs.get(teamId);const update=service.updateGene({teamId,geneId:gene.id,status:'active'});update.catch(()=>{});await writing;releasePeers();while(!run.finalizing)await new Promise(setImmediate);rejectWrite(Error('activation disk failure'));await assert.rejects(update,/activation disk failure/);await run.promise;
 assert.equal(gene.status,'candidate');assert.equal((await new TeamStore(dir).load())[0].genes[0].status,'candidate');service.store.save=save;
});

test('failed child identity persistence rolls back admission so the next round can create a real child',{timeout:15000},async t=>{
 const {service,parent,requests}=await fixture(t);const {teamId}=await service.createTeam({parentSessionId:parent.id,members:[{name:'Peer',role:'review'}]});const save=service.store.save.bind(service.store);let failed=false;
 service.store.save=teams=>{if(!failed&&teams[0].members[0].childId){failed=true;return Promise.reject(Error('identity disk failure'));}return save(teams);};
 await service.send({teamId,text:'First attempt.'});await service.runs.get(teamId)?.promise;assert.equal(service.teams[0].status,'failed');assert.equal(service.teams[0].members[0].childId,undefined);assert.equal(requests.length,0);
 service.store.save=save;await service.send({teamId,text:'Retry admission.'});await service.runs.get(teamId)?.promise;assert.equal(service.teams[0].status,'completed');assert.equal(requests.length,1);assert.ok(service.teams[0].members[0].childId);
});
test('team runs actual continuable children and one synthesis; settlement never starts paid parent chatter',{timeout:15000},async t=>{
 const {ctx,service,parent,requests}=await fixture(t);parent.ctx.systemPrompt.context({name:'companion-idle-fixture',order:0,text:'Stable native runtime context.'});const {teamId}=await service.createTeam({parentSessionId:parent.id,name:'Review',members:[{name:'Research',role:'Research'},{name:'Review',role:'Review'}]});
 await service.send({teamId,text:'Compare options.'});await service.runs.get(teamId)?.promise;await parent.whenIdle();
 const snapshot=await service.snapshot({});const team=snapshot.teams[0];assert.equal(team.status,'completed',team.error);assert.equal(requests.length,3);assert.equal(team.messages.length,4);assert.ok(requests.every(r=>r.model==='real-fixture'&&r.sessionId!==parent.id));
 assert.ok(team.messages.slice(1).every(m=>m.text==='Actual peer answer'));assert.ok(team.members.every(m=>m.id!==parent.id));
 assert.equal(snapshot.tasks.find(task=>task.id===parent.id).mood,'idle','the identified settlement-only skipped turn must not become a parent problem');
 await service.send({teamId,text:'Continue the review.'});await service.runs.get(teamId)?.promise;await parent.whenIdle();assert.equal(requests.length,6);assert.equal((await service.snapshot({})).teams[0].status,'completed');
 const children=await ctx.subagents.listChildren(parent.id);assert.equal(children.length,2);
 const pets=(await service.snapshot({})).tasks.filter(task=>task.parentSessionId===parent.id);assert.equal(pets.length,2);assert.ok(pets.every(p=>p.mode==='continuable'));
});

test('team snapshot includes registered live children and retains their actual outcome after native disposal',{timeout:15000},async t=>{
 let entered,release;const start=new Promise(resolve=>{entered=resolve;});const hold=new Promise(resolve=>{release=resolve;});t.after(()=>release());
 const {ctx,service,parent}=await fixture(t,async function*(){entered();await hold;yield*answer('Child completed.');});
 const {teamId}=await service.createTeam({parentSessionId:parent.id,members:[{name:'Peer',role:'review'}]});await service.send({teamId,text:'Review.'});await start;
 const list=ctx.agents.list.bind(ctx.agents);ctx.agents.list=()=>list().filter(agent=>agent===parent);
 try{const live=(await service.snapshot({})).tasks.find(task=>task.parentSessionId===parent.id);assert.equal(live.mood,'thinking');release();await service.runs.get(teamId)?.promise;const settled=(await service.snapshot({})).tasks.find(task=>task.parentSessionId===parent.id);assert.equal(settled.mood,'celebrating');assert.equal(settled.caption,'Child completed.');}finally{ctx.agents.list=list;}
});

test('identified settlement-only turns remain neutral after full native runtime restart and session replay',{timeout:15000},async t=>{
 const {ctx,service,parent,dir}=await fixture(t);parent.ctx.systemPrompt.context({name:'restart-fixture',order:0,text:'Stable native runtime context.'});
 const {teamId}=await service.createTeam({parentSessionId:parent.id,members:[{name:'Research',role:'research'},{name:'Peer',role:'review'}]});await service.send({teamId,text:'Review.'});await service.runs.get(teamId)?.promise;await parent.whenIdle();
 const skipped=parent.session.events.findLast(event=>event.type==='turn/end');assert.equal(skipped.data.reason.kind,'blocked');assert.equal((await service.snapshot({})).tasks.find(task=>task.id===parent.id).mood,'idle');
 await ctx.fiber.dispose();
 const restarted=await nativeRuntime();try{
  for(const name of ['dsh-typert-registry','dsh-session','dsh-session-projection','dsh-session-persistence-jsonl','dsh-agent','dsh-llm','dsh-agent-loop','dsh-subagent','dsh-subagent-spawn-in-process','dsh-api-gateway']){const m=await nativeImport('@deepseek-ai/'+name);await restarted.plugin(m.default??m,name==='dsh-session-persistence-jsonl'?{root:join(dir,'sessions')}:{});}
  await restarted.plugin(kernel,{});await restarted.plugin(host,{profileDir:dir});const {agent:resumed}=await restarted.agents.resume({resumeSessionId:parent.id});await resumed.ctx.plugin(agentKernel);
  assert.equal(resumed.session.events.findLast(event=>event.type==='turn/end').data.turn,skipped.data.turn);assert.equal((await restarted.coldxCompanion.snapshot({})).tasks.find(task=>task.id===parent.id).mood,'idle');
  // A real, unrelated native pre-step rejection is intentionally not marked.
  restarted.on('agent/pre-step',()=>({kind:'reject'}),{global:true,prepend:true});const {createUserMessage}=await nativeImport('@deepseek-ai/dsh-llm');resumed.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Unrelated blocked request.'}]}));await resumed.whenIdle();
  assert.equal(resumed.session.events.findLast(event=>event.type==='turn/end').data.reason.kind,'blocked');assert.equal((await restarted.coldxCompanion.snapshot({})).tasks.find(task=>task.id===parent.id).mood,'problem');
 }finally{await restarted.fiber.dispose();}
});
test('child settlement during a native parent tool preserves its required continuation',{timeout:15000},async t=>{
 let parentCalls=0;let toolEntered,releaseTool,noticeEntered;
 const entered=new Promise(resolve=>{toolEntered=resolve;});const hold=new Promise(resolve=>{releaseTool=resolve;});const notice=new Promise(resolve=>{noticeEntered=resolve;});
 const {ctx,service,parent}=await fixture(t,async function*(request){
  if(request.sessionId==='team-parent'&&++parentCalls===1){yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'block-end',index:0,block:{type:'tool-call',name:'parent_probe',id:'parent-probe',arguments:'{}'}};yield {type:'finish',reason:{kind:'tool-calls'}};return;}
  yield {type:'block-start',index:0,blockType:'text'};yield {type:'block-end',index:0,block:{type:'text',text:request.sessionId==='team-parent'?'Parent completed after tool':'Child completed'}};yield {type:'finish',reason:{kind:'stop'}};
 });
 const {defineContentToolFixture}=await nativeImport('@deepseek-ai/dsh-tools');const {createUserMessage}=await nativeImport('@deepseek-ai/dsh-llm');
 parent.ctx.tools.register(defineContentToolFixture({name:'parent_probe',description:'Blocking native tool',parameters:{},execute:async()=>{toolEntered();await hold;return [{type:'text',text:'Tool result requires a parent answer'}];}}));
 parent.ctx.on('agent/inbox/inserted',({message})=>{if(message.source?.kind==='subagent-settled')noticeEntered();});
 t.after(()=>releaseTool());parent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Execute tool and summarize.'}]}));await entered;
 const {teamId}=await service.createTeam({parentSessionId:parent.id,members:[{name:'Peer',role:'Review'}]});await service.send({teamId,text:'Review independently.'});await service.runs.get(teamId)?.promise;await notice;releaseTool();await parent.whenIdle();
 assert.equal(parentCalls,2,'parent must consume the completed tool result');assert.equal(parent.session.events.findLast(e=>e.type==='turn/end').data.reason.kind,'completed');
 assert.equal(parent.session.events.findLast(e=>e.type==='assistant/message').data.message.content[0].text,'Parent completed after tool');
});
test('pending frames include live owned children, exclude foreign agents, and never expose approval contents',{timeout:15000},async t=>{
 let entered;const start=new Promise(r=>{entered=r;});const {ctx,service,parent}=await fixture(t,async function*(request){entered();await new Promise((resolve,reject)=>request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true}));});
 const {teamId}=await service.createTeam({parentSessionId:parent.id,members:[{name:'R',role:'R'}]});await service.send({teamId,text:'Wait.'});await start;const child=[...service.runs.get(teamId).agents.values()][0];assert.ok(ctx.coldxKernel.owns(child));
 service.consumeFrame({rpcId:'approval-1',payload:{type:'approval/requested',sessionId:child.id,approvalId:'a',reason:'PRIVATE FILE CONTENT'}});
 const {agent:foreign}=await ctx.agents.create({sessionId:'foreign'});service.consumeFrame({rpcId:'foreign-pending',payload:{type:'question/requested',sessionId:foreign.id}});
 const snapshot=await service.snapshot({});assert.equal(snapshot.tasks[0].id,child.id);assert.equal(snapshot.tasks[0].mood,'waiting');assert.equal(snapshot.tasks[0].pendingId,'approval-1');assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE|foreign/);
 service.consumeFrame({payload:{type:'approval/resolved',sessionId:child.id,approvalId:'a'}});assert.ok(!(await service.snapshot({})).tasks.some(task=>task.pendingId));await service.stop({teamId});
});
test('RPC envelope, bounded recovery, and partial native failure preserve actual outcomes',{timeout:15000},async t=>{
 let calls=0;const {LlmError}=await nativeImport('@deepseek-ai/dsh-llm');const {ctx,service,parent,dir}=await fixture(t,async function*(){if(++calls===1)throw new LlmError('PRIVATE PROVIDER DETAILS','PROVIDER_ERROR');yield {type:'block-start',index:0,blockType:'text'};yield {type:'block-end',index:0,block:{type:'text',text:'Successful peer'}};yield {type:'finish',reason:{kind:'stop'}};});
 const rpc=await ctx.typertGateway.invokeRpc('coldxCompanion/createTeam',{args:{request:{parentSessionId:parent.id,members:[{name:'A',role:'Research'},{name:'B',role:'Review'}]}}},new AbortController().signal);assert.equal(rpc.ok,true);const {teamId}=rpc.value;
 await service.send({teamId,text:'Review.'});await service.runs.get(teamId)?.promise;const team=(await service.snapshot({})).teams[0];assert.equal(team.status,'failed');assert.equal(calls,2);assert.ok(team.messages.some(m=>m.text==='Successful peer'));assert.doesNotMatch(JSON.stringify(team),/PRIVATE/);
 service.teams[0].status='running';await service.store.save(service.teams);const restored=await new TeamStore(dir).load();assert.equal(restored[0].status,'interrupted');assert.equal(restored[0].members.length,2);
});
test('team rejects unrelated parent and stops native provider without claiming success',{timeout:15000},async t=>{
 let entered;const start=new Promise(r=>{entered=r;});let providerSignal;
 const {ctx,service,parent}=await fixture(t,async function*(request){providerSignal=request.signal;entered();await new Promise((resolve,reject)=>request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true}));});
 const {agent:other}=await ctx.agents.create({sessionId:'other'});await assert.rejects(service.createTeam({parentSessionId:other.id,members:[{name:'R',role:'R'}]}),/ColdX/);
 const {teamId}=await service.createTeam({parentSessionId:parent.id,members:[{name:'R',role:'R'}]});await service.send({teamId,text:'Wait.'});await start;await service.stop({teamId});assert.equal(providerSignal.aborted,true);const team=(await service.snapshot({})).teams[0];assert.equal(team.status,'stopped');assert.equal(team.messages.length,1);
});
test('native team tools enforce read-only scope and unloading cancels the provider without waking parent',{timeout:15000},async t=>{
 let entered;const start=new Promise(r=>{entered=r;});let providerSignal;
 const {ctx,service,parent,hostFiber,requests}=await fixture(t,async function*(request){providerSignal=request.signal;entered();await new Promise((resolve,reject)=>request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true}));});
 const {defineContentToolFixture}=await nativeImport('@deepseek-ai/dsh-tools');let writes=0;
 ctx.tools.register(defineContentToolFixture({name:'read',description:'Read fixture',parameters:{},execute:async()=>[{type:'text',text:'read-only result'}]}));
 ctx.tools.register(defineContentToolFixture({name:'write',description:'Write fixture',parameters:{},execute:async()=>{writes++;return [{type:'text',text:'written'}];}}));
 const {teamId}=await service.createTeam({parentSessionId:parent.id,members:[{name:'R',role:'Research'}]});await service.send({teamId,text:'Read.'});await start;const child=[...service.runs.get(teamId).agents.values()][0];
 const execute=name=>ctx.tools.execute({agent:child,name,arguments:{},callId:name,signal:new AbortController().signal});assert.equal((await execute('read')).isError,false);assert.equal((await execute('write')).isError,true);assert.equal(writes,0);
 await hostFiber.dispose();assert.equal(providerSignal.aborted,true);await parent.whenIdle();assert.equal(requests.length,1);assert.equal(service.teams[0].status,'stopped');
});
