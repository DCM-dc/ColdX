import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {dshRequire} from '../plugin/page-native.mjs';

async function nativeDirectory(){
  const source=await readFile(process.env.COLDX_MODEL_CLIENT || dshRequire.resolve('@deepseek-ai/dsh-client-ui-model-selection/client'),'utf8');
  let exports;
  const runtime={createSnapshotStore(initial){let value=initial;return{getSnapshot:()=>value,update(fn){const next={...value};fn(next);value=next;},subscribe:()=>()=>{}};}};
  vm.runInNewContext(source,{window:{__ModuleLoader__:{load(record){exports=record.factory(name=>name==='@deepseek-ai/cordis'?{Service:class{}}:name==='@deepseek-ai/dsh-client-runtime/client'?runtime:{});}}}});
  return exports.ModelDirectory;
}
const selected={provider:'deepseek',model:'flash',reasoningEffort:'high'};
const catalog={current:selected,routable:true,groups:[],failures:[]};

test('native transport failures unlock model selection and directory loading for retry',async()=>{
  const Directory=await nativeDirectory();let rejectLoad=false,rejectSelect=false;
  const directory=new Directory({
    async models(){if(rejectLoad)throw new Error('load disconnected');return{result:{ok:true,value:catalog}};},
    async selectModel(value){if(rejectSelect)throw new Error('select disconnected');return{result:{ok:true,value:{selected:value}}};},
  },'owner',()=>true);
  await directory.load();rejectSelect=true;
  await assert.rejects(directory.select({...selected,reasoningEffort:'max'}),/select disconnected/);
  assert.equal(directory.store.getSnapshot().status,'error');assert.match(directory.store.getSnapshot().error,/select disconnected/);
  assert.equal(directory.store.getSnapshot().current.reasoningEffort,'high');
  rejectSelect=false;await directory.select({...selected,reasoningEffort:'max'});
  assert.equal(directory.store.getSnapshot().status,'ready');
  rejectLoad=true;await assert.rejects(directory.load(),/load disconnected/);
  assert.equal(directory.store.getSnapshot().status,'error');assert.match(directory.store.getSnapshot().error,/load disconnected/);
  assert.equal(directory.store.getSnapshot().current.reasoningEffort,'max');
  rejectLoad=false;await directory.load();assert.equal(directory.store.getSnapshot().status,'ready');assert.equal(directory.store.getSnapshot().error,null);
});

test('stale or disposed native directory transport failures cannot poison a newer selection',async()=>{
  const Directory=await nativeDirectory();let reject;
  const directory=new Directory({models:()=>new Promise((_resolve,no)=>{reject=no;}),selectModel:async value=>({result:{ok:true,value:{selected:value}}})},'owner',()=>true);
  const stale=directory.load();await directory.select({...selected,reasoningEffort:'max'});reject(new Error('old load'));
  await assert.rejects(stale,/old load/);assert.equal(directory.store.getSnapshot().status,'ready');assert.equal(directory.store.getSnapshot().error,null);
  const disposed=directory.load();directory.dispose();const before=directory.store.getSnapshot();reject(new Error('disposed load'));
  await assert.rejects(disposed,/disposed load/);assert.equal(directory.store.getSnapshot(),before);
});
