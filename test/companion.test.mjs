import test from 'node:test';
import assert from 'node:assert/strict';
import {createCompanionComponents} from '../plugin/client/companion-source.mjs';

const create = () => createCompanionComponents({createElement() {}}, {}, '');
test('companion follows running and pending state without declaring a cancelled turn successful', () => {
  const pet = create();
  pet.observe({sessionId:'a',running:true});
  assert.equal(pet.getSnapshot().mood,'busy');
  pet.observe({sessionId:'a',running:true,pending:1});
  assert.equal(pet.getSnapshot().mood,'waiting');
  pet.observe({sessionId:'a',running:false});
  assert.equal(pet.getSnapshot().mood,'idle');
  assert.doesNotMatch(pet.getSnapshot().caption,/完成|成功/);
});
test('terminal errors get a gentle response, never a success celebration', () => {
  const pet=create();
  pet.observe({sessionId:'a',running:false,lastKind:'turn-error'});
  assert.equal(pet.getSnapshot().mood,'problem');
  pet.observe({sessionId:'a',running:true,lastKind:'turn-error'});
  assert.equal(pet.getSnapshot().mood,'busy','retry takes priority over old errors');
});
test('session ownership prevents stale unmounts from resetting another session', () => {
  const pet=create();
  pet.observe({sessionId:'a',running:true});
  pet.observe({sessionId:'b',running:true});
  pet.forget('a');
  assert.equal(pet.getSnapshot().mood,'busy');
  pet.forget('b');
  assert.equal(pet.getSnapshot().mood,'idle');
});
test('streaming identical state does not notify or allocate new snapshots', () => {
  const pet=create();let notices=0;
  const unsubscribe=pet.subscribe(()=>notices++);
  pet.observe({sessionId:'a',running:true});
  const before=pet.getSnapshot();
  for(let i=0;i<100;i++)pet.observe({sessionId:'a',running:true});
  assert.equal(pet.getSnapshot(),before);assert.equal(notices,1);
  unsubscribe();pet.forget('a');assert.equal(notices,1);
});
test('petting never masks waiting or failed execution state', () => {
  const pet=create();
  for(const mood of ['busy','waiting','problem']) {
    assert.equal(pet.petCaption(mood,2),pet.labels[mood]);
  }
  assert.notEqual(pet.petCaption('idle',0),pet.petCaption('idle',1));
});
test('host snapshots keep native task identity and never invent team messages', async()=>{
  const task={id:'child',parentSessionId:'parent',mode:'continuable',name:'研究伙伴',mood:'waiting',caption:'需要选择',pendingId:'p1',color:'sky'};
  const calls=[],cleanups=[];
  const pet=createCompanionComponents({createElement(){},useEffect:fn=>cleanups.push(fn())},{getSnapshot:()=>({value:{enabled:true}}),subscribe:()=>()=>{}},'',{
    rpc:async(method)=>{calls.push(method);return {version:1,tasks:[task],teams:[]};},getSessionId:()=> 'parent'
  });
  pet.Controller();await new Promise(resolve=>setImmediate(resolve));await pet.refresh();
  assert.deepEqual(pet.getLive().data.teams,[]);
  assert.equal(pet.getLive().data.tasks[0].mode,'continuable');
  assert.deepEqual(calls.filter(x=>typeof x==='string'),['snapshot','snapshot']);
  assert.equal(pet.getLive().data.tasks[0].pendingId,'p1');
  for(const cleanup of cleanups)cleanup?.();
  assert.deepEqual(pet.getLive().data.tasks,[],'teardown clears stale tasks');
  pet.dispose();
});
test('disconnect clears task state and reconnect restores native state',async t=>{
  const cleanups=[];let offline=false;
  const pet=createCompanionComponents({createElement(){},useEffect:fn=>cleanups.push(fn())},{getSnapshot:()=>({value:{enabled:true}}),subscribe:()=>()=>{}},'',{
    rpc:async()=>{if(offline)throw Error('offline');return {version:1,tasks:[{id:'child',mood:'working',caption:'working',parentSessionId:'parent',mode:'continuable'}],teams:[]};},
  });
  t.after(()=>{for(const cleanup of cleanups)cleanup?.();pet.dispose();});
  pet.Controller();await new Promise(resolve=>setImmediate(resolve));await pet.refresh();
  assert.equal(pet.getLive().data.tasks[0].id,'child');
  offline=true;await pet.refresh();
  assert.deepEqual(pet.getLive().data.tasks,[]);
  assert.match(pet.getLive().error,/无法连接/);
  offline=false;await pet.refresh();
  assert.equal(pet.getLive().error,'');assert.equal(pet.getLive().data.tasks[0].id,'child');
});
test('pending refresh does not overlap and a disposed controller ignores its late response',async t=>{
  const cleanups=[];let resolveSnapshot,calls=0;
  const pet=createCompanionComponents({createElement(){},useEffect:fn=>cleanups.push(fn())},{getSnapshot:()=>({value:{enabled:true}}),subscribe:()=>()=>{}},'',{
    rpc:()=>{calls++;return new Promise(resolve=>{resolveSnapshot=resolve;});}
  });
  t.after(()=>{for(const cleanup of cleanups)cleanup?.();pet.dispose();});
  pet.Controller();await pet.refresh();assert.equal(calls,1);
  pet.dispose();resolveSnapshot({version:1,tasks:[{id:'stale'}],teams:[]});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(pet.getLive().data.tasks,[]);
});
