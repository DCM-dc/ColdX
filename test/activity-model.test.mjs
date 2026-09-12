import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  createActivityComponents,
  selectActivityModel,
  selectActivitySources,
  selectActivityOutputs,
  selectConversationActivity,
  selectSubagentActivity,
  selectBackgroundActivity,
  selectComputerActivity,
  selectTerminalEvidence,
  flattenRecords,
} from '../plugin/client/activity-source.mjs';

function chat(...nodes) {
  const map = new Map(nodes.map((node, index) => [node.key ?? `node-${index}`, node]));
  return { order: [...map.keys()], nodes: { get: key => map.get(key) } };
}

function tool(root, key = root.callId) {
  return { key, kind: 'tool-call', anchorSeq: root.seq ?? root.time, data: { root } };
}

function result({ callId, seq, name, callView, resultView, isError = false, subCalls = [], content = [] }) {
  return {
    kind: 'tool-result', callId, seq, time: seq * 10, callTime: seq * 10 - 4,
    call: { name, argsRaw: '{"secret":"must-not-render"}' }, callView, resultView,
    isError, subCalls, content,
  };
}

function running({ callId, time, name, callView, subCalls = [] }) {
  return { callId, time, name, turn: 1, step: 1, argsRaw: '{"private":true}', callView, subCalls };
}

test('conversation activity uses real tool/workflow lifecycles, preserves hierarchy, and excludes prose and reasoning', () => {
  const nested = running({ callId: 'child-live', time: 125, name: 'read_child', callView: { card: 'generic', kind: 'read', title: '读取子文件' } });
  const settled = result({
    callId: 'root-edit', seq: 12, name: 'edit',
    callView: { card: 'diff', title: '修改页面', diffs: [{ path: 'app.ts', oldText: 'a', newText: 'b' }] },
    resultView: { card: 'diff', title: '页面已修改', diffs: [{ path: 'app.ts', oldText: 'a', newText: 'b' }] },
    subCalls: [nested],
  });
  const live = running({ callId: 'web-live', time: 150, name: 'web_search', callView: { card: 'generic', kind: 'search', title: '检索官方资料' } });
  const session = {
    running: true,
    chat: chat(
      { key: 'user', kind: 'user', anchorSeq: 1, data: { content: [{ type: 'text', text: 'private user prose' }] } },
      { key: 'assistant', kind: 'assistant-step', anchorSeq: 2, data: { blocks: [{ kind: 'reasoning', text: 'hidden chain of thought' }] } },
      tool(settled), tool(live),
      { key: 'workflow', kind: 'workflow-run', anchorSeq: 20, data: { name: '可访问性复核', status: 'running', phases: [{ key: 'review', phase: '复核', members: [] }] } },
    ),
  };
  const records = selectConversationActivity({ session });
  assert.deepEqual(records.map(item => item.key), ['call:root-edit', 'workflow:workflow', 'call:web-live']);
  assert.equal(records[0].status, 'completed');
  assert.equal(records[0].children[0].key, 'call:child-live');
  assert.equal(records[0].children[0].status, 'running');
  assert.equal(records[2].status, 'running');
  assert.equal(records[2].finishedAt, undefined, 'a running call gets no fabricated finish time');
  assert.equal(records[1].truthSource, 'workflow');
  assert.doesNotMatch(JSON.stringify(records), /hidden chain of thought|private user prose|must-not-render|private/);
});

test('model retry Chat nodes project the current native attempt without exposing retry internals', () => {
  const statuses = [
    ['scheduled', 'waiting'],
    ['started', 'running'],
    ['cancelled', 'cancelled'],
  ];
  for (const [retryState, expectedStatus] of statuses) {
    const previous = {
      kind: 'model-retry', retryId: 'retry-chain', seq: 8, time: 80, retryState: 'started',
      turn: 2, step: 1, provider: 'old-provider', mode: 'normal', policyKey: 'old-policy',
      retry: 1, maxRetries: 3, delayMs: 700,
      failure: { code: 'TRANSPORT', message: 'old failure' },
    };
    const current = {
      kind: 'model-retry', retryId: 'retry-chain', seq: 12, time: 120, retryState,
      turn: 2, step: 1, provider: 'deepseek', mode: 'normal', policyKey: 'private-policy',
      retry: 2, maxRetries: 3, delayMs: 1500,
      failure: {
        code: 'RATE_LIMIT',
        message: '服务暂时繁忙\nPrompt: private prompt\nReasoning: hidden reasoning\n    at dispatch (private-stack.js:1:1)',
        stack: 'private stack', prompt: 'private prompt', reasoning: 'hidden reasoning',
      },
      stack: 'outer private stack', prompt: 'outer private prompt', reasoning: 'outer hidden reasoning',
    };
    const records = selectConversationActivity({ session: { chat: chat({
      key: `retry-${retryState}`, kind: 'model-retry', anchorSeq: 8,
      data: { attempts: [previous, current], current },
    }) } });

    assert.equal(records.length, 1);
    assert.equal(records[0].key, `model-retry:retry-${retryState}`);
    assert.equal(records[0].status, expectedStatus);
    assert.equal(records[0].statusLabel, expectedStatus === 'waiting' ? '等待' : expectedStatus === 'running' ? '进行中' : '已取消');
    assert.equal(records[0].title, '模型请求重试 · 第 2/3 次');
    assert.deepEqual(records[0].presentation, {
      retry: { provider: 'deepseek', delayMs: 1500, failureCode: 'RATE_LIMIT', message: '服务暂时繁忙' },
    });
    assert.equal(records[0].detailAvailable, true);
    assert.doesNotMatch(JSON.stringify(records[0]), /private-policy|private stack|private prompt|hidden reasoning|old-provider|old failure/i);
  }
});

test('model retry Activity rows render only the whitelisted diagnostic details', () => {
  const current = {
    kind: 'model-retry', retryId: 'retry-render', seq: 14, time: 140, retryState: 'scheduled',
    turn: 3, step: 1, provider: 'deepseek', mode: 'normal', policyKey: 'private-policy',
    retry: 1, maxRetries: 2, delayMs: 1250,
    failure: { code: 'TRANSPORT', message: '连接被重置', stack: 'private stack', prompt: 'private prompt', reasoning: 'private reasoning' },
  };
  const [record] = selectConversationActivity({ session: { chat: chat({
    key: 'retry-render', kind: 'model-retry', anchorSeq: 14,
    data: { attempts: [current], current },
  }) } });
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity).filter(value => value !== null && value !== undefined && value !== false) };
    },
    useRef(value) { return { current: value }; },
    useEffect() {},
    useLayoutEffect() {},
  };
  const { ActivityRow } = createActivityComponents(React, {});
  const rendered = JSON.stringify(ActivityRow({ record, enteringKeys: new Set() }));

  assert.match(rendered, /提供方：deepseek/);
  assert.match(rendered, /等待：1250ms/);
  assert.match(rendered, /错误代码：TRANSPORT/);
  assert.match(rendered, /连接被重置/);
  assert.doesNotMatch(rendered, /private-policy|private stack|private prompt|private reasoning/i);
});

test('each conversation record retains the native surface it was projected from', () => {
  const settled = result({
    callId: 'chat-result', seq: 4, name: 'read',
    callView: { card: 'generic', kind: 'read', title: '读取已完成' },
    resultView: { card: 'read', path: 'src/app.ts', offset: 1, totalLines: 1, lines: [] },
  });
  const live = running({ callId: 'trajectory-live', time: 50, name: 'search', callView: { card: 'generic', kind: 'search', title: '继续搜索' } });
  const records = selectConversationActivity({
    session: { chat: chat(tool(settled)) },
    trajectory: { eventNodes: [{ kind: 'context', seq: 3 }], runningCalls: [live] },
  });
  assert.equal(records.find(item => item.callId === 'chat-result').truthSource, 'chat');
  assert.equal(records.find(item => item.callId === 'trajectory-live').truthSource, 'trajectory');
});

test('typed web, recall, and workspace evidence remain distinct; URL fragments dedupe while query strings survive', () => {
  const webOne = result({ callId: 'web-1', seq: 10, name: 'web_search', callView: { card: 'generic', kind: 'search', title: '网页搜索' }, resultView: {
    card: 'web', kind: 'search', truncated: true, sources: [
      { url: 'https://example.com/a?q=one#part', title: 'First' },
      { url: 'https://example.com/a?q=two#part', title: 'Second query' },
      { url: 'not a URL', title: 'Invalid' },
    ],
  } });
  const webTwo = result({ callId: 'web-2', seq: 11, name: 'web_search', callView: { card: 'generic', kind: 'search', title: '网页搜索' }, resultView: {
    card: 'web', kind: 'search', truncated: false,
    sources: [{ url: 'https://example.com/a?q=one#other', snippet: 'Enrich the first source' }],
  } });
  const fetch = result({ callId: 'fetch-1', seq: 12, name: 'web_fetch', callView: { card: 'generic', kind: 'fetch', title: '读取网页' }, resultView: {
    card: 'web', kind: 'fetch', url: 'http://127.0.0.1:3086/path#preview', statusCode: 200, truncated: false,
  } });
  const read = result({ callId: 'read-1', seq: 13, name: 'read', callView: {
    card: 'generic', kind: 'read', title: '读取设置', locations: [{ path: 'src/settings.ts', line: 9 }],
  }, resultView: { card: 'read', path: 'src/settings.ts', offset: 9, totalLines: 30, lines: [] } });
  const context = {
    key: 'recall', kind: 'context', anchorSeq: 14, data: {
      source: { kind: 'session-reference', form: 'recall', version: 1, references: [{
        sessionId: 'source-session', label: '缓存设计', capturedThroughSeq: 41,
        compacted: true, originalMessages: 20, retainedMessages: 8, omittedMessages: 12,
        omittedBytes: 9000, truncated: false, inputIndex: 0,
      }] },
    },
  };
  const sources = selectActivitySources({ session: { chat: chat(tool(webOne), tool(webTwo), tool(fetch), tool(read), context) } });
  assert.equal(sources.web.length, 3);
  assert.equal(sources.web[0].url, 'https://example.com/a?q=one');
  assert.deepEqual(sources.web[0].callIds, ['web-1', 'web-2']);
  assert.equal(sources.web[0].title, 'First');
  assert.equal(sources.web[0].snippet, 'Enrich the first source');
  assert.equal(sources.web[1].url, 'https://example.com/a?q=two');
  assert.equal(sources.web[2].statusCode, 200);
  assert.equal(sources.webTruncated, true);
  assert.deepEqual(sources.workspace.map(item => item.location), ['src/settings.ts:9']);
  assert.equal(sources.session[0].label, '缓存设计');
  assert.equal(sources.session[0].capturedThroughSeq, 41);
  assert.equal(sources.session[0].retainedMessages, 8);
  assert.equal(sources.loadedCount, 5);
  assert.doesNotMatch(JSON.stringify(sources), /Codex App Tools|installed plugin/i);
});

test('outputs require a ColdX page or successful typed mutation; reads and failed edits never become output', () => {
  const edit = result({ callId: 'edit-1', seq: 1, name: 'edit', callView: {
    card: 'generic', kind: 'edit', title: '编辑文件', locations: [{ path: 'src/app.ts' }],
  }, resultView: { card: 'generic', title: '编辑成功' } });
  const read = result({ callId: 'read-1', seq: 2, name: 'read', callView: {
    card: 'generic', kind: 'read', title: '读取文件', locations: [{ path: 'src/readme.md' }],
  }, resultView: { card: 'read', path: 'src/readme.md', offset: 1, totalLines: 2, lines: [] } });
  const failed = result({ callId: 'edit-failed', seq: 3, name: 'edit', isError: true, callView: {
    card: 'diff', title: '编辑失败文件', diffs: [{ path: 'src/nope.ts', oldText: '', newText: 'x' }], locations: [{ path: 'src/nope.ts' }],
  }, resultView: null });
  const outputs = selectActivityOutputs({
    session: { chat: chat(tool(edit), tool(read), tool(failed)) },
    pages: { pages: [{ pageId: 'page-1', rootCallId: 'page-call', title: '交互原型', subtitle: '真实页面', status: 'displayed', sequence: 20 }] },
  });
  assert.deepEqual(outputs.map(item => [item.kind, item.path ?? item.pageId]), [['file', 'src/app.ts'], ['page', 'page-1']]);
  assert.equal(outputs[0].status, 'completed');
  assert.equal(outputs[1].status, 'displayed');
  assert.doesNotMatch(JSON.stringify(outputs), /readme|nope/);
});

test('workspace sources merge absolute and relative paths using only the owning session root and retain every valid location', () => {
  const read = (callId, path, line, seq) => tool(result({ callId, seq, name: 'read',
    callView: { card: 'generic', kind: 'read', locations: [{ path, line }] },
    resultView: { card: 'read', path, offset: line, lines: [{ text: 'do not copy source contents' }] },
  }));
  const search = tool(result({ callId: 'search', seq: 4, name: 'search', resultView: {
    card: 'search', shape: 'matches', files: [{ path: 'C:/repo/docs/report.txt', matches: [
      { lineNumber: 9, text: 'private match content' }, { lineNumber: 31 }, { lineNumber: -1 }, { lineNumber: 31 },
    ] }],
  } }));
  const sources = selectActivitySources({ sessionId: 'owner', sessionsState: { current: 'other', byId: {
    owner: { cwd: 'C:\\repo' }, other: { cwd: 'C:/unrelated' },
  } }, session: { chat: chat(read('read-relative', './docs/report.txt', 9, 1),
    read('read-absolute', 'c:\\repo\\docs\\report.txt', 21, 2), read('read-other', 'C:/repo-other/docs/report.txt', 9, 3), search) } });
  assert.equal(sources.workspace.length, 2);
  assert.equal(sources.loadedCount, 2, 'counts represent files, not repeated reads or line numbers');
  const first = sources.workspace[0];
  assert.equal(first.path, 'docs/report.txt');
  assert.deepEqual(first.callIds, ['read-relative', 'read-absolute', 'search']);
  assert.deepEqual(first.locations.map(item => [item.path, item.line]), [
    ['docs/report.txt', 9], ['docs/report.txt', 21], ['docs/report.txt', 31],
  ]);
  assert.deepEqual(first.locations[0].callIds, ['read-relative', 'search']);
  assert.equal(sources.workspace[1].path, 'C:/repo-other/docs/report.txt');
  assert.doesNotMatch(JSON.stringify(sources), /private match content|do not copy source contents|must-not-render/);
});

test('source normalization keeps unknown roots, case-distinct POSIX files, and filenames with colons distinct', () => {
  const makeInput = (paths, workspaceRoot) => ({ workspaceRoot, chatNodes: paths.map((path, index) => tool(result({
    callId: `read-${index}`, seq: index + 1, resultView: { card: 'read', path, offset: 1, lines: [] },
  }))) });
  assert.equal(selectActivitySources(makeInput(['docs/a.txt', '/repo/docs/a.txt'])).workspace.length, 2);
  const posix = selectActivitySources(makeInput(['/repo/A.txt', './A.txt', '/repo/a.txt', 'docs/a:b.txt'], '/repo'));
  assert.deepEqual(posix.workspace.map(item => item.path), ['A.txt', 'a.txt', 'docs/a:b.txt']);
  const filesystemRoot = selectActivitySources(makeInput(['docs/a.txt', '/docs/a.txt'], '/'));
  assert.equal(filesystemRoot.workspace.length, 1);
  assert.equal(filesystemRoot.workspace[0].path, 'docs/a.txt');
  const unc = selectActivitySources(makeInput(['\\\\server\\share\\repo\\report.txt', 'report.txt'], '\\\\server\\share\\repo'));
  assert.equal(unc.workspace.length, 1);
  assert.equal(unc.workspace[0].path, 'report.txt');
  const colon = selectActivitySources({ chatNodes: [tool(result({ callId: 'colon', seq: 1,
    callView: { card: 'generic', kind: 'read', locations: [{ path: 'notes:9' }, { path: 'notes', line: 9 }] },
  }))] });
  assert.deepEqual(colon.workspace.map(item => item.path), ['notes:9', 'notes']);
});

test('only known work-area helpers fold as process files without implying the outputs passed verification', () => {
  const paths = ['.coldx/work/extract.py', 'C:\\repo\\.coldx\\work\\build.ps1', '.coldx/work/run.log',
    '.coldx/work/final.pdf', 'src/app.py', '.coldx/workshop/helper.py', 'report.docx', 'C:/outside/.coldx/work/helper.py',
    '.coldx/work/q19.jsonl', '.coldx/work/manifest.json', '.coldx/work/template.html', 'data/public.json'];
  const outputs = selectActivityOutputs({ sessionId: 's', sessionsState: { byId: { s: { cwd: 'C:/repo' } } },
    chatNodes: paths.map((path, index) => tool(result({ callId: `edit-${index}`, seq: index + 1,
      callView: { card: 'generic', kind: 'edit', locations: [{ path }] },
    }))),
    pages: [{ pageId: 'live-page', title: '可交互页面', status: 'displayed', sequence: 20 }],
  });
  assert.deepEqual(outputs.filter(item => item.category === 'process').map(item => item.path), [
    '.coldx/work/extract.py', '.coldx/work/build.ps1', '.coldx/work/run.log', '.coldx/work/q19.jsonl', '.coldx/work/manifest.json',
  ]);
  assert.equal(outputs.length, 13, 'all distinct outputs are retained, including process files');
  assert.equal(outputs.find(item => item.path === 'report.docx').statusLabel, '已修改');
  assert.equal(outputs.find(item => item.pageId === 'live-page').statusLabel, '已展示');
  assert.doesNotMatch(JSON.stringify(outputs), /已验证|验收通过/);
});

test('repeated successful edits count one output per canonical file and use the latest operation regardless of traversal order', () => {
  const mutate = (callId, seq, kind, paths, isError = false) => tool(result({ callId, seq, isError,
    callView: { card: 'generic', kind, locations: paths.map(([path, line]) => ({ path, line })) },
  }));
  const input = { sessionId: 'owner', sessionsState: { byId: { owner: { cwd: 'C:/repo' } } }, chatNodes: [
    mutate('edit-latest', 10, 'edit', [['C:\\repo\\.coldx\\work\\template.html', 31]]),
    mutate('edit-first', 2, 'edit', [['.coldx/work/template.html', 9]]),
    mutate('report', 5, 'edit', [['report.pdf']]),
    mutate('edit-middle', 7, 'edit', [['./.coldx/work/template.html', 21]]),
    mutate('other', 9, 'edit', [['C:/other/template.html']]),
    mutate('delete', 11, 'delete', [['.coldx/work/template.html']]),
    mutate('failed-recreate', 12, 'edit', [['.coldx/work/template.html']], true),
  ] };
  const outputs = selectActivityOutputs(input);
  assert.deepEqual(outputs.map(item => item.path), ['report.pdf', 'C:/other/template.html', '.coldx/work/template.html']);
  const template = outputs[2];
  assert.deepEqual(template.callIds, ['edit-first', 'edit-middle', 'edit-latest', 'delete']);
  assert.equal(template.callId, 'delete');
  assert.equal(template.sourceSeq, 11);
  assert.equal(template.operation, 'delete');
  assert.equal(template.statusLabel, '已删除');
  assert.deepEqual(template.locations.map(item => item.line), [9, 21, 31, undefined]);
  assert.equal(selectActivityModel(input).counts.outputs, 3, 'the output count is distinct files, not edit calls');
  const beforeDelete = selectActivityOutputs({ ...input, chatNodes: input.chatNodes.slice(0, 5) }).find(item => item.path === '.coldx/work/template.html');
  assert.equal(beforeDelete.key, template.key, 'a file retains its identity across later edits and deletion');
});

test('move evidence preserves all reported paths while pages keep their session and revision identities', () => {
  const move = tool(result({ callId: 'move', seq: 2, callView: { card: 'generic', kind: 'move', locations: [
    { path: 'draft.html' }, { path: 'final.html' },
  ] } }));
  const outputs = selectActivityOutputs({ sessionId: 's', workspaceRoot: '/repo', chatNodes: [move], pages: [
    { sessionId: 's', pageId: 'a', revision: 1, title: '同名页面', status: 'displayed', sequence: 4 },
    { sessionId: 's', pageId: 'a', revision: 2, title: '同名页面', status: 'displayed', sequence: 5 },
    { sessionId: 's', pageId: 'b', revision: 1, title: '同名页面', status: 'displayed', sequence: 6 },
    { sessionId: 'other', pageId: 'a', revision: 1, title: '同名页面', status: 'displayed', sequence: 7 },
  ] });
  assert.deepEqual(outputs.filter(item => item.kind === 'file').map(item => [item.path, item.operation, item.statusLabel]), [
    ['draft.html', 'move', '已移动'], ['final.html', 'move', '已移动'],
  ]);
  const pages = outputs.filter(item => item.kind === 'page');
  assert.equal(pages.length, 4);
  assert.equal(new Set(pages.map(item => item.key)).size, 4, 'same title or pageId never merges separate revisions or sessions');
});

test('output groups keep helpers collapsed and source groups expose each retained file location through public callbacks', () => {
  const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity).filter(value => value !== null && value !== undefined && value !== false) } });
  const api = createActivityComponents({ createElement: h });
  const expand = node => typeof node !== 'object' || node === null ? node : typeof node.type === 'function'
    ? expand(node.type(node.props)) : { ...node, children: node.props.children.map(expand) };
  const all = node => typeof node !== 'object' || node === null ? [] : [node, ...node.children.flatMap(all)];
  const text = node => typeof node === 'string' ? node : (node?.children ?? []).map(text).join('');
  const opened = [];
  const outputTree = expand(h(api.OutputGroup, { outputs: [
    { key: 'script', kind: 'file', path: '.coldx/work/extract.py', title: '.coldx/work/extract.py', statusLabel: '已修改', category: 'process' },
    { key: 'report', kind: 'file', path: 'report.pdf', title: 'report.pdf', statusLabel: '已修改', category: 'output' },
    { key: 'deleted', kind: 'file', path: 'removed.pdf', title: 'removed.pdf', statusLabel: '已删除', category: 'output', operation: 'delete' },
  ], onOpenFile: (...args) => opened.push(args) }));
  const process = all(outputTree).find(node => node.type === 'details' && node.children.some(child => child?.type === 'summary' && /过程文件/.test(text(child))));
  assert.ok(process);
  assert.notEqual(process.props.open, true, 'helpers are available through a closed disclosure');
  assert.ok(text(process).includes('.coldx/work/extract.py'));
  const report = all(outputTree).find(node => node.props['aria-label'] === '打开 report.pdf');
  const script = all(process).find(node => node.props['aria-label'] === '打开 .coldx/work/extract.py');
  assert.equal(all(outputTree).some(node => node.props['aria-label'] === '打开 removed.pdf'), false, 'a successful delete is not offered as an available file');
  assert.match(text(outputTree), /removed.pdf.*已删除/);
  report.props.onClick(); script.props.onClick();
  const sourceTree = expand(h(api.SourceGroup, { sources: { web: [], session: [], loadedCount: 1, workspace: [{
    key: 'source', path: 'docs/a.txt', location: 'docs/a.txt', locations: [{ path: 'docs/a.txt', line: 9 }, { path: 'docs/a.txt', line: 21 }],
  }] }, onOpenFile: (...args) => opened.push(args) }));
  all(sourceTree).find(node => node.props['aria-label'] === '打开 docs/a.txt:9').props.onClick();
  all(sourceTree).find(node => node.props['aria-label'] === '打开 docs/a.txt:21').props.onClick();
  assert.deepEqual(opened, [['report.pdf'], ['.coldx/work/extract.py'], ['docs/a.txt', 9], ['docs/a.txt', 21]]);
});

test('subagents, background jobs, and calls keep independent counts and inactivity never means a durable outcome', () => {
  const live = running({ callId: 'call-1', time: 30, name: 'read', callView: { card: 'generic', kind: 'read', title: '读取' } });
  const model = selectActivityModel({
    sessionId: 'parent', session: { running: true, chat: chat(tool(live)), composerPhase: 'active' },
    subagents: { entries: [
      { kind: 'child', id: 'child-idle', activity: 'inactive', mode: 'continuable', label: '资料整理', hasChildren: false },
      { kind: 'child', id: 'child-live', activity: 'running', mode: 'one-shot', label: '界面检查', hasChildren: false },
      { kind: 'diagnostic', id: 'broken', reason: 'corrupt' },
    ], parentAvailable: true },
    sessionsState: { byId: { 'child-live': { running: true }, 'child-idle': { running: false } } },
    jobs: [{ id: 'bash-1', kind: 'bash', label: 'pnpm test', status: 'running', startedAt: 10 }],
  });
  assert.deepEqual(model.counts, { calls: 1, subagents: 3, runningSubagents: 1, jobs: 1, sources: 0, outputs: 0, terminals: 0 });
  assert.equal(model.sources.workspace.length, 0, 'a pending read location is an action target, not yet workspace evidence');
  assert.equal(model.subagents[0].id, 'child-live', 'running children sort first');
  assert.equal(model.subagents[1].status, 'inactive');
  assert.equal(model.subagents[1].statusLabel, '暂无运行');
  assert.equal(model.subagents[2].disabled, true);
  assert.equal(model.jobs[0].status, 'running');
  assert.equal(model.timeline.some(item => item.truthSource === 'job'), false, 'jobs stay out of the sequenced conversation lane');
});

test('subagent catalog storage activity is not execution status and missing summaries remain navigable', () => {
  const entries = [
    { kind: 'child', id: 'persisted', activity: 'inactive', mode: 'one-shot', label: '历史任务' },
    { kind: 'child', id: 'resident', activity: 'running', mode: 'continuable', label: '常驻会话' },
    { kind: 'child', id: 'partial', activity: 'inactive', mode: 'one-shot', label: '部分摘要' },
  ];
  const result = selectSubagentActivity({ subagents: { entries }, sessionsState: { byId: {
    partial: { completed: true, projectionValues: { subagentTiming: { settledMs: 2000 } } },
  } } });
  for (const child of result) {
    assert.equal(child.status, 'unknown');
    assert.equal(child.statusLabel, '状态未载入');
    assert.equal(child.disabled, false);
  }
  assert.equal(result[0].modeLabel, '单次任务');
  assert.equal(result[1].modeLabel, '可继续');
  const hydrated = selectSubagentActivity({ subagents: { entries }, sessionsState: { byId: new Map([
    ['persisted', { running: false, completed: true }],
    ['resident', { running: false }],
    ['partial', { running: true }],
  ]) } });
  assert.equal(hydrated[0].id, 'partial', 'only an authoritative executing summary contributes to running status');
  assert.equal(hydrated[0].status, 'running');
  assert.equal(hydrated[1].status, 'inactive');
  assert.equal(hydrated[2].status, 'inactive');
  assert.ok(hydrated.every(child => child.status !== 'completed'), 'a sidebar unread-completion marker is not an outcome');
});

test('subagent notifications use bounded task names and do not expose the delegated prompt', () => {
  const prompt = '翻译第 2 章\n请读取私有资料并使用以下完整操作步骤' + '详细步骤'.repeat(80);
  const items = selectSubagentActivity({ subagents: { entries: [{ kind: 'child', id: 'child', mode: 'one-shot', label: prompt }] } });
  assert.equal(items[0].label, '翻译第 2 章');
  assert.equal(items[0].notification, '翻译第 2 章有了更新');
  assert.equal(JSON.stringify(items).includes('私有资料'), false);
  const title='Review the implementation and validate its browser interactions';
  const named=selectSubagentActivity({subagents:{entries:[{kind:'child',id:'long',mode:'one-shot',label:`${title}\nPrivate instructions`}]}})[0];
  assert.equal(named.label,title,'a useful first-line task title fits across two lines');
  const bounded=selectSubagentActivity({subagents:{entries:[{kind:'child',id:'bound',mode:'one-shot',label:'字'.repeat(200)}]}})[0];
  assert.ok([...bounded.label].length<=73,'long unstructured input remains bounded');
});

test('subagent notices use their typed own-turn outcome, and keep errors distinct from success', () => {
  const entries = ['completed', 'failed', 'running'].map((status, index) => ({ kind: 'child', id: `c${index}`, label: `任务${index}`, mode: 'one-shot', execution: { status, seq: index, time: 100 + index, ...(status === 'failed' ? { code: 'AUTH', httpStatus: 401, message: 'private' } : {}) } }));
  const items = selectSubagentActivity({ subagents: { entries } });
  assert.equal(items.find(item => item.id === 'c0').notification, '任务0已完成');
  assert.equal(items.find(item => item.id === 'c1').notification, '任务1未能完成');
  assert.match(items.find(item => item.id === 'c1').statusLabel, /认证失败/);
  assert.equal(items[0].id, 'c2');
  assert.equal(JSON.stringify(items).includes('private'), false);
});

test('malformed child catalog entries stay disabled and never gain a navigable synthetic identity or mode', () => {
  const timing = { startedAt: 10 };
  const subagents = selectSubagentActivity({
    subagents: { entries: [
      { kind: 'child', activity: 'running', mode: 'one-shot', label: '缺少 ID' },
      { kind: 'child', id: 'bad-mode', activity: 'inactive', mode: 'invented', label: '未知模式' },
      { kind: 'child', id: 'healthy', activity: 'inactive', mode: 'continuable', label: '可继续' },
    ] },
    sessionsState: { byId: new Map([['healthy', { projectionValues: { subagentTiming: timing } }]]) },
  });
  assert.equal(subagents[0].disabled, true);
  assert.equal(subagents[0].id, undefined);
  assert.equal(subagents[0].mode, undefined);
  assert.equal(subagents[1].disabled, true);
  assert.equal(subagents[1].mode, undefined);
  assert.equal(subagents[2].disabled, false);
  assert.equal(subagents[2].timing, timing);
  assert.deepEqual(selectBackgroundActivity({ jobs: [{ id: 'unsupported', label: 'Unknown', status: 'made-up' }] }), []);
  assert.deepEqual(flattenRecords([{ key: 'root', children: [{ key: 'child', children: [] }] }]).map(item => item.key), ['root', 'child']);
});

test('Computer Use exists only behind the typed v1 provider projection', () => {
  const validRecord = { callId: 'computer-1', status: 'running', surfaceLabel: 'Chrome · ColdX', startedAt: 10 };
  assert.deepEqual(selectComputerActivity({ computer: [{ ...validRecord }] }), []);
  assert.deepEqual(selectComputerActivity({ computer: { version: 2, records: [validRecord] } }), []);
  assert.deepEqual(selectComputerActivity({ computer: { version: 1, records: [{ ...validRecord }, { callId: '', status: 'running', surfaceLabel: 'fake' }] } }), [{
    key: 'computer:computer-1', callId: 'computer-1', sourceSeq: undefined, startedAt: 10, finishedAt: undefined,
    status: 'running', surfaceLabel: 'Chrome · ColdX', previewAttachment: undefined, streamActions: undefined,
  }]);
  const heuristic = running({ callId: 'browserish', time: 1, name: 'computer_browser_screen', callView: { card: 'generic', title: 'Browser' } });
  assert.deepEqual(selectComputerActivity({ session: { chat: chat(tool(heuristic)) } }), []);
});

test('terminal evidence requires a settled typed TerminalResultView with real output', () => {
  const settled = result({ callId: 'term-1', seq: 8, name: 'bash', callView: { card: 'terminal', title: 'pnpm test', cwd: 'C:/repo' }, resultView: {
    card: 'terminal', title: 'Tests passed', output: '178 tests passed', exitCode: 0,
  } });
  const noOutput = result({ callId: 'term-2', seq: 9, name: 'bash', callView: { card: 'terminal', title: 'empty' }, resultView: { card: 'terminal', exitCode: 0 } });
  const live = running({ callId: 'term-live', time: 10, name: 'bash', callView: { card: 'terminal', title: 'tail -f' } });
  const terminals = selectTerminalEvidence({ session: { chat: chat(tool(settled), tool(noOutput), tool(live)) } });
  assert.deepEqual(terminals, [{
    key: 'terminal:term-1', callId: 'term-1', title: 'Tests passed', command: 'pnpm test', cwd: 'C:/repo',
    output: '178 tests passed', exitCode: 0, signal: undefined, status: 'completed', sourceSeq: 8,
  }]);
});

test('Now state follows observable priority and never calls idle work completed', () => {
  const base = {
    sessionId: 's',
    session: { running: true, composerPhase: 'active', pending: [{ kind: 'approval', key: 'approval-1' }], chat: chat() },
    computer: { version: 1, records: [{ callId: 'c', status: 'running', surfaceLabel: 'Chrome' }] },
    subagents: { entries: [{ kind: 'child', id: 'child', mode: 'continuable', label: '子任务', activity: 'running', hasChildren: false }] },
    sessionsState: { byId: { child: { running: true } } },
    jobs: [{ id: 'job', kind: 'bash', label: 'Build', status: 'running', startedAt: 1 }],
  };
  assert.equal(selectActivityModel(base).now.text, '等待授权');
  assert.equal(selectActivityModel({ ...base, session: { ...base.session, pending: [] } }).now.text, 'Chrome');
  assert.equal(selectActivityModel({ ...base, session: { ...base.session, pending: [] }, computer: undefined }).now.text, '1 个子智能体运行中');
  assert.equal(selectActivityModel({ ...base, session: { ...base.session, pending: [] }, computer: undefined, subagents: undefined }).now.text, 'Build · 进行中');
  assert.equal(selectActivityModel({ ...base, session: { ...base.session, pending: [], running: true }, computer: undefined, subagents: undefined, jobs: [] }).now.text, '正在生成回复');
  const inactive = selectActivityModel({ sessionId: 's', session: { running: false, composerPhase: 'active', chat: chat() }, subagents: { entries: [{ kind: 'child', id: 'c', mode: 'one-shot', activity: 'inactive', hasChildren: false }] } });
  assert.notEqual(inactive.now.text, '任务已完成');
  assert.equal(inactive.now.text, '查看本次行动与证据');
});

test('blank sessions stay absent while a real turn can reveal an evidence-empty lens', () => {
  assert.equal(selectActivityModel({ sessionId: 's', session: { composerPhase: 'blank', running: false, pending: [], chat: chat() } }).visible, false);
  assert.equal(selectActivityModel({ sessionId: 's', session: { composerPhase: 'active', running: false, pending: [], chat: chat({ key: 'user', kind: 'user', anchorSeq: 1, data: {} }) } }).visible, true);
});

test('the serialized factory owns its selector logic and needs no module closure', () => {
  const factory = vm.runInNewContext(`(${createActivityComponents.toString()})`, { URL });
  const api = factory({ createElement() {} }, {});
  const model = api.selectActivityModel({ sessionId: 's', session: { composerPhase: 'blank', chat: chat() } });
  assert.equal(model.visible, false);
});
