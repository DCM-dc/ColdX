import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLabComponents } from '../plugin/client/lab-source.mjs';
import { createLabFiles } from '../plugin/lab-files.mjs';

// A hook scheduler exercises transport/lifetime behavior without pretending to
// test browser layout. Motion and the real Gateway have separate native tests.
function fixture() {
  const slots = [], effects = [], requests = [], indicators = [], flips = [];
  let cursor = 0, tree, alive = true, lateWrites = 0;
  const React = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], update => { if (!alive) lateWrites++; slots[index] = typeof update === 'function' ? update(slots[index]) : update; }];
    },
    useRef(value) { const index = cursor++; return slots[index] ??= { current: value }; },
    useId() { return React.useRef(`id-${cursor}`).current; },
    useEffect(effect, deps) {
      const index = cursor++, previous = slots[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        const next = { deps, cleanup: null }; slots[index] = next;
        effects.push(() => { previous?.cleanup?.(); next.cleanup = effect(); });
      }
    },
    useLayoutEffect(effect, deps) { React.useEffect(effect, deps); },
  };
  const create = vm.runInNewContext(`(${createLabComponents.toString()})`, { crypto, AbortController });
  const { Lab } = create(React, () => ({ dispose() {}, flip(...args) { flips.push(args); }, indicator(...args) { indicators.push(args); }, release() {} }));
  const ctx = { connection: { rpc: { call(path, method, params, signal) {
    assert.equal(path, '/api');
    return new Promise((resolve, reject) => requests.push({ method, params, signal, resolve, reject }));
  } } } };
  let props = { ctx, sessionId: 'agent-a' };
  const render = () => { cursor = 0; tree = Lab(props); while (effects.length) effects.shift()(); return tree; };
  function all(node) { return node && typeof node === 'object' ? [node, ...(node.props?.children ?? []).flat(Infinity).flatMap(all)] : []; }
  const label = node => node && typeof node === 'object' ? (node.props?.children ?? []).flat(Infinity).map(label).join('') : String(node ?? '');
  return {
    requests, indicators, flips, render,
    all: () => all(tree),
    button(text) { return all(tree).find(node => node.type === 'button' && label(node).includes(text)); },
    text() { return label(tree); },
    session(value) { props = { ...props, sessionId: value }; render(); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); alive = false; },
    lateWrites: () => lateWrites,
  };
}

const flush = () => new Promise(resolve => setImmediate(resolve));
function run(id = 'run-a') {
  const files = Array.from({ length: 12 }, (_, i) => ({ id: `file-${i}`, name: `sample-${i}.md`, bytes: 32 }));
  return { runId: id, files, versions: [], plans: ['project', 'type', 'time', 'mixed'].map(id => ({ id, label: id, entries: files.map(file => ({ ...file, fileId: file.id, group: 'Samples' })) })) };
}
async function ready(f, value = run()) { f.render(); f.requests[0].resolve({ ok: true, value }); await flush(); f.render(); }

test('serialized Lab sends native Agent-scoped requests and deduplicates Apply before a rerender', async () => {
  const f = fixture(); await ready(f);
  assert.equal(f.requests[0].method, 'coldxLab/create');
  assert.equal(f.requests[0].params.args.agentId, 'agent-a');
  const apply = f.button('应用这个方案');
  apply.props.onClick(); apply.props.onClick();
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].method, 'coldxLab/apply');
  assert.equal(f.requests[1].params.args.request.planId, 'mixed');
  f.requests[1].resolve({ ok: true, value: { versionId: 'version-a', outputPath: 'C:\\verified-output', files: run().files, verified: true } });
  await flush(); f.render();
  assert.match(f.text(), /12 个文件已写入，内容核验一致/);
  assert.match(f.text(), /C:\\verified-output/);
  f.button('再生成一版').props.onClick();
  assert.notEqual(f.requests[2].params.args.request.requestId, f.requests[1].params.args.request.requestId);
  f.unmount();
});

test('cancelled Apply retries with the same operation ID and cannot update an unmounted Lab', async () => {
  const f = fixture(); await ready(f);
  f.button('应用这个方案').props.onClick(); f.render();
  const first = f.requests[1];
  f.button('停止').props.onClick();
  assert.equal(first.signal.aborted, true);
  first.reject(new Error('aborted')); await flush(); f.render();
  assert.match(f.text(), /已停止等待/);
  f.button('应用这个方案').props.onClick();
  assert.equal(f.requests[2].params.args.request.requestId, first.params.args.request.requestId);
  f.unmount(); assert.equal(f.requests[2].signal.aborted, true);
  f.requests[2].resolve({ ok: true, value: { versionId: 'late', files: [] } });
  await flush(); assert.equal(f.lateWrites(), 0);
});

test('a session switch aborts old preparation and ignores its late response', async () => {
  const f = fixture(); f.render(); const first = f.requests[0];
  f.session('agent-b');
  assert.equal(first.signal.aborted, true);
  assert.equal(f.requests[1].params.args.agentId, 'agent-b');
  first.resolve({ ok: true, value: run('old-run') });
  f.requests[1].resolve({ ok: true, value: run('new-run') });
  await flush(); f.render(); f.button('应用这个方案').props.onClick();
  assert.equal(f.requests[2].params.args.request.runId, 'new-run');
  f.unmount();
});

test('the plan indicator uses layout bounds while a pressed pill is visually scaled', async () => {
  const f = fixture(); await ready(f);
  const rail = f.all().find(node => node.props.className === 'coldx-lab-plans');
  const plate = f.all().find(node => node.props.className === 'coldx-lab-selection');
  rail.props.ref.current = { scrollLeft: 0, getBoundingClientRect: () => ({ left: 20, top: 10 }) };
  plate.props.ref.current = { style: {} };
  const pill = f.all().find(node => node.props.role === 'tab' && node.props.children[0] === 'type');
  pill.props.ref({ offsetLeft: 100, offsetTop: 4, offsetWidth: 96, offsetHeight: 44,
    getBoundingClientRect: () => ({ left: 121.44, top: 14.66, width: 93.12, height: 42.68 }) });
  pill.props.onClick({ detail: 0 }); f.render();
  assert.deepEqual(JSON.parse(JSON.stringify(f.indicators.at(-1)[1])), { left: 100, top: 4, width: 96, height: 44 });
  assert.equal(f.indicators.at(-1)[2].keyboard, true);
  f.unmount();
});

test('keyboard regrouping settles FLIP immediately for both a group button and a custom form', async () => {
  for (const form of [false, true]) {
    const f = fixture(); await ready(f);
    const wrapper = f.all().find(node => node.props.className === 'coldx-lab-file-wrap');
    wrapper.props.ref({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 120, height: 44 }) });
    f.all().find(node => node.props.className === 'coldx-lab-file').props.onClick(); f.render();
    if (form) {
      f.all().find(node => node.type === 'input').props.onChange({ target: { value: '新分组' } }); f.render();
      f.all().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    } else f.button('优先处理').props.onClick({ detail: 0 });
    f.render(); assert.equal(f.flips.at(-1)[2].keyboard, true); f.unmount();
  }
});

test('mixed preview exposes the real project/type hierarchy and preserves every file when switching or overriding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coldx-lab-preview-'));
  const files = createLabFiles({ labRoot: join(root, 'source'), outputRoot: join(root, 'output') });
  const value = await files.create({ ownerId: 'agent-a', requestId: 'hierarchy' });
  const f = fixture(); await ready(f, value);
  const groups = () => f.all().filter(node => node.props.className === 'coldx-lab-subgroup');
  const fileButtons = () => f.all().filter(node => node.props.className === 'coldx-lab-file');
  assert.equal(groups().length, 9);
  assert.equal(fileButtons().length, 12);
  assert.match(f.text(), /3 个文件夹 · 9 个子分组/);
  assert.deepEqual(groups().map(node => node.props['aria-label']).sort(), [...new Set(value.plans.find(plan => plan.id === 'mixed').entries.map(entry => entry.group))].sort());
  f.button(value.plans.find(plan => plan.id === 'project').label).props.onClick({ detail: 1 }); f.render();
  assert.equal(groups().length, 0);
  assert.equal(fileButtons().length, 12);
  assert.doesNotMatch(f.text(), /子分组/);
  f.button(value.plans.find(plan => plan.id === 'mixed').label).props.onClick({ detail: 1 }); f.render();
  assert.equal(groups().length, 9);
  fileButtons()[0].props.onClick(); f.render();
  f.button('优先处理').props.onClick({ detail: 1 }); f.render();
  assert.equal(fileButtons().length, 12);
  assert.equal(new Set(fileButtons().map(node => node.props.title)).size, 12);
  assert.match(f.text(), /4 个文件夹/);
  f.unmount();
});
