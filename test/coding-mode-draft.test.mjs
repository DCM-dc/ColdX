import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createSessionControls} from '../plugin/client/session-controls-source.mjs';
import {dshRequire} from '../plugin/page-native.mjs';

const {createModeCoordinator} = createSessionControls({createElement(){}},{});
function fixture(execute) {
  const calls=[], projection=new Map();
  let snapshot={sessionId:'draft-one',blank:true,composerPhase:'blank'};
  const session={sessionId:'draft-one',getSnapshot:() => snapshot,projections:{get:key => projection.get(key)}};
  const coordinator=createModeCoordinator({readSession:id => id===session.sessionId ? snapshot : undefined,executeCommand:async (id,command,signal) => {calls.push([id,command]);await execute?.(id,command,signal);}});
  return {calls,projection,session,coordinator,get snapshot(){return snapshot;},setSnapshot:value => {snapshot=value;}};
}

test('blank-session Goal/Plan choices stay in the shared local draft without executing commands',async () => {
  const f=fixture();
  await f.coordinator.run('draft-one','/coldx-goal on',f.snapshot);
  await f.coordinator.run('draft-one','/plan',f.snapshot);
  assert.deepEqual(f.calls,[],'mode clicks must not publish a blank conversation');
  assert.deepEqual(f.coordinator.getSnapshot('draft-one',f.snapshot),{goal:true,plan:true,phase:'draft'});
  await f.coordinator.run('draft-one','/plan off',f.snapshot);
  assert.equal(f.coordinator.getSnapshot('draft-one',f.snapshot).plan,false);
  assert.deepEqual(f.calls,[]);
  assert.equal(f.coordinator.getSnapshot('other',{blank:true}),null,'session drafts remain isolated');
});

test('the first real submission synchronizes selected modes once and keeps them through projection lag',async () => {
  const f=fixture();
  await f.coordinator.run('draft-one','/coldx-goal on',f.snapshot);
  await f.coordinator.run('draft-one','/plan',f.snapshot);
  const lease=await f.coordinator.beforeSend(f.session,new AbortController().signal);
  assert.deepEqual(f.calls,[['draft-one','/coldx-goal on'],['draft-one','/plan']]);
  assert.equal(f.coordinator.getSnapshot('draft-one',f.snapshot).phase,'sending');
  await assert.rejects(f.coordinator.run('draft-one','/plan off',f.snapshot),/正在提交/);
  lease.commit();lease.release();
  assert.equal(f.coordinator.getSnapshot('draft-one',f.snapshot).phase,'committed');
  assert.equal(await f.coordinator.beforeSend(f.session),undefined);
  assert.equal(f.calls.length,2);
  f.setSnapshot({sessionId:'draft-one',blank:false,composerPhase:'active'});
  await f.coordinator.run('draft-one','/plan off',f.snapshot);
  assert.equal(f.calls.at(-1)[1],'/plan off','existing conversation commands remain native');
});

test('failed mode synchronization retains draft selections and retries only the unacknowledged mode',async () => {
  let fail=true;
  const f=fixture(async (_id,command) => {if(command==='/plan' && fail) throw new Error('Plan rejected');});
  await f.coordinator.run('draft-one','/coldx-goal on',f.snapshot);
  await f.coordinator.run('draft-one','/plan',f.snapshot);
  await assert.rejects(f.coordinator.beforeSend(f.session),/Plan rejected/);
  assert.equal(f.coordinator.getSnapshot('draft-one',f.snapshot).phase,'draft');
  assert.equal(f.coordinator.getSnapshot('draft-one',f.snapshot).goal,true);
  fail=false;
  const lease=await f.coordinator.beforeSend(f.session);
  assert.deepEqual(f.calls.map(([,command]) => command),['/coldx-goal on','/plan','/plan']);
  lease.release();
  const retry=await f.coordinator.beforeSend(f.session);
  assert.equal(f.calls.length,3,'a failed prompt retries without duplicate accepted mode commands');
  retry.commit();retry.release();
});

test('unbound home preferences bind only to a blank session on real submission',async () => {
  const f=fixture();
  await f.coordinator.run(undefined,'/plan');
  assert.deepEqual(f.calls,[]);
  assert.equal(f.coordinator.getSnapshot('existing',{blank:false}),null);
  const lease=await f.coordinator.beforeSend(f.session);
  assert.deepEqual(f.calls,[['draft-one','/plan']]);
  assert.equal(f.coordinator.getSnapshot(undefined),null);
  lease.commit();lease.release();
});

test('cancelled preparation releases its lock and does not forget an accepted mode',async () => {
  const controller=new AbortController();
  const f=fixture(async () => {controller.abort();});
  await f.coordinator.run('draft-one','/coldx-goal on',f.snapshot);
  await assert.rejects(f.coordinator.beforeSend(f.session,controller.signal),{name:'AbortError'});
  assert.equal(f.coordinator.getSnapshot('draft-one',f.snapshot).phase,'draft');
  const lease=await f.coordinator.beforeSend(f.session);
  assert.equal(f.calls.length,1);
  lease.release();
});

async function nativeSendSession() {
  const source=await readFile(dshRequire.resolve('@deepseek-ai/dsh-client-ui-conversation/client'),'utf8');
  const start=source.indexOf('async sendSession(session, text, imageIds, mode, signal) {');
  const end=source.indexOf('\n\t\t\t}',start)+'\n\t\t\t}'.length;
  assert.ok(start>=0 && end>start);
  return vm.runInNewContext(`({${source.slice(start,end)}}).sendSession`);
}

test('the installed native input sends the original text once after modes, retaining attachments on refusal',async () => {
  const send=await nativeSendSession(), f=fixture(), order=[];
  await f.coordinator.run('draft-one','/plan',f.snapshot);
  const coordinator=createModeCoordinator({executeCommand:async (id,command) => {order.push(command);}});
  await coordinator.run('draft-one','/plan',f.snapshot);
  let accept=false;
  f.session.prompt=async (content,mode) => {order.push('prompt');assert.deepEqual(JSON.parse(JSON.stringify(content)),[{type:'image',data:'image'}, {type:'text',text:'Build my page'}]);assert.equal(mode,'queue');return {ok:accept};};
  const attachment={file:'local'}, context={ctx:{get:name => name==='coldxCodingMode' ? coordinator : undefined},draftImages:() => [attachment],serializeImages:async () => [{type:'image',data:'image'}],releaseDraftImages:() => order.push('release')};
  const failed=await send.call(context,f.session,'Build my page',['image-one'],'queue',new AbortController().signal);
  assert.equal(failed.kind,'error');
  assert.deepEqual(order,['/plan','prompt']);
  assert.equal(coordinator.getSnapshot('draft-one',f.snapshot).phase,'draft');
  accept=true;
  await send.call(context,f.session,'Build my page',['image-one'],'queue',new AbortController().signal);
  assert.deepEqual(order,['/plan','prompt','prompt','release']);
  assert.equal(coordinator.getSnapshot('draft-one',f.snapshot).phase,'committed');
});

test('native mode preparation failure or cancellation does not submit or release the user content',async () => {
  const send=await nativeSendSession();
  for (const cancelled of [false,true]) {
    const abort=new AbortController(), order=[], f=fixture();
    const coordinator=createModeCoordinator({executeCommand:async () => {order.push('mode');if(cancelled) abort.abort();else throw new Error('mode unavailable');}});
    await coordinator.run('draft-one','/plan',f.snapshot);
    f.session.prompt=async () => {order.push('prompt');return {ok:true};};
    const context={ctx:{get:() => coordinator},draftImages:() => [],serializeImages:async () => [],releaseDraftImages:() => order.push('release')};
    await assert.rejects(send.call(context,f.session,'Keep this draft',[],'queue',abort.signal));
    assert.deepEqual(order,['mode']);
    assert.equal(coordinator.getSnapshot('draft-one',f.snapshot).phase,'draft');
  }
});

test('native image validation finishes before any mode command and unextended DSH still submits once',async () => {
  const send=await nativeSendSession(), f=fixture(), order=[];
  const context={ctx:{get:() => ({beforeSend:async () => {order.push('prepare');}})},draftImages:() => [{file:'missing'}],serializeImages:async () => {throw new Error('image unreadable');},releaseDraftImages:() => order.push('release')};
  await assert.rejects(send.call(context,f.session,'Keep image',['one'],'queue'),/image unreadable/);
  assert.deepEqual(order,[]);
  context.ctx.get=() => undefined;
  context.draftImages=() => [];
  context.serializeImages=async () => [];
  f.session.prompt=async content => {order.push(content[0].text);return {ok:true};};
  assert.equal((await send.call(context,f.session,'Original request',[],'queue')).kind,'success');
  assert.deepEqual(order,['Original request','release']);
});

test('concurrent first submissions cannot race mode preparation and disposal blocks late completion',async () => {
  let settle;
  const waiting=new Promise(resolve => {settle=resolve;});
  const f=fixture(async () => waiting);
  await f.coordinator.run('draft-one','/plan',f.snapshot);
  const first=f.coordinator.beforeSend(f.session);
  await assert.rejects(f.coordinator.beforeSend(f.session),/正在提交/);
  assert.equal(f.calls.length,1);
  f.coordinator.dispose();
  settle();
  await assert.rejects(first,/已关闭/);
  assert.equal(f.coordinator.getSnapshot('draft-one',f.snapshot),null,'late completions cannot resurrect a disposed plugin draft');
});

test('cancellation after preparation and a rejected prompt both release the lease without losing attachments',async () => {
  const send=await nativeSendSession();
  for (const cancelled of [true,false]) {
    const abort=new AbortController(), f=fixture(), order=[];
    await f.coordinator.run('draft-one','/plan',f.snapshot);
    const service={async beforeSend(...args) {const lease=await f.coordinator.beforeSend(...args);if(cancelled) abort.abort();return lease;}};
    const context={ctx:{get:() => service},draftImages:() => [{file:'local'}],serializeImages:async () => [{type:'image',data:'image'}],releaseDraftImages:() => order.push('release')};
    f.session.prompt=async () => {order.push('prompt');throw new Error('transport rejected');};
    await assert.rejects(send.call(context,f.session,'Keep draft',['one'],'queue',abort.signal),cancelled ? {name:'AbortError'} : /transport rejected/);
    assert.deepEqual(order,cancelled ? [] : ['prompt']);
    assert.equal(f.coordinator.getSnapshot('draft-one',f.snapshot).phase,'draft');
  }
});
