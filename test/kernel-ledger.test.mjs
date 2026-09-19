import test from 'node:test';
import assert from 'node:assert/strict';
import { KernelLedger } from '../lib/kernel/ledger.mjs';

test('request telemetry records actual timing and usage only, never prompt or unknown fields', () => {
  let now=100;const ledger=new KernelLedger({now:()=>now});
  const request=ledger.start('one',{messageCount:2,totalChars:123,secret:'private'});
  now=110;request.admitted();now=120;request.chunk({type:'text-delta',text:'private-output'});
  request.chunk({type:'usage',usage:{inputTokens:10,outputTokens:3,cacheReadTokens:5,secret:'key'}});
  now=130;request.end('completed');request.end('failed');
  const snapshot=ledger.snapshot('one');
  assert.equal(snapshot.requestCount,1);assert.equal(snapshot.completed,1);assert.equal(snapshot.failed,0);
  assert.equal(snapshot.last.queueMs,10);assert.equal(snapshot.last.firstChunkMs,10);assert.equal(snapshot.last.durationMs,30);
  assert.deepEqual(snapshot.last.usage,{inputTokens:10,outputTokens:3,cacheReadTokens:5});
  assert.doesNotMatch(JSON.stringify(snapshot),/private|secret|key|output-text/);
  assert.equal(ledger.snapshot('two').requestCount,0);
});

test('ledger bounds history, preserves active owners and accounts tool failures', () => {
  const ledger=new KernelLedger({maxOwners:2,maxRecent:3});
  const active=ledger.start('active',{});active.admitted();
  for(let i=0;i<8;i++){ const r=ledger.start('other-'+i,{});r.admitted();r.end('completed'); }
  assert.equal(ledger.snapshot('active').last.state,'running');assert.ok(ledger.ownerCount<=2);
  for(let i=0;i<8;i++){const r=ledger.start('active',{});r.admitted();r.end('completed');}
  ledger.tool('active',{durationMs:12,isError:true});
  assert.equal(ledger.snapshot('active').toolFailures,1);assert.equal(ledger.snapshot('active').recent.length,3);
  active.end('cancelled');assert.equal(ledger.snapshot('active').cancelled,1);
});
