import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MarketplaceJobs} from '../plugin/marketplace-jobs.mjs';

const request={id:'author/plugin',packageId:'dsh-test-plugin'};
const meta={packageId:request.packageId,version:'1.0.0'};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
async function fixture(t,install){const dir=await mkdtemp(join(tmpdir(),'coldx-market-jobs-'));const statePath=join(dir,'state.json');const jobs=new MarketplaceJobs({installer:{install},statePath});t.after(()=>jobs.dispose());await jobs.ready;return{jobs,statePath};}

test('AI repair preserves the failed attempt and original session through retry and restart',async t=>{
  let fails=true;const {jobs,statePath}=await fixture(t,async()=>{if(fails)throw Object.assign(Error('Registry failed'),{code:'package-manager-failed'});return{status:'active',message:'Loaded'};});
  const first=await jobs.start(request,meta,{ownerSessionId:'original-task'});await jobs.wait(first.jobId);
  const repair=await jobs.beginRepair(first.jobId,'original-task','repair-click-1');assert.equal(repair.parentJobId,first.jobId);
  assert.equal((await jobs.beginRepair(first.jobId,'original-task','repair-click-1')).repairId,repair.repairId);
  await assert.rejects(jobs.beginRepair(first.jobId,'other-task','repair-click-2'),/任务|owner/);
  fails=false;const retry=await jobs.start(request,meta,{ownerSessionId:'original-task'});const result=await jobs.wait(retry.jobId);
  assert.equal(result.parentJobId,first.jobId);assert.equal(result.ownerSessionId,'original-task');
  assert.equal(result.attempts[0].status,'failed');assert.equal(result.attempts[0].failureCode,'package-manager-failed');assert.match(result.attempts[0].log,/Registry failed/);
  assert.equal(result.repairs[0].status,'completed');
  const loaded=new MarketplaceJobs({statePath,installer:{install:async()=>{throw Error('Unrequested');}}});t.after(()=>loaded.dispose());await loaded.ready;
  assert.equal(loaded.snapshot()[0].attempts[0].jobId,first.jobId);assert.equal(loaded.snapshot()[0].repairs[0].repairId,repair.repairId);
});

test('root repair routing survives persistence while original child audit attribution is retained',async t=>{
 const {jobs,statePath}=await fixture(t,async()=>{throw Error('Child install failed');});
 const first=await jobs.start(request,meta,{ownerSessionId:'child',rootSessionId:'root'});await jobs.wait(first.jobId);
 const loaded=new MarketplaceJobs({statePath,installer:{install:async()=>({status:'active',message:'Loaded'})}});t.after(()=>loaded.dispose());await loaded.ready;
 assert.equal(loaded.snapshot()[0].ownerSessionId,'child');assert.equal(loaded.snapshot()[0].rootSessionId,'root');
 await assert.rejects(loaded.beginRepair(first.jobId,'foreign','wrong-root'),/任务/);
 const repair=await loaded.beginRepair(first.jobId,'root','root-repair');assert.equal(repair.ownerSessionId,'root');assert.equal(loaded.snapshot()[0].ownerSessionId,'child');
 const retry=await loaded.start(request,meta,{ownerSessionId:'root',rootSessionId:'root'});const result=await loaded.wait(retry.jobId);
 assert.equal(result.attempts[0].ownerSessionId,'child');assert.equal(result.attempts[0].rootSessionId,'root');assert.equal(result.repairs[0].status,'completed');
});

test('repeated clicks share one install, publish progress and persist actual activation',async t=>{
  const gate=deferred();let calls=0;
  const {jobs,statePath}=await fixture(t,async(_meta,{onProgress})=>{calls++;onProgress({phase:'installing',message:'Downloading package'});await gate.promise;return{status:'active',version:'1.0.0',tools:['test_tool'],message:'Loaded'};});
  const [first,second]=await Promise.all([jobs.start(request,meta),jobs.start(request,meta)]);
  assert.equal(first.jobId,second.jobId);assert.equal(first.status,'installing');
  assert.equal(jobs.snapshot()[0].status,'installing');
  gate.resolve();const result=await jobs.wait(first.jobId);assert.equal(calls,1);assert.equal(result.status,'active');
  assert.deepEqual(result.tools,['test_tool']);assert.match(result.log,/Downloading/);
  assert.equal(JSON.parse(await readFile(statePath,'utf8')).installs[0].status,'active');
  assert.equal((await jobs.start(request,meta)).jobId,first.jobId);assert.equal(calls,1);
});

test('profile installs are serialized and failures can be retried without a false installed status',async t=>{
  const gate=deferred();const order=[];let fail=true;
  const {jobs}=await fixture(t,async value=>{order.push(value.packageId);if(value.packageId===meta.packageId){await gate.promise;if(fail)throw Error('Registry unavailable');}return{status:'needs-config',message:'API key required',version:value.version};});
  const first=await jobs.start(request,meta);
  const second=await jobs.start({id:'author/other',packageId:'dsh-other'},{packageId:'dsh-other',version:'2.0.0'});
  assert.deepEqual(order,[meta.packageId]);gate.resolve();
  assert.equal((await jobs.wait(first.jobId)).status,'failed');assert.equal((await jobs.wait(second.jobId)).status,'needs-config');
  assert.deepEqual(order,[meta.packageId,'dsh-other']);fail=false;
  const retry=await jobs.start(request,meta);assert.notEqual(retry.jobId,first.jobId);assert.equal((await jobs.wait(retry.jobId)).status,'needs-config');
});

test('cancellation reaches the real install and service disposal drains owned work',async t=>{
  const started=deferred();let settled=false;
  const {jobs}=await fixture(t,async(_meta,{signal})=>{started.resolve();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));settled=true;signal.throwIfAborted();});
  const controller=new AbortController();const record=await jobs.start(request,meta,{signal:controller.signal});await started.promise;
  controller.abort(new Error('User stopped installation'));const result=await jobs.wait(record.jobId);
  assert.equal(settled,true);assert.equal(result.status,'failed');assert.match(result.message,/stopped/);
  await jobs.dispose();await assert.rejects(jobs.start(request,meta),/closed/);
});

test('restart never preserves an interrupted installation as success; installed truth can be reconciled',async t=>{
  const {jobs,statePath}=await fixture(t,async()=>({status:'active',message:'Loaded',version:'1.0.0'}));
  const record=await jobs.start(request,meta);await jobs.wait(record.jobId);await jobs.dispose();
  const restored=new MarketplaceJobs({statePath,installer:{install(){throw Error('not requested');}}});t.after(()=>restored.dispose());await restored.ready;
  await restored.reconcile([{packageId:meta.packageId,version:'1.0.0',status:'needs-config',message:'Missing configuration'}]);
  assert.equal(restored.snapshot()[0].status,'needs-config');
  await restored.reconcile([]);assert.equal(restored.snapshot()[0].status,'failed');assert.match(restored.snapshot()[0].message,/未安装|removed/);
});

test('an AI observer can cancel waiting for a shared user install without cancelling that install',async t=>{
  const gate=deferred();let installSignal;
  const {jobs}=await fixture(t,async(_meta,{signal})=>{installSignal=signal;await gate.promise;return{status:'active',message:'Ready'};});
  const record=await jobs.start(request,meta);
  const observer=new AbortController();assert.equal((await jobs.start(request,meta,{signal:observer.signal})).jobId,record.jobId);
  const waiting=jobs.wait(record.jobId,observer.signal);await Promise.resolve();observer.abort(new Error('Stop observing'));
  const outcome=await Promise.race([waiting.then(()=> 'completed',()=> 'cancelled'),new Promise(resolve=>setTimeout(()=>resolve('still waiting'),50))]);
  gate.resolve();await jobs.wait(record.jobId);
  assert.equal(outcome,'cancelled');assert.equal(installSignal.aborted,false);
});

test('damaged installation history is preserved for inspection without disabling the marketplace',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'coldx-market-recovery-')),statePath=join(dir,'state.json');
  await writeFile(statePath,'{"version":1,"installs":');
  const jobs=new MarketplaceJobs({statePath,installer:{install:async()=>({status:'active',message:'Loaded'})}});t.after(()=>jobs.dispose());
  await jobs.ready;assert.deepEqual(jobs.snapshot(),[]);assert.match(jobs.historyNotice,/记录|恢复/);
  const backup=(await readdir(dir)).find(name=>name.startsWith('state.json.corrupt-'));
  assert.ok(backup);assert.equal(await readFile(join(dir,backup),'utf8'),'{"version":1,"installs":');
  const record=await jobs.start(request,meta);assert.equal((await jobs.wait(record.jobId)).status,'active');
  assert.equal(JSON.parse(await readFile(statePath,'utf8')).installs.length,1);
});

test('cancelling a queued owned job publishes failure without waiting for an unrelated user install',async t=>{
  const gate=deferred(),calls=[];
  const {jobs,statePath}=await fixture(t,async value=>{
    calls.push(value.packageId);if(value.packageId==='dsh-first')await gate.promise;
    return{status:'active',message:'Ready'};
  });
  const first=await jobs.start({id:'author/first',packageId:'dsh-first'},{packageId:'dsh-first',version:'1.0.0'});
  const owner=new AbortController();
  const second=await jobs.start(request,meta,{signal:owner.signal});
  const waiting=jobs.wait(second.jobId,owner.signal);await Promise.resolve();owner.abort(new Error('Queued install cancelled'));
  const outcome=await Promise.race([waiting.then(value=>value.status,()=> 'cancelled'),new Promise(resolve=>setTimeout(()=>resolve('still waiting'),80))]);
  const receipt=JSON.parse(await readFile(statePath,'utf8')).installs.find(value=>value.packageId===meta.packageId);
  const retry=await jobs.start(request,meta);
  gate.resolve();await jobs.wait(first.jobId);await waiting;const result=await jobs.wait(retry.jobId);
  assert.equal(outcome,'failed','a cancelled queued job settles before its predecessor completes');
  assert.equal(receipt.status,'failed','cancelled queue state is saved immediately');
  assert.notEqual(retry.jobId,second.jobId,'a queued cancellation can be retried immediately');
  assert.equal(result.status,'active');assert.deepEqual(calls,['dsh-first',meta.packageId],'the cancelled placeholder never invokes the installer');
});

test('an installation failure stays retryable when package files exist but did not pass verification',async t=>{
  let fail=true,calls=0;
  const {jobs}=await fixture(t,async()=>{calls++;if(fail)throw Error('Package integrity verification failed');return{status:'active',message:'Verified and loaded'};});
  const first=await jobs.start(request,meta);assert.equal((await jobs.wait(first.jobId)).status,'failed');
  for(const status of ['installed','needs-restart','active']){
    await jobs.reconcile([{packageId:meta.packageId,version:meta.version,status,message:'Files found'}]);
    assert.equal(jobs.snapshot()[0].status,'failed',`${status} inspection cannot approve the failed installation`);
    assert.match(jobs.snapshot()[0].message,/integrity/);
  }
  fail=false;const retry=await jobs.start(request,meta);
  assert.notEqual(retry.jobId,first.jobId);assert.equal((await jobs.wait(retry.jobId)).status,'active');assert.equal(calls,2);
});
