import {mkdir,open,rename,rm,lstat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';

export const RELEASE_PAGE='https://github.com/DCM-dc/ColdX/releases';
const LATEST='https://api.github.com/repos/DCM-dc/ColdX/releases/latest';
const version=value=>/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value??'')?.slice(1).map(Number);
const newer=(left,right)=>left.some((n,i)=>n>right[i]&&left.slice(0,i).every((v,j)=>v===right[j]));
const headers={'User-Agent':'ColdX-release-updates','Accept':'application/vnd.github+json'};
const fileDigest=async path=>{const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return 'sha256:'+hash.digest('hex');};
const permittedDownload=url=>url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&(
  (url.hostname==='github.com'&&url.pathname.startsWith('/DCM-dc/ColdX/releases/download/'))||url.hostname==='release-assets.githubusercontent.com');
export function selectRelease(value,currentVersion,platform,arch){
  const next=version(value?.tag_name),current=version(currentVersion);
  if(!next||!current||!newer(next,current)||value.draft||value.prerelease)return null;
  const normalized=next.join('.');
  const os={win32:'win',darwin:'mac',linux:'linux'}[platform],ext={win32:'exe',darwin:'dmg',linux:'AppImage'}[platform];
  const name=`ColdX-${normalized}-${os}-${arch}.${ext}`;
  const item=Array.isArray(value.assets)?value.assets.find(x=>x?.name===name):undefined;
  let asset=null;
  if(item?.state==='uploaded'&&Number.isSafeInteger(item.size)&&item.size>0&&item.size<=1_500_000_000&&/^sha256:[a-f0-9]{64}$/i.test(item.digest??'')){
    try{const url=new URL(item.browser_download_url);if(url.origin==='https://github.com'&&url.pathname===`/DCM-dc/ColdX/releases/download/${value.tag_name}/${name}`&&!url.search&&!url.hash&&!url.username&&!url.password)asset={name,size:item.size,digest:item.digest.toLowerCase(),url:url.href};}catch{}
  }
  return{version:normalized,tag:value.tag_name,url:`${RELEASE_PAGE}/tag/${encodeURIComponent(value.tag_name)}`,publishedAt:value.published_at??null,asset};
}
async function boundedBytes(response,limit){
  if(!response.ok)throw Error(`GitHub 暂时不可用（HTTP ${response.status}）。`);
  const reader=response.body?.getReader();if(!reader)throw Error('下载内容为空。');
  let size=0;const chunks=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit)throw Error('下载内容超过限制。');chunks.push(Buffer.from(value));}return Buffer.concat(chunks);}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export class ReleaseUpdates{
  constructor({directory,currentVersion,platform=process.platform,arch=process.arch,fetch:fetcher=globalThis.fetch,launch}={}){
    Object.assign(this,{directory,currentVersion,platform,arch,fetcher});this.controller=new AbortController();this.epoch=0;this.value={status:'idle',currentVersion,release:null,checkedAt:null,downloaded:0};
    this.launch=launch??(path=>new Promise((resolve,reject)=>{const child=spawn(path,[],{detached:true,windowsHide:true,stdio:'ignore'});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});}));
  }
  state(){return{...this.value,release:this.value.release?{...this.value.release,asset:this.value.release.asset?{...this.value.release.asset}:null}:null,canInstall:this.platform==='win32'};}
  async check(){
    if(this.checking)return this.checking;
    if(['downloading','ready','launched'].includes(this.value.status)||this.installing)return this.state();
    const epoch=this.epoch;
    this.checking=(async()=>{try{
      const response=await this.fetcher(LATEST,{headers,redirect:'error',signal:AbortSignal.any([this.controller.signal,AbortSignal.timeout(15_000)])});
      const release=response.status===404?null:selectRelease(JSON.parse((await boundedBytes(response,1_000_000)).toString('utf8')),this.currentVersion,this.platform,this.arch);
      if(epoch!==this.epoch)return this.state();
      this.value={status:release?'available':'current',currentVersion:this.currentVersion,release,checkedAt:Date.now(),downloaded:0};
    }catch(error){if(epoch===this.epoch)this.value={...this.value,status:'error',error:'检查更新失败，请稍后重试。',checkedAt:Date.now()};if(this.controller.signal.aborted)throw error;}return this.state();})().finally(()=>{this.checking=null;});
    return this.checking;
  }
  async download(expectedVersion){
    if(this.downloading)return this.downloading;
    const release=this.value.release,asset=release?.asset;
    if(!asset||release.version!==expectedVersion)throw Error('更新版本已变化或没有可校验的当前平台安装包。');
    if(['ready','launched'].includes(this.value.status))return this.state();
    this.epoch++;
    this.downloading=(async()=>{
      let temporary;
      try{
        this.value={...this.value,status:'downloading',downloaded:0,error:undefined};
        await mkdir(this.directory,{recursive:true});
        if((await lstat(this.directory)).isSymbolicLink())throw Error('更新目录不能为链接。');
        const temporaryPath=join(this.directory,asset.name+'.'+randomUUID()+'.partial');
        const signal=AbortSignal.any([this.controller.signal,AbortSignal.timeout(30*60_000)]);
        let url=new URL(asset.url),response;
        for(let redirects=0;redirects<=4;redirects++){
          if(!permittedDownload(url))throw Error('更新下载地址不受支持。');
          response=await this.fetcher(url.href,{redirect:'manual',signal,headers:{'User-Agent':headers['User-Agent']}});
          if(![301,302,303,307,308].includes(response.status))break;
          const location=response.headers.get('location');await response.body?.cancel();
          if(!location||redirects===4)throw Error('更新下载地址重定向异常。');url=new URL(location,url);
        }
        if(!response.ok)throw Error(`下载失败（HTTP ${response.status}）。`);
        const file=await open(temporaryPath,'wx'),hash=createHash('sha256');temporary=temporaryPath;let count=0;
        try{for await(const chunk of response.body){count+=chunk.length;if(count>asset.size)throw Error('下载长度不符合发布记录。');hash.update(chunk);await file.writeFile(chunk);this.value={...this.value,downloaded:count};}await file.sync();}
        finally{await file.close();}
        if(count!==asset.size||'sha256:'+hash.digest('hex')!==asset.digest)throw Error('安装包校验失败，未启用该更新。');
        await rename(temporary,join(this.directory,asset.name));temporary=null;
        this.value={...this.value,release,status:'ready',downloaded:count};return this.state();
      }catch(error){this.value={...this.value,status:'available',error:String(error.message).slice(0,240)};throw error;}
      finally{if(temporary)await rm(temporary,{force:true}).catch(()=>{});}
    })().finally(()=>{this.downloading=null;});return this.downloading;
  }
  async install({version:expectedVersion,confirmed}){
    if(this.installing)throw Error('安装程序正在启动。');
    if(!confirmed)throw Error('请先确认安装更新。');
    if(expectedVersion!==this.value.release?.version)throw Error('更新版本已变化，请重新确认。');
    if(this.value.status==='launched')throw Error('安装程序已经启动。');
    if(this.value.status!=='ready')throw Error('请等待安装包下载完成。');
    if(this.platform!=='win32')throw Error('当前平台请通过发布页面安装更新。');
    this.installing=true;this.epoch++;
    const asset=this.value.release.asset,path=join(this.directory,asset.name);
    let verified=false;
    try{
      const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==asset.size||await fileDigest(path)!==asset.digest)throw Error('安装包校验失败，请重新下载。');
      verified=true;this.value={...this.value,status:'launched'};
      await this.launch(path);return this.state();
    }catch(error){this.value={...this.value,status:verified?'ready':'available',error:verified?'无法启动安装程序。':'安装包校验失败，请重新下载。'};throw error;}
    finally{this.installing=false;}
  }
  dispose(){this.controller.abort();}
}
