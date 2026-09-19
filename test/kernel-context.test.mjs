import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextMeter } from '../lib/kernel/context-meter.mjs';
const frozen = value => { if(value && typeof value==='object'){ Object.values(value).forEach(frozen); Object.freeze(value); } return value; };

test('context meter reuses immutable history and measures appended content without changing requests', () => {
  const meter = new ContextMeter();
  const messages=frozen(Array.from({length:1000},()=>({role:'user',content:[{type:'text',text:'unchanged history'}]})));
  const first=meter.measure({system:'rules',messages,tools:[]});
  const second=meter.measure({system:'rules',messages:[...messages,frozen({role:'user',content:[{type:'text',text:'new request'}]})],tools:[]});
  assert.equal(second.messageCount,1001); assert.ok(second.messageChars>first.messageChars);
  assert.ok(second.cacheHits>=1000); assert.ok(second.visitedNodes<first.visitedNodes/2);
  assert.equal(messages[0].content[0].text,'unchanged history');
});

test('shallow frozen containers cannot hide mutable text changes', () => {
  const meter=new ContextMeter(),block={type:'text',text:'a'},messages=Object.freeze([{role:'user',content:[block]}]);
  const first=meter.measure({messages});block.text='longer';
  assert.equal(meter.measure({messages}).messageChars-first.messageChars,5);
});

test('meter never retains image payloads and counts reused blocks at every occurrence', () => {
  const meter=new ContextMeter(),block=frozen({type:'text',text:'abc'}),image=frozen({type:'image',data:'private-base64'.repeat(1000),mediaType:'image/png'});
  const result=meter.measure({messages:[{content:[block,block,image]}],tools:[]});
  assert.ok(result.messageChars<100); assert.equal(result.imageCount,1);
  assert.doesNotMatch(JSON.stringify(result),/private|base64|image\/png/);
  const cyclic={};cyclic.self=cyclic;assert.doesNotThrow(()=>meter.measure({messages:[cyclic]}));
});

test('large inputs stop accounting at the budget without evaluating accessors',()=>{
  const meter=new ContextMeter();
  const result=meter.measure({messages:Array(1_000_000).fill('a')});
  assert.equal(result.complete,false);assert.ok(result.visitedNodes<=200_000);
  let invoked=false;const getter={get content(){invoked=true;return 'hidden';}};
  assert.equal(meter.measure({messages:[getter]}).complete,false);assert.equal(invoked,false);
});
