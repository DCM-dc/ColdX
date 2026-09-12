import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {dshRequire} from '../plugin/page-native.mjs';
import {createMenuCatalog} from '../plugin/client/menu-catalog-source.mjs';

const row={name:'local-writer',description:'Work with local documents',whenToUse:'For local writing',modelInvocable:false};
const success=skills=>({result:{ok:true,value:{skills}}});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const deps=(list,bail=()=>true)=>({connection:{api:{skills:{list}}},sessions:{subagentAddress:()=>undefined,scope:()=>({bail})}});

test('catalog only exposes real native skills and optional native metadata',async()=>{
  const calls=[],catalog=createMenuCatalog(deps(async(request,signal)=>{calls.push([request,signal]);return success([{...row,icon:'invented',plugin:'fake'}]);}));
  assert.deepEqual(await catalog.load('session'),[row]);assert.deepEqual(calls[0][0],{sessionId:'session'});assert.ok(calls[0][1] instanceof AbortSignal);
  assert.deepEqual(await catalog.load(undefined),[]);assert.equal(calls.length,1);
  const serialized=new Function(`return (${createMenuCatalog.toString()});`)();assert.deepEqual(await serialized(deps(async()=>success([]))).load('other'),[]);
});

test('malformed catalogs and host errors cannot become successful empty or invented lists',async()=>{
  for(const receipt of [success([{...row,name:'../../x'}]),success([row,row]),success([{name:'no-description'}]),{result:{ok:true,value:{}}}]){
    const catalog=createMenuCatalog(deps(async()=>receipt));await assert.rejects(catalog.load('owner'),/无效/);
  }
  const catalog=createMenuCatalog(deps(async()=>({result:{ok:false,error:{message:'provider unavailable'}}})));
  await assert.rejects(catalog.load('owner'),/provider unavailable/);
});

test('aborted or superseded loads cannot authorize picks or replace newer session catalogs',async()=>{
  const first=deferred(),next=deferred();let index=0;
  const catalog=createMenuCatalog(deps(()=>index++===0?first.promise:next.promise));
  const old=catalog.load('owner');const oldRejected=assert.rejects(old);const newer=catalog.load('owner');
  next.resolve(success([row]));assert.deepEqual(await newer,[row]);first.resolve(success([{...row,name:'stale'}]));await oldRejected;
  assert.throws(()=>catalog.pick('owner','stale'),/不在当前目录/);
  const abort=new AbortController(),pending=deferred(),other=createMenuCatalog(deps(()=>pending.promise));
  const waiting=other.load('owner',abort.signal);const rejected=assert.rejects(waiting);abort.abort();pending.resolve(success([row]));await rejected;
  assert.throws(()=>other.pick('owner',row.name),/不在当前目录/);
});

test('pick validates exact session, loaded name and input span before native insertion',async()=>{
  const applied=[],catalog=createMenuCatalog(deps(async()=>success([row]),function(carrier,event,request){assert.equal(carrier.bail,this.bail);applied.push({event,request});return true;}));
  await catalog.load('owner');
  const input={phase:'plain',draft:'one two',draftRev:7};
  const props={input,selection:{start:4,end:7,draftRev:7}};
  assert.deepEqual(catalog.pick('owner',row.name,props),{text:'/local-writer ',caret:18});
  assert.deepEqual(applied,[{event:'slash/input-insert-text',request:{text:'/local-writer ',span:{start:4,end:7,draftRev:7}}}]);
  assert.throws(()=>catalog.pick('other',row.name,props),/不在当前目录/);
  assert.throws(()=>catalog.pick('owner','made-up',props),/不在当前目录/);
  for(const selection of [{start:-1,end:4,draftRev:7},{start:0,end:8,draftRev:7},{start:0,end:0,draftRev:6}])assert.throws(()=>catalog.pick('owner',row.name,{input,selection}),/已变化/);
  assert.throws(()=>catalog.pick('owner',row.name,{...props,locked:true}),/无法添加/);
  assert.throws(()=>catalog.pick('owner',row.name,{...props,input:{...input,phase:'submitting'}}),/正在处理/);
  assert.equal(applied.length,1);catalog.invalidate('owner');assert.throws(()=>catalog.pick('owner',row.name,props),/不在当前目录/);
});

test('addressed subagents and disposed catalogs do not expose host-owned skills',async()=>{
  let called=0;const dependency=deps(async()=>{called++;return success([row]);});dependency.sessions.subagentAddress=()=>({parentSessionId:'parent'});
  const catalog=createMenuCatalog(dependency);assert.deepEqual(await catalog.load('subagent'),[]);assert.equal(called,0);
  catalog.dispose();await assert.rejects(catalog.load('owner'),/已关闭/);
});

test('native insertion preserves the remaining draft, attachments and one-step undo; stale CAS is refused',async()=>{
  const source=await readFile(process.env.COLDX_CONVERSATION_CLIENT || dshRequire.resolve('@deepseek-ai/dsh-client-ui-conversation/client'),'utf8');let native;
  const createSnapshotStore=initial=>{let value=initial;return{getSnapshot:()=>value,set:next=>{value=next;},subscribe:()=>()=>{}};};
  vm.runInNewContext(source.replace('exports.ConversationController = ConversationController;','exports.__SessionInputShell=SessionInputShell; exports.ConversationController = ConversationController;'),{window:{__ModuleLoader__:{load(record){native=record.factory(name=>name==='@deepseek-ai/cordis'?{Service:class{}}:name==='@deepseek-ai/dsh-client-runtime/client'?{createSnapshotStore}:name==='react'?{memo:value=>value}:name==='react/jsx-runtime'?{jsx:()=>null,jsxs:()=>null}:{});}}}});
  const shell=new native.__SessionInputShell({});shell.setDraft('keep replace tail');shell.addImages(['image-owned']);
  const catalog=createMenuCatalog(deps(async()=>success([row]),(_carrier,event,request)=>event==='slash/input-insert-text'&&shell.insertText(request.text,request.span)));
  await catalog.load('owner');const input=shell.snapshot,selection={start:5,end:12,draftRev:input.draftRev};
  catalog.pick('owner',row.name,{input,selection});assert.equal(shell.snapshot.draft,'keep /local-writer  tail');assert.deepEqual([...shell.snapshot.imageIds],['image-owned']);
  assert.throws(()=>catalog.pick('owner',row.name,{input,selection}),/尚未添加/);shell.undo();assert.equal(shell.snapshot.draft,'keep replace tail');assert.deepEqual([...shell.snapshot.imageIds],['image-owned']);
  const append=shell.snapshot;catalog.pick('owner',row.name,{input:append,selection:{start:append.draft.length,end:append.draft.length,draftRev:append.draftRev}});
  assert.equal(shell.snapshot.draft,'keep replace tail /local-writer ');shell.undo();assert.equal(shell.snapshot.draft,'keep replace tail');
});
