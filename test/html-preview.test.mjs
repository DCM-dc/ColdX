import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const {createHtmlPreviewComponents} = await import('../plugin/client/html-preview-source.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});

function fixture() {
  assert.equal(typeof createHtmlPreviewComponents, 'function');
  const hooks = [], queued = [], messages = new Set(), subscribers = new Set(), builds = [];
  let cursor = 0, theme = 'dark', node, props = {identity:'one\u0000report.html', html:'<input value="draft">', title:'report.html'};
  const same = (a,b) => a?.length === b?.length && a.every((value,index) => Object.is(value,b[index]));
  const cell = init => hooks[cursor++] ??= init();
  const React = {
    createElement(type, props) { return {type,props}; },
    useRef(value) { return cell(() => ({current:value})); },
    useMemo(fn,deps) { const slot = cell(() => ({})); if (!same(slot.deps,deps)) { slot.value=fn(); slot.deps=deps; } return slot.value; },
    useEffect(fn,deps) { const slot = cell(() => ({})); if (!same(slot.deps,deps)) { slot.deps=deps; queued.push(() => {slot.cleanup?.();slot.cleanup=fn();}); } },
  };
  const create = vm.runInNewContext(`(${createHtmlPreviewComponents.toString()})`, {crypto:{randomUUID}, window:{addEventListener(type,listener) {if(type==='message') messages.add(listener);},removeEventListener(type,listener) {messages.delete(listener);}}});
  const {HtmlPreview} = create(React, options => {builds.push(structuredClone(options));return JSON.stringify(options);}, () => theme, listener => {subscribers.add(listener); return () => subscribers.delete(listener);});
  function render() {
    cursor=0;
    const vnode=HtmlPreview(props);
    if (!node || node.props.key !== vnode.props.key) node={contentWindow:{replies:[],postMessage(message) {this.replies.push(structuredClone(message));}}};
    node.props=vnode.props; vnode.props.ref.current=node;
    for(const run of queued.splice(0)) run();
    return node;
  }
  render();
  return {
    get node(){return node;}, builds, subscribers, messages,
    theme(value) {theme=value;for(const listener of subscribers) listener();render();},
    update(value) {props={...props,...value};render();},
    dispatch(data,source=node.contentWindow) {for(const listener of messages) listener({data,source});},
    unmount() {for(const slot of hooks) slot.cleanup?.();},
  };
}

test('HTML preview follows DSH theme without reloading local inputs or scripts', () => {
  const f=fixture(), original=f.node, source=original.props.srcDoc;
  const {channel}=JSON.parse(source);
  assert.equal(f.builds[0].rawDocument,true);
  assert.equal(f.builds[0].theme,'dark');
  assert.equal(original.props.sandbox,'allow-scripts');
  original.draft='unsaved';
  f.theme('light');
  assert.equal(f.node,original);
  assert.equal(f.node.props.srcDoc,source);
  assert.equal(f.node.draft,'unsaved');
  assert.equal(f.builds.length,1);
  assert.deepEqual(original.contentWindow.replies.at(-1),{type:'coldx:theme',channel,theme:'light'});
  original.contentWindow.replies.length=0;
  original.props.onLoad();
  assert.deepEqual(original.contentWindow.replies.at(-1),{type:'coldx:theme',channel,theme:'light'});
  f.update({identity:'two\u0000report.html'});
  assert.notEqual(f.node,original);
  assert.notEqual(JSON.parse(f.node.props.srcDoc).channel,channel);
  assert.equal(f.builds[1].theme,'light');
  assert.equal(f.subscribers.size,1);
  assert.equal(f.messages.size,1);
  f.unmount();
  assert.equal(f.subscribers.size,0);
  assert.equal(f.messages.size,0);
});

test('HTML preview validates message ownership and rejects accidental task submissions', () => {
  const f=fixture(), frame=f.node, {channel}=JSON.parse(frame.props.srcDoc);
  frame.contentWindow.replies.length=0;
  f.dispatch({type:'coldx:ready',channel},{});
  f.dispatch({type:'coldx:ready',channel:'foreign'});
  assert.equal(frame.contentWindow.replies.length,0);
  f.dispatch({type:'coldx:ready',channel});
  assert.equal(frame.contentWindow.replies[0].type,'coldx:theme');
  f.dispatch({type:'coldx:submit',channel,requestId:'one',value:{draft:'secret'}});
  assert.deepEqual(frame.contentWindow.replies.at(-1),{type:'coldx:result',channel,requestId:'one',ok:false,error:'文件预览不能提交任务，请在对话中继续。'});
  f.unmount();
});
