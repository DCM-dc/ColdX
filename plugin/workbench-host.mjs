import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {nativeImport} from './page-native.mjs';
const {TypertRemoteService}=await nativeImport('@deepseek-ai/dsh-typert-protocol');
const nativeSchedule=await nativeImport('@deepseek-ai/dsh-schedule');
const {foldScheduleEvents,scheduleView}=nativeSchedule;
const run=promisify(execFile);
export const name='coldx-workbench';
export const inject=['agents','tools','sessionQuery','typert'];
export const WORKBENCH_INVOCATIONS=['schedules','schedule','pullRequests'].map(method=>({id:`coldx-workbench:${method}`,service:'coldxWorkbench',namespace:'coldxWorkbench',method,invocation:{kind:'direct'},parameters:[{name:'request',wire:'request',source:'json',codec:{mode:'src-json'}}],cancellation:{parameter:'signal'},result:{mode:'src-json'}}));
function object(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw Error('无效的工作台请求。');}
export class WorkbenchService extends TypertRemoteService {
  constructor(ctx,{execute=run}={}){super(ctx,'coldxWorkbench');this.execute=execute;}
  agent(id){if(typeof id!=='string')throw Error('请先选择一个任务。');const agent=this.ctx.agents.get(id);if(!agent||agent.session.header.parentSession)throw Error('请打开所属的主任务后重试。');return agent;}
  async schedules(request={},signal){
    object(request,[]);const records=await this.ctx.sessionQuery.listSessions(signal),items=[];let unavailable=0;
    for(const row of records.slice(0,1000)){
      signal?.throwIfAborted();const id=row.header?.id;if(!id)continue;
      try {const live=this.ctx.agents.get(id),log=live?.session??await this.ctx.sessionQuery.readSession(id);if(log.header?.parentSession)continue;
        for(const record of foldScheduleEvents(log.events,log.header?.seedLength??0).active)items.push({...scheduleView(record,Date.now()),sessionId:id,title:log.header?.title||'未命名任务',live:Boolean(live)});
      }catch(error){signal?.throwIfAborted();unavailable++;}
    }
    return {items,unavailable,truncated:records.length>1000};
  }
  async schedule(request,signal){
    object(request,['sessionId','operation','prompt','at','everySeconds','id']);signal?.throwIfAborted();const agent=this.agent(request.sessionId);
    if(!['create','delete'].includes(request.operation))throw Error('无效的定时任务操作。');
    const args=request.operation==='delete'?{id:request.id}:{prompt:request.prompt,...request.at?{at:request.at}:{every_seconds:request.everySeconds}};
    if(request.operation==='delete'&&(typeof args.id!=='string'||!args.id))throw Error('请选择一个定时任务。');
    if(request.operation==='create'&&(typeof args.prompt!=='string'||!args.prompt.trim()||args.prompt.length>16000))throw Error('请输入任务内容（不超过 16000 字）。');
    // Use the native tool pipeline, including policy, validation and persistence.
    const result=await agent.ctx.tools.execute({name:`schedule_${request.operation}`,arguments:args,agent,callId:`coldx-ui-${randomUUID()}`,signal:signal??new AbortController().signal});
    if(result.isError)throw Error(result.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n')||'定时任务操作失败。');
    if(result.value?.code)throw Error(result.value.message||result.value.code);
    return result.value;
  }
  async pullRequests(request,signal){
    object(request,['sessionId']);const agent=this.agent(request.sessionId);signal?.throwIfAborted();const cwd=agent.session.header.cwd;
    if(typeof cwd!=='string')throw Error('当前任务没有工作目录。');
    try{
      const {stdout}=await this.execute('gh',['pr','list','--limit','50','--json','number,title,url,state,isDraft,updatedAt,headRefName,author'],{cwd,windowsHide:true,timeout:20000,maxBuffer:1024*1024,signal});
      const items=JSON.parse(stdout);if(!Array.isArray(items))throw Error('invalid response');
      return {items:items.filter(item=>{try{const url=new URL(item.url);return url.protocol==='https:'&&!url.username&&!url.password;}catch{return false;}}),limited:items.length===50};
    }catch(error){signal?.throwIfAborted();return {items:[],unavailable:true,message:error.code==='ENOENT'?'需要安装 GitHub CLI 后才能读取 Pull Request。':'无法读取当前项目的 Pull Request。请确认该目录是 Git 仓库，并在 GitHub CLI 中完成连接。'};}
  }
}
export function apply(ctx){
  // The pinned DSH base ships schedule but does not activate it in its web
  // composition. Mount its lifecycle once, before the first root is created.
  ctx.plugin(nativeSchedule);
  new WorkbenchService(ctx);ctx.typert.register({package:name,face:'host',schemas:[],model:{services:[],events:[],objects:[]},invocations:WORKBENCH_INVOCATIONS});
}
