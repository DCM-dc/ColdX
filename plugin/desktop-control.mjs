import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const ACTIONS = new Set(['windows','observe','focus','click','double_click','drag','scroll','type','key']);
const INPUTS = new Set(['click','double_click','drag','scroll','type','key']);
const psPath = () => join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
export function desktopCapability(platform = process.platform) {
  const available = platform === 'win32' && existsSync(psPath());
  return { available, platform, backend: available ? 'windows-native' : null,
    ...!available ? { reason:platform === 'win32' ? 'Windows PowerShell 5.1 不可用。' : '当前版本的桌面控制支持 Windows 10/11；此平台仍可使用独立浏览器。' } : {} };
}
function sameWindow(a,b,ignoreForeground=false) { return a?.id === b?.id && a?.pid === b?.pid && JSON.stringify(a?.bounds) === JSON.stringify(b?.bounds) && (ignoreForeground || a?.foreground === b?.foreground); }
function validate(request) {
  if (!request || !ACTIONS.has(request.action)) throw new Error('Unsupported desktop action.');
  const allowed = new Set(['action','windowId','observationId','x','y','endX','endY','deltaX','deltaY','text','keys','button']);
  if(Object.keys(request).some(key=>!allowed.has(key))) throw new Error('Unsupported desktop argument.');
  if(request.action !== 'windows' && (typeof request.windowId !== 'string' || !/^\d{1,20}$/.test(request.windowId))) throw new Error('A listed windowId is required.');
  if(request.action === 'type' && (typeof request.text !== 'string' || !request.text.length || request.text.length > 20_000)) throw new Error('Text must contain 1–20000 characters.');
  if(request.action === 'key' && (!Array.isArray(request.keys) || request.keys.length < 1 || request.keys.length > 5 || request.keys.some(key=>typeof key!=='string' || !/^(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|Control|Alt|Shift|Meta|Enter|Escape|Tab|Backspace|Delete|Space|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown)$/.test(key)))) throw new Error('Unsupported keyboard combination.');
  if(request.button !== undefined && !['left','right','middle'].includes(request.button)) throw new Error('Unsupported mouse button.');
  for(const key of ['deltaX','deltaY']) if(request[key]!==undefined && (!Number.isInteger(request[key]) || Math.abs(request[key])>2400)) throw new Error('Scroll is limited to 2400 units per action.');
  return request;
}

/** JSON-only worker; user data is never interpolated into a shell program. */
export class WindowsDesktopWorker {
  constructor({spawnProcess=spawn,startupTimeoutMs=60_000,actionTimeoutMs=15_000}={}) {
    if(!Number.isInteger(startupTimeoutMs)||startupTimeoutMs<1||startupTimeoutMs>60_000||!Number.isInteger(actionTimeoutMs)||actionTimeoutMs<1||actionTimeoutMs>15_000)throw new Error('Desktop timeouts must remain within bounded startup/action limits.');
    this.spawnProcess=spawnProcess;this.startupTimeoutMs=startupTimeoutMs;this.actionTimeoutMs=actionTimeoutMs;this.pending=new Map();this.sequence=0;this.stopped=false;
    this.ready=new Promise((resolve,reject)=>{this.resolveReady=resolve;this.rejectReady=reject;});
    // Enabling the controller may start a helper before its first request.
    this.ready.catch(()=>{});
    this.launching=this.start().catch(error=>{void this.stop(error);});
  }
  fail(error) {
    this.failure??=error;clearTimeout(this.startupTimer);this.rejectReady(this.failure);
    for(const entry of this.pending.values()){entry.cleanup();entry.reject(this.failure);}this.pending.clear();
  }
  async start() {
    this.directory=await mkdtemp(join(tmpdir(),'coldx-computer-'));
    this.cancelPath=join(this.directory,'cancel');
    if(this.stopped) return;
    const startedAt=Date.now();
    this.child=this.spawnProcess(psPath(),['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./windows/computer-worker.ps1',import.meta.url)),this.cancelPath],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.child.stdin.on('error',()=>{});
    this.stderr='';this.child.stderr.on('data',chunk=>{this.stderr=(this.stderr+chunk.toString()).slice(-1500);});
    this.lines=createInterface({input:this.child.stdout});
    this.lines.on('line',line=>{
      if(line.length>16*1024*1024) {void this.stop(new Error('Desktop helper protocol response is too large.'));return;}
      try {
        const result=JSON.parse(line);
        if(result.type==='ready'&&result.protocol==='coldx-desktop'&&result.version===1){
          if(this.stopped||this.readyComplete)return;
          clearTimeout(this.startupTimer);this.readyComplete=true;this.startupMs=Date.now()-startedAt;this.resolveReady();return;
        }
        const pending=this.pending.get(result.id);if(!pending)return;this.pending.delete(result.id);pending.cleanup();result.ok?pending.resolve(result.value):pending.reject(new Error(result.error||'Desktop action failed.'));
      } catch { /* Non-protocol startup diagnostics are never treated as results. */ }
    });
    const exitedError=()=>new Error(`Desktop helper ${this.readyComplete?'exited':'startup failed'}. ${this.stderr}`);
    this.exited=new Promise(resolve=>this.child.once('close',()=>{resolve();if(!this.stopped)void this.stop(exitedError());}));
    this.child.once('error',error=>{void this.stop(new Error(`Desktop helper startup failed: ${error.message}`));});
    this.startupTimer=setTimeout(()=>{void this.stop(new Error(`Desktop helper startup timed out after ${this.startupTimeoutMs}ms while loading or compiling. ${this.stderr}`));},this.startupTimeoutMs);
  }
  async request(request,signal) {
    const abort=()=>{void this.stop(signal?.reason instanceof Error?signal.reason:new Error('Desktop request cancelled.'));};
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    try {
      await this.ready;signal?.throwIfAborted();if(this.stopped||this.failure||!this.child)throw this.failure||new Error('Desktop stopped.');
      const id=++this.sequence;
      return await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{void this.stop(new Error(`Desktop action ${request.action} timed out after ${this.actionTimeoutMs}ms.`));},this.actionTimeoutMs);
        const cleanup=()=>{clearTimeout(timer);};this.pending.set(id,{resolve,reject,cleanup});
        this.child.stdin.write(JSON.stringify({id,...request})+'\n',error=>{if(error){this.pending.delete(id);cleanup();reject(error);}});
      });
    }finally{signal?.removeEventListener('abort',abort);}
  }
  async stop(reason=new Error('Desktop stopped.')) {
    if(this.stopping) return this.stopping;
    this.stopped=true;this.fail(reason);
    this.stopping=(async()=>{
      // Do not await readiness here: stop must also work during Add-Type.
      await this.launching;
      if(this.cancelPath) await writeFile(this.cancelPath,'stop');
      this.child?.stdin.end();
      const timer=setTimeout(()=>this.child?.kill(),1500);
      await this.exited; clearTimeout(timer); this.lines?.close();
      if(this.directory) await rm(this.directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
    })();return this.stopping;
  }
}

/** One physical desktop lease per host, independent from isolated browser sessions. */
export class DesktopController {
  constructor({platform=process.platform,workerFactory=()=>new WindowsDesktopWorker(),onChange=()=>{}}={}) {
    this.platform=platform;this.workerFactory=workerFactory;this.onChange=onChange;this.states=new Map();this.queue=Promise.resolve();
  }
  state(id) {if(!this.states.has(id))this.states.set(id,{active:false,paused:false,busy:false,windows:[],window:null,observation:null});return this.states.get(id);}
  snapshot(id) {return {...this.state(id), occupied:Boolean(this.owner && this.owner!==id)};}
  changed(id) {this.onChange(id);}
  assertOwner(id) {if(this.owner!==id || !this.state(id).active)throw new Error('Desktop owner mismatch / 桌面不属于此会话。');}
  async enable(id) {
    if(this.platform!=='win32')throw new Error(desktopCapability(this.platform).reason);
    if(this.owner && this.owner!==id)throw new Error('The desktop is in use by another session / 另一个会话正在使用桌面。');
    if(!this.owner){this.owner=id;this.worker=this.workerFactory();this.controller=new AbortController();Object.assign(this.state(id),{active:true,paused:false,error:''});this.changed(id);}
    return this.snapshot(id);
  }
  async pause(id,paused) {this.assertOwner(id);if(typeof paused!=='boolean')throw new Error('paused must be boolean.');this.state(id).paused=paused;this.changed(id);if(paused)await this.queue;return this.snapshot(id);}
  async act(id,raw,{signal,manual=false}={}) {
    const request=validate(raw);this.assertOwner(id);
    const lifetime=this.controller.signal;const combined=signal?AbortSignal.any([signal,lifetime]):lifetime;
    const run=async()=>{
      combined.throwIfAborted();this.assertOwner(id);const state=this.state(id);
      if((INPUTS.has(request.action)||request.action==='focus') && state.paused && !manual)throw new Error('Desktop is paused for manual control / 桌面已暂停。');
      if(INPUTS.has(request.action) && (!state.observation || request.observationId!==state.observation.id || request.windowId!==state.window?.id))throw new Error('A current observation is required / 请重新观察。');
      if(INPUTS.has(request.action)) {
        for(const key of ['x','y',...(request.action==='drag'?['endX','endY']:[])]) if(['click','double_click','drag'].includes(request.action) && (!Number.isInteger(request[key]) || request[key]<0 || request[key]>=(key.toLowerCase().includes('x')?state.observation.width:state.observation.height)))throw new Error('Coordinates must be inside the observation.');
        const fresh=await this.worker.request({action:'windows'},combined);
        let current=fresh.windows.find(window=>window.id===request.windowId);
        if(!sameWindow(current,state.window,manual) || (!manual && !current.foreground)) {state.observation=null;this.changed(id);throw new Error('Window or foreground changed / 窗口发生变化，请重新观察。');}
        // Clicking ColdX's explicit manual controls naturally focuses ColdX.
        // Restore only the already observed, identity-checked target window.
        if(manual && !current.foreground){const focused=await this.worker.request({action:'focus',windowId:request.windowId},combined);current=focused.window;if(!sameWindow(current,state.window,true)||!current.foreground)throw new Error('Manual target changed while focusing. Observe again.');state.window=current;}
      }
      state.busy=true;this.changed(id);
      try {
        const result=await this.worker.request({...request,...INPUTS.has(request.action)?{expectedWindow:state.window}:{}},combined);
        combined.throwIfAborted();
        if(request.action==='windows') state.windows=result.windows;
        else {
          if(!result.window || !result.image || !result.width || !result.height)throw new Error('Desktop helper returned an incomplete observation.');
          state.window=result.window;state.observation={id:randomUUID(),capturedAt:Date.now(),width:result.width,height:result.height,scale:1,previewAttachment:result.image,controls:result.controls || [],visibleScreenCapture:true};
        }
        state.error='';return this.snapshot(id);
      } catch(error) {state.observation=null;state.error=error.message;if(combined.aborted&&!lifetime.aborted)void this.stop(id);throw error;}
      finally {state.busy=false;this.changed(id);}
    };
    const result=this.queue.then(run,run);this.queue=result.catch(()=>{});return result;
  }
  async stop(id) {
    if(this.owner!==id) {if(this.owner) this.assertOwner(id);return this.snapshot(id);}
    const worker=this.worker;this.controller.abort(new Error('Desktop stopped.'));
    Object.assign(this.state(id),{active:false,paused:false,busy:false,observation:null});this.changed(id);
    await worker.stop();await this.queue;this.owner=undefined;this.worker=undefined;this.changed(id);return this.snapshot(id);
  }
  async dispose(){if(this.owner)await this.stop(this.owner);}
}
