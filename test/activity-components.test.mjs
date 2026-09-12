import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createActivityComponents } from '../plugin/client/activity-source.mjs';

function chat(...nodes) {
  const map = new Map(nodes.map((node, index) => [node.key ?? `node-${index}`, node]));
  return { order: [...map.keys()], nodes: { get: key => map.get(key) } };
}

function running(callId, title, anchorSeq) {
  return { key: callId, kind: 'tool-call', anchorSeq, data: { root: {
    callId, name: callId, argsRaw: '{"reasoning":"never show"}', time: anchorSeq * 10,
    callView: { card: 'generic', kind: 'read', title }, subCalls: [],
  } } };
}

function settledWeb() {
  return { key: 'web', kind: 'tool-call', anchorSeq: 8, data: { root: {
    kind: 'tool-result', callId: 'web', seq: 8, time: 80, callTime: 70, call: { name: 'web_search', argsRaw: '{}' }, isError: false, content: [], subCalls: [],
    callView: { card: 'generic', kind: 'search', title: '搜索资料' },
    resultView: { card: 'web', kind: 'search', truncated: false, sources: [{ url: 'https://example.com/docs?q=one#intro', title: 'Example docs', snippet: 'Verified source.' }] },
  } } };
}

function settledTerminal() {
  return { key: 'terminal', kind: 'tool-call', anchorSeq: 9, data: { root: {
    kind: 'tool-result', callId: 'terminal', seq: 9, time: 90, callTime: 85, call: { name: 'bash', argsRaw: '{}' }, isError: false, content: [], subCalls: [],
    callView: { card: 'terminal', title: 'pnpm test', cwd: 'C:/repo' },
    resultView: { card: 'terminal', title: '测试完成', output: '12 tests passed', exitCode: 0 },
  } } };
}

function settledRead(callId = 'read-a', anchorSeq = 5) {
  return { key: callId, kind: 'tool-call', anchorSeq, data: { root: {
    kind: 'tool-result', callId, seq: anchorSeq, time: anchorSeq * 10, callTime: anchorSeq * 10 - 5,
    call: { name: 'read', argsRaw: '{}' }, isError: false, content: [], subCalls: [],
    callView: { card: 'generic', kind: 'read', title: '读取工作区' },
    resultView: { card: 'read', path: 'src/app.ts', offset: 1, totalLines: 1, lines: [] },
  } } };
}

function snapshot(id = 'session-a', nodes = [running('read-a', '读取工作区', 5), settledWeb(), settledTerminal()]) {
  return {
    sessionId: id,
    session: {
      sessionId: id, composerPhase: 'active', running: true, pending: [],
      chat: chat(
        { key: 'user', kind: 'user', anchorSeq: 1, data: { content: [{ type: 'text', text: 'User prose must stay out.' }] } },
        { key: 'assistant', kind: 'assistant-step', anchorSeq: 2, data: { blocks: [{ kind: 'reasoning', text: 'Secret hidden reasoning.' }] } },
        ...nodes,
      ),
    },
    pages: { pages: [{ pageId: 'page-a', rootCallId: 'page-call', title: '生成页面', subtitle: '真实产物', status: 'displayed', sequence: 12 }] },
    subagents: { entries: [
      { kind: 'child', id: 'child-live', activity: 'running', mode: 'continuable', label: '并行研究', hasChildren: false },
      { kind: 'child', id: 'child-idle', activity: 'inactive', mode: 'one-shot', label: '旧任务', hasChildren: false },
    ], parentAvailable: true },
    jobs: [{ id: 'bash-1', kind: 'bash', label: 'pnpm build', status: 'running', startedAt: 10 }],
  };
}

function mount(initialSnapshot = snapshot(), options = {}) {
  const instances = new Map(), nodes = new Map(), listeners = new Map(), effects = [];
  let current, cursor, dirty = true, tree, props = { snapshot: initialSnapshot, ...options.props }, destroyed = false, focused;
  const motionCalls = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const cell = initialize => current.hooks[cursor++] ??= initialize();
  const React = {
    createElement: (type, rawProps, ...children) => ({ type, props: { ...(rawProps ?? {}), children: children.flat(Infinity).filter(value => value !== null && value !== undefined && value !== false) } }),
    useRef: value => cell(() => ({ current: value })),
    useState(initial) {
      const state = cell(() => ({ value: typeof initial === 'function' ? initial() : initial }));
      return [state.value, update => {
        if (destroyed) return;
        const value = typeof update === 'function' ? update(state.value) : update;
        if (!Object.is(value, state.value)) { state.value = value; dirty = true; }
      }];
    },
    useMemo(create, deps) {
      const memo = cell(() => ({}));
      if (!same(memo.deps, deps)) { memo.deps = deps; memo.value = create(); }
      return memo.value;
    },
    useEffect(setup, deps) {
      const effect = cell(() => ({}));
      if (!same(effect.deps, deps)) { effect.deps = deps; effect.setup = setup; effects.push(effect); }
    },
    useLayoutEffect(setup, deps) { React.useEffect(setup, deps); },
  };
  const document = {
    activeElement: null,
    addEventListener(type, listener) { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
  };
  const factory = vm.runInNewContext(`(${createActivityComponents.toString()})`, { URL, Date, document });
  const motion = {
    materialize(node) { motionCalls.push({ kind: 'materialize', node }); },
    animate(node, target, config) {
      motionCalls.push({ kind: 'animate', node, target, config }); Object.assign(node.style, target);
      if (target.opacity === '0') config?.onFinish?.();
      return { cancel() {} };
    },
    indicator(node, target, config) { motionCalls.push({ kind: 'indicator', node, target, config }); },
    confirm(node, config) { motionCalls.push({ kind: 'confirm', node, config }); },
    release(node) { if (node) motionCalls.push({ kind: 'release', node }); },
  };
  const frost = { pressHandlers: () => ({}) };
  const api = factory(React, frost, motion);
  function resolve(vnode, path = 'root') {
    if (vnode === null || vnode === undefined || typeof vnode === 'boolean') return null;
    if (typeof vnode !== 'object') return String(vnode);
    if (Array.isArray(vnode)) return vnode.map((child, index) => resolve(child, `${path}.${index}`)).flat().filter(Boolean);
    if (typeof vnode.type === 'function') {
      const key = `${path}:${vnode.type.name}`;
      current = instances.get(key) ?? { hooks: [] }; instances.set(key, current); cursor = 0;
      return resolve(vnode.type(vnode.props), `${key}/`);
    }
    const key = `${path}:${vnode.type}`;
    const node = nodes.get(key) ?? {
      type: vnode.type, props: {}, children: [], style: {}, hidden: false, inert: false,
      scrollHeight: 1000, clientHeight: 400, scrollTop: 600, offsetLeft: 0, offsetTop: 0, offsetWidth: 100, offsetHeight: 36,
      focus() { focused = node; document.activeElement = node; },
      scrollTo(value) { node.lastScroll = value; node.scrollTop = value.top; },
    };
    nodes.set(key, node); node.props = vnode.props; node.hidden = Boolean(vnode.props.hidden); node.inert = Boolean(vnode.props.inert);
    if (typeof vnode.props.ref === 'function') vnode.props.ref(node);
    else if (vnode.props.ref && typeof vnode.props.ref === 'object') vnode.props.ref.current = node;
    node.children = vnode.props.children.map((child, index) => resolve(child, `${key}.${child?.props?.key ?? index}`)).flat().filter(Boolean);
    return node;
  }
  const flatten = node => typeof node === 'object' && node ? [node, ...node.children.flatMap(flatten)] : [];
  const text = node => typeof node === 'string' ? node : (node?.children ?? []).map(text).join('');
  function render() {
    let attempts = 0;
    while (dirty) {
      if (++attempts > 30) throw new Error('Activity Lens did not settle');
      dirty = false; effects.length = 0;
      current = instances.get('root') ?? { hooks: [] }; instances.set('root', current); cursor = 0;
      tree = resolve(React.createElement(api.ActivityLens, props));
      for (const effect of [...effects]) { effect.cleanup?.(); effect.cleanup = effect.setup?.(); }
    }
    return tree;
  }
  render();
  return {
    api, document, motionCalls, get focused() { return focused; },
    all(predicate = () => true) { return flatten(tree).filter(predicate); },
    text() { return text(tree); }, textOf(node) { return text(node); },
    fire(node, name, extra = {}) { node.props[name]?.({ currentTarget: node, target: node, detail: 1, preventDefault() {}, stopPropagation() {}, ...extra }); render(); },
    dispatch(type, extra = {}) { for (const listener of listeners.get(type) ?? []) listener({ preventDefault() {}, stopPropagation() {}, ...extra }); render(); },
    listenerCount(type) { return listeners.get(type)?.size ?? 0; },
    update(next) { props = { ...props, snapshot: next }; dirty = true; render(); },
    unmount() { destroyed = true; for (const instance of instances.values()) for (const hook of instance.hooks) hook.cleanup?.(); },
  };
}

test('utility trigger opens a nonmodal right-side evidence sheet without exposing prose or hidden reasoning', () => {
  const f = mount();
  const trigger = f.all(node => node.type === 'button' && node.props.className?.includes('cx-activity-trigger'))[0];
  assert.equal(trigger.props['aria-expanded'], false);
  assert.equal(f.all(node => node.type === 'aside').length, 0);
  f.fire(trigger, 'onClick');
  const sheet = f.all(node => node.type === 'aside')[0];
  assert.equal(sheet.props['data-open'], 'true');
  assert.equal(sheet.props.role, undefined);
  assert.equal(sheet.props['aria-modal'], undefined);
  assert.match(f.text(), /行动镜|执行轨迹|证据|子智能体|后台活动|来源|终端结果/);
  assert.doesNotMatch(f.text(), /Secret hidden reasoning|User prose must stay out|never show/);
  assert.equal(f.all(node => node.props.className?.includes('scrim')).length, 0);
  const entrance = f.motionCalls.find(call => call.kind === 'animate' && call.node === sheet && call.target.opacity === '1');
  assert.ok(entrance.config.duration <= 180, 'routine evidence panel opens promptly');
  assert.equal(entrance.config.spring, undefined, 'routine evidence panel does not bounce');
  assert.equal(entrance.config.from.transform, 'none');
  f.unmount();
});

test('Escape closes the sheet, restores trigger focus, and does not install an outside-click closer', () => {
  const f = mount();
  const trigger = f.all(node => node.props.className?.includes('cx-activity-trigger'))[0];
  f.fire(trigger, 'onClick');
  assert.equal(f.listenerCount('keydown'), 1);
  assert.equal(f.listenerCount('pointerdown'), 0);
  f.dispatch('keydown', { key: 'Escape' });
  assert.equal(f.all(node => node.type === 'aside').length, 0);
  assert.equal(f.focused, trigger);
  assert.equal(f.listenerCount('keydown'), 0);
  f.unmount();
});

test('subagent navigation and source opening use exact public identities', () => {
  const opened = [], urls = [];
  const f = mount(snapshot(), { props: { onOpenSubagent: value => opened.push(value), onOpenExternal: value => urls.push(value) } });
  f.fire(f.all(node => node.props.className?.includes('cx-activity-trigger'))[0], 'onClick');
  const child = f.all(node => node.props['aria-label'] === '打开子智能体 并行研究')[0];
  f.fire(child, 'onClick');
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), [{ parentSessionId: 'session-a', childSessionId: 'child-live', mode: 'continuable' }]);
  assert.match(f.textOf(child), /并行研究状态未载入/);
  assert.match(f.text(), /状态未载入/);
  assert.doesNotMatch(f.text(), /one-shot|continuable|未运行/);
  const link = f.all(node => node.type === 'a' && node.props.href?.startsWith('https://example.com'))[0];
  f.fire(link, 'onClick');
  assert.deepEqual(urls, ['https://example.com/docs?q=one']);
  assert.equal(link.props.target, '_blank');
  assert.equal(link.props.rel, 'noopener noreferrer');
  f.unmount();
});

test('many subagents render three recent notices with older children in a closed disclosure', () => {
  const state = snapshot();
  state.subagents.entries = Array.from({ length: 22 }, (_, index) => ({ kind: 'child', id: `child-${index}`, mode: 'one-shot', label: `任务 ${index}\nDo not expose the complete prompt`, execution: { status: 'failed', seq: index, time: index, code: 'AUTH', httpStatus: 401 } }));
  const f = mount(state);
  f.fire(f.all(node => node.props.className?.includes('cx-activity-trigger'))[0], 'onClick');
  const progress = f.all(node => node.props['data-pane'] === 'timeline')[0];
  const evidence = f.all(node => node.props['data-pane'] === 'evidence')[0];
  assert.equal(progress.props['data-active'], true);
  assert.match(f.textOf(progress), /任务 21模型认证失败/);
  assert.doesNotMatch(f.textOf(evidence), /子智能体|任务 21/);
  const group = progress.children.find(node => node.type === 'details' && node.props.className?.includes('cx-activity-group'));
  assert.ok(group, 'subagent notices belong to the default progress pane');
  assert.equal(group.children.find(node => node.type === 'ul').children.length, 3);
  assert.ok(progress.children.indexOf(group) < progress.children.findIndex(node => node.props.className === 'cx-activity-operations'));
  const older = f.all(node => node.type === 'details' && node.props.className?.includes('cx-activity-agent-history'))[0];
  assert.ok(older);
  assert.notEqual(older.props.open, true);
  assert.match(f.text(), /查看其余 19 个子任务/);
  assert.match(f.text(), /任务 21模型认证失败/);
  assert.match(f.text(), /模型认证失败/);
  assert.doesNotMatch(f.text(), /complete prompt/);
  f.unmount();
});

test('finished operations are collapsed as history while live work and failure counts remain visible', () => {
  const nodes=[running('live','检查当前文件',10),settledRead('done',3),{...settledTerminal(),data:{root:{...settledTerminal().data.root,isError:true}}}];
  const f=mount(snapshot('history-session',nodes));
  f.fire(f.all(node=>node.props.className?.includes('cx-activity-trigger'))[0],'onClick');
  const history=f.all(node=>node.type==='details' && node.props.className?.includes('cx-activity-history'))[0];
  assert.ok(history,'settled operations have an explicit collapsed history');
  assert.notEqual(history.props.open,true);
  assert.match(f.textOf(history.children[0]),/已结束的操作.*2.*1.*失败/);
  assert.doesNotMatch(f.textOf(history),/检查当前文件/);
  assert.match(f.textOf(history),/读取工作区|测试完成/);
  const live=f.all(node=>node.props.className==='cx-activity-live-operations')[0];
  assert.match(f.textOf(live),/检查当前文件/);
  f.unmount();
});

test('subagent titles and real outcomes are distinct text rows and the header contains no count strip', () => {
  const state=snapshot();state.subagents.entries=[{kind:'child',id:'compact-child',mode:'one-shot',label:'Inspect the browser and validate its implementation',execution:{status:'completed',seq:2,time:10}}];
  const f=mount(state,{props:{onOpenSubagent(){}}});
  f.fire(f.all(node=>node.props.className?.includes('cx-activity-trigger'))[0],'onClick');
  const name=f.all(node=>node.props.className==='cx-activity-agent-name')[0],status=f.all(node=>node.props.className==='cx-activity-agent-status')[0];
  assert.ok(name && status);
  assert.doesNotMatch(f.textOf(name),/完成/);assert.match(f.textOf(status),/完成/);
  const header=f.all(node=>node.type==='header')[0];assert.doesNotMatch(f.textOf(header),/调用|来源|子智能体/);
  f.unmount();
});

test('terminal summaries stay readable while disclosure retains the typed command and its outcome', () => {
  const state=snapshot('command-session',[settledTerminal()]);state.pages={pages:[]};state.subagents={entries:[]};state.jobs=[];
  state.session.running=false;state.session.composerPhase='idle';
  const f=mount(state);f.fire(f.all(node=>node.props.className?.includes('cx-activity-trigger'))[0],'onClick');
  const now=f.all(node=>node.props.className==='cx-activity-now')[0];
  assert.match(f.textOf(now),/命令执行已结束/);assert.doesNotMatch(f.textOf(now),/pnpm test/);
  const command=f.all(node=>node.props.className==='cx-activity-command-detail')[0];assert.equal(f.textOf(command),'pnpm test');
  const history=f.all(node=>node.type==='details' && node.props.className?.includes('cx-activity-history'))[0];
  assert.match(f.textOf(history),/运行命令.*完成/);assert.notEqual(history.props.open,true);
  f.unmount();
});

test('switching sessions clears open, tab, and old evidence before the new session can expand', () => {
  const f = mount();
  f.fire(f.all(node => node.props.className?.includes('cx-activity-trigger'))[0], 'onClick');
  const tabs = f.all(node => node.props.role === 'tab');
  const rail = f.all(node => node.props.role === 'tablist')[0];
  f.fire(rail, 'onKeyDown', { key: 'ArrowRight' });
  assert.equal(f.focused.props['aria-label'], '成果与来源');
  const next = snapshot('session-b', [running('read-b', '只属于 B 的记录', 1)]);
  next.pages = { pages: [] }; next.subagents = { entries: [] }; next.jobs = [];
  f.update(next);
  assert.equal(f.all(node => node.type === 'aside').length, 0);
  assert.doesNotMatch(f.text(), /Example docs|并行研究|12 tests passed/);
  f.fire(f.all(node => node.props.className?.includes('cx-activity-trigger'))[0], 'onClick');
  assert.match(f.text(), /只属于 B 的记录/);
  assert.doesNotMatch(f.text(), /读取工作区|Example docs|并行研究/);
  assert.equal(f.all(node => node.props.role === 'tab' && node.props['aria-selected'] === true)[0].props['aria-label'], '进度');
  assert.equal(tabs.length, 2);
  f.unmount();
});

test('manual browsing suspends current-work follow and Return to current jumps to the top without motion', () => {
  const f = mount(snapshot(), { props: { reducedMotion: true } });
  f.fire(f.all(node => node.props.className?.includes('cx-activity-trigger'))[0], 'onClick');
  const panelEntrance = f.motionCalls.find(call => call.kind === 'animate' && call.node?.props?.className?.includes('cx-activity-sheet') && call.target.opacity === '1');
  assert.notEqual(panelEntrance?.config?.reducedFade, true, 'the shared runtime must suppress the spatial panel transition under Reduced Motion');
  const scroll = f.all(node => node.props.className === 'cx-activity-scroll')[0];
  scroll.scrollTop = 100;
  f.fire(scroll, 'onScroll');
  const next = snapshot('session-a', [running('read-a', '读取工作区', 5), settledWeb(), settledTerminal(), running('new-call', '新增真实调用', 13)]);
  f.update(next);
  const back = f.all(node => node.props.className?.includes('cx-activity-return'))[0];
  assert.match(f.textOf(back), /返回当前 · 1/);
  f.fire(back, 'onClick');
  assert.deepEqual(JSON.parse(JSON.stringify(scroll.lastScroll)), { top: 0, behavior: 'auto' });
  assert.equal(f.all(node => node.props.className?.includes('cx-activity-return')).length, 0);
  f.unmount();
});

test('Computer Use section stays absent until the typed provider projection is supplied', () => {
  const f = mount();
  f.fire(f.all(node => node.props.className?.includes('cx-activity-trigger'))[0], 'onClick');
  assert.doesNotMatch(f.text(), /电脑使用/);
  const next = snapshot();
  next.computer = { version: 1, records: [{ callId: 'computer-1', status: 'running', surfaceLabel: 'Chrome · ColdX' }] };
  f.update(next);
  assert.match(f.text(), /电脑使用|Chrome · ColdX|未提供实时画面/);
  f.unmount();
});

test('computer controls and real screenshots appear together while older operations are collapsed', () => {
  const data = snapshot();
  data.computer = {version:1,records:Array.from({length:5},(_item,index)=>({callId:`computer-${index}`,sourceSeq:index,status:'completed',surfaceLabel:`网页 ${index}`,previewAttachment:{mime:'image/png',base64:'aGVsbG8='}}))};
  const f = mount(data,{props:{computerControls:'浏览器控制入口',renderComputerPreview:record=>`操作截图 ${record.callId}`}});
  f.fire(f.all(node=>node.props.className?.includes('cx-activity-trigger'))[0],'onClick');
  assert.match(f.text(),/浏览器控制入口/); assert.doesNotMatch(f.text(),/未提供实时画面/);
  const history = f.all(node=>node.props.className?.includes('cx-activity-computer-history'))[0];
  assert.equal(history.type,'details'); assert.equal(Boolean(history.props.open),false);
  assert.match(f.textOf(history),/其余 2 次操作/);
  const group = f.all(node=>node.type==='details' && node.props.className?.includes('cx-activity-group')).find(node=>f.textOf(node.children[0]).includes('电脑使用'));
  const recent = group.children.find(node=>node.type==='ul');
  assert.equal(recent.children.length,3); assert.match(f.textOf(recent.children[0]),/网页 4/);
  f.unmount();
});

test('live rows enter once while completed rows move into history without replaying hidden animations', () => {
  const f = mount();
  f.fire(f.all(node => node.props.className?.includes('cx-activity-trigger'))[0], 'onClick');
  const rowMaterializations = () => f.motionCalls.filter(call => call.kind === 'materialize' && call.node?.props?.className === 'cx-activity-row');
  const initialCount = rowMaterializations().length;
  assert.equal(initialCount, 1, 'hidden ended records do not materialize');

  const withNew = snapshot('session-a', [running('read-a', '读取工作区', 5), settledWeb(), settledTerminal(), running('new-call', '新增真实调用', 13)]);
  f.update(withNew);
  assert.equal(rowMaterializations().length, initialCount + 1, 'only the new stable key enters');

  const settled = snapshot('session-a', [running('read-a', '读取工作区', 5), settledWeb(), settledTerminal(), settledRead('new-call', 13)]);
  f.update(settled);
  assert.equal(f.motionCalls.filter(call => call.kind === 'confirm' && call.node?.props?.className === 'cx-activity-row').length, 0, 'reparenting into collapsed history does not animate an invisible row');
  const history=f.all(node=>node.type==='details' && node.props.className?.includes('cx-activity-history'))[0];
  assert.match(f.textOf(history),/读取工作区/);

  const trigger = f.all(node => node.props.className?.includes('cx-activity-trigger'))[0];
  f.fire(trigger, 'onClick');
  f.fire(f.all(node => node.props.className?.includes('cx-activity-trigger'))[0], 'onClick');
  assert.equal(rowMaterializations().length, initialCount + 1, 'reopening does not replay known records');
  f.unmount();
});
