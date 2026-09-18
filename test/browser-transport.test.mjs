import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserTransport} from '../plugin/browser-transport.mjs';

test('a failed new-tab navigation keeps custom controls on the actual newly selected page',async()=>{
  const operated=[],sent=[];
  const page=name=>({isClosed:()=>false,url:()=>name,title:async()=>name,reload:async()=>operated.push(name)});
  const a=page('old'),b=page('failed-new'),open=[a];
  const transport={send:async message=>sent.push(message)};
  const adapter=createBrowserTransport(transport,()=>({pages:()=>open}));adapter.onmessage=()=>{};
  await transport.onmessage({id:1,method:'tools/call',params:{name:'browser_tabs',arguments:{action:'new',url:'https://unreachable.invalid'}}});
  open.push(b);
  await adapter.send({id:1,result:{isError:true,content:[{type:'text',text:'Navigation failed'}]}});
  await transport.onmessage({id:2,method:'tools/call',params:{name:'browser_reload',arguments:{}}});
  assert.deepEqual(operated,['failed-new']);
  const state=JSON.parse(sent[0].result.content.at(-1).text.replace('COLDX_BROWSER_STATE:',''));
  assert.equal(state.activeTabId,'1');assert.equal(state.url,'failed-new');
});
