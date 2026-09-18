import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createComputerComponents } from '../plugin/client/computer-source.mjs';

function mount(rpc) {
  const hooks = []; let cursor = 0, effects = [], disposed = false, lateUpdates = 0, apiState;
  const cell = initial => hooks[cursor++] ??= initial();
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
    useRef: initial => cell(() => ({ current: initial })),
    useId: () => cell(() => `computer-${cursor}`),
    useState(initial) {
      const entry = cell(() => ({ value: typeof initial === 'function' ? initial() : initial }));
      return [entry.value, next => { if (disposed) { lateUpdates++; return; } entry.value = typeof next === 'function' ? next(entry.value) : next; }];
    },
    useEffect(setup, dependencies) {
      const entry = cell(() => ({}));
      if (!entry.dependencies || dependencies.some((value, index) => !Object.is(value, entry.dependencies[index]))) {
        entry.dependencies = dependencies; effects.push(() => { entry.cleanup?.(); entry.cleanup = setup(); });
      }
    },
  };
  const api = createComputerComponents(React, rpc);
  return { api, render(sessionId) { cursor = 0; effects = []; apiState = api.useComputer(sessionId); for (const effect of effects) effect(); return apiState; },
    renderPreview(props) { cursor=0; effects=[]; const tree=api.ComputerPreview(props); for (const effect of effects) effect(); return tree; },
    renderWorkspace(props) { cursor=0; effects=[]; const tree=api.ComputerWorkspace(props); for (const effect of effects) effect(); return tree; },
    get lateUpdates() { return lateUpdates; }, dispose() { for (const entry of hooks) entry.cleanup?.(); disposed = true; } };
}

test('computer snapshots follow their session, cancel stale reads, and never initiate browser operations', async t => {
  const calls = [];
  const view = mount((sessionId, method, request, signal) => new Promise(resolve => calls.push({sessionId, method, request, signal, resolve})));
  t.after(() => view.dispose());
  view.render('a'); assert.equal(calls[0].method, 'read');
  calls[0].resolve({ version: 1, revision: 1, records: [{ callId: 'a1' }], browserOpen: true, connected: true });
  await delay(0); const a = view.render('a'); assert.equal(a.snapshot.records[0].callId, 'a1');
  const b = view.render('b'); assert.equal(b.snapshot.records.length, 0); assert.equal(calls[0].signal.aborted, true);
  await a.close(); assert.equal(calls.length, 2, 'stale owner cannot close the new browser');
  calls[1].resolve({version: 1, revision: 2, records: [{callId: 'b1'}]});
  view.dispose(); await delay(0); assert.equal(view.lateUpdates, 0);
  assert.ok(calls.every(call => call.method === 'read'));
});

test('close requests are explicitly owned, errors remain visible and a retry is possible', async t => {
  const calls = [];
  const view = mount(async (sessionId, method) => {
    calls.push({sessionId, method});
    if (method === 'close') throw new Error('driver unavailable');
    return {version: 1, revision: 1, records: [], browserOpen: true, connected: true};
  });
  t.after(() => view.dispose()); view.render('owned'); await delay(0);
  await view.render('owned').close();
  const state = view.render('owned'); assert.equal(state.closeError, 'driver unavailable'); assert.equal(state.closing, false);
  assert.deepEqual(calls.filter(call => call.method === 'close'), [{sessionId: 'owned', method: 'close'}]);
});

test('same-frame close calls admit once and its returned snapshot cannot be replaced by an older read', async t => {
  const calls=[];
  const view=mount((sessionId,method,request,signal)=>new Promise(resolve=>calls.push({sessionId,method,request,signal,resolve})));
  t.after(()=>view.dispose());
  const state=view.render('owned');
  const first=state.close(), second=state.close();
  assert.equal(calls.filter(call=>call.method==='close').length,1,'the lock must not depend on a React repaint');
  calls.find(call=>call.method==='close').resolve({version:1,revision:4,records:[{callId:'latest'}],browserOpen:false,connected:false});
  await Promise.all([first,second]);
  assert.equal(view.render('owned').snapshot.records[0]?.callId,'latest','close must apply its confirmed snapshot immediately');
  calls[0].resolve({version:1,revision:3,records:[{callId:'stale'}],browserOpen:true,connected:true});
  await delay(0);
  const snapshot=view.render('owned').snapshot;
  assert.equal(snapshot.browserOpen,false);
  assert.equal(snapshot.records[0].callId,'latest');
});

test('a close response owned by the previous session cannot alter a new session or clear its pending close', async t => {
  const calls=[];
  const view=mount((sessionId,method,request,signal)=>new Promise(resolve=>calls.push({sessionId,method,request,signal,resolve})));
  t.after(()=>view.dispose());
  const first=view.render('a').close();
  const next=view.render('b').close();
  const oldClose=calls.find(call=>call.sessionId==='a' && call.method==='close');
  assert.equal(oldClose.signal.aborted,true);
  oldClose.resolve({version:1,revision:10,records:[{callId:'from-a'}],browserOpen:false});
  await first;
  assert.equal(view.render('b').closing,true);
  assert.equal(view.render('b').snapshot.records.length,0);
  calls.find(call=>call.sessionId==='b' && call.method==='close').resolve({version:1,revision:2,records:[{callId:'from-b'}],browserOpen:false});
  await next;
  assert.equal(view.render('b').closing,false);
  assert.equal(view.render('b').snapshot.records[0].callId,'from-b');
});

test('screenshot previews accept bounded raster data only and collapse older images', () => {
  const view = mount(async () => {}), { api } = view;
  assert.equal(api.previewUrl({mime: 'image/png', base64: 'aGVsbG8='}), 'data:image/png;base64,aGVsbG8=');
  for (const attachment of [{mime:'image/svg+xml',base64:'aGVsbG8='}, {mime:'image/png',base64:'javascript:alert(1)'}, {mime:'image/png',base64:'A'.repeat(12 * 1024 * 1024 + 4)}]) assert.equal(api.previewUrl(attachment), undefined);
  const record = {surfaceLabel: '页面', previewAttachment: {mime:'image/png', base64:'aGVsbG8='}};
  assert.equal(api.ComputerPreview({record}).type, 'figure'); assert.equal(api.ComputerPreview({record, latest:false}).type, 'details');
  view.dispose();
});

function descendants(node) {
  if (!node || typeof node !== 'object') return [];
  return [node,...(node.props?.children ?? []).flatMap(descendants)];
}

test('screenshot sizing is local, keyboard reachable and resets for a different captured image', () => {
  const calls=[], view=mount((...args)=>calls.push(args));
  const record={callId:'capture-1',surfaceLabel:'页面',previewAttachment:{mime:'image/png',base64:'aGVsbG8='}};
  let tree=view.renderPreview({record});
  let button=descendants(tree).find(node=>node.type==='button');
  assert.ok(button,'the screenshot needs a native keyboard-operable size control');
  assert.equal(button.props.children.join(''),'放大截图');
  assert.equal(button.props['aria-pressed'],false);
  const original=descendants(tree).find(node=>node.type==='img').props.src;
  button.props.onClick();
  tree=view.renderPreview({record});
  button=descendants(tree).find(node=>node.type==='button');
  assert.equal(button.props.children.join(''),'适合宽度');
  assert.equal(button.props['aria-pressed'],true);
  const viewport=descendants(tree).find(node=>node.props?.id===button.props['aria-controls']);
  assert.equal(viewport.props.tabIndex,0);
  assert.match(viewport.props['aria-label'],/方向键/);
  assert.equal(descendants(tree).find(node=>node.type==='img').props.src,original);
  assert.deepEqual(calls,[],'viewing existing pixels must never request a fresh screenshot');
  button.props.onClick();
  assert.equal(view.renderPreview({record}).props['data-zoom'],'fit');
  descendants(view.renderPreview({record})).find(node=>node.type==='button').props.onClick();
  assert.equal(view.renderPreview({record:{...record,callId:'capture-2'}}).props['data-zoom'],'fit');
  view.dispose();
});

test('a completed browser_close is shown as closed even while its driver remains connected', () => {
  const view=mount(async()=>{}), {ComputerStatus}=view.api;
  const text=tree=>JSON.stringify(tree);
  const state={snapshot:{connected:true,browserOpen:false,records:[{surfaceLabel:'关闭浏览器',status:'completed'}]},close(){}};
  const closed=ComputerStatus({state});
  assert.match(text(closed),/浏览器已关闭/);
  assert.doesNotMatch(text(closed),/等待打开网页/);
  assert.match(text(closed),/结束浏览器会话/);
  assert.match(text(ComputerStatus({state:{...state,snapshot:{...state.snapshot,records:[]}}})),/等待打开网页/);
  assert.match(text(ComputerStatus({state:{...state,snapshot:{...state.snapshot,browserOpen:true}}})),/画面随工具操作更新/);
  assert.doesNotMatch(text(ComputerStatus({state:{...state,snapshot:{...state.snapshot,records:[{surfaceLabel:'关闭浏览器',status:'failed'}]}}})),/浏览器已关闭/);
  view.dispose();
});

test('workspace normalizes a user URL and exposes explicit browser takeover without operating on mount',()=>{
  const calls=[],view=mount(async()=>{});const props={sessionId:'a',view:'browser',state:{snapshot:{version:1,records:[],browser:{tabs:[],connected:true,paused:false}},action:(method,request)=>calls.push({method,request})}};
  let tree=view.renderWorkspace(props);assert.deepEqual(calls,[]);
  descendants(tree).find(node=>node.props?.['aria-label']==='浏览器地址').props.onChange({target:{value:'example.com'}});
  tree=view.renderWorkspace(props);descendants(tree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});
  assert.deepEqual(calls[0],{method:'browserAction',request:{action:'navigate',url:'https://example.com'}});
  descendants(tree).find(node=>node.type==='button'&&node.props.children.join('')==='手动接管').props.onClick();
  assert.deepEqual(calls[1],{method:'browserAction',request:{action:'pause',paused:true}});view.dispose();
});

test('a finished child workspace disables mutation controls while keeping history visible',()=>{
  const view=mount(async()=>{});const tree=view.renderWorkspace({sessionId:'ended-child',view:'browser',state:{snapshot:{version:1,readOnly:true,records:[],browser:{tabs:[{id:'0',index:0,title:'Saved page',url:'https://example.com',active:true}],connected:false}}}});
  assert.match(JSON.stringify(tree),/子任务已结束/);
  assert.ok(descendants(tree).filter(node=>node.type==='button').every(node=>node.props.disabled));view.dispose();
});

test('manual screenshot keyboard preserves literal punctuation, spaces, case and shortcuts',()=>{
  const calls=[],view=mount(async()=>{});
  const tree=view.renderWorkspace({sessionId:'a',view:'desktop',state:{snapshot:{records:[],desktop:{active:true,paused:true,window:{id:'12'},observation:{id:'observed',previewAttachment:{mime:'image/png',base64:'aGVsbG8='}}}},action:(method,request)=>calls.push({method,request})}});
  const image=descendants(tree).find(node=>node.type==='img');
  for(const key of ['!',' ','A'])image.props.onKeyDown({key,shiftKey:key==='A',preventDefault(){}});
  image.props.onKeyDown({key:'a',ctrlKey:true,preventDefault(){}});
  assert.deepEqual(calls.map(call=>call.request),[
    {windowId:'12',observationId:'observed',action:'type',text:'!'},
    {windowId:'12',observationId:'observed',action:'key',keys:['Space']},
    {windowId:'12',observationId:'observed',action:'key',keys:['Shift','A']},
    {windowId:'12',observationId:'observed',action:'key',keys:['Control','A']},
  ]);view.dispose();
});

test('workspace screenshot zoom is local, remains across observations and resets for another target',()=>{
  const calls=[],view=mount(async()=>{}),image={mime:'image/png',base64:'aGVsbG8='};
  const props={sessionId:'a',view:'desktop',state:{snapshot:{readOnly:true,records:[],desktop:{window:{id:'12'},observation:{previewAttachment:image}}},action:(...args)=>calls.push(args)}};
  let tree=view.renderWorkspace(props),zoom=descendants(tree).find(node=>node.props?.['aria-label']==='按原尺寸查看截图');
  assert.ok(zoom);assert.equal(zoom.props.disabled,false,'read-only history can still zoom');zoom.props.onClick();
  tree=view.renderWorkspace(props);assert.equal(descendants(tree).find(node=>node.props?.role==='region').props['data-zoom'],'actual');
  props.state.snapshot.desktop.observation.previewAttachment={...image,base64:'d29ybGQ='};tree=view.renderWorkspace(props);
  assert.equal(descendants(tree).find(node=>node.props?.role==='region').props['data-zoom'],'actual');
  props.state.snapshot.desktop.window.id='13';tree=view.renderWorkspace(props);assert.equal(descendants(tree).find(node=>node.props?.role==='region').props['data-zoom'],'fit');
  assert.deepEqual(calls,[]);view.dispose();
});

test('manual takeover stays visibly pending while a model desktop action is running',()=>{
  const view=mount(async()=>{});const tree=view.renderWorkspace({sessionId:'a',view:'desktop',state:{snapshot:{records:[],desktop:{active:true,paused:true,busy:true,window:{id:'12'},observation:{previewAttachment:{mime:'image/png',base64:'aGVsbG8='}}}}}});
  assert.match(JSON.stringify(tree),/等待当前操作完成/);
  assert.equal(descendants(tree).find(node=>node.props?.className==='cx-computer-live-frame').props['data-interactive'],false);view.dispose();
});
