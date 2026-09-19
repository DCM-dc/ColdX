import {nativeImport} from './page-native.mjs';
import {verifyChildRead} from './child-read-access.mjs';
import {RequestScheduler} from '../lib/kernel/scheduler.mjs';
import {ContextMeter} from '../lib/kernel/context-meter.mjs';
import {KernelLedger} from '../lib/kernel/ledger.mjs';

const {TypertRemoteService}=await nativeImport('@deepseek-ai/dsh-typert-protocol');
const {isAgentLoopRequest}=await nativeImport('@deepseek-ai/dsh-llm');
const {scopeChainOf}=await nativeImport('@deepseek-ai/dsh-scope');
export const name='coldx-kernel';
export const inject=['agents','llm','tools','typert'];
const requestParameter={name:'request',wire:'request',source:'json',codec:{mode:'src-json'}};
export const KERNEL_INVOCATIONS=[
  {id:'coldx-kernel:read',service:'coldxKernel',namespace:'coldxKernel',method:'read',invocation:{kind:'direct'},parameters:[
    {name:'agent',wire:'agentId',source:'lookup',lookup:'agent',codec:{mode:'src-json'}},requestParameter],cancellation:{parameter:'signal'},result:{mode:'src-json'}},
  {id:'coldx-kernel:read-child',service:'coldxKernel',namespace:'coldxKernel',method:'readChild',invocation:{kind:'direct'},parameters:[
    {name:'address',wire:'address',source:'json',codec:{mode:'src-json'}},requestParameter],cancellation:{parameter:'signal'},result:{mode:'src-json'}},
];
function validateRequest(request){if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).length)throw Error('Invalid kernel metrics request.');}

export class KernelService extends TypertRemoteService {
  constructor(ctx,{limit=4,maxQueued=64}={}){
    super(ctx,'coldxKernel');this.scopes=new WeakMap();this.lifetime=new AbortController();this.closingAgents=new Set();
    this.scheduler=new RequestScheduler({limit,maxQueued});this.meter=new ContextMeter();this.ledger=new KernelLedger();
  }
  async close(){
    const agents=this.ctx.agents.list().filter(agent=>this.owns(agent));
    this.closingAgents=new Set(agents);
    this.lifetime.abort(new Error('ColdX kernel is closed.'));this.scheduler.dispose();
    // Cancel the native owner of the frozen provider/tool signal. Keep the
    // status guard installed until the native wake latch reaches quiescence.
    for(const agent of agents)agent.cancel({kind:'disposed'},{keepInbox:true});
    await Promise.allSettled(agents.map(agent=>agent.whenIdle()));
    this.closingAgents.clear();this.ledger.clear();
  }
  attach(scope){this.scopes.set(scope,(this.scopes.get(scope)??0)+1);let removed=false;return()=>{if(removed)return;removed=true;const count=this.scopes.get(scope)??0;if(count<=1)this.scopes.delete(scope);else this.scopes.set(scope,count-1);};}
  owns(agent){
    if(this.lifetime.signal.aborted||!agent||this.ctx.agents.get(agent.id)!==agent)return false;
    const seen=new Set();
    for(let current=agent;current&&!seen.has(current);){
      seen.add(current);
      if(scopeChainOf(current).some(scope=>this.scopes.has(scope)))return true;
      const parent=this.ctx.agents.get(current.session?.header?.parentSession);
      // Durable lineage alone never grants runtime ownership.
      current=parent&&this.ctx.agents.isOwnedBy(current.id,parent)?parent:undefined;
    }
    return false;
  }
  snapshot(id){return{version:1,scheduler:this.scheduler.snapshot(),session:this.ledger.snapshot(id)};}
  read(agent,request,signal){validateRequest(request);signal?.throwIfAborted();if(!this.owns(agent))throw Error('Kernel metrics require an exact live ColdX Agent.');return this.snapshot(agent.id);}
  async readChild(address,request,signal){
    validateRequest(request);const combined=signal?AbortSignal.any([signal,this.lifetime.signal]):this.lifetime.signal;
    combined.throwIfAborted();const parent=this.ctx.agents.get(address?.parentSessionId);
    if(!this.owns(parent))throw Error('Kernel child metrics require their live ColdX parent.');
    const child=await verifyChildRead(this.ctx,address,combined);const value=this.snapshot(child.sessionId);
    await child.revalidate();combined.throwIfAborted();
    if(!this.owns(parent))throw Error('Kernel child parent changed during read.');
    return value;
  }
  async *stream(agent,options,next){
    const signal=options.signal?AbortSignal.any([options.signal,this.lifetime.signal]):this.lifetime.signal;
    const record=this.ledger.start(agent.id,this.meter.measure(options));
    let release,outcome='cancelled';
    try{
      release=await this.scheduler.acquire({owner:agent.id,priority:agent.session?.header?.origin==='subagent'?'normal':'interactive',signal});
      signal.throwIfAborted();if(!this.owns(agent))throw Error('ColdX Agent was released before request admission.');record.admitted();
      for await(const chunk of next()){
        signal.throwIfAborted();record.chunk(chunk);
        if(chunk.type==='finish')outcome=chunk.reason?.kind==='error'?'failed':['aborted','cancelled'].includes(chunk.reason?.kind)?'cancelled':'completed';
        yield chunk;
      }
    }catch(error){outcome=signal.aborted?'cancelled':'failed';throw error;}
    finally{release?.();record.end(outcome);}
  }
}

export function apply(ctx,config={}){
  const service=new KernelService(ctx,config);
  ctx.typert.register({package:'coldx-kernel',face:'host',schemas:[],model:{services:[],events:[],objects:[]},invocations:KERNEL_INVOCATIONS});
  ctx.on('llm/stream',(options,next)=>{
    if(!isAgentLoopRequest(options)||!options.sessionId)return next();
    const agent=ctx.agents.get(options.sessionId);return service.owns(agent)?service.stream(agent,options,next):next();
  },{global:true,prepend:true});
  const dispatched=new WeakMap();
  ctx.on('tools/execute',(exec,next)=>{
    if(service.owns(exec.agent))dispatched.set(exec,performance.now());
    return next();
  },{global:true});
  ctx.on('tools/result',(exec,result)=>{
    const start=dispatched.get(exec);dispatched.delete(exec);
    if(service.owns(exec.agent))service.ledger.tool(exec.agent.id,{
      durationMs:start===undefined?undefined:Math.max(0,performance.now()-start),isError:result.isError===true,
    });
  },{global:true});
  const statusGuard=ctx.on('agent/status',({agent,status})=>{
    if(status==='running'&&service.closingAgents.has(agent))agent.cancel({kind:'disposed'},{keepInbox:true});
  },{global:true});
  // Yield the exact disposer so Cordis nests it in the composite effect.
  // Sibling effects can otherwise detach the guard while close is awaiting.
  ctx.effect(function*(){yield statusGuard;yield ()=>service.close();});
}
