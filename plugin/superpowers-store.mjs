import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,lstat,realpath,rm} from 'node:fs/promises';
import {join,dirname,resolve,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseSuperpowersSkill} from './superpowers-adapter.mjs';

const COMMIT=/^[a-f0-9]{40}$/;
const LIMIT=8*1024*1024, FILE_LIMIT=512*1024, COUNT=256;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const blob=bytes=>createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const clone=value=>structuredClone(value);
const info=snapshot=>({version:snapshot.release,commit:snapshot.commit,source:'https://github.com/obra/superpowers'});
function safePath(path) {
  if(typeof path!=='string'||path.length>240||path.includes('\\')||path.includes(':')||path.startsWith('/')||path.split('/').some(part=>!part||part==='.'||part==='..')||!(/^(LICENSE|skills\/[A-Za-z0-9_./-]+\.md)$/.test(path)))throw Error('Invalid skill resource path / 技能路径无效。');
  return path;
}
function contains(root,path){const part=relative(root,path);if(isAbsolute(part)||part==='..'||part.startsWith('..'+sep))throw Error('Skill path escaped snapshot.');}
async function writeJson(path,value){await mkdir(dirname(path),{recursive:true});const temp=path+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(value,null,2)+'\n');await rename(temp,path);}
async function removeStaging(root,path){
  const stagingRoot=resolve(root,'staging'),target=resolve(path);
  contains(stagingRoot,target);if(dirname(target)!==stagingRoot)throw Error('Invalid staging cleanup target.');
  const stat=await lstat(target);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Invalid staging directory type.');
  // Windows TEMP may use an 8.3 alias; profiles may also live behind a junction.
  // Compare canonical paths on both sides while retaining the lexical guard.
  const [realRoot,realTarget]=await Promise.all([realpath(stagingRoot),realpath(target)]);
  contains(realRoot,realTarget);if(dirname(realTarget)!==realRoot)throw Error('Invalid canonical staging cleanup target.');
  // Defender/indexers may briefly hold a just-written file. Await bounded
  // native retries before settling stage(), rather than leaking failed bytes.
  await rm(realTarget,{recursive:true,force:true,maxRetries:6,retryDelay:100});
}

/** Immutable snapshots; staged GitHub data is inert until explicit activation. */
export class SuperpowersStore {
  constructor({root,bundledDir=fileURLToPath(new URL('../vendor/superpowers',import.meta.url)),fetchImpl=globalThis.fetch,now=Date.now}={}) {
    if(!root)throw Error('Superpowers profile storage is required.');
    this.root=resolve(root);this.bundledDir=resolve(bundledDir);this.fetch=fetchImpl;this.now=now;this.listeners=new Set();this.controller=new AbortController();this.cache=new Map();this.tail=Promise.resolve();
    this.data={version:1,enabled:false,autoCheck:true,lastCheckedAt:null,candidate:null,revision:0};this.ready=this.initialize();
  }
  async initialize() {
    this.bundled=await this.readSnapshot(this.bundledDir);this.cache.set(this.bundled.commit,this.bundled);this.data.active=info(this.bundled);
    try {
      const bytes=await readFile(join(this.root,'state.json'));if(bytes.length>64*1024)throw Error('Saved state too large.');const saved=JSON.parse(bytes);
      if(saved.version!==1||typeof saved.enabled!=='boolean'||typeof saved.autoCheck!=='boolean'||!COMMIT.test(saved.active?.commit))throw Error('Invalid saved skill state.');
      const active=await this.snapshot(saved.active.commit);this.data={...this.data,enabled:saved.enabled,autoCheck:saved.autoCheck,active:info(active),lastCheckedAt:Number.isFinite(saved.lastCheckedAt)?saved.lastCheckedAt:null,revision:Number.isSafeInteger(saved.revision)?saved.revision:0};
      const candidate=saved.candidate;
      if(candidate&&COMMIT.test(candidate.commit)&&candidate.id===candidate.commit&&typeof candidate.version==='string')this.data.candidate={...candidate,...candidate.status==='downloading'?{status:'failed',message:'上次下载被中断，请重试。'}:{}};
    }catch(error){if(error.code!=='ENOENT')this.data.notice='技能状态读取失败，已保留原数据并使用内置版本：'+String(error.message).slice(0,200);}
  }
  state(){return clone({...this.data,skills:(this.cache.get(this.data.active?.commit)?.skills??[]).map(({name,description})=>({name,description}))});}
  subscribe(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn);}
  notify(){for(const fn of this.listeners)try{fn(this.state());}catch{}}
  queue(fn){const next=this.tail.then(fn,fn);this.tail=next.catch(()=>{});return next;}
  async persist(){await writeJson(join(this.root,'state.json'),this.data);this.notify();}
  async setting(request){return this.queue(async()=>{await this.ready;this.controller.signal.throwIfAborted();if(Object.keys(request).some(key=>!['enabled','autoCheck','expectedRevision'].includes(key))||['enabled','autoCheck'].some(key=>key in request&&typeof request[key]!=='boolean'))throw Error('Invalid Superpowers setting.');if(request.expectedRevision!==undefined&&request.expectedRevision!==this.data.revision)throw Error('Settings changed; refresh and retry.');const previous=clone(this.data);for(const key of ['enabled','autoCheck'])if(key in request)this.data[key]=request[key];this.data.revision++;try{await this.persist();}catch(error){this.data=previous;throw error;}return this.state();});}
  async readSnapshot(directory) {
    const realRoot=await realpath(directory),manifestBytes=await readFile(join(realRoot,'manifest.json'));if(manifestBytes.length>128*1024)throw Error('Snapshot manifest too large.');
    const manifest=JSON.parse(manifestBytes);if(manifest.version!==1||manifest.upstream!=='obra/superpowers'||!COMMIT.test(manifest.commit)||typeof manifest.release!=='string'||!Array.isArray(manifest.files)||manifest.files.length>COUNT)throw Error('Invalid Superpowers manifest.');
    const seen=new Set(),skills=[];let total=0,licensed=false;
    for(const item of manifest.files){const path=safePath(item.path);if(seen.has(path))throw Error('Duplicate skill path.');seen.add(path);const full=join(realRoot,path);const stat=await lstat(full);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Invalid skill file type.');contains(realRoot,await realpath(full));if(stat.size>FILE_LIMIT||(total+=stat.size)>LIMIT)throw Error('Skill snapshot size limit exceeded.');const bytes=await readFile(full);if(item.bytes!==bytes.length||item.sha256!==hash(bytes))throw Error('Skill snapshot integrity hash mismatch / 完整性校验失败。');const text=bytes.toString('utf8');if(path==='LICENSE'){licensed=text.includes('MIT License')&&text.includes('Jesse Vincent');}if(path.endsWith('/SKILL.md')){const parsed=parseSuperpowersSkill(text,path);if(skills.some(skill=>skill.name===parsed.name))throw Error('Duplicate skill name.');skills.push({...parsed,absolutePath:full,directory:dirname(full)});}}
    if(!licensed||!skills.length)throw Error('Snapshot must include the upstream MIT license and skills.');
    return Object.freeze({...manifest,directory:realRoot,skills:skills.sort((a,b)=>a.name.localeCompare(b.name))});
  }
  async snapshot(commit){if(!COMMIT.test(commit))throw Error('Invalid snapshot commit.');if(this.cache.has(commit))return this.cache.get(commit);const value=await this.readSnapshot(join(this.root,'versions',commit));if(value.commit!==commit)throw Error('Snapshot identity mismatch.');this.cache.set(commit,value);return value;}
  async request(url,signal,limit=FILE_LIMIT) {
    const parsed=new URL(url);if(!['api.github.com','raw.githubusercontent.com'].includes(parsed.hostname)||parsed.protocol!=='https:'||parsed.username||parsed.password)throw Error('Untrusted update source.');
    const combined=AbortSignal.any([this.controller.signal,AbortSignal.timeout(20_000),...signal?[signal]:[]]);combined.throwIfAborted();
    const response=await this.fetch(url,{signal:combined,redirect:'error',headers:{Accept:'application/vnd.github+json','User-Agent':'ColdX-Superpowers'}});if(!response.ok)throw Error(`GitHub 更新读取失败 (${response.status})。`);if(Number(response.headers.get('content-length'))>limit)throw Error('Update response too large.');
    const chunks=[];let size=0;const reader=response.body.getReader();try{while(true){combined.throwIfAborted();const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw Error('Update response too large.');chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});}return Buffer.concat(chunks);
  }
  async check({signal}={}) {return this.queue(async()=>{await this.ready;signal?.throwIfAborted();const meta=JSON.parse(await this.request('https://api.github.com/repos/obra/superpowers/commits/main',signal));if(!COMMIT.test(meta.sha))throw Error('Invalid upstream commit.');const pkg=JSON.parse(await this.request(`https://raw.githubusercontent.com/obra/superpowers/${meta.sha}/package.json`,signal));if(typeof pkg.version!=='string'||pkg.version.length>40)throw Error('Invalid upstream version.');this.data.lastCheckedAt=this.now();if(meta.sha!==this.data.active.commit&&this.data.candidate?.commit!==meta.sha)this.data.candidate={id:meta.sha,commit:meta.sha,version:pkg.version,status:'available',changedSkills:[]};else if(meta.sha===this.data.active.commit)this.data.candidate=null;delete this.data.notice;await this.persist();return this.state();});}
  async stage({candidateId,signal}={}) {return this.queue(async()=>{await this.ready;const candidate=this.data.candidate;if(!candidate||candidate.id!==candidateId)throw Error('Update candidate changed.');if(candidate.status==='ready')return this.state();candidate.status='downloading';delete candidate.message;await this.persist();let staging;
    try {
      const tree=JSON.parse(await this.request(`https://api.github.com/repos/obra/superpowers/git/trees/${candidate.commit}?recursive=1`,signal,2*1024*1024));if(tree.truncated||!Array.isArray(tree.tree))throw Error('Incomplete GitHub tree.');
      const entries=tree.tree.filter(row=>row.path==='LICENSE'||row.path?.startsWith('skills/')&&row.path.endsWith('.md'));
      if(!entries.length||entries.length>COUNT)throw Error('Skill file count limit exceeded.');const seen=new Set();let total=0;
      for(const row of entries){safePath(row.path);if(seen.has(row.path)||row.type!=='blob'||row.mode!=='100644'||!COMMIT.test(row.sha)||!Number.isSafeInteger(row.size)||row.size<0||row.size>FILE_LIMIT||(total+=row.size)>LIMIT)throw Error('Invalid upstream skill entry.');seen.add(row.path);}
      staging=join(this.root,'staging',randomUUID());await mkdir(staging,{recursive:true});const files=[];
      for(const row of entries){signal?.throwIfAborted();const bytes=await this.request(`https://raw.githubusercontent.com/obra/superpowers/${candidate.commit}/${row.path}`,signal);if(bytes.length!==row.size||blob(bytes)!==row.sha)throw Error('Upstream skill integrity mismatch.');await mkdir(dirname(join(staging,row.path)),{recursive:true});await writeFile(join(staging,row.path),bytes,{flag:'wx'});files.push({path:row.path,bytes:bytes.length,sha256:hash(bytes),gitBlob:row.sha});}
      const manifest={version:1,upstream:'obra/superpowers',release:candidate.version,commit:candidate.commit,files};await writeJson(join(staging,'manifest.json'),manifest);await this.readSnapshot(staging);
      const target=join(this.root,'versions',candidate.commit);await mkdir(dirname(target),{recursive:true});try{await rename(staging,target);}catch(error){if(!['EEXIST','ENOTEMPTY','EPERM'].includes(error.code))throw error;const existing=await this.readSnapshot(target);if(existing.commit!==candidate.commit||existing.release!==manifest.release||existing.files.length!==files.length||!files.every(row=>existing.files.some(item=>item.path===row.path&&item.bytes===row.bytes&&item.sha256===row.sha256)))throw Error('Existing candidate does not match upstream / 完整性校验失败。');}
      const previous=await this.snapshot(this.data.active.commit);candidate.changedSkills=files.filter(row=>row.path.startsWith('skills/')&&!previous.files.some(old=>old.path===row.path&&old.sha256===row.sha256)).map(row=>row.path);candidate.status='ready';await this.persist();return this.state();
    }catch(error){candidate.status='failed';candidate.message=String(error.message).slice(0,300);await this.persist();throw error;}
    finally{if(staging)try{await removeStaging(this.root,staging);}catch(error){if(error.code!=='ENOENT'){this.data.notice='临时技能下载尚未清理：'+String(error.message).slice(0,180);this.notify();}}}
  });}
  async activate({candidateId,expectedActiveCommit}={}) {return this.queue(async()=>{await this.ready;const candidate=this.data.candidate;if(this.data.active.commit!==expectedActiveCommit)throw Error('Active version changed / 当前版本已变化。');if(!candidate||candidate.id!==candidateId||candidate.status!=='ready')throw Error('Candidate is not ready for activation.');this.controller.signal.throwIfAborted();const snapshot=await this.readSnapshot(join(this.root,'versions',candidate.commit));if(snapshot.commit!==candidate.commit)throw Error('Candidate identity mismatch.');const previous=clone(this.data);this.data.active=info(snapshot);this.data.candidate=null;this.data.revision++;this.cache.set(snapshot.commit,snapshot);try{await this.persist();}catch(error){this.data=previous;throw error;}return this.state();});}
  async dispose(){this.controller.abort(new Error('Superpowers store closed.'));await this.tail;this.listeners.clear();}
}
