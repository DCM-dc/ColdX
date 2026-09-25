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

test('primary workbench navigation stays separate from session file tabs', () => {
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children: children.flat() }; },
    useRef(initial) { return { current: initial }; },
    useSyncExternalStore(_subscribe, snapshot) { return snapshot(); },
    useEffect() {}, useLayoutEffect() {},
  };
  const pane = createWorkbenchPane(React);
  const nodes = root => [root, ...root.children.flatMap(child => child && typeof child === 'object' && 'type' in child ? nodes(child) : [])];
  const render = () => nodes(pane.Tabs({ sessionId: 'a' }));
  pane.openDocument('a', 'docs/first.md');
  pane.openDocument('a', 'docs/second.md');
  let tree = render();
  let rails = tree.filter(node => node.type === 'nav');
  assert.equal(rails.length, 2, 'file documents have their own navigation row');
  assert.deepEqual(rails[0].children.map(node => node.props['data-workbench-tab']), ['timeline', 'evidence', 'files', 'browser', 'desktop']);
  assert.deepEqual(nodes(rails[1]).filter(node => node.props['data-workbench-file']).map(node => node.props['data-workbench-file']), ['docs/first.md', 'docs/second.md']);
  assert.equal(rails[0].children.find(node => node.props['data-workbench-tab'] === 'files').props['aria-selected'], true);
  assert.equal(nodes(rails[1]).find(node => node.props['data-workbench-file'] === 'docs/second.md').props['aria-selected'], true);
  pane.open('a', 'browser');
  tree = render(); rails = tree.filter(node => node.type === 'nav');
  assert.equal(rails.length, 1, 'document row stays within Files, while the files remain session-scoped');
  assert.equal(rails[0].children.find(node => node.props['data-workbench-tab'] === 'browser').props['aria-selected'], true);
  pane.open('a', 'files');
  tree = render(); rails = tree.filter(node => node.type === 'nav');
  assert.equal(rails.length, 2);
  const key = (rail, value) => rail.props.onKeyDown({ key:value, preventDefault() {} });
  key(rails[0], 'ArrowRight');
  assert.equal(pane.get('a').active, 'browser', 'primary arrow navigation crosses only primary views');
  pane.openDocument('a', 'docs/first.md');
  rails = render().filter(node => node.type === 'nav');
  key(rails[1], 'ArrowRight');
  assert.equal(pane.get('a').activeDocument, 'docs/second.md', 'document arrow navigation selects the sibling file');
  assert.deepEqual(pane.get('a').documents, ['docs/first.md', 'docs/second.md']);
});

test('pane factory survives the native lazy factory serialization boundary', () => {
  const factory = vm.runInNewContext(`(${createWorkbenchPane.toString()})`);
  const pane = factory({ createElement() {} }); pane.open('owner', 'files');
  assert.equal(pane.get('owner').active, 'files');
});

test('browser and desktop share the same session pane and cannot close each other late', () => {
  const pane = createWorkbenchPane({createElement() {}});
  assert.equal(pane.open('a', 'browser'), true);
  assert.equal(pane.open('a', 'desktop'), true);
  assert.equal(pane.close('a', 'browser'), false);
  assert.equal(pane.get('a').active, 'desktop');
  pane.open('b', 'browser');
  pane.close('a', 'desktop');
  assert.equal(pane.get('b').active, 'browser');
});

test('workbench remembers open documents per conversation and selects a neighbor when one closes', () => {
  const pane = createWorkbenchPane({ createElement() {} });
  pane.openDocument('a', 'src/first.md');
  pane.openDocument('a', 'src/second.md');
  pane.openDocument('b', 'other.md');
  assert.deepEqual(pane.get('a').documents, ['src/first.md', 'src/second.md']);
  assert.equal(pane.get('a').activeDocument, 'src/second.md');
  pane.open('a', 'browser');
  assert.deepEqual(pane.get('a').documents, ['src/first.md', 'src/second.md'], 'switching surface keeps document tabs');
  pane.selectDocument('a', 'src/first.md');
  assert.equal(pane.get('a').active, 'files');
  assert.equal(pane.get('a').activeDocument, 'src/first.md');
  pane.closeDocument('a', 'src/first.md');
  assert.deepEqual(pane.get('a').documents, ['src/second.md']);
  assert.equal(pane.get('a').activeDocument, 'src/second.md');
  assert.deepEqual(pane.get('b').documents, ['other.md']);
  assert.equal(pane.get('b').activeDocument, 'other.md');
});

test('keyboard closing a document focuses the selected tab, while pointer and unfocused closes preserve focus', () => {
  const document = { activeElement: null };
  let cursor = 0, layout = [], liveTabs = [];
  const rail = { querySelectorAll: selector => selector === '[role="tab"]' ? liveTabs : [] };
  const refs = [{ current: rail }];
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children }; },
    useRef(initial) { return refs[cursor++] ??= { current: initial }; },
    useSyncExternalStore(_subscribe, snapshot) { return snapshot(); },
    useEffect() {},
    useLayoutEffect(effect) { layout.push(effect); },
  };
  const pane = vm.runInNewContext(`(${createWorkbenchPane.toString()})`, { document })(React);
  const nodes = tree => [tree, ...tree.children.flatMap(child => child && typeof child === 'object' && 'type' in child ? nodes(child) : Array.isArray(child) ? child.flatMap(item => item && typeof item === 'object' && 'type' in item ? nodes(item) : []) : [])];
  const render = () => {
    cursor = 0; layout = [];
    const tree = pane.Tabs({ sessionId: 'a' });
    liveTabs = nodes(tree).filter(node => node.props.role === 'tab').map(node => ({
      dataset: { workbenchFile: node.props['data-workbench-file'], workbenchTab: node.props['data-workbench-tab'] },
      getAttribute(name) { return node.props[name]; },
      focus() { document.activeElement = this; },
    }));
    for (const effect of layout) effect();
    return tree;
  };
  const close = (path, detail, focused) => {
    const tree = render();
    const button = nodes(tree).find(node => node.props['aria-label'] === `关闭 ${path}`);
    assert.ok(button);
    const currentTarget = {};
    if (focused) document.activeElement = currentTarget;
    button.props.onClick({ detail, currentTarget });
    render();
  };

  pane.openDocument('a', 'first.md'); pane.openDocument('a', 'second.md');
  close('second.md', 0, true);
  assert.equal(document.activeElement?.dataset.workbenchFile, 'first.md');
  close('first.md', 0, true);
  assert.equal(document.activeElement?.dataset.workbenchTab, 'files', 'closing the last document focuses Files');

  const composer = { name: 'composer' }; document.activeElement = composer;
  pane.openDocument('a', 'first.md'); pane.openDocument('a', 'second.md');
  close('second.md', 1, false);
  assert.equal(document.activeElement, composer, 'pointer close does not move focus');
  close('first.md', 0, false);
  assert.equal(document.activeElement, composer, 'unfocused programmatic close does not move focus');
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
