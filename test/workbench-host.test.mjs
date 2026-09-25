import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkbenchService} from '../plugin/workbench-host.mjs';
const service=ctx=>Object.assign(Object.create(WorkbenchService.prototype),{ctx});
test('schedule management executes through native policy and uses the exact parent agent',async()=>{
  const agent={id:'owner',session:{header:{id:'owner'}}},calls=[];
  agent.ctx={tools:{execute:async value=>{calls.push(value);return{value:{id:'s1'}};}}};
  const host=service({agents:{get:id=>id==='owner'?agent:undefined},tools:{execute:async()=>{throw Error('Agent-local tools are not registered in root scope');}}});
  assert.deepEqual(await host.schedule({operation:'create',sessionId:'owner',prompt:'Check the build',everySeconds:3600}),{id:'s1'});
  assert.equal(calls[0].agent,agent);assert.equal(calls[0].name,'schedule_create');assert.equal(calls[0].arguments.every_seconds,3600);
  await assert.rejects(host.schedule({operation:'create',sessionId:'missing',prompt:'Check'}),/主任务/);
  agent.session.header.parentSession='another';await assert.rejects(host.schedule({operation:'delete',sessionId:'owner',id:'s1'}),/主任务/);
});
test('native schedule denial and uncertain persistence are not reported as success',async()=>{
  const agent={session:{header:{}}};const ctx={agents:{get:()=>agent},tools:{execute:async()=>({isError:true,content:[{type:'text',text:'Permission denied'}]})}};
  agent.ctx={tools:ctx.tools};
  const host=service(ctx);
  await assert.rejects(host.schedule({sessionId:'s',operation:'delete',id:'x'}),/Permission denied/);
  ctx.tools.execute=async()=>({value:{code:'persistence_uncertain',message:'not confirmed'}});
  await assert.rejects(host.schedule({sessionId:'s',operation:'delete',id:'x'}),/not confirmed/);
});
test('schedule list reads durable headers, excludes inherited fork reminders and reports unavailable history',async()=>{
  const event={type:'schedule/change',data:{version:1,operation:'create',schedule:{id:'schedule-1',kind:'every',prompt:'Inspect',everySeconds:3600,scheduledAt:'2030-01-01T00:00:00.000Z'}}};
  const logs={p:{header:{id:'p',title:'Parent'},events:[event]},fork:{header:{id:'fork',seedLength:1},events:[event]},child:{header:{id:'child',parentSession:'p'},events:[event]}};
  const host=service({agents:{get:()=>undefined},sessionQuery:{listSessions:async()=>['p','fork','child','broken'].map(id=>({header:{id}})),readSession:async id=>{if(!logs[id])throw Error('broken');return logs[id];}}});
  const result=await host.schedules({});assert.equal(result.items.length,1);assert.equal(result.items[0].sessionId,'p');assert.equal(result.items[0].live,false);assert.equal(result.unavailable,1);
});
test('PR inspection uses fixed argv, owning workspace, bounded output and no shell',async()=>{
  const host=service({agents:{get:()=>({session:{header:{cwd:'C:/workspace with spaces'}}})}});const calls=[];
  host.execute=async(...args)=>{calls.push(args);return {stdout:JSON.stringify([{number:1,url:'https://github.com/a/b/pull/1'},{number:2,url:'javascript:alert(1)'}])};};
  const result=await host.pullRequests({sessionId:'owner'});assert.equal(result.items.length,1);assert.equal(calls[0][0],'gh');assert.equal(calls[0][2].cwd,'C:/workspace with spaces');assert.equal(calls[0][2].shell,undefined);assert.equal(calls[0][2].windowsHide,true);
});
