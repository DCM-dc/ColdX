import {join,resolve} from 'node:path';
import {nativeImport} from './page-native.mjs';
import {SuperpowersStore} from './superpowers-store.mjs';
import {SUPERPOWERS_DSH_GUIDANCE} from './superpowers-adapter.mjs';

const {TypertRemoteService}=await nativeImport('@deepseek-ai/dsh-typert-protocol');
export const name='coldx-superpowers';
export const inject=['agents','skills','typert'];
export const SUPERPOWERS_INVOCATIONS=['state','setting','check','stage','activate'].map(method=>({
  id:'coldx-superpowers:'+method,service:'coldxSuperpowers',namespace:'coldxSuperpowers',method,
  invocation:{kind:'direct'},parameters:[{name:'request',wire:'request',source:'json',codec:{mode:'src-json'}}],
  cancellation:{parameter:'signal'},result:{mode:'src-json'},
}));
function object(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw Error('Invalid Superpowers request.');}

export class SuperpowersService extends TypertRemoteService {
  constructor(ctx,store){super(ctx,'coldxSuperpowers');this.store=store;this.pins=new Map();this.disposed=false;this.checking=undefined;this.nextAutoCheck=0;}
  enabledFor(agent){return !this.disposed&&this.store.state().enabled&&this.pins.has(agent)&&this.ctx.agents.get(agent.id)===agent;}
  owner(agent){return this.ctx.agents.list().find(parent=>parent!==agent&&this.ctx.agents.isOwnedBy(agent.id,parent));}
  root(agent){const visited=new Set();while(!visited.has(agent)){visited.add(agent);const parent=this.owner(agent);if(!parent)return agent;agent=parent;}return agent;}
  refresh(){
    const active=this.store.state().active.commit;
    for(const [agent,pin]of this.pins){const root=this.root(agent);const family=[...this.pins.keys()].filter(item=>this.root(item)===root);if(!family.some(item=>item.status==='running'))pin.commit=active;pin.invalidate?.();}
  }
  attach(agent){
    if(this.disposed||this.pins.has(agent))return;
    const parent=this.owner(agent),pin={commit:this.pins.get(parent)?.commit??this.store.state().active.commit};this.pins.set(agent,pin);
    pin.dispose=agent.ctx.get('skills').registerProvider(control=>{
      pin.invalidate=control.invalidate;
      return{name:'coldx-superpowers',list:async options=>{
        if(!this.enabledFor(agent))return[];options.signal?.throwIfAborted();const snapshot=await this.store.snapshot(pin.commit);
        // DSH resolves nearer scope layers before rank. This provider is scoped
        // for version pinning, so explicitly leave host catalog names to their
        // project/user/runtime winner instead of shadowing them with a bundle.
        const inherited=new Set((await this.ctx.skills.list({cwd:options.cwd,signal:options.signal})).map(skill=>skill.name));
        return snapshot.skills.filter(skill=>!inherited.has(skill.name)).map(skill=>({name:skill.name,description:skill.description,invocation:skill.invocation,source:'bundled',provider:'coldx-superpowers',rank:600,resourceBase:{kind:'directory',path:skill.directory},path:skill.absolutePath,locator:{commit:pin.commit,name:skill.name}}));
      },get:async(candidate,options)=>{
        if(!this.enabledFor(agent)||candidate.locator?.commit!==pin.commit)return undefined;
        options.signal?.throwIfAborted();const snapshot=await this.store.snapshot(pin.commit),skill=snapshot.skills.find(item=>item.name===candidate.name);if(!skill)return undefined;
        return{name:skill.name,description:skill.description,invocation:skill.invocation,source:'bundled',provider:'coldx-superpowers',resourceBase:{kind:'directory',path:skill.directory},path:skill.absolutePath,content:skill.content+'\n\n'+SUPERPOWERS_DSH_GUIDANCE};
      }};
    });
  }
  detach(agent){const pin=this.pins.get(agent);if(!pin)return;this.pins.delete(agent);pin.dispose?.();this.refresh();}
  state(request,signal){object(request,[]);signal?.throwIfAborted();const value=this.store.state();return{...value,pinnedOlderTasks:[...this.pins].filter(([agent,pin])=>this.root(agent)===agent&&pin.commit!==value.active.commit).length};}
  async setting(request,signal){object(request,['enabled','autoCheck','expectedRevision']);signal?.throwIfAborted();await this.store.setting(request);return this.state({},signal);}
  async check(request,signal){object(request,[]);await this.store.check({signal});return this.state({},signal);}
  async stage(request,signal){object(request,['candidateId']);if(typeof request.candidateId!=='string')throw Error('Invalid candidate.');await this.store.stage({...request,signal});return this.state({},signal);}
  async activate(request,signal){object(request,['candidateId','expectedActiveCommit']);signal?.throwIfAborted();await this.store.activate(request);return this.state({},signal);}
  async autoCheck(){
    if(this.disposed||this.checking||!this.store.state().autoCheck||Date.now()<this.nextAutoCheck)return;
    const last=this.store.state().lastCheckedAt;if(last&&Date.now()-last<24*60*60*1000)return;
    this.checking=(async()=>{try{await this.store.check();const candidate=this.store.state().candidate;if(candidate&&candidate.status!=='ready')await this.store.stage({candidateId:candidate.id});this.nextAutoCheck=Date.now()+24*60*60*1000;}catch(error){this.nextAutoCheck=Date.now()+60*60*1000;this.store.data.notice='Superpowers 更新暂时不可用：'+String(error.message).slice(0,200);this.store.notify();}})().finally(()=>{this.checking=undefined;});
    return this.checking;
  }
  async dispose(){this.disposed=true;for(const pin of this.pins.values())pin.dispose?.();this.pins.clear();await this.store.dispose();await this.checking;}
}

export async function apply(ctx,config={}) {
  const profileDir=resolve(config.profileDir??join(config.home??process.env.DSH_HOME??'.runtime','profiles','web'));
  const store=config.store??new SuperpowersStore({root:join(profileDir,'.coldx-superpowers')});await store.ready;
  const service=new SuperpowersService(ctx,store);
  ctx.typert.register({package:'coldx-superpowers',face:'host',schemas:[],model:{services:[],events:[],objects:[]},invocations:SUPERPOWERS_INVOCATIONS});
  for(const agent of ctx.agents.list())service.attach(agent);
  ctx.on('agent/created',({agent})=>service.attach(agent));
  ctx.on('agent/disposed',({agent})=>service.detach(agent));
  ctx.on('agent/status',()=>service.refresh());
  ctx.effect(()=>store.subscribe(()=>service.refresh()));
  if(config.autoStart!==false){const timer=setTimeout(()=>void service.autoCheck(),5_000),interval=setInterval(()=>void service.autoCheck(),15*60*1000);timer.unref?.();interval.unref?.();ctx.effect(()=>()=>{clearTimeout(timer);clearInterval(interval);});}
  ctx.effect(()=>()=>service.dispose());
}
