import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createWorkbenchPane } from '../plugin/client/workbench-pane-source.mjs';

test('one session workbench switches views without opening competing panels or losing another session', () => {
  const pane = createWorkbenchPane({ createElement() {} });
  let changes = 0; const unsubscribe = pane.subscribe(() => changes++);
  const initial = pane.get('a'); assert.equal(initial.active, null);
  pane.open('a', 'timeline'); assert.equal(pane.get('a').active, 'timeline');
  pane.open('a', 'files'); assert.equal(pane.get('a').active, 'files');
  const files = pane.get('a'); pane.open('a', 'files'); assert.equal(pane.get('a'), files);
  pane.open('b', 'evidence'); assert.equal(pane.get('a'), files);
  pane.close('a', 'timeline'); assert.equal(pane.get('a'), files, 'a delayed close from the old pane cannot close the new one');
  pane.close('a', 'files'); assert.equal(pane.get('a').active, null);
  assert.equal(pane.get('b').active, 'evidence');
  assert.equal(pane.open('a', 'unknown'), false); assert.equal(changes, 4);
  unsubscribe(); pane.open('a', 'files'); assert.equal(changes, 4);
});

test('pane factory survives the native lazy factory serialization boundary', () => {
  const factory = vm.runInNewContext(`(${createWorkbenchPane.toString()})`);
  const pane = factory({ createElement() {} }); pane.open('owner', 'files');
  assert.equal(pane.get('owner').active, 'files');
});

test('desktop remains nonmodal, narrow drawers use native modality, and hidden panels never steal later focus', () => {
  const hooks = [], observers = new Set(), events = new Map(), calls = [];
  let cursor = 0, pending = [], width = 1000, controls;
  const document = {activeElement:null,addEventListener(type,listener){events.set(type,listener);},removeEventListener(type){events.delete(type);}};
  const focusable = name => ({name,isConnected:true,focus(){document.activeElement=this;}});
  const composer = focusable('composer'), trigger = focusable('trigger'), unrelated = focusable('unrelated'); document.activeElement=composer;
  const root = {getBoundingClientRect:()=>({top:0,width}),querySelector:()=>({getBoundingClientRect:()=>({bottom:76})})};
  const panel = {...focusable('panel'),open:false,modal:false,dataset:{},style:{setProperty(){}},closest:()=>root,contains:node=>node===panel,matches:()=>panel.modal,
    show(){calls.push('show');panel.open=true;panel.modal=false;panel.focus();},showModal(){calls.push('showModal');panel.open=true;panel.modal=true;panel.focus();},close(){calls.push('close');panel.open=false;panel.modal=false;}};
  const React = {createElement(){},useRef:value=>hooks[cursor++]??={current:value},useLayoutEffect(setup,deps){
    const hook=hooks[cursor++]??={}; if(!hook.deps||deps.some((value,index)=>value!==hook.deps[index])){hook.deps=deps;pending.push(()=>{hook.cleanup?.();hook.cleanup=setup();});}
  }};
  const ResizeObserver=class{constructor(fn){this.fn=fn;observers.add(this);}observe(){}disconnect(){observers.delete(this);}};
  const pane=vm.runInNewContext(`(${createWorkbenchPane.toString()})`,{document,ResizeObserver})(React);
  const render=visible=>{cursor=0;pending=[];controls=pane.usePanel({sessionId:'a',panelRef:{current:panel},triggerRef:{current:trigger},present:true,visible,onClose:()=>pane.close('a','files')});for(const run of pending)run();};
  pane.open('a','files');render(true);assert.deepEqual(calls,['show']);assert.equal(document.activeElement,composer);
  width=700;for(const observer of observers)observer.fn();assert.equal(panel.modal,true);assert.equal(document.activeElement,panel);
  controls.onCancel({preventDefault(){}});render(false);assert.equal(panel.open,false);assert.equal(document.activeElement,composer);
  unrelated.focus();for(const observer of observers)observer.fn();assert.equal(document.activeElement,unrelated,'a resize after closing cannot focus the old trigger');
  for(const hook of hooks)hook.cleanup?.();
});
