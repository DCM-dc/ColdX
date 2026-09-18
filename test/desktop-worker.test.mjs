import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {WindowsDesktopWorker} from '../plugin/desktop-control.mjs';

function fixture(t){
  t.mock.timers.enable({apis:['setTimeout']});
  let launched;const spawned=new Promise(resolve=>{launched=resolve;}),requests=[];
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.stdin=new Writable({write(data,_encoding,done){requests.push(JSON.parse(data.toString()));done();},final(done){done();queueMicrotask(()=>child.emit('close',0));}});
  child.kill=()=>{child.emit('close',null,'SIGTERM');return true;};
  const worker=new WindowsDesktopWorker({spawnProcess:()=>{launched();return child;},startupTimeoutMs:1000,actionTimeoutMs:100});
  t.after(()=>worker.stop());
  const emit=value=>child.stdout.write(JSON.stringify(value)+'\n');
  return {worker,spawned,requests,child,ready:()=>emit({type:'ready',protocol:'coldx-desktop',version:1}),reply:value=>emit({id:requests.at(-1).id,ok:true,value})};
}

test('desktop worker waits for compiled-helper readiness before starting an action deadline',async t=>{
  const f=fixture(t),pending=f.worker.request({action:'probe'});await f.spawned;
  await Promise.resolve();t.mock.timers.tick(500);await Promise.resolve();
  assert.equal(f.requests.length,0,'no action may be sent during cold compilation');
  f.ready();await Promise.resolve();await Promise.resolve();
  assert.equal(f.requests.length,1);f.reply({available:true});assert.deepEqual(await pending,{available:true});
});

test('desktop worker startup is bounded and reports the startup phase',async t=>{
  const f=fixture(t),result=f.worker.request({action:'probe'}).catch(error=>error);await f.spawned;
  t.mock.timers.tick(1000);const error=await result;assert.match(error.message,/startup.*timed out/i);assert.equal(f.requests.length,0);
});

test('desktop action deadline remains independent and bounded after startup',async t=>{
  const f=fixture(t),result=f.worker.request({action:'probe'}).catch(error=>error);await f.spawned;
  f.ready();await Promise.resolve();await Promise.resolve();assert.equal(f.requests.length,1);
  t.mock.timers.tick(100);assert.match((await result).message,/action.*timed out/i);
});

test('stopping or cancelling during desktop startup never waits for readiness',async t=>{
  const f=fixture(t),abort=new AbortController(),result=f.worker.request({action:'probe'},abort.signal).catch(error=>error);await f.spawned;
  abort.abort(new Error('Owned startup cancelled'));await f.worker.stop();
  assert.match((await result).message,/cancelled/i);assert.equal(f.requests.length,0);
});

test('helper compilation diagnostics survive early exit',async t=>{
  const f=fixture(t),result=f.worker.request({action:'probe'}).catch(error=>error);await f.spawned;
  f.child.stderr.write('Add-Type failed: compilation error');f.child.emit('close',1);
  assert.match((await result).message,/startup.*Add-Type failed: compilation error/i);
});

test('stopping an idle helper during compilation does not need a handshake or first request',async t=>{
  const f=fixture(t);await f.spawned;await f.worker.stop();
  await assert.rejects(f.worker.ready,/stopped/i);assert.equal(f.requests.length,0);
});

test('spawn failure rejects readiness and still completes cleanup',async()=>{
  const worker=new WindowsDesktopWorker({spawnProcess:()=>{throw new Error('Owned spawn failed');}});
  await assert.rejects(worker.request({action:'probe'}),/Owned spawn failed/);await worker.stop();
});
