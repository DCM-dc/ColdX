import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { dshRequire } from '../plugin/page-native.mjs';

async function model() {
  const patch = await readFile(new URL('../patches/@deepseek-ai__dsh-client-ui-conversation@0.1.1-rc.2.patch', import.meta.url), 'utf8').catch(() => '');
  const added = patch.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1)).join('\n');
  const start = added.indexOf('// ColdX process model begin');
  const end = added.indexOf('// ColdX process model end');
  assert.ok(start >= 0 && end > start, 'the compatibility patch must ship its grouping model');
  const { coldxProcessGroups } = vm.runInNewContext(`${added.slice(start, end)}; ({ coldxProcessGroups })`);
  return nodes => JSON.parse(JSON.stringify(coldxProcessGroups(nodes.map(node => node.key), new Map(nodes.map(node => [node.key, node])))));
}
const location = (step, turn = 1) => ({ kind: 'step', turn: { turn }, step: { turn, step, status: 'closed' } });
const call = (id, name = 'read', extra = {}) => ({ kind: 'tool-result', callId: id, call: { name }, isError: false, subCalls: [], ...extra });
const tool = (id, step, name = 'read', extra = {}) => ({ key: id, kind: 'tool-call', location: location(step), data: { root: call(id, name, extra) } });
const think = (id, step, blocks = [{ kind: 'reasoning', text: 'working' }]) => ({ key: id, kind: 'assistant', location: location(step), data: { status: 'settled', blocks } });

test('long settled process runs group by native step while preserving every original key', async () => {
  const group = await model();
  const nodes = Array.from({ length: 30 }, (_, i) => [think(`think-${i}`, i + 1), tool(`call-${i}`, i + 1)]).flat();
  const result = group(nodes);
  assert.equal(result.length, 1);
  assert.equal(result[0].stepCount, 30);
  assert.equal(result[0].callCount, 30);
  assert.deepEqual(result[0].nodeKeys, nodes.map(node => node.key));
});

test('answers, generated pages including nested Code Mode pages, errors and active steps stay outside groups', async () => {
  const group = await model();
  const prefix = [think('t1', 1), tool('c1', 1), think('t2', 2), tool('c2', 2)];
  const special = [
    think('answer', 3, [{ kind: 'text', text: 'The result is ready.' }]),
    tool('page', 3, 'coldx_present_page'),
    tool('question', 3, 'coldx_interact'),
    tool('nested', 3, 'run_code', { subCalls: [call('deep-page', 'coldx_present_page')] }),
    tool('error', 3, 'bash', { isError: true }),
    tool('nested-error', 3, 'run_code', { subCalls: [call('failed', 'bash', { isError: true })] }),
    tool('custom', 3, 'custom_editor'),
    { ...think('running', 3), data: { status: 'running', blocks: [{ kind: 'reasoning', text: 'live' }] } },
    { ...tool('active-step', 3), location: { ...location(3), step: { step: 3, status: 'open' } } },
    { ...tool('waiting', 3), data: { root: { callId: 'waiting', name: 'read', subCalls: [] } } },
  ];
  for (const boundary of special) {
    const result = group([...prefix, boundary, ...prefix.map(node => ({ ...node, key: `${node.key}-after` }))]);
    const kept = result.find(entry => entry.nodeKeys.includes(boundary.key));
    assert.equal(kept.nodeKeys.length, 1, boundary.key);
    assert.equal(kept.stepCount, undefined, boundary.key);
    assert.equal(result.length, 3, boundary.key);
  }
});

test('groups do not cross turns or swallow short process runs', async () => {
  const group = await model();
  const short = [think('t1', 1), tool('c1', 1), tool('c2', 1)];
  assert.deepEqual(group(short).map(entry => entry.nodeKeys), [['t1'], ['c1'], ['c2']]);
  const nodes = [...short, { ...tool('turn2', 1), location: location(1, 2) }];
  assert.equal(group(nodes).length, 4);
});

test('selected descendant call ids are retained for automatic disclosure expansion', async () => {
  const group = await model();
  const nodes = [think('t1', 1), tool('c1', 1, 'run_code', { subCalls: [call('child', 'read')] }), think('t2', 2), tool('c2', 2)];
  assert.ok(group(nodes)[0].callIds.includes('child'));
});

test('collapsed process disclosure retains all native children and claims reading before expansion', async () => {
  const patch = await readFile(new URL('../patches/@deepseek-ai__dsh-client-ui-conversation@0.1.1-rc.2.patch', import.meta.url), 'utf8');
  const added = patch.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1)).join('\n');
  const start = added.indexOf('function ColdXProcessGroup(');
  const end = added.indexOf('\n\t\t}', start) + '\n\t\t}'.length;
  let expanded, explored = 0;
  const element = (type, props) => ({ type, props });
  const create = vm.runInNewContext(`(${added.slice(start, end)})`, {
    react: { useState: initial => [expanded ??= initial(), next => { expanded = typeof next === 'function' ? next(expanded) : next; }], useEffect: setup => setup() },
    react_jsx_runtime: { jsx: element, jsxs: element },
  });
  const children = [{ type: 'native-call', key: 'call-1' }, { type: 'native-call', key: 'call-2' }];
  const props = { group: { key: 'group', nodeKeys: ['call-1', 'call-2'], stepCount: 2, callCount: 2, callIds: ['call-1', 'call-2'] }, chatScroll: { read: () => null }, onExplore: () => explored++, children };
  let tree = create(props);
  assert.equal(tree.type, 'details');
  assert.equal(tree.props.open, false);
  assert.equal(tree.props.children[1].props.children, children, 'closing the group must not unmount its native call seats');
  let prevented = false;
  tree.props.children[0].props.onClick({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'controlled expansion must cancel the native default toggle before the parent rerenders');
  assert.equal(explored, 1, 'reading the expanded group must suspend native follow-to-bottom');
  tree = create(props);
  assert.equal(tree.props.open, true);
  assert.equal(tree.props.children[1].props.children, children);
  tree.props.children[0].props.onClick({ preventDefault() {} });
  tree = create(props);
  assert.equal(tree.props.open, false, 'a second activation collapses through the same React state owner');
  expanded = undefined;
  tree = create({ ...props, chatScroll: { read: () => ({ anchorKey: 'call-2' }) } });
  assert.equal(tree.props.open, true, 'a restored scroll anchor inside the group starts visible');
});

test('file mentions preserve native resolution and consult only the exact-session registered fallback', async () => {
  const patch = await readFile(new URL('../patches/@deepseek-ai__dsh-client-ui-conversation@0.1.1-rc.2.patch', import.meta.url), 'utf8');
  const added = patch.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1)).join('\n');
  const start = added.indexOf('// ColdX file mentions begin'), end = added.indexOf('// ColdX file mentions end');
  assert.ok(start >= 0 && end > start, 'the compatibility patch must ship the composed file resolver');
  const compose = vm.runInNewContext(`${added.slice(start, end)}; coldxFileMentions`);
  const nativeHit = { title: 'native/file.txt', open() {} };
  const fallbackHit = { title: 'artifacts/report.pdf', open() {} };
  const calls = [], owner = { seq: 51 };
  const services = new Map([
    ['chatFileMentions', { forClosing(value) { assert.equal(value, owner); return { resolve(value) { return value === 'file.txt' ? nativeHit : undefined; } }; } }],
    ['coldxFilePreview', { resolve(id, value) { calls.push([id, value]); return value === 'report.pdf' ? fallbackHit : undefined; } }],
  ]);
  const ctx = { get: key => services.get(key) };
  const mentions = compose(ctx, 'exact-session', owner);
  assert.equal(mentions.resolve('file.txt'), nativeHit);
  assert.equal(calls.length, 0, 'native hits must not be shadowed by session fallback paths');
  assert.equal(mentions.resolve('report.pdf'), fallbackHit);
  assert.deepEqual(calls.at(-1), ['exact-session', 'report.pdf']);
  assert.equal(mentions.resolve('unregistered.pdf'), undefined);
  services.delete('coldxFilePreview');
  assert.equal(compose(ctx, 'exact-session', owner).resolve('file.txt'), nativeHit);
  services.clear();
  assert.equal(compose(ctx, 'exact-session', owner), undefined);
});

test('process grouping observes content-only changes in the native mutable node store', async () => {
  const patch = await readFile(new URL('../patches/@deepseek-ai__dsh-client-ui-conversation@0.1.1-rc.2.patch', import.meta.url), 'utf8');
  const selected = patch.match(/\+[^\n]*const processNodes = useSession\(([^\n]+)\);/u)?.[1];
  assert.ok(selected, 'groups must subscribe to content updates, not the unchanged store identity');
  const select = vm.runInNewContext(`(${selected})`);
  // Characterize rc.2's actual mutable store: values() caches until an upsert,
  // while the store object and order remain identical through a late child.
  const source = await readFile(dshRequire.resolve('@deepseek-ai/dsh-client-ui-conversation/client'), 'utf8');
  const start = source.indexOf('var MutableChatNodeStore = class {');
  const end = source.indexOf('var MutableChatLocationIndex = class {', start);
  const Store = vm.runInNewContext(`const EMPTY_LIST = []; ${source.slice(start,end)}; MutableChatNodeStore`);
  const store = new Store();
  const nodes = [think('t1', 1), tool('c1', 1, 'run_code'), think('t2', 2), tool('c2', 2)];
  store.replace(nodes);
  const snapshot = { chat: { nodes: store, order: nodes.map(node => node.key) } };
  const before = select(snapshot);
  assert.equal(select(snapshot), before, 'unchanged snapshots must not cause a React subscription loop');
  store.upsert([tool('c1', 1, 'run_code', { subCalls: [call('late-page', 'coldx_present_page')] })]);
  const after = select(snapshot);
  assert.notEqual(after, before, 'a late page must invalidate the enclosing process group');
  const group = await model();
  assert.equal(group([...after]).find(item => item.nodeKeys.includes('c1')).nodeKeys.length, 1);
});
