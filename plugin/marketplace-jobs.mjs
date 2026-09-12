import {randomUUID} from 'node:crypto';
import {mkdir,readFile,rename,stat,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

const terminal=new Set(['installed','active','needs-config','needs-restart','failed']);
const keyOf=record=>`${record.id}\0${record.packageId}`;
const text=value=>String(value??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').slice(-12_000);
const copy=value=>structuredClone(value);

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
    try{source=(await stat(this.statePath)).size>3_000_000?null:await readFile(this.statePath,'utf8');}
    catch(error){if(error.code==='ENOENT')return;throw error;}
    let saved;
    try {
      if(source===null||source.length>3_000_000)throw Error('Plugin installation history exceeds its size limit.');
      saved=JSON.parse(source);
      if(saved?.version!==1||!Array.isArray(saved.installs))throw Error('Invalid plugin installation history.');
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
      this.records.set(keyOf(record),record);
    }
  }
  snapshot(){return [...this.records.values()].sort((a,b)=>b.updatedAt-a.updatedAt).map(copy);}
  persist() {
    if(!this.statePath)return Promise.resolve();
    const content=JSON.stringify({version:1,installs:this.snapshot().reverse().slice(-100)},null,2)+'\n';
    const write=async()=>{
      try {
        await mkdir(dirname(this.statePath),{recursive:true});const temp=this.statePath+'.tmp';await writeFile(temp,content);await rename(temp,this.statePath);
        this.persistenceNotice=undefined;
      } catch(error) {this.persistenceNotice=`安装记录保存失败：${text(error.message)}`;throw error;}
    };
    const next=this.writes.then(write,write);this.writes=next.catch(()=>{});return next;
  }
  async start(request,meta,{signal,agent}={}) {
    await this.ready;
    if(this.closed)throw Error('Plugin marketplace is closed.');
    signal?.throwIfAborted();
    const key=keyOf(request),previous=this.records.get(key);
    if(previous&&(previous.status==='installing'||(previous.status!=='failed'&&previous.version===meta.version)))return copy(previous);
    const record={id:request.id,packageId:request.packageId,version:meta.version,jobId:randomUUID(),status:'installing',message:'等待安装…',log:'',updatedAt:this.now(),url:`https://github.com/${request.id}`};
    this.records.set(key,record);
    const operation=new AbortController();
    const combined=AbortSignal.any([operation.signal,this.controller.signal,...signal?[signal]:[]]);
    const started=this.persist();
    let phase='queued',completion,resolveResult;
    const promise=new Promise(resolve=>{resolveResult=resolve;});
    const fail=error=>{record.status='failed';record.message=text(error?.message||error);record.log=text(record.log+'\n'+record.message);};
    const finish=()=>{
      if(completion)return completion;
      combined.removeEventListener('abort',abortQueued);record.updatedAt=this.now();
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
