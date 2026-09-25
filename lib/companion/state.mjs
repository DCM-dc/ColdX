import {randomUUID} from 'node:crypto';
import {recoverGenes,recoverRound} from './growth.mjs';
export const COLORS=['coral','peach','gold','mint','sky','lilac','pink','blue'];
export const bounded=(value,max=2000)=>typeof value==='string'?value.slice(0,max):'';
export const publicText=blocks=>(Array.isArray(blocks)?blocks:[]).filter(block=>block?.type==='text').map(block=>bounded(block.text)).join('\n').slice(0,2000);
export function colorFor(id){let hash=0;for(const c of id)hash=(hash*31+c.charCodeAt(0))>>>0;return COLORS[hash%COLORS.length];}
function required(value,max,label){if(typeof value!=='string'||!value.trim()||value.length>max)throw Error(`Invalid ${label}.`);return value.trim();}
export function normalizeTeam(input){
 if(!input||!Array.isArray(input.members)||input.members.length<1||input.members.length>4)throw Error('Choose one to four team members.');
 const parentSessionId=required(input.parentSessionId,200,'parent task');
 return {id:randomUUID(),parentSessionId,name:bounded(input.name,80).trim()||'小绒团队',status:'idle',members:input.members.map((member,index)=>({id:randomUUID(),name:required(member.name,60,'member name'),role:required(member.role,500,'member role'),color:COLORS.includes(member.color)?member.color:COLORS[index]})),messages:[],genes:[]};
}
export function recoverTeams(value){
 if(!Array.isArray(value))return [];
 return value.slice(0,8).flatMap(raw=>{try{const safe=normalizeTeam(raw);if(typeof raw.id!=='string'||raw.id.length>200)return [];
 const members=safe.members.map((m,i)=>({...m,id:bounded(raw.members[i].id,200)||m.id,...raw.members[i].childId?{childId:bounded(raw.members[i].childId,200)}:{}}));
 const messages=(Array.isArray(raw.messages)?raw.messages:[]).slice(-80).filter(m=>m&&typeof m==='object').map(m=>({id:bounded(m.id,200)||randomUUID(),name:bounded(m.name,60),text:bounded(m.text),at:Number.isFinite(m.at)?m.at:0,...m.taskId?{taskId:bounded(m.taskId,200)}:{}}));
 const round=recoverRound(raw.round,members);
 return [{...safe,id:raw.id,status:raw.status==='running'?'interrupted':['idle','completed','stopped','failed','interrupted'].includes(raw.status)?raw.status:'interrupted',members,messages,genes:recoverGenes(raw.genes,members,messages),...(round?{round}:{}),...(raw.status==='running'?{error:'上次讨论因应用退出而中断；发送新消息可继续。'}:{})}];}catch{return [];}});
}
export class TaskFold{
 index=0;caption='';mood='idle';updatedAt=0;mode=undefined;title='';reason=undefined;
 push(event,ignoredTurns){const data=event.data??{};
  if(event.type==='turn/start')this.beforeTurn={caption:this.caption,mood:this.mood,updatedAt:this.updatedAt,reason:this.reason};
  if(event.type==='turn/end'&&data.reason?.kind==='blocked'&&ignoredTurns?.has(data.turn)&&this.beforeTurn){Object.assign(this,this.beforeTurn);return;}
  this.updatedAt=event.time||this.updatedAt;
  if(event.type==='subagent/descriptor'){this.mode=data.mode;this.title=bounded(data.label,60);}
  if(event.type==='turn/start'){this.mood='thinking';this.reason=undefined;this.caption='';}
  if(event.type==='tool/call')this.mood='working';
  if(event.type==='assistant/chunk'&&data.chunk?.type==='text-delta'){this.mood='speaking';this.caption=bounded(this.caption+bounded(data.chunk.text),120);}
  if(event.type==='assistant/message'){const text=publicText(data.message?.content);if(text)this.caption=text.slice(0,120);}
  if(event.type==='turn/end'){this.reason=data.reason?.kind;this.mood=this.reason==='completed'?'celebrating':['aborted','cancelled'].includes(this.reason)?'stopped':'problem';}
 }
 update(events,ignoredTurns){if(events.length<this.index){this.index=0;this.caption='';this.mood='idle';this.beforeTurn=undefined;}for(;this.index<events.length;this.index++)this.push(events[this.index],ignoredTurns);return this;}
}
