import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {nativeImport} from './page-native.mjs';
import {ReleaseUpdates,RELEASE_PAGE} from './release-updates.mjs';
const {TypertRemoteService}=await nativeImport('@deepseek-ai/dsh-typert-protocol');
const {settingsNamespace}=await nativeImport('@deepseek-ai/dsh-settings');
const {default:Schema}=await nativeImport('@deepseek-ai/schemastery');
const NAMESPACE=settingsNamespace('coldx-updates');
const schema=Schema.object({autoCheck:Schema.boolean().default(true),autoDownload:Schema.boolean().default(false)});
export const name='coldx-updates';
export const inject=['typert','settings','agents'];
export const UPDATE_INVOCATIONS=['state','check','download','install','setting'].map(method=>({id:`coldx-updates:${method}`,service:'coldxUpdates',namespace:'coldxUpdates',method,invocation:{kind:'direct'},parameters:[{name:'request',wire:'request',source:'json',codec:{mode:'src-json'}}],cancellation:{parameter:'signal'},result:{mode:'src-json'}}));
function requestKeys(request,keys){if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).some(k=>!keys.includes(k)))throw Error('无效的更新请求。');}
export class UpdatesService extends TypertRemoteService{
  constructor(ctx,{updater,desktop=false}){
    super(ctx,'coldxUpdates');this.updater=updater;this.desktop=desktop;
    this.scope=ctx.settings.register(NAMESPACE,schema,{base:{autoCheck:true,autoDownload:desktop},applies:'live'});
    const automatic=()=>{if(this.scope.get().autoCheck)void this.check({automatic:true}).catch(()=>{});};
    const start=setTimeout(automatic,10_000);start.unref?.();const interval=setInterval(automatic,24*60*60_000);interval.unref?.();
    ctx.effect(()=>()=>{clearTimeout(start);clearInterval(interval);updater.dispose();});
  }
  state(request={}){requestKeys(request,[]);return{...this.updater.state(),desktop:this.desktop,canInstall:this.desktop&&this.updater.platform==='win32',settings:this.scope.get(),releasePage:RELEASE_PAGE};}
  async check(request,signal){requestKeys(request,['automatic']);signal?.throwIfAborted();await this.updater.check();
    if(this.desktop&&this.scope.get().autoDownload&&this.updater.state().status==='available'&&this.updater.state().release?.asset)void this.updater.download(this.updater.state().release.version).catch(()=>{});
    return this.state();
  }
  download(request,signal){requestKeys(request,['version']);signal?.throwIfAborted();const state=this.updater.state();if(typeof request.version!=='string'||!state.release?.asset||state.release.version!==request.version)throw Error('更新版本已变化或没有当前平台安装包。');void this.updater.download(request.version).catch(()=>{});return this.state();}
  async install(request,signal){requestKeys(request,['version','confirmed']);signal?.throwIfAborted();if(!this.desktop)throw Error('网页版请从发布页面安装桌面版。');if(this.ctx.agents.list().some(agent=>agent.status==='running'))throw Error('请等待正在运行的任务结束，再安装更新。');await this.updater.install(request);return this.state();}
  async setting(request,signal){requestKeys(request,['autoCheck','autoDownload']);if(Object.values(request).some(v=>typeof v!=='boolean'))throw Error('更新设置必须为开关值。');signal?.throwIfAborted();await this.ctx.settings.update(NAMESPACE,request);return this.state();}
}
export async function apply(ctx,config={}){
  const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  const updater=config.updater??new ReleaseUpdates({directory:join(config.profileDir??process.env.DSH_HOME??'.runtime','.coldx-updates'),currentVersion:pkg.version});
  new UpdatesService(ctx,{updater,desktop:process.env.COLDX_DESKTOP_RUNTIME==='1'});
  ctx.typert.register({package:'coldx-updates',face:'host',schemas:[],model:{services:[],events:[],objects:[]},invocations:UPDATE_INVOCATIONS});
}
