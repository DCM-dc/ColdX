import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkbenchNavigation } from '../plugin/client/navigation-source.mjs';

function harness(overrides = {}) {
  let values = [], cursor = 0;
  const calls = [], effects = [], fileQueries = [], fileOpens = [];
  const React = {
    Fragment: Symbol('fragment'),
    createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
    useState(initial) {
      const slot = cursor++;
      if (!(slot in values)) values[slot] = typeof initial === 'function' ? initial() : initial;
      return [values[slot], value => { values[slot] = typeof value === 'function' ? value(values[slot]) : value; }];
    },
    useRef(value) { return { current: value }; },
    useEffect(callback) { effects.push(callback); },
    useSyncExternalStore(_subscribe, read) { return read(); },
  };
  const rows = overrides.rows ?? [{ id: 's1', displayTitle: 'Build editor', updatedAt: 2 }, { id: 's2', displayTitle: 'Fix input', updatedAt: 1 }];
  const sessions = { ids: rows.map(row => row.id), byId: Object.fromEntries(rows.map(row => [row.id, row])), current: 's1' };
  const ctx = {
    settingsScope: { bind() { return { subscribe() { return () => {}; }, getSnapshot() { return { value: { pinned: [] } }; } }; } },
    sessions: { list: { subscribe() { return () => {}; }, getSnapshot() { return sessions; } }, open(id) { calls.push(['open', id]); }, async search() { return { ok: true, value: { items: [] } }; } },
    workspaces: { list: { subscribe() { return () => {}; }, getSnapshot() { return { items: overrides.spaces ?? [], archivedSessionIds: overrides.archived ?? [] }; } }, startSession(id) { calls.push(['start', id]); return overrides.startSession?.(id); }, async pickDirectory() { calls.push(['pick']); return undefined; } },
    remote: { fileReferences: { list(...args) { fileQueries.push(args); return overrides.fileList ? overrides.fileList(...args) : overrides.fileResults ?? { ok: true, value: [] }; } } },
  };
  const navigation = createWorkbenchNavigation(React, ctx, { icon: name => ({ type: 'icon', props: { name, children: [] } }), api: overrides.api ?? (async () => ({ items: [] })), files: { open(...args) { fileOpens.push(args); } }, pane: {} });
  const render = id => {
    navigation.navigate(id);
    cursor = 0;
    const root = navigation.Pages();
    const body = walk(root).find(node => node.props?.className === 'cx-workbench-page-body');
    cursor = 0;
    return body.props.children[0].type();
  };
  return { render, seed(next) { values = next; }, navigation, sessions, calls, effects, fileQueries, fileOpens, resetHooks() { cursor = 0; } };
}

function walk(node) {
  if (node == null || typeof node !== 'object') return [];
  return [node, ...(node.props?.children ?? []).flat(Infinity).flatMap(walk)];
}

test('search opens a command dialog with native task and project actions', () => {
  const { navigation, calls } = harness({ spaces: [{ workspaceId: 'w1', title: 'Project one' }] });
  const nav = navigation.Nav({ wide: true });
  walk(nav).find(node => node.props?.['aria-label'] === '搜索与命令').props.onClick({ currentTarget: { focus() {} } });
  const page = navigation.Pages();
  const dialog = walk(page).find(node => node.props?.role === 'dialog');
  assert.ok(dialog, 'search uses an accessible overlay dialog');
  assert.equal(dialog.type, 'dialog', 'search is in the native top layer above a narrow modal workbench drawer');
  assert.equal(dialog.props['aria-modal'], true);
  assert.equal(calls.length, 0, 'opening search does not create a conversation');
  const search = walk(dialog).find(node => typeof node.type === 'function');
  const tree = search.type(search.props);
  assert.match(JSON.stringify(tree), /最近会话/);
  assert.equal(walk(tree).filter(node => node.props?.['data-session-id']).length, 2);
  const newChat = walk(tree).find(node => node.props?.['aria-label']?.startsWith('新对话'));
  newChat.props.onClick();
  assert.deepEqual(calls, [['start', undefined]]);
});

test('repeated Enter while a new conversation is starting creates only one conversation', async () => {
  let finish;
  const fixture = harness({ startSession: () => new Promise(resolve => { finish = resolve; }) });
  fixture.seed(['新对话']);
  fixture.navigation.navigate('search');
  const dialog = walk(fixture.navigation.Pages()).find(node => node.props?.role === 'dialog');
  const search = walk(dialog).find(node => typeof node.type === 'function');
  const input = walk(search.type(search.props)).find(node => node.props?.role === 'combobox');
  input.props.onKeyDown({ key: 'Enter', preventDefault() {} });
  input.props.onKeyDown({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(fixture.calls, [['start', undefined]]);
  finish();
  await Promise.resolve();
});

test('double clicking an in-flight new-conversation command creates only one conversation', async () => {
  let finish;
  const fixture = harness({ startSession: () => new Promise(resolve => { finish = resolve; }) });
  fixture.navigation.navigate('search');
  const dialog = walk(fixture.navigation.Pages()).find(node => node.props?.role === 'dialog');
  const search = walk(dialog).find(node => typeof node.type === 'function');
  const newChat = walk(search.type(search.props)).find(node => node.props?.['aria-label']?.startsWith('新对话'));
  newChat.props.onClick();
  newChat.props.onClick();
  assert.deepEqual(fixture.calls, [['start', undefined]]);
  finish();
  await Promise.resolve();
});

test('same-name file results expose their complete paths to assistive technology', () => {
  const fixture = harness();
  fixture.seed(['README', null, false, 0, 0, '', { owner:'s1', query:'README', items:[
    {path:'docs/README.md',kind:'file'}, {path:'src/README.md',kind:'file'},
  ] }, false, '']);
  fixture.navigation.navigate('search');
  const dialog = walk(fixture.navigation.Pages()).find(node => node.props?.role === 'dialog');
  const search = walk(dialog).find(node => typeof node.type === 'function');
  const files = walk(search.type(search.props)).filter(node => node.props?.['data-file-path']);
  assert.equal(files.length, 2);
  assert.match(files[0].props['aria-label'], /docs\/README\.md/);
  assert.match(files[1].props['aria-label'], /src\/README\.md/);
});

test('a failed conversation search identifies partial failure while file matches remain usable', () => {
  const fixture = harness();
  fixture.seed(['README', {ok:false,error:{message:'索引不可用'}}, false, 0, 0, '',
    {owner:'s1',query:'README',items:[{path:'docs/README.md',kind:'file'}]}, false, '']);
  fixture.navigation.navigate('search');
  const dialog = walk(fixture.navigation.Pages()).find(node => node.props?.role === 'dialog');
  const search = walk(dialog).find(node => typeof node.type === 'function');
  const tree = search.type(search.props);
  assert.ok(walk(tree).find(node => node.props?.['data-file-path'] === 'docs/README.md'));
  const status = walk(tree).find(node => node.props?.className === 'cx-command-status');
  assert.match(JSON.stringify(status), /会话搜索失败/);
  assert.match(JSON.stringify(status), /文件结果仍可使用/);
});

test('command dialog enters the native top layer even when the narrow workbench drawer is open', () => {
  const fixture = harness();
  fixture.navigation.navigate('search');
  const previousDocument = globalThis.document;
  globalThis.document = { querySelector() { return null; } };
  try {
    const dialog = walk(fixture.navigation.Pages()).find(node => node.props?.role === 'dialog');
    const calls = [];
    dialog.props.ref.current = {
      open: false,
      showModal() { calls.push('showModal'); this.open = true; },
      close() { calls.push('close'); this.open = false; },
    };
    const cleanup = fixture.effects.at(-1)();
    assert.deepEqual(calls, ['showModal']);
    cleanup();
    assert.deepEqual(calls, ['showModal', 'close']);
  } finally { globalThis.document = previousDocument; }
});

test('command results omit archived sessions and Enter opens selected native session', () => {
  const { navigation, calls } = harness({ archived: ['s1'] });
  navigation.navigate('search');
  const dialog = walk(navigation.Pages()).find(node => node.props?.role === 'dialog');
  const search = walk(dialog).find(node => typeof node.type === 'function');
  const tree = search.type(search.props);
  assert.deepEqual(walk(tree).filter(node => node.props?.['data-session-id']).map(node => node.props['data-session-id']), ['s2']);
  const input = walk(tree).find(node => node.props?.role === 'combobox');
  input.props.onKeyDown({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(calls, [['open', 's2']]);
});

test('Ctrl+K reopens search without losing the original focus target or creating a session', async () => {
  const fixture = harness();
  let onKeyDown, restored = 0, inputFocused = 0;
  const origin = { isConnected: true, focus() { restored++; } };
  const previousDocument = globalThis.document;
  globalThis.document = {
    activeElement: origin,
    addEventListener(name, listener) { if (name === 'keydown') onKeyDown = listener; },
    removeEventListener() {},
    querySelector(selector) { return selector === '.cx-command-search input' ? { focus() { inputFocused++; } } : null; },
  };
  try {
    fixture.navigation.Pages();
    const dispose = fixture.effects[0]();
    const key = (letter, preventDefault) => onKeyDown({ key: letter, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, preventDefault });
    let prevented = 0;
    key('k', () => prevented++);
    assert.ok(walk(fixture.navigation.Pages()).find(node => node.props?.role === 'dialog'));
    globalThis.document.activeElement = { isConnected: false };
    key('k', () => prevented++);
    assert.equal(inputFocused, 1);
    key('n', () => prevented++);
    assert.equal(prevented, 2, 'Ctrl+N remains owned by the host/native shortcut');
    const dialog = walk(fixture.navigation.Pages()).find(node => node.props?.role === 'dialog');
    dialog.props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
    await Promise.resolve();
    assert.equal(restored, 1);
    assert.deepEqual(fixture.calls, []);
    dispose();
  } finally { globalThis.document = previousDocument; }
});

test('closing a palette opened from page body restores focus to the search control', async () => {
  const fixture = harness();
  let onKeyDown, bodyFocus = 0, searchFocus = 0;
  const body = { isConnected:true, focus() { bodyFocus++; } };
  const searchButton = { isConnected:true, focus() { searchFocus++; } };
  const previousDocument = globalThis.document;
  globalThis.document = {
    body, documentElement:{ isConnected:true }, activeElement:body,
    addEventListener(name, listener) { if(name==='keydown')onKeyDown=listener; },
    removeEventListener() {},
    querySelector(selector) { return selector.includes('.cx-navigation-search') ? searchButton : null; },
  };
  try {
    fixture.navigation.Pages();
    const dispose = fixture.effects[0]();
    onKeyDown({ key:'k', ctrlKey:true, metaKey:false, altKey:false, shiftKey:false, preventDefault() {} });
    const dialog = walk(fixture.navigation.Pages()).find(node => node.props?.role === 'dialog');
    dialog.props.onKeyDown({ key:'Escape', preventDefault() {}, stopPropagation() {} });
    await Promise.resolve();
    assert.equal(bodyFocus, 0);
    assert.equal(searchFocus, 1);
    dispose();
  } finally { globalThis.document=previousDocument; }
});

test('query shows native workspace files and opens the owning session preview', async () => {
  const fixture = harness({ fileResults: { ok: true, value: [{ path: 'docs/README.md', kind: 'file' }, { path: 'docs', kind: 'directory' }] } });
  fixture.navigation.navigate('search');
  const dialog = walk(fixture.navigation.Pages()).find(node => node.props?.role === 'dialog');
  const search = walk(dialog).find(node => typeof node.type === 'function');
  let tree = search.type(search.props);
  walk(tree).find(node => node.props?.role === 'combobox').props.onChange({ target: { value: 'README' } });
  fixture.resetHooks();
  tree = search.type(search.props);
  const fileEffect = fixture.effects.at(-1);
  assert.equal(typeof fileEffect, 'function');
  const stopFirst = fileEffect();
  await new Promise(resolve => setTimeout(resolve, 140));
  fixture.resetHooks();
  tree = search.type(search.props);
  const file = walk(tree).find(node => node.props?.['data-file-path'] === 'docs/README.md');
  assert.ok(file, 'native file result appears in a separate group');
  file.props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fixture.fileQueries.map(([id, query]) => [id, query]), [['s1', 'README']]);
  assert.deepEqual(fixture.fileOpens, [['s1', 'docs/README.md']]);
  assert.equal(walk(tree).some(node => node.props?.['data-file-path'] === 'docs'), false, 'directories are not offered as file previews');
  walk(tree).find(node => node.props?.role === 'combobox').props.onChange({ target: { value: 'other' } });
  fixture.resetHooks();
  tree = search.type(search.props);
  assert.equal(walk(tree).some(node => node.props?.['data-file-path'] === 'docs/README.md'), false, 'old file hits disappear as soon as the query changes');
  stopFirst();
  const stopSecond = fixture.effects.at(-1)();
  walk(tree).find(node => node.props?.role === 'combobox').props.onChange({ target: { value: '' } });
  fixture.resetHooks();
  tree = search.type(search.props);
  stopSecond();
  fixture.effects.at(-1)();
  fixture.resetHooks();
  tree = search.type(search.props);
  assert.doesNotMatch(JSON.stringify(tree), /正在搜索…/, 'clearing a pending file query clears loading state');
});

test('synchronous native file search failure becomes an error instead of leaving search loading', async () => {
  const fixture = harness({ fileList() { throw Error('磁盘不可用'); } });
  fixture.navigation.navigate('search');
  const dialog = walk(fixture.navigation.Pages()).find(node => node.props?.role === 'dialog');
  const search = walk(dialog).find(node => typeof node.type === 'function');
  let tree = search.type(search.props);
  walk(tree).find(node => node.props?.role === 'combobox').props.onChange({ target: { value: 'readme' } });
  fixture.resetHooks();
  search.type(search.props);
  const stop = fixture.effects.at(-1)();
  await new Promise(resolve => setTimeout(resolve, 140));
  fixture.resetHooks();
  tree = search.type(search.props);
  assert.match(JSON.stringify(tree), /磁盘不可用/);
  assert.doesNotMatch(JSON.stringify(tree), /正在搜索…/);
  assert.equal(fixture.fileQueries.length, 1);
  stop();
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
