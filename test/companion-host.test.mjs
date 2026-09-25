import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskFold, normalizeTeam, recoverTeams} from '../lib/companion/state.mjs';
import {TeamStore} from '../lib/companion/store.mjs';
import {extractGene,experienceContext} from '../lib/companion/growth.mjs';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('companion projection is incremental, public-only, and cancellation never celebrates',()=>{
 const fold=new TaskFold();
 fold.push({type:'assistant/chunk',time:1,data:{chunk:{type:'reasoning-delta',text:'secret'}}});
 assert.equal(fold.caption,'');
 fold.push({type:'assistant/message',time:2,data:{message:{content:[{type:'reasoning',text:'secret'},{type:'text',text:'Public answer'}]}}});
 assert.equal(fold.caption,'Public answer');
 fold.push({type:'turn/end',time:3,data:{reason:{kind:'aborted'}}});
 assert.equal(fold.mood,'stopped');
});

test('only identified companion no-op turns preserve the previous parent state',()=>{
 const fold=new TaskFold();const events=[{type:'turn/start',time:1,data:{turn:1}},{type:'assistant/message',time:2,data:{message:{content:[{type:'text',text:'Previous result.'}]}}},{type:'turn/end',time:3,data:{turn:1,reason:{kind:'completed'}}},{type:'turn/start',time:4,data:{turn:2}}];
 fold.update(events);assert.equal(fold.mood,'thinking');events.push({type:'turn/end',time:5,data:{turn:2,reason:{kind:'blocked'}}});fold.update(events,new Set([2]));assert.equal(fold.mood,'celebrating');assert.equal(fold.caption,'Previous result.');assert.equal(fold.updatedAt,3);
 events.push({type:'turn/start',time:6,data:{turn:3}},{type:'turn/end',time:7,data:{turn:3,reason:{kind:'blocked'}}});fold.update(events,new Set([2]));assert.equal(fold.mood,'problem','an unrelated blocked turn must remain visible');
 const interrupted=new TaskFold();interrupted.update([{type:'turn/start',time:1,data:{turn:1}},{type:'turn/end',time:2,data:{turn:1,reason:{kind:'error'}}}],new Set([1]));assert.equal(interrupted.mood,'problem','a marker cannot hide an actual persistence or runtime failure');
});

test('persisted no-op markers are exact, bounded, and optional for legacy team files',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'coldx-noop-store-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'companion-teams.json');
 await writeFile(path,JSON.stringify({version:1,teams:[],ignoredTurns:[{sessionId:'parent',createdAt:12,turns:[1,1,-1,0,1.5,'2',2]},{sessionId:'foreign',createdAt:'bad',turns:[1]}]}));const store=new TeamStore(dir);await store.load();assert.deepEqual(store.ignoredTurns,[{sessionId:'parent',createdAt:12,turns:[1,2]}]);
 store.ignoredTurns=Array.from({length:70},(_,i)=>({sessionId:`parent-${i}`,createdAt:i,turns:Array.from({length:600},(_,j)=>j+1)}));await store.save([]);const restored=new TeamStore(dir);await restored.load();assert.equal(restored.ignoredTurns.length,64);assert.ok(restored.ignoredTurns.every(record=>record.turns.length===512));assert.ok(restored.ignoredTurns.every(record=>record.turns.at(-1)===600));
 await writeFile(path,JSON.stringify({version:1,teams:[]}));const legacy=new TeamStore(dir);await legacy.load();assert.deepEqual(legacy.ignoredTurns,[]);
});
test('maximum bounded teams survive non-ASCII and JSON-escaped persistence round trips',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'coldx-companion-store-'));t.after(()=>rm(dir,{recursive:true,force:true}));const store=new TeamStore(dir);
 for(const text of ['绒'.repeat(2000),'\u0000'.repeat(2000)]){
  const teams=Array.from({length:8},(_,i)=>({...normalizeTeam({parentSessionId:`parent-${i}`,name:'名'.repeat(80),members:Array.from({length:4},()=>({name:'名'.repeat(60),role:'角'.repeat(500)}))}),messages:Array.from({length:80},(_,j)=>({id:`message-${j}`,name:'名'.repeat(60),text,at:1}))}));
  await store.save(teams);const restored=await store.load();assert.equal(restored.length,8);assert.equal(restored[7].messages.length,80);assert.equal(restored[7].messages[79].text,text);
 }
});
test('team input and restart state are bounded and interrupted',()=>{
 assert.throws(()=>normalizeTeam({parentSessionId:'p',members:Array(5).fill({name:'x',role:'r'})}));
 const team=normalizeTeam({parentSessionId:'p',name:'Team',members:[{name:'Research',role:'Research'}]});
 const recovered=recoverTeams([{...team,status:'running',messages:Array(100).fill({id:'m',name:'n',text:'x'.repeat(3000),at:1})}]);
 assert.equal(recovered[0].status,'interrupted');
 assert.equal(recovered[0].messages.length,80);
 assert.equal(recovered[0].messages[0].text.length,2000);
});

test('restart settles active rounds and preserves only bounded owned experience records',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'coldx-hive-store-'));t.after(()=>rm(dir,{recursive:true,force:true}));const store=new TeamStore(dir);
 const team=normalizeTeam({parentSessionId:'parent',members:[{name:'Review',role:'review'}]});team.members[0].childId='review-child';
 const record={id:'gene',title:'Check constraints',when:'When reviewing',practice:'List the known constraints.',status:'candidate',sourceTaskId:'review-child',sourceMessageId:'message',roundId:'round',createdAt:1,uses:2};
 team.round={id:'round',phase:'synthesizing',startedAt:1,reviewerId:'review-child'};team.status='running';team.genes=[record];await store.save([team]);const [restored]=await store.load();
 assert.equal(restored.status,'interrupted');assert.equal(restored.round?.phase,'settled');assert.ok(restored.round.finishedAt>=1);assert.deepEqual(restored.genes,[record]);
 const records=Array.from({length:18},(_,i)=>({...record,id:`g-${i}`,status:'active'}));
 const [bounded]=recoverTeams([{...team,genes:records.concat({...record,id:'forged',sourceTaskId:'foreign-child'})}]);assert.equal(bounded.genes.length,12);assert.equal(bounded.genes.filter(g=>g.status==='active').length,3);assert.ok(bounded.genes.every(g=>g.sourceTaskId==='review-child'));
 const [legacy]=recoverTeams([{...team,round:undefined,genes:undefined,status:'completed'}]);assert.equal(legacy.status,'completed');assert.deepEqual(legacy.genes,[]);assert.equal(legacy.round,undefined);
 const [invalid]=recoverTeams([{...team,genes:[{...record,title:'x'.repeat(61)},{...record,uses:-1},{...record,sourceTaskId:'foreign-child'},{...record,practice:''}]}]);assert.deepEqual(invalid.genes,[]);
});

test('gene extraction removes only one valid trailing metadata block from public text',()=>{
 const fields={title:'t'.repeat(60),when:'w'.repeat(180),practice:'p'.repeat(400)};const fence=value=>'```coldx-gene\n'+JSON.stringify(value)+'\n```';
 const valid=extractGene([{type:'reasoning',text:fence({title:'PRIVATE',when:'PRIVATE',practice:'PRIVATE'})},{type:'text',text:'Public conclusion.\n'+fence(fields)}]);assert.equal(valid.text,'Public conclusion.');assert.deepEqual(valid.gene,fields);
 for(const text of ['Conclusion.\n'+fence({...fields,title:'t'.repeat(61)}),'Conclusion.\n'+fence({...fields,when:' '}),'Conclusion.\n'+fence({...fields,sourceTaskId:'foreign'}),fence(fields)+'\n'+fence(fields),fence(fields)+'\nOther text','x'.repeat(12001)+'\n'+fence(fields),'```coldx-gene\nnot json\n```']){
  const result=extractGene([{type:'text',text}]);assert.equal(result.gene,undefined);assert.equal(result.text,text.slice(0,2000));
 }
 const long=extractGene([{type:'text',text:'x'.repeat(2500)+'\n'+fence(fields)}]);assert.deepEqual(long.gene,fields);assert.equal(long.text.length,2000);
 const records=Array.from({length:4},(_,i)=>({id:`gene-${i}`,...fields,status:i===0?'candidate':'active',uses:0,createdAt:i}));const context=experienceContext(records);assert.ok(context.text.length<=1200);assert.equal(context.genes.length,1);assert.equal(context.genes[0].id,'gene-1');
});
