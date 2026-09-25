import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkbenchShell } from '../plugin/client/workbench-shell-source.mjs';

function fixture(summaryOpen = false) {
  const states = [];
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
    useState(initial) {
      const slot = states.length;
      const value = typeof initial === 'function' ? initial() : initial;
      states.push(slot === 0 && summaryOpen ? true : value);
      return [states[slot], value => { states[slot] = typeof value === 'function' ? value(states[slot]) : value; }];
    },
    useRef(value) { return { current: value }; },
    useEffect() {},
  };
  return { ...createWorkbenchShell(React), states };
}

const all = node => !node || typeof node !== 'object' ? [] : [node, ...(node.props?.children ?? []).flat(Infinity).flatMap(all)];
const copy = node => typeof node === 'string' ? node : !node || typeof node !== 'object' ? '' : (node.props?.children ?? []).flat(Infinity).map(copy).join(' ');
const model = overrides => ({
  outputs: [], subagents: [], computers: [], terminals: [],
  sources: { web: [], workspace: [], session: [], loadedCount: 0 },
  counts: { calls: 0 }, now: { kind: 'idle', text: '查看本次行动与证据', status: 'unknown', tone: 'neutral' },
  ...overrides,
});

test('explicitly opened summary exposes native progress', async () => {
  const { Summary, states } = fixture(true);
  const opened = [];
  const tree = Summary({ sessionId: 'parent', model: model({
    now: { kind: 'call', text: '读取工作区', status: 'running', tone: 'accent' },
    counts: { calls: 2 },
  }), onOpenView: view => opened.push(view) });
  const nodes = all(tree);
  const aside = nodes.find(node => node.type === 'aside' && node.props?.['aria-label'] === '任务摘要');
  assert.equal(aside.props['data-open'], 'true');
  assert.match(copy(aside), /读取工作区/);
  assert.match(copy(aside), /2 次工具调用/);
  await nodes.find(node => node.props?.['aria-label'] === '查看任务进度').props.onClick();
  assert.deepEqual(opened, ['timeline']);
  assert.equal(states[0], false, 'opening native workbench closes the summary');
});

test('an empty new conversation keeps its composer unobstructed', () => {
  const { Summary } = fixture();
  const tree = Summary({ sessionId: 'new', model: model({ visible: false }) });
  const nodes = all(tree);
  assert.ok(nodes.some(node => node.props?.['aria-label'] === '任务摘要'));
  assert.equal(nodes.some(node => node.type === 'aside'), false);
});

test('a newly opened populated conversation leaves the summary closed until requested', () => {
  const { Summary, states } = fixture();
  const tree = Summary({ sessionId: 'existing', model: model({ visible: true, outputs: [{ key:'file', path:'report.md' }] }) });
  const nodes = all(tree);
  const trigger = nodes.find(node => node.props?.['aria-label'] === '任务摘要');
  assert.equal(trigger.props['aria-expanded'], false);
  assert.equal(nodes.some(node => node.type === 'aside'), false);
  trigger.props.onClick();
  assert.equal(states[0], true, 'the summary can still be opened explicitly');
});

test('outputs, sources and native children keep their real opening callbacks', async () => {
  const { Summary } = fixture(true);
  const opened = [];
  const output = { key: 'file:report', kind: 'file', path: 'report.md', title: 'report.md', statusLabel: '已修改' };
  const tree = Summary({ sessionId: 'parent', model: model({
    outputs: [output],
    sources: {
      web: [{ key: 'web:docs', title: '官方文档', domain: 'example.com', url: 'https://example.com/docs' }],
      workspace: [{ key: 'workspace:code', path: 'src/code.mjs', line: 11 }],
      session: [], loadedCount: 2,
    },
    subagents: [{ key: 'child', id: 'child', kind: 'child', mode: 'continuable', label: '检查页面', status: 'running', statusLabel: '进行中' }],
  }),
  onOpenOutput: value => opened.push(['output', value]),
  onOpenFile: (path, line) => opened.push(['file', path, line]),
  onOpenSubagent: value => opened.push(['child', value]),
  onOpenView: view => opened.push(['view', view]),
  });
  const nodes = all(tree);
  await nodes.find(node => node.props?.['aria-label'] === '打开 report.md').props.onClick();
  await nodes.find(node => node.props?.['aria-label'] === '打开子智能体 检查页面').props.onClick();
  await nodes.find(node => node.props?.['aria-label'] === '打开 src/code.mjs').props.onClick();
  assert.deepEqual(opened, [
    ['output', output],
    ['child', { parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable' }],
    ['file', 'src/code.mjs', 11],
  ]);
  const web = nodes.find(node => node.type === 'a' && node.props?.href === 'https://example.com/docs');
  assert.equal(web.props.rel, 'noopener noreferrer');
});

test('unknown agent status and empty output do not become success claims', () => {
  const { Summary } = fixture(true);
  const tree = Summary({ sessionId: 'parent', model: model({
    subagents: [{ key: 'missing', kind: 'diagnostic', label: '状态不明', status: 'unknown', statusLabel: '状态未载入', disabled: true }],
  }) });
  assert.match(copy(tree), /状态未载入/);
  assert.match(copy(tree), /暂无产物/);
  assert.doesNotMatch(copy(tree), /已完成/);
  const disabled = all(tree).find(node => node.props?.['aria-label'] === '打开子智能体 状态不明');
  assert.equal(disabled.props.disabled, true);
});

test('summary close and Escape restore trigger focus', () => {
  const { Summary, states } = fixture(true);
  const tree = Summary({ sessionId: 'parent', model: model() });
  const nodes = all(tree);
  const trigger = nodes.find(node => node.props?.['aria-label'] === '任务摘要');
  const aside = nodes.find(node => node.type === 'aside' && node.props?.['aria-label'] === '任务摘要');
  let focused = 0;
  trigger.props.ref.current = { focus: () => focused++ };
  aside.props.onKeyDown({ key: 'Escape', stopPropagation() {} });
  assert.equal(states[0], false);
  assert.equal(focused, 1);
});

test('sidebar brand has an original compact mark with a readable name', () => {
  const { Sidebar } = fixture();
  const tree = Sidebar({ collapsed: false, startSession() {}, toggleSidebar() {}, renderSlot: () => null });
  const brand = all(tree).find(node => node.props?.['aria-label'] === 'ColdX 首页');
  assert.ok(all(brand).some(node => node.props?.className === 'cx-rebuild-brand-mark'));
  assert.match(copy(brand), /ColdX/);
});
