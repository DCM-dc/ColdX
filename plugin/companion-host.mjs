import {randomUUID} from 'node:crypto';
import {nativeImport} from './page-native.mjs';
import {TaskFold,normalizeTeam,bounded,publicText,colorFor} from '../lib/companion/state.mjs';
import {TeamStore,MAX_IGNORED_SESSIONS,MAX_IGNORED_TURNS} from '../lib/companion/store.mjs';
import {MAX_ACTIVE_GENES,extractGene,candidateGene,appendCandidate,experienceContext} from '../lib/companion/growth.mjs';
const {TypertRemoteService}=await nativeImport('@deepseek-ai/dsh-typert-protocol');
const {finalAssistantOutput}=await nativeImport('@deepseek-ai/dsh-subagent');
export const name='coldx-companion';
export const inject=['agents','subagents','typert','coldxKernel'];
export const COMPANION_INVOCATIONS=['snapshot','createTeam','send','stop','removeTeam','updateGene'].map(method=>({id:`coldx-companion:${method}`,service:'coldxCompanion',namespace:'coldxCompanion',method,invocation:{kind:'direct'},parameters:[{name:'request',wire:'request',source:'json',codec:{mode:'src-json'}}],cancellation:{parameter:'signal'},result:{mode:'src-json'}}));
// Advisory team members may inspect, search and ask. No shell, edits, reports,
// delegated agents or code transport can escape this monotonic native filter.
export const ADVISORY_TOOLS=['read','read_image','read_file','list_directory','glob','grep','search_files','web_search','web_fetch','ask_user_question'];
function requestObject(request,keys){if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).some(key=>!keys.includes(key)))throw Error('Invalid companion request.');}
export class CompanionService extends TypertRemoteService{
 constructor(ctx,config={}){super(ctx,'coldxCompanion');this.store=new TeamStore(config.profileDir);this.persistenceTail=Promise.resolve();this.teams=[];this.runs=new Map();this.blocked=new Set();this.updatingGenes=new Set();this.folds=new WeakMap();this.ignoredTurns=new Map();this.memberStates=new Map();this.noticeOwners=new WeakMap();this.pending=new Map();this.closed=false;this.ready=this.store.load().then(teams=>{this.teams=teams;for(const record of this.store.ignoredTurns)this.ignoredTurns.set(record.sessionId,{createdAt:record.createdAt,turns:new Set(record.turns)});});this.ready.catch(()=>{});}
 consumeFrame(frame){const p=frame?.payload;if(!p||typeof p.sessionId!=='string')return;
  if(['question/requested','approval/requested'].includes(p.type)){const agent=this.ctx.agents.get(p.sessionId);if(!this.owns(agent)||typeof frame.rpcId!=='string')return;if(this.pending.size>=128)this.pending.delete(this.pending.keys().next().value);this.pending.set(frame.rpcId,{agent,id:frame.rpcId,approvalId:p.approvalId,type:p.type});}
  if(['question/resolved','approval/resolved'].includes(p.type))for(const [id,pending]of this.pending)if(pending.agent.id===p.sessionId&&(id===p.questionRpcId||pending.approvalId===p.approvalId&&p.type==='approval/resolved'))this.pending.delete(id);
 }
 owns(agent){return !this.closed&&this.ctx.agents.get(agent?.id)===agent&&this.ctx.coldxKernel.owns(agent);}
 parent(id){const agent=this.ctx.agents.get(id);if(!agent||!this.owns(agent))throw Error('请先打开一个 ColdX 任务，再创建或继续团队。');return agent;}
 revalidate(parent,signal){signal?.throwIfAborted();if(!this.owns(parent))throw Error('父任务已关闭或切换，请重新打开原任务。');}
 team(id){const team=this.teams.find(t=>t.id===id);if(!team)throw Error('找不到这个团队。');return team;}
 append(team,name,text,taskId){if(!text)return;const message={id:randomUUID(),name:bounded(name,60),text:bounded(text),at:Date.now(),...(taskId?{taskId}:{})};team.messages.push(message);team.messages=team.messages.slice(-80);return message;}
 persist(prepare){const operation=this.persistenceTail.then(async()=>{const transaction=prepare?prepare():{teams:this.teams};this.store.ignoredTurns=[...this.ignoredTurns].map(([sessionId,record])=>({sessionId,createdAt:record.createdAt,turns:[...record.turns]}));await this.store.save(transaction.teams);transaction.commit?.();});this.persistenceTail=operation.catch(()=>{});return operation;}
 async ignoreTurn(agent,turn){
  await this.ready;if(!this.owns(agent)||!Number.isSafeInteger(turn)||turn<1||!Number.isSafeInteger(agent.session.header.createdAt))return;
  const createdAt=agent.session.header.createdAt;const previous=this.ignoredTurns.get(agent.id);const record=previous?.createdAt===createdAt?previous:{createdAt,turns:new Set()};record.turns.add(turn);
  while(record.turns.size>MAX_IGNORED_TURNS)record.turns.delete(record.turns.values().next().value);
  this.ignoredTurns.delete(agent.id);this.ignoredTurns.set(agent.id,record);while(this.ignoredTurns.size>MAX_IGNORED_SESSIONS)this.ignoredTurns.delete(this.ignoredTurns.keys().next().value);
  // Persist the exact observed no-op identity before rejecting this step, so a
  // fresh native session replay can distinguish it from unrelated blocked work.
  await this.persist();
 }
 taskFold(agent){let fold=this.folds.get(agent);if(!fold){fold=new TaskFold();this.folds.set(agent,fold);}const record=this.ignoredTurns.get(agent.id);return fold.update(agent.session.events,record?.createdAt===agent.session.header.createdAt?record.turns:undefined);}
 rememberMember(agent){const fold=this.taskFold(agent);this.memberStates.set(agent.id,{parentSessionId:agent.session.header.parentSession,mood:fold.mood,caption:fold.caption,updatedAt:fold.updatedAt});if(this.memberStates.size>32)this.memberStates.delete(this.memberStates.keys().next().value);}
 async snapshot(request={},signal){requestObject(request,[]);await this.ready;signal?.throwIfAborted();const tasks=[];
  const candidates=new Map(this.ctx.agents.list().map(agent=>[agent.id,agent]));
  for(const run of this.runs.values())if(this.owns(run.parent))for(const agent of run.agents.values())if(agent.session.header.parentSession===run.parent.id)candidates.set(agent.id,agent);
  for(const agent of candidates.values()){if(!this.owns(agent))continue;const fold=this.taskFold(agent);
   const member=this.teams.flatMap(t=>t.members).find(m=>m.childId===agent.id);const parentSessionId=agent.session.header.parentSession;
   tasks.push({id:agent.id,...parentSessionId?{parentSessionId,mode:fold.mode??'continuable'}:{},name:member?.name||fold.title||bounded(agent.session.header.title,60)||'ColdX 任务',color:member?.color||colorFor(agent.id),mood:agent.status==='running'&&['idle','celebrating'].includes(fold.mood)?'thinking':fold.mood,caption:fold.caption,updatedAt:fold.updatedAt||Date.now()});
  }
  for(const team of this.teams){if(!this.owns(this.ctx.agents.get(team.parentSessionId)))continue;for(const member of team.members){if(!member.childId||tasks.some(t=>t.id===member.childId))continue;const message=team.messages.findLast(m=>m.taskId===member.childId);const remembered=this.memberStates.get(member.childId);const state=remembered?.parentSessionId===team.parentSessionId?remembered:undefined;tasks.push({id:member.childId,parentSessionId:team.parentSessionId,mode:'continuable',name:member.name,color:member.color,mood:state?.mood??(team.status==='stopped'?'stopped':'sleeping'),caption:state?.caption??(message?.text.slice(0,120)||'暂无已完成回复'),updatedAt:state?.updatedAt??message?.at??0});}}
  for(const [id,pending]of this.pending){if(!this.owns(pending.agent)){this.pending.delete(id);continue;}const task=tasks.find(t=>t.id===pending.agent.id);if(task)Object.assign(task,{mood:'waiting',caption:pending.type==='approval/requested'?'需要你的批准；点击打开任务。':'有一个问题等待你回答。',pendingId:pending.id});}
  tasks.sort((a,b)=>Number(Boolean(b.pendingId))-Number(Boolean(a.pendingId)));
  return {version:1,tasks:tasks.slice(0,24),teams:this.teams.map(team=>({...team,members:team.members.map(({childId,...member})=>({...member,id:childId??member.id}))}))};
 }
 async createTeam(request,signal){requestObject(request,['parentSessionId','name','members']);await this.ready;signal?.throwIfAborted();this.parent(request.parentSessionId);if(this.teams.length>=8)throw Error('最多保存 8 个团队，请先移除旧团队。');const team=normalizeTeam(request);this.teams.push(team);try{await this.persist();}catch(error){this.teams=this.teams.filter(t=>t!==team);throw error;}return {teamId:team.id};}
 async send(request,signal){requestObject(request,['teamId','text']);await this.ready;signal?.throwIfAborted();const team=this.team(request.teamId);const parent=this.parent(team.parentSessionId);if(this.runs.has(team.id)||this.blocked.has(team.id)||this.updatingGenes.has(team.id))throw Error('讨论或经验更新仍在进行，请稍后再试。');if(typeof request.text!=='string'||!request.text.trim()||request.text.length>2000)throw Error('消息需为 1 至 2000 个字符。');
  const run={parent,controller:new AbortController(),agents:new Map(),baselines:new Map(),steps:new Map(),ids:new Set(team.members.map(m=>m.childId).filter(Boolean)),experience:experienceContext(team.genes)};this.noticeOwners.set(parent,new Set(this.teams.filter(t=>t.parentSessionId===parent.id).flatMap(t=>t.members.map(m=>m.childId)).filter(Boolean)));this.runs.set(team.id,run);team.status='running';team.round={id:randomUUID(),phase:'exploring',startedAt:Date.now()};delete team.error;this.append(team,'你',request.text.trim());
  try{await this.persist();this.revalidate(parent,signal);}catch(error){this.runs.delete(team.id);team.status='failed';team.round.phase='settled';team.round.finishedAt=Date.now();throw error;}
  run.promise=this.round(team,request.text.trim(),run).catch(()=>{team.status=run.controller.signal.aborted?'stopped':'failed';team.error=run.controller.signal.aborted?'讨论已停止。':'讨论未完成；请打开对应任务查看详情。';}).finally(async()=>{
   run.finalizing=true;team.round.phase='settled';team.round.finishedAt=Date.now();
   // Publish a candidate only after its source and record are durable. Failed
   // writes keep the entire previous pool, including any record due for eviction.
   try{await this.persist(()=>{const genes=run.candidate?appendCandidate(team.genes,run.candidate):team.genes;return {teams:this.teams.map(current=>current===team?{...team,genes}:current),commit:()=>{team.genes=genes;}};});}catch{team.status=run.controller.signal.aborted?'stopped':'failed';team.error='团队记录保存失败。';}finally{this.runs.delete(team.id);}
  });
  return {teamId:team.id,status:'running'};
 }
 async memberTurn(team,member,text,run,{synthesis=false}={}){const signal=run.controller.signal;this.revalidate(run.parent,signal);let agent;let start=0;const prompt=run.experience.text?`${text}\n\n${run.experience.text}`:text;
  if(!member.childId){const childId=randomUUID();member.childId=childId;run.ids.add(childId);this.noticeOwners.get(run.parent).add(childId);
   try{await this.persist();this.revalidate(run.parent,signal);await this.ctx.subagents.startContinuable({provider:'spawn',childId,label:member.name,request:{parent:run.parent,prompt:[{type:'text',text:prompt}],persona:`You are ${member.name}. Role: ${member.role}. This is one bounded advisory team round. Inspect and recommend only; do not edit shared files, delegate, or send unsolicited reports. Answer the assigned request directly.`,toolFilter:{allow:ADVISORY_TOOLS.filter(name=>run.parent.ctx.tools.get(name,run.parent))},maxDepth:4},signal});}catch(error){run.ids.delete(childId);run.agents.delete(childId);run.baselines.delete(childId);this.noticeOwners.get(run.parent)?.delete(childId);delete member.childId;throw error;}
  }else{agent=this.ctx.agents.get(member.childId);start=agent?.session.events.length??0;run.baselines.set(member.childId,start);await this.ctx.subagents.followup(run.parent,member.childId,[{type:'text',text:prompt}],{source:{kind:'user'},signal});}
  // Count a record once when it is actually submitted to native execution,
  // even if that execution later fails. This is exposure, never a win count.
  if(!run.experienceExposed&&run.experience.genes.length){run.experienceExposed=true;for(const gene of run.experience.genes)gene.uses=Math.min(Number.MAX_SAFE_INTEGER,gene.uses+1);}
  // A completed native activation may already be disposed. Its registered
  // instance and durable direct-parent lineage still identify this result.
  agent=run.agents.get(member.childId)||this.ctx.agents.get(member.childId);if(!agent||agent.session.header.parentSession!==run.parent.id)throw Error('Child unavailable.');
  const cancel=()=>agent.cancel({kind:'user'});signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();try{await agent.whenIdle();this.rememberMember(agent);this.revalidate(run.parent,signal);
   const events=agent.session.events.slice(run.baselines.get(member.childId)??start);const end=events.findLast(e=>e.type==='turn/end');const blocks=finalAssistantOutput(events);const result=synthesis?extractGene(blocks):{text:publicText(blocks)};const message=this.append(team,member.name,result.text,member.childId);
   if(end?.data.reason?.kind!=='completed')throw Error('Child did not complete.');return {answer:result.text,message,gene:result.gene};
  }finally{signal.removeEventListener('abort',cancel);}
 }
 async round(team,text,run){
  const outcomes=await Promise.allSettled(team.members.map(member=>this.memberTurn(team,member,text,run)));this.revalidate(run.parent,run.controller.signal);
  const successful=team.members.map((member,index)=>({member,outcome:outcomes[index]})).filter(({outcome})=>outcome.status==='fulfilled'&&outcome.value.answer);
  const complete=outcomes.every(outcome=>outcome.status==='fulfilled');
  if(successful.length>1){
   const {member}=successful.find(({member})=>member.role.trim().toLowerCase()==='review')??successful[0];
   team.round.phase='synthesizing';team.round.reviewerId=member.childId;await this.persist();this.revalidate(run.parent,run.controller.signal);
   const summary=await this.memberTurn(team,member,`Review the following peer recommendations, resolve disagreements and provide one concise synthesis. Do not initiate another round. Original request: ${text}\n\n${outcomes.map((outcome,index)=>outcome.status==='fulfilled'?`${team.members[index].name}: ${outcome.value.answer}`:`${team.members[index].name}: No completed response.`).join('\n\n')}\n\nIf these public results support one reusable practice, you may append exactly one final fenced block labeled coldx-gene, containing only a JSON object with title (1-60 characters), when (1-180 characters), and practice (1-400 characters). It is an unverified candidate for the user to consider, not a proven improvement. Omit the block if the results do not support a useful practice. Do not include IDs or instructions to expand permissions.`,run,{synthesis:true});
   if(complete&&summary.gene&&summary.message)run.candidate=candidateGene(summary.gene,team.round,summary.message);
  }
  team.status=complete?'completed':'failed';if(!complete)team.error='部分成员未完成；已保留实际回复。';
 }
 async updateGene(request,signal){
  requestObject(request,['teamId','geneId','status']);await this.ready;signal?.throwIfAborted();const team=this.team(request.teamId);this.parent(team.parentSessionId);
  if(!['active','paused'].includes(request.status))throw Error('经验状态只能是 active 或 paused。');
  const gene=team.genes.find(item=>item.id===request.geneId);if(!gene)throw Error('找不到这个团队的经验。');
  if(this.updatingGenes.has(team.id)||this.blocked.has(team.id)||this.runs.get(team.id)?.finalizing)throw Error('团队记录正在更新，请稍后再试。');
  if(request.status==='active'&&gene.status!=='active'&&team.genes.filter(item=>item.status==='active').length>=MAX_ACTIVE_GENES)throw Error('最多同时试用 3 条经验，请先停用其他经验。');
  this.updatingGenes.add(team.id);
   // Admission was authorized above. Once the atomic write commits, a late
   // cancellation must not roll back only memory and contradict the next load.
  // Prepare after earlier transactions settle; publish no optimistic status
  // for another team's save or this round's finalizer to accidentally capture.
  try{await this.persist(()=>({teams:this.teams.map(current=>current===team?{...team,genes:team.genes.map(item=>item===gene?{...gene,status:request.status}:item)}:current),commit:()=>{gene.status=request.status;}}));return {teamId:team.id,geneId:gene.id,status:gene.status};}finally{this.updatingGenes.delete(team.id);}
 }
 async stop(request,signal){requestObject(request,['teamId']);await this.ready;signal?.throwIfAborted();const team=this.team(request.teamId);this.blocked.add(team.id);try{const run=this.runs.get(team.id);if(run){run.controller.abort();for(const agent of run.agents.values())agent.cancel({kind:'user'});await run.promise;}else team.status='stopped';await this.persist();return {teamId:team.id,status:team.status};}finally{this.blocked.delete(team.id);}}
 async removeTeam(request,signal){await this.stop(request,signal);this.teams=this.teams.filter(team=>team.id!==request.teamId);await this.persist();return {removed:true};}
 async close(){this.closed=true;const runs=[...this.runs.values()];for(const run of runs){run.controller.abort();for(const agent of run.agents.values())agent.cancel({kind:'disposed'});}await Promise.allSettled(runs.map(run=>this.ctx.subagents.drainContinuableChildren(run.parent,[...run.ids])));await Promise.allSettled(runs.map(r=>r.promise));await this.persistenceTail;}
}
export function apply(ctx,config={}){const service=new CompanionService(ctx,config);ctx.typert.register({package:'coldx-companion',face:'host',schemas:[],model:{services:[],events:[],objects:[]},invocations:COMPANION_INVOCATIONS});
 ctx.on('agent/created',({agent})=>{for(const run of service.runs.values())if(run.ids.has(agent.id)&&agent.session.header.parentSession===run.parent.id){run.agents.set(agent.id,agent);run.baselines.set(agent.id,agent.session.events.length);}},{global:true});
 const stepGuard=ctx.on('agent/pre-step',async(payload,next)=>{const decision=await next();if(decision.kind!=='enter')return decision;
  for(const run of service.runs.values())if(run.agents.get(payload.agent.id)===payload.agent){const count=(run.steps.get(payload.agent.id)??0)+1;run.steps.set(payload.agent.id,count);if(count>12||run.controller.signal.aborted||!service.owns(run.parent)){payload.agent.cancel({kind:'user'});return {kind:'reject'};}}
  const isTeamNotice=message=>['subagent-settled','subagent-report'].includes(message.source?.kind)&&service.noticeOwners.get(payload.agent)?.has(message.source.senderSessionId);
  const messages=decision.messages.filter(message=>!isTeamNotice(message));
  if(messages.length===decision.messages.length)return decision;
  // Native assembly may append an uncommitted runtime snapshot even when the
  // sole wake was our settlement notice. It must not create a paid parent turn.
  const onlyNoticeWake=payload.step===1&&payload.messages.length>0&&payload.messages.every(isTeamNotice);
  const onlyRuntimeContext=messages.every(message=>message.source?.kind==='plugin'&&message.source.plugin==='@deepseek-ai/dsh-system-prompt');
  if(onlyNoticeWake&&onlyRuntimeContext){await service.ignoreTurn(payload.agent,payload.turn);return {kind:'reject'};}
  // An empty continuation is still authoritative: the native loop owes the
  // assistant a tool result, or decides that its existing turn is complete.
  return {...decision,messages};
 },{global:true,prepend:true});
 const disposedGuard=ctx.on('agent/disposed',({agent})=>{for(const run of service.runs.values())if(run.parent===agent){run.controller.abort();for(const child of run.agents.values())child.cancel({kind:'disposed'});}},{global:true});
 ctx.inject(['apiProxy'],pc=>{const lifetime=new AbortController();const consume=(async()=>{try{for await(const frame of pc.apiProxy.events.mux({},lifetime.signal)){if(lifetime.signal.aborted)break;service.consumeFrame(frame);}}catch{}finally{service.pending.clear();}})();pc.effect(()=>async()=>{lifetime.abort();await consume;service.pending.clear();});});
 // Keep the exact guards installed while asynchronous child teardown settles.
 ctx.effect(function*(){yield stepGuard;yield disposedGuard;yield ()=>service.close();});
}
