import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {nativeRuntime,nativeImport} from './native-helpers.mjs';
import {SuperpowersStore} from '../plugin/superpowers-store.mjs';
import * as feature from '../plugin/superpowers-host.mjs';
import {superpowersPrompt} from '../plugin/superpowers-adapter.mjs';

async function bundle(root,commit,text='First version') {
 const files={'LICENSE':'MIT License\nCopyright (c) 2025 Jesse Vincent','skills/verification-before-completion/SKILL.md':'---\nname: verification-before-completion\ndescription: Use before reporting success\n---\n'+text};
 for(const [path,content]of Object.entries(files)){await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),content);}
 await writeFile(join(root,'manifest.json'),JSON.stringify({version:1,upstream:'obra/superpowers',release:'6.3.0',commit,files:Object.entries(files).map(([path,content])=>({path,bytes:Buffer.byteLength(content),sha256:createHash('sha256').update(content).digest('hex')}))}));
}
async function fixture(t) {
 const ctx=await nativeRuntime();t.after(()=>ctx.fiber.dispose());
 for(const name of ['dsh-typert-registry','dsh-session','dsh-agent','dsh-llm','dsh-agent-loop','dsh-api-gateway','dsh-skill','dsh-tool-skill']){const mod=await nativeImport('@deepseek-ai/'+name);await ctx.plugin(mod.default??mod,{});}
 const root=await mkdtemp(join(tmpdir(),'coldx-superpowers-host-'));await bundle(join(root,'bundle'),'a'.repeat(40));
 const store=new SuperpowersStore({root:join(root,'state'),bundledDir:join(root,'bundle')});await store.ready;
 const fiber=await ctx.plugin(feature,{store,autoStart:false});const {agent}=await ctx.agents.create({sessionId:'root-skills',meta:{cwd:root}});
 const rpc=(method,request={})=>ctx.typertGateway.invokeRpc('coldxSuperpowers/'+method,{args:{request}},new AbortController().signal);
 return{ctx,agent,store,root,fiber,rpc};
}
test('profile toggle changes native skill availability without creating a session or chat event',async t=>{
 const f=await fixture(t),count=f.ctx.agents.list().length,events=f.agent.session.events.length;
 assert.equal((await f.ctx.skills.list({scope:f.agent})).length,0);assert.equal(superpowersPrompt({agent:f.agent}),'');
 assert.equal((await f.rpc('setting',{enabled:true})).ok,true);
 const catalog=await f.ctx.skills.list({scope:f.agent});assert.equal(catalog.length,1);assert.equal(catalog[0].name,'verification-before-completion');
 const result=await f.ctx.tools.execute({agent:f.agent,name:'skill',arguments:{name:catalog[0].name},callId:'skill-test',signal:new AbortController().signal});
 assert.equal(result.isError,false);assert.match(result.value.content,/First version/);assert.match(superpowersPrompt({agent:f.agent}),/Superpowers/);
 assert.equal(f.ctx.agents.list().length,count);assert.equal(f.agent.session.events.length,events);
 await f.rpc('setting',{enabled:false});assert.equal((await f.ctx.skills.list({scope:f.agent})).length,0);
});
test('running parent and child keep their pinned snapshot until the family becomes idle',async t=>{
 const f=await fixture(t);await f.rpc('setting',{enabled:true});
 const {agent:child}=await f.agent.ctx.agents.create({sessionId:'child-skills',meta:{cwd:f.root,origin:'subagent'}});
 assert.equal((await f.ctx.skills.get('verification-before-completion',{scope:child})).content.includes('First version'),true);
 // A native pending turn establishes a real running status; pre-step waits without contacting a model.
 let release;const pending=new Promise(resolve=>{release=resolve;});f.agent.ctx.on('agent/pre-step',async(_event,next)=>{await pending;return{kind:'reject'};});
 const {createUserMessage}=await nativeImport('@deepseek-ai/dsh-llm');f.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Test pending task'}]}));assert.equal(f.agent.status,'running');
 const commit='b'.repeat(40);await bundle(join(f.root,'state','versions',commit),commit,'Second version');
 f.store.data.candidate={id:commit,commit,version:'6.4.0',status:'ready'};await f.store.activate({candidateId:commit,expectedActiveCommit:'a'.repeat(40)});
 assert.match((await f.ctx.skills.get('verification-before-completion',{scope:f.agent})).content,/First version/);
 assert.match((await f.ctx.skills.get('verification-before-completion',{scope:child})).content,/First version/);
 release();await f.agent.whenIdle();assert.match((await f.ctx.skills.get('verification-before-completion',{scope:f.agent})).content,/Second version/);
 assert.match((await f.ctx.skills.get('verification-before-completion',{scope:child})).content,/Second version/);
 await f.fiber.dispose();assert.equal((await f.ctx.skills.list({scope:f.agent})).length,0);
});

test('automatic updater stages once and never activates without the explicit RPC',async t=>{
 const f=await fixture(t),service=f.ctx.coldxSuperpowers,old=f.store.state().active.commit;let checks=0,stages=0;
 f.store.check=async()=>{checks++;f.store.data.lastCheckedAt=Date.now();f.store.data.candidate={id:'b'.repeat(40),commit:'b'.repeat(40),version:'6.4.0',status:'available'};return f.store.state();};
 f.store.stage=async({candidateId})=>{assert.equal(candidateId,'b'.repeat(40));stages++;f.store.data.candidate.status='ready';return f.store.state();};
 await service.autoCheck();await service.autoCheck();assert.equal(checks,1);assert.equal(stages,1);assert.equal(f.store.state().active.commit,old);assert.equal(f.store.state().candidate.status,'ready');
 await f.store.setting({autoCheck:false});service.nextAutoCheck=0;f.store.data.lastCheckedAt=null;await service.autoCheck();assert.equal(checks,1);
});

test('host project and user skills retain native precedence for both parent and child',async t=>{
 const f=await fixture(t),name='verification-before-completion';
 const register=(source,rank)=>f.ctx.skills.registerProvider(()=>({name:'test-'+source,list:async()=>[{name,description:source,source,provider:'test-'+source,rank,invocation:{modelInvocable:true,userInvocable:true},locator:{}}],get:async()=>({name,description:source,source,provider:'test-'+source,content:source+' instructions',invocation:{modelInvocable:true,userInvocable:true}})}));
 const removeUser=register('user',400),removeProject=register('project',100);await f.rpc('setting',{enabled:true});
 const {agent:child}=await f.agent.ctx.agents.create({sessionId:'precedence-child',meta:{cwd:f.root,origin:'subagent'}});
 for(const agent of [f.agent,child])assert.equal((await f.ctx.skills.get(name,{scope:agent,cwd:f.root})).content,'project instructions');
 removeProject();for(const agent of [f.agent,child])assert.equal((await f.ctx.skills.get(name,{scope:agent,cwd:f.root})).content,'user instructions');
 removeUser();for(const agent of [f.agent,child])assert.match((await f.ctx.skills.get(name,{scope:agent,cwd:f.root})).content,/First version/);
});
