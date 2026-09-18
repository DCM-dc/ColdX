import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

async function fixture() {
  const { DesktopController } = await import('../plugin/desktop-control.mjs');
  let clicks = 0, concurrent = 0, maximum = 0, stopped = 0;
  const identity = { id:'12', pid:42, processName:'owned-fixture', title:'Fixture', bounds:{x:20,y:30,width:600,height:400}, foreground:true };
  const worker = { async request(request, signal) {
    concurrent++; maximum = Math.max(maximum,concurrent);
    try {
      await delay(5, undefined, {signal});
      if(request.action==='windows') return {windows:[structuredClone(identity)]};
      if(request.action==='click') clicks++;
      return {window:structuredClone(identity), width:600,height:400, image:{mime:'image/png',base64:'aGVsbG8='}, controls:[]};
    } finally {concurrent--;}
  }, async stop(){stopped++;} };
  return { controller:new DesktopController({platform:'win32',workerFactory:()=>worker}), identity, counts:()=>({clicks,maximum,stopped}) };
}

test('desktop control rejects another session and consumed or stale observations before input', async t=>{
  const f=await fixture(); t.after(()=>f.controller.dispose());
  await f.controller.enable('a');
  await assert.rejects(f.controller.enable('b'),/another session|另一个会话/);
  const observed=await f.controller.act('a',{action:'observe',windowId:'12'});
  await assert.rejects(f.controller.act('b',{action:'click',windowId:'12',observationId:observed.observation.id,x:4,y:5}),/owner|归属/);
  f.identity.bounds.x=50;
  await assert.rejects(f.controller.act('a',{action:'click',windowId:'12',observationId:observed.observation.id,x:4,y:5}),/changed|变化|重新观察/);
  assert.equal(f.counts().clicks,0);
});

test('pause blocks model writes while manual input is allowed and refreshes the observation',async t=>{
  const f=await fixture(); t.after(()=>f.controller.dispose()); await f.controller.enable('a');
  const observed=await f.controller.act('a',{action:'observe',windowId:'12'});
  f.controller.pause('a',true);
  await assert.rejects(f.controller.act('a',{action:'focus',windowId:'12'}),/paused|暂停/);
  const action={action:'click',windowId:'12',observationId:observed.observation.id,x:4,y:5};
  await assert.rejects(f.controller.act('a',action),/paused|暂停/);
  const next=await f.controller.act('a',action,{manual:true});
  assert.notEqual(next.observation.id,observed.observation.id);
  assert.equal(f.counts().clicks,1);
  await assert.rejects(f.controller.act('a',action,{manual:true}),/observation|观察/);
});

test('stop cancels queued desktop work and releases physical ownership for another session',async()=>{
  const f=await fixture(); await f.controller.enable('a');
  const pending=f.controller.act('a',{action:'observe',windowId:'12'});
  const queued=f.controller.act('a',{action:'observe',windowId:'12'});
  await f.controller.stop('a');
  const results=await Promise.allSettled([pending,queued]);
  assert.ok(results.every(row=>row.status==='rejected'));
  await f.controller.enable('b');
  assert.equal(f.controller.snapshot('a').active,false);
  assert.equal(f.controller.snapshot('b').active,true);
  assert.ok(f.counts().maximum<=1);
  await f.controller.dispose();
});

test('desktop protocol rejects arbitrary code, oversized typing and invalid coordinates',async t=>{
  const f=await fixture();t.after(()=>f.controller.dispose());await f.controller.enable('a');
  const state=await f.controller.act('a',{action:'observe',windowId:'12'});
  for(const action of [
    {action:'shell',command:'anything'},
    {action:'type',windowId:'12',observationId:state.observation.id,text:'x'.repeat(20001)},
    {action:'click',windowId:'12',observationId:state.observation.id,x:-1,y:3},
    {action:'click',windowId:'12',observationId:state.observation.id,x:900,y:3},
  ]) await assert.rejects(f.controller.act('a',action));
  assert.equal(f.counts().clicks,0);
});

test('manual takeover waits for the active action to finish and rejects queued model input',async t=>{
  const {DesktopController}=await import('../plugin/desktop-control.mjs');
  let release,started,pausing=false;const gate=new Promise(resolve=>{release=resolve;}),begun=new Promise(resolve=>{started=resolve;});
  const window={id:'12',pid:42,foreground:true,bounds:{x:0,y:0,width:40,height:40}};
  const value={window,width:40,height:40,image:{mime:'image/png',base64:'aGVsbG8='}};
  const controller=new DesktopController({platform:'win32',workerFactory:()=>({request:async request=>{if(request.action==='windows')return{windows:[window]};if(request.action==='type'){started();await gate;}return value;},stop:async()=>{}})});
  t.after(()=>controller.dispose());await controller.enable('a');const state=await controller.act('a',{action:'observe',windowId:'12'});
  const active=controller.act('a',{action:'type',text:'hello',windowId:'12',observationId:state.observation.id});await begun;
  const takeover=Promise.resolve(controller.pause('a',true)).then(()=>{pausing=true;});await delay(0);
  try {assert.equal(pausing,false,'takeover must not complete while native input is still active');assert.equal(controller.snapshot('a').busy,true);}finally{release();}
  await Promise.all([active,takeover]);assert.equal(controller.snapshot('a').busy,false);assert.ok(controller.snapshot('a').observation);
  await assert.rejects(controller.act('a',{action:'focus',windowId:'12'}),/paused|暂停/);
});
