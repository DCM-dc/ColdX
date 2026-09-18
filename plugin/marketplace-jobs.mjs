import {randomUUID} from 'node:crypto';
import {mkdir,readFile,rename,stat,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

const terminal=new Set(['installed','active','needs-config','needs-restart','failed']);
const keyOf=record=>`${record.id}\0${record.packageId}`;
const text=value=>String(value??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').slice(-12_000);
const copy=value=>structuredClone(value);
const repairStates=new Set(['queued','running','completed','needs-attention']);
function audit(value){return{jobId:text(value.jobId),status:terminal.has(value.status)?value.status:'failed',version:text(value.version),message:text(value.message).slice(-1000),log:text(value.log).slice(-2000),updatedAt:Number(value.updatedAt)||0,...typeof value.ownerSessionId==='string'?{ownerSessionId:value.ownerSessionId}:{},...typeof value.rootSessionId==='string'?{rootSessionId:value.rootSessionId}:{},...typeof value.failureCode==='string'?{failureCode:text(value.failureCode)}:{}};}
function repairCopy(value){return{repairId:text(value.repairId),requestId:text(value.requestId),parentJobId:text(value.parentJobId),ownerSessionId:text(value.ownerSessionId),status:repairStates.has(value.status)?value.status:'needs-attention',createdAt:Number(value.createdAt)||0,...typeof value.messageId==='string'?{messageId:text(value.messageId)}:{},...typeof value.message==='string'?{message:text(value.message)}:{}};}

/** Profile-owned install operations; UI state and native tools read this same ledger. */
export class MarketplaceJobs {
  constructor({installer,statePath,now=Date.now}) {
    this.installer=installer;this.statePath=statePath;this.now=now;
    this.records=new Map();this.pending=new Map();this.queue=Promise.resolve();this.writes=Promise.resolve();
    this.controller=new AbortController();this.closed=false;this.persistenceNotice=undefined;
    this.ready=this.load();
  }
  async load() {
    if(!this.statePath)return;
    let source;
    try{source=(await stat(this.statePath)).size>8_000_000?null:await readFile(this.statePath,'utf8');}
    catch(error){if(error.code==='ENOENT')return;throw error;}
    let saved;
    try {
      if(source===null||source.length>8_000_000)throw Error('Plugin installation history exceeds its size limit.');
      saved=JSON.parse(source);
      if(![1,2].includes(saved?.version)||!Array.isArray(saved.installs))throw Error('Invalid plugin installation history.');
    } catch {
      // Keep the original evidence instead of overwriting a damaged receipt.
      await rename(this.statePath,this.statePath+'.corrupt-'+randomUUID());
      this.historyNotice='安装记录损坏，原文件已保留。市场已恢复，旧安装记录暂不可用。';
      return;
    }
    for(const value of saved.installs.slice(-100)) {
      if(!value||typeof value.id!=='string'||typeof value.packageId!=='string'||typeof value.jobId!=='string'||typeof value.version!=='string')continue;
      const record={id:value.id,packageId:value.packageId,jobId:value.jobId,version:value.version,
        status:terminal.has(value.status)?value.status:'failed',message:text(value.message),log:text(value.log),updatedAt:Number(value.updatedAt)||0,
        ...(Array.isArray(value.tools)?{tools:value.tools.filter(item=>typeof item==='string').slice(0,100)}:{}),
        ...(typeof value.url==='string'&&value.url.startsWith('https://github.com/')?{url:value.url}:{})};
      if(value.status==='installing')record.message='上次安装被中断，请重试。';
      if(typeof value.ownerSessionId==='string')record.ownerSessionId=value.ownerSessionId;
      if(typeof value.rootSessionId==='string')record.rootSessionId=value.rootSessionId;
      if(typeof value.parentJobId==='string')record.parentJobId=value.parentJobId;
      if(typeof value.failureCode==='string')record.failureCode=text(value.failureCode);
      if(Array.isArray(value.attempts))record.attempts=value.attempts.slice(-10).filter(item=>item&&typeof item.jobId==='string').map(audit);
      if(Array.isArray(value.repairs))record.repairs=value.repairs.slice(-10).filter(item=>item&&typeof item.repairId==='string'&&typeof item.ownerSessionId==='string').map(item=>repairCopy({...item,...['queued','running'].includes(item.status)?{status:'needs-attention',message:'上次修复被中断，请在原任务继续。'}:{}}));
      this.records.set(keyOf(record),record);
    }
  }
  snapshot(){return [...this.records.values()].sort((a,b)=>b.updatedAt-a.updatedAt).map(copy);}
  persist() {
    if(!this.statePath)return Promise.resolve();
    const content=JSON.stringify({version:2,installs:this.snapshot().reverse().slice(-100)},null,2)+'\n';
    const write=async()=>{
      try {
        await mkdir(dirname(this.statePath),{recursive:true});const temp=this.statePath+'.tmp';await writeFile(temp,content);await rename(temp,this.statePath);
        this.persistenceNotice=undefined;
      } catch(error) {this.persistenceNotice=`安装记录保存失败：${text(error.message)}`;throw error;}
    };
    const next=this.writes.then(write,write);this.writes=next.catch(()=>{});return next;
  }
  async start(request,meta,{signal,agent,ownerSessionId=agent?.id,rootSessionId}={}) {
    await this.ready;
    if(this.closed)throw Error('Plugin marketplace is closed.');
    signal?.throwIfAborted();
    const key=keyOf(request),previous=this.records.get(key);
    if(previous&&(previous.status==='installing'||(previous.status!=='failed'&&previous.version===meta.version)))return copy(previous);
    const record={id:request.id,packageId:request.packageId,version:meta.version,jobId:randomUUID(),status:'installing',message:'等待安装…',log:'',updatedAt:this.now(),url:`https://github.com/${request.id}`};
    if(ownerSessionId)record.ownerSessionId=ownerSessionId;
    if(rootSessionId)record.rootSessionId=rootSessionId;
    if(previous){record.parentJobId=previous.jobId;record.attempts=[...(previous.attempts??[]),audit(previous)].slice(-10);record.repairs=(previous.repairs??[]).map(item=>({...item,...item.ownerSessionId===ownerSessionId&&['queued','running'].includes(item.status)?{status:'running'}:{}}));}
    this.records.set(key,record);
    const operation=new AbortController();
    const combined=AbortSignal.any([operation.signal,this.controller.signal,...signal?[signal]:[]]);
    const started=this.persist();
    let phase='queued',completion,resolveResult;
    const promise=new Promise(resolve=>{resolveResult=resolve;});
    const fail=error=>{record.status='failed';record.message=text(error?.message||error);record.failureCode=text(error?.code||'install-failed');record.log=text(record.log+'\n'+record.message);};
    const finish=()=>{
      if(completion)return completion;
      combined.removeEventListener('abort',abortQueued);record.updatedAt=this.now();
      for(const repair of record.repairs??[])if(repair.status==='running'){repair.status=record.status==='active'?'completed':'needs-attention';repair.message=record.message;}
      completion=(async()=>{
        try{await this.persist();}catch{/* persist retains the write failure independently of runtime inspection. */}
        this.pending.delete(record.jobId);const value=copy(record);resolveResult(value);return value;
      })();
      return completion;
    };
    const abortQueued=()=>{
      if(phase!=='queued')return;
      // A queued job has no installer to drain. Publish cancellation now while
      // leaving the unrelated running job and the serialization chain intact.
      phase='cancelled';fail(combined.reason);void finish();
    };
    const execute=async()=>{
      if(phase==='cancelled')return promise;
      phase='running';combined.removeEventListener('abort',abortQueued);
      try {
        await started;combined.throwIfAborted();
        const result=await this.installer.install(meta,{signal:combined,agent,onProgress:update=>{
          if(record.status!=='installing')return;
          record.message=text(typeof update==='string'?update:update?.message||update?.phase);
          record.log=text(record.log+'\n'+record.message);record.updatedAt=this.now();
        }});
        combined.throwIfAborted();
        if(!result||!terminal.has(result.status)||result.status==='failed')throw Error(result?.message||'Installer did not return a verified outcome.');
        record.status=result.status;record.message=text(result.message||'安装已完成。');
        if(Array.isArray(result.tools))record.tools=result.tools.filter(item=>typeof item==='string').slice(0,100);
      } catch(error) {
        fail(error);
      } finally {
        await finish();
      }
      return copy(record);
    };
    const queued=this.queue.then(execute,execute);this.queue=queued.then(()=>{},()=>{});
    this.pending.set(record.jobId,{promise,controller:operation,ownerSignal:signal});
    combined.addEventListener('abort',abortQueued,{once:true});if(combined.aborted)abortQueued();
    await started;
    return copy(record);
  }
  async wait(jobId,signal) {
    await this.ready;signal?.throwIfAborted();
    const pending=this.pending.get(jobId);
    if(pending){
      // The originating caller drains its own cancelled installation. Another
      // caller may stop observing without cancelling the user's shared job.
      if(!signal||pending.ownerSignal===signal)return copy(await pending.promise);
      return new Promise((resolve,reject)=>{
        const abort=()=>{cleanup();reject(signal.reason);};
        const cleanup=()=>signal.removeEventListener('abort',abort);
        signal.addEventListener('abort',abort,{once:true});
        if(signal.aborted)return abort();
        pending.promise.then(value=>{cleanup();resolve(copy(value));},error=>{cleanup();reject(error);});
      });
    }
    const record=[...this.records.values()].find(row=>row.jobId===jobId);
    if(!record)throw Error('Unknown plugin installation.');
    return copy(record);
  }
  async beginRepair(jobId,ownerSessionId,requestId){
    await this.ready;if(this.closed)throw Error('Plugin marketplace is closed.');
    const record=[...this.records.values()].find(value=>value.jobId===jobId||value.attempts?.some(item=>item.jobId===jobId));
    if(!record)throw Error('安装记录不存在，请刷新。');
    const duplicate=record.repairs?.find(value=>value.requestId===requestId);
    if(duplicate){if(duplicate.ownerSessionId!==ownerSessionId)throw Error('修复属于另一任务。');return copy(duplicate);}
    if(record.jobId!==jobId||!['failed','needs-config','needs-restart'].includes(record.status))throw Error('请使用当前未完成的安装记录。');
    const repairOwner=record.rootSessionId??record.ownerSessionId;
    if(repairOwner&&repairOwner!==ownerSessionId)throw Error('请回到原任务修复安装。');
    const pending=record.repairs?.find(value=>['queued','running'].includes(value.status));if(pending)return copy(pending);
    record.ownerSessionId??=ownerSessionId;record.rootSessionId??=ownerSessionId;const repair={repairId:randomUUID(),requestId,parentJobId:jobId,ownerSessionId,status:'queued',createdAt:this.now()};record.repairs=[...(record.repairs??[]),repair].slice(-10);record.updatedAt=this.now();await this.persist();return copy(repair);
  }
  async bindRootOwner(jobId,expectedOwnerSessionId,rootSessionId){await this.ready;const record=[...this.records.values()].find(value=>value.jobId===jobId);if(!record||record.ownerSessionId!==expectedOwnerSessionId||record.rootSessionId&&record.rootSessionId!==rootSessionId)throw Error('安装任务归属已变化，请刷新。');record.rootSessionId=rootSessionId;await this.persist();return copy(record);}
  async recordAssistance(request,{version='unpublished',message='此项目需要 AI 检查安装方法。',ownerSessionId}={}){
    await this.ready;if(this.closed)throw Error('Plugin marketplace is closed.');const key=keyOf(request),existing=this.records.get(key);if(existing)return copy(existing);
    const record={...request,version,ownerSessionId,jobId:randomUUID(),status:'failed',failureCode:'assisted-install-required',message:text(message),log:'尚未执行安装；等待 AI 诊断。',updatedAt:this.now(),url:`https://github.com/${request.id}`};this.records.set(key,record);await this.persist();return copy(record);
  }
  async updateRepair(repairId,update){await this.ready;for(const record of this.records.values()){const repair=record.repairs?.find(value=>value.repairId===repairId);if(!repair)continue;if(update.status&&!repairStates.has(update.status))throw Error('Invalid repair state.');for(const key of ['status','messageId','message'])if(typeof update[key]==='string')repair[key]=text(update[key]);record.updatedAt=this.now();await this.persist();return copy(repair);}throw Error('Unknown plugin repair.');}
  async reconcile(installed) {
    await this.ready;
    if(!Array.isArray(installed))return;
    let changed=false;
    for(const record of this.records.values()) {
      // Existing files are insufficient evidence that a failed verification or
      // activation succeeded. Only a new admitted install may clear that failure.
      if(record.status==='installing'||record.status==='failed')continue;
      const actual=installed.find(item=>item.packageId===record.packageId);
      if(actual&&terminal.has(actual.status)&&actual.status!=='failed') {
        if(record.status!==actual.status||record.version!==actual.version||record.message!==actual.message){
          record.status=actual.status;record.version=actual.version||record.version;record.message=text(actual.message);changed=true;
        }
      } else if(!actual&&record.status!=='failed') {record.status='failed';record.message='插件当前未安装，可能已被移除。';changed=true;}
    }
    if(changed)await this.persist();
  }
  async dispose(){
    if(this.disposal)return this.disposal;
    this.closed=true;this.controller.abort(new Error('Plugin marketplace closed.'));
    this.disposal=(async()=>{await this.ready.catch(()=>{});await this.queue;await this.writes;})();
    return this.disposal;
  }
}
