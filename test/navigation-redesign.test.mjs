import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkbenchNavigation } from '../plugin/client/navigation-source.mjs';

function harness(overrides = {}) {
  let values = [], cursor = 0;
  const React = {
    Fragment: Symbol('fragment'),
    createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
    useState(initial) {
      const slot = cursor++;
      if (!(slot in values)) values[slot] = typeof initial === 'function' ? initial() : initial;
      return [values[slot], value => { values[slot] = typeof value === 'function' ? value(values[slot]) : value; }];
    },
    useRef(value) { return { current: value }; },
    useEffect() {},
    useSyncExternalStore(_subscribe, read) { return read(); },
  };
  const rows = overrides.rows ?? [{ id: 's1', displayTitle: 'Build editor', updatedAt: 2 }, { id: 's2', displayTitle: 'Fix input', updatedAt: 1 }];
  const sessions = { ids: rows.map(row => row.id), byId: Object.fromEntries(rows.map(row => [row.id, row])), current: 's1' };
  const ctx = {
    settingsScope: { bind() { return { subscribe() { return () => {}; }, getSnapshot() { return { value: { pinned: [] } }; } }; } },
    sessions: { list: { subscribe() { return () => {}; }, getSnapshot() { return sessions; } }, open() {}, search() {} },
    workspaces: { list: { subscribe() { return () => {}; }, getSnapshot() { return { items: [], archivedSessionIds: [] }; } } },
  };
  const navigation = createWorkbenchNavigation(React, ctx, { icon: name => ({ type: 'icon', props: { name, children: [] } }), api: overrides.api ?? (async () => ({ items: [] })), files: {}, pane: {} });
  const render = id => {
    navigation.navigate(id);
    cursor = 0;
    const root = navigation.Pages();
    const body = walk(root).find(node => node.props?.className === 'cx-workbench-page-body');
    cursor = 0;
    return body.props.children[0].type();
  };
  return { render, seed(next) { values = next; }, navigation, sessions };
}

function walk(node) {
  if (node == null || typeof node !== 'object') return [];
  return [node, ...(node.props?.children ?? []).flat(Infinity).flatMap(walk)];
}

test('search has an actionable recent-conversation state before a query', () => {
  const { render } = harness();
  const tree = render('search');
  assert.match(JSON.stringify(tree), /最近会话/);
  assert.equal(walk(tree).filter(node => node.props?.className?.includes('cx-page-list-row')).length, 2);
  assert.ok(walk(tree).some(node => node.props?.['aria-label'] === '搜索名称或对话内容'));
});

test('scheduled tasks expose native live state and distinguish an empty filtered result', () => {
  const { render, seed } = harness();
  seed([{ loading: false, data: { items: [{ id: 'job', sessionId: 's1', prompt: 'Check release', title: 'Release', scheduledAt: '2026-09-26T08:00:00.000Z', kind: 'every', everySeconds: 86400, live: false }] } }, 0, 'missing']);
  const tree = render('schedules');
  assert.match(JSON.stringify(tree), /没有匹配的定时任务/);
  assert.match(JSON.stringify(tree), /所属会话已打开/);
  seed([{ loading: false, data: { items: [{ id: 'job', sessionId: 's1', prompt: 'Check release', title: 'Release', scheduledAt: '2026-09-26T08:00:00.000Z', kind: 'every', everySeconds: 86400, live: false }] } }, 0, '']);
  const scheduled = render('schedules');
  assert.match(JSON.stringify(scheduled), /等待会话打开/);
  assert.ok(walk(scheduled).find(node => node.type === 'button' && node.props?.children?.includes('取消安排')).props.disabled);
});

test('pull requests reject non-web target URLs while preserving valid PR links', () => {
  const { render, seed } = harness();
  seed(['s1', { loading: false, data: { items: [
    { number: 7, title: 'Good PR', url: 'https://github.com/example/repo/pull/7', headRefName: 'feature', isDraft: false },
    { number: 8, title: 'Unsafe PR', url: 'javascript:alert(1)', headRefName: 'other', isDraft: false },
  ] } }, 0]);
  const tree = render('pullRequests');
  const links = walk(tree).filter(node => node.type === 'a');
  assert.equal(links.length, 1);
  assert.equal(links[0].props.href, 'https://github.com/example/repo/pull/7');
  assert.match(JSON.stringify(tree), /Unsafe PR/);
});

test('schedule form still calls the native operation with its selected session', async () => {
  const calls = [];
  const { render, seed } = harness({ api: async (...args) => { calls.push(args); return { ok: true }; } });
  seed([{ loading: false, data: { items: [] } }, 0, '', true, 's1', 'Check release', 'daily']);
  const tree = render('schedules');
  const form = walk(tree).find(node => node.type === 'form');
  assert.ok(form);
  form.props.onSubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [['schedule', { operation: 'create', sessionId: 's1', prompt: 'Check release', everySeconds: 86400 }]]);
});
