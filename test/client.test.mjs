import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createClientPlugin } from '../plugin/client/client-source.mjs';
import { createWorkspaceModel } from '../plugin/client/workspace-model.mjs';
import { dshRequire } from '../plugin/page-native.mjs';
import { createFileViewComponents } from '../plugin/client/file-view-source.mjs';
import { createWorkbenchPane } from '../plugin/client/workbench-pane-source.mjs';
import { createSessionControls } from '../plugin/client/session-controls-source.mjs';
import { createWorkspaceShell } from '../plugin/client/workspace-shell-source.mjs';

test('the built client retains its native lazy module entry', async () => {
  const source = await readFile(new URL('../plugin/client/client.js', import.meta.url), 'utf8');
  let record;
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value) { record = value; } } } });
  assert.equal(record.id, 'coldx-client');
  assert.equal(typeof record.factory, 'function');
});

function mountClient(reply = { ok: true, value: {} }) {
  const commands = []; const fileQueries = []; const drafts = []; const openedSubagents = []; let frostDisposed = 0;
  const CodingModeControl = () => null;
  const AttachmentControl = () => null;
  const ComposerAttachments = () => null;
  const ActivityLens = () => null;
  const SessionTerminal = () => null;
  const TerminalSettingsRow = () => null;
  const React = { useEffect() {}, useSyncExternalStore: (_subscribe, read) => read(), Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
  const InlineTool = props => React.createElement('article', props);
  const plugin = createClientPlugin(React, { MarkdownText: () => null }, {
    brand: () => ({ Mark() {}, Name() {}, HeroBrand() {} }),
    workspaceShell: createWorkspaceShell,
    modelControl: () => ({ ModelControl() {} }),
    superpowers: () => ({SuperpowersControl(){},SuperpowersSettingsRow(){},dispose(){}}),
    usage: () => ({UsageEntry(){},UsageSettingsRow(){},BalanceNotice(){}}),
    updates: () => ({UpdateNotice(){},UpdateSettingsRow(){}}),
    marketplace: (_react,_primitives,api) => ({ MarketplaceEntry() {}, api }),
    menuCatalog: () => ({ load: async () => [], pick() {}, dispose() {} }),
    interactions: () => ({ QuestionFrame() {} }),
    stage: () => ({ InlineTool }),
    workspaceModel: createWorkspaceModel,
    motion() {},
    frost: (react, motion) => { assert.equal(react, React); assert.equal(typeof motion, "function"); return { dispose() { frostDisposed++; } }; },
    sessionControls: (react, frost) => { assert.equal(react, React); assert.equal(typeof frost.dispose, "function"); return { ...createSessionControls(react, frost), CodingModeControl }; },
    attachments: (react, frost) => { assert.equal(react, React); assert.equal(typeof frost.dispose, 'function'); return { AttachmentControl, ComposerAttachments }; },
    activity: (react, frost) => { assert.equal(react, React); assert.equal(typeof frost.dispose, 'function'); return { ActivityLens, selectConversationActivity() { return []; } }; },
    terminal: (react, activity, scope, frost) => { assert.equal(react, React); assert.equal(typeof activity.selectConversationActivity, 'function'); assert.ok(scope); assert.equal(typeof frost.dispose, 'function'); return { SessionTerminal, TerminalSettingsRow }; },
    files: createFileViewComponents,
    htmlPreview: () => ({HtmlPreview(){}}),
    pdf: () => ({PdfPreview(){}}),
    workbenchPane: createWorkbenchPane,
    computer: () => ({ useComputer: () => ({snapshot:{version:1,records:[]}}), ComputerPreview(){}, ComputerStatus(){}, ComputerWorkspace(){} }),
  }, '');
  const entries = new Map();
  const options = new Map();
  const disposers = [];
  let settingsSpec;
  const settingsScope = { getSnapshot: () => ({ status: 'ready', value: { showTerminal: false }, writable: true }), subscribe: () => () => {}, async set() {} };
  const ctx = { sessions: { binding: () => ({session:{getSnapshot:()=>({blank:false})}}), openSubagent(address) { openedSubagents.push(address); } }, settingsScope: { bind(spec) { settingsSpec = spec; return settingsScope; } }, remote: {
    commands: { async execute(...args) { commands.push(args); return reply; } },
    fileReferences: { async list(...args) { fileQueries.push(args); return { ok: true, value: [{ path: 'README.md', kind: 'file' }] }; } },
  }, slots: {
    inject(_name, callback) { const result = callback(); if (result?.next) for (const item of result) disposers.push(item); else disposers.push(result); return result; },
    register(config, component) {
      const key = `${config.name}:${config.key ?? config.id ?? ''}`;
      entries.set(key, component); options.set(key, config);
      return () => { entries.delete(key); options.delete(key); };
    },
  }, theme: { getTheme: () => ({ active: { colorScheme: 'light' } }), overrideTokens: () => () => {} }, effect(callback) { disposers.push(callback()); } };
  const uploads = [];
  ctx.connection = { rpc: { async call(...args) { uploads.push(args); return reply; } } };
  ctx.provide = () => {};
  plugin.apply(ctx);
  entries.uploads = uploads;
  return { entries, options, InlineTool, CodingModeControl, AttachmentControl, ComposerAttachments, ActivityLens, SessionTerminal, TerminalSettingsRow, plugin, commands, fileQueries, drafts, openedSubagents, settingsScope, get settingsSpec() { return settingsSpec; }, get frostDisposed() { return frostDisposed; }, dispose() { for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose(); } };
}

test('ColdX owns only its inline tool renderers and releases every slot on disposal', t => {
  const mounted = mountClient(); t.after(() => mounted.dispose());
  const { entries, options, InlineTool } = mounted;
  assert.equal(entries.size, 23);
  assert.equal(entries.get('sidebar.footer.action:coldx-marketplace').name,'MarketplaceEntry');
  assert.equal(options.get('sidebar.footer.action:coldx-marketplace').order,-10);
  assert.equal(entries.get('conversation.input.model.effort:').name, 'EnhancedModelControl');
  assert.equal(options.get('conversation.input.model.effort:').priority, -10);
  const Entry = entries.get('conversation.input.add:');
  const label = Entry({ sessionId: 'demo' });
  assert.equal(label.type, 'fragment');
  assert.equal(label.props.children[0].type, mounted.AttachmentControl);
  assert.equal(label.props.children[0].props.unified, true);
  assert.equal(label.props.children[0].props.modeItems.type, mounted.CodingModeControl);
  assert.equal(label.props.children[0].props.modeItems.props.embedded, true);
  assert.equal(entries.get('conversation.input.left:coldx')({sessionId:'demo'}).type.name, 'InputReferenceBridge');
  assert.equal(JSON.stringify(label).includes('体验一下'), false);
  const snapshot = { sessionId: 'dock-session', chat: {} };
  const terminal = entries.get('conversation.input.dock:coldx-terminal')({ sessionId: 'dock-session', session: snapshot, useSession() { throw new Error('dock must use its owner snapshot'); } });
  assert.equal(terminal.type, mounted.SessionTerminal);
  assert.deepEqual(terminal.props, { sessionId: 'dock-session', session: snapshot, children: [] });
  assert.ok(entries.has('conversation.session.header.utilities:coldx-activity'));
  assert.equal(entries.get('conversation.input.attachments:'), mounted.ComposerAttachments);
  assert.equal(options.get('conversation.input.attachments:').priority, -10);
  assert.equal(entries.get('settings.general.item:coldx-terminal'), mounted.TerminalSettingsRow);
  assert.equal(mounted.settingsSpec.namespace, 'coldx-activity');
  assert.deepEqual(mounted.settingsSpec.decode({ showTerminal: true }), { showTerminal: true });
  assert.equal(mounted.settingsSpec.decode({ showTerminal: 'yes' }), undefined);
  for (const toolName of ['coldx_present_page', 'coldx_interact']) {
    const key = `tool.call.toolview:${toolName}`;
    assert.equal(entries.get(key), InlineTool, 'the native slot passes all runtime and call-owner props directly');
    assert.equal(options.get(key).key, toolName);
  }
  mounted.dispose();
  assert.equal(entries.size, 0);
  assert.equal(options.size, 0);
});

function sessionWithCalls(...calls) {
  const nodes = calls.map((root, index) => ({ key: `tool:${index}`, kind: 'tool-call', data: { root } }));
  return { chat: { order: nodes.map(node => node.key), nodes: { get: key => nodes.find(node => node.key === key), values: () => nodes } } };
}
const question = id => ({ kind: 'question', payload: { questions: [{ id, question: '选择', options: [{ label: '冰蓝' }] }] } });

test('only ColdX questions with their own visible native call relinquish the composer', t => {
  const mounted = mountClient(); t.after(() => mounted.dispose());
  const select = mounted.options.get('conversation.composer:coldx-page-wait').select;
  const pageQuestion = question('coldx-page:call-1:1');
  const decision = question('coldx-interaction:child:opaque-id:1');
  const session = sessionWithCalls(
    { callId: 'call-1', name: 'coldx_present_page', subCalls: [] },
    { callId: 'root-code', name: 'run_code', subCalls: [{ callId: 'child:opaque-id', name: 'coldx_interact', subCalls: [] }] },
  );
  assert.equal(select({ interactions: [pageQuestion], session }), pageQuestion);
  assert.equal(select({ interactions: [pageQuestion, decision], session }), decision);
  const settled = sessionWithCalls({ callId: 'call-1', kind: 'tool-result', call: { name: 'coldx_present_page' }, subCalls: [] });
  assert.equal(select({ interactions: [pageQuestion], session: settled }), pageQuestion);
  assert.equal(select({ interactions: [] }), null);
  assert.equal(select({ interactions: [{ kind: 'approval' }], session }), null);
  assert.equal(select({ interactions: [pageQuestion, { kind: 'approval' }], session }), null);
  assert.equal(select({ interactions: [question('normal')], session }), null);
  assert.equal(select({ interactions: [pageQuestion, question('normal')], session }), null);
  const plan = question('coldx-page:call-1:1'); plan.payload.questions[0].intent = { kind: 'plan-review' };
  assert.equal(select({ interactions: [plan], session }), null);
  assert.equal(select({ interactions: [question('coldx-page::1')], session }), null);
});

test('carrier-first hydration keeps the native composer until a matching visible tool node arrives', t => {
  const mounted = mountClient(); t.after(() => mounted.dispose());
  const select = mounted.options.get('conversation.composer:coldx-page-wait').select;
  const pageQuestion = question('coldx-page:call-1:1');
  const interactions = [pageQuestion];
  assert.equal(select({ interactions }), null);
  assert.equal(select({ interactions, session: sessionWithCalls() }), null);
  assert.equal(select({ interactions, session: sessionWithCalls({ callId: 'another-call', name: 'coldx_present_page', subCalls: [] }) }), null);
  assert.equal(select({ interactions, session: sessionWithCalls({ callId: 'call-1', name: 'ask_user_question', subCalls: [] }) }), null);
  const hydrated = sessionWithCalls({ callId: 'call-1', name: 'coldx_present_page', subCalls: [] });
  const hidden = { chat: { ...hydrated.chat, order: [] } };
  assert.equal(select({ interactions, session: hidden }), null);
  assert.equal(select({ interactions, session: hydrated }), pageQuestion);
});

test('the ColdX client declares the native inline tool slot owner as a dependency', async () => {
  const manifest = JSON.parse(await readFile(new URL('../plugin/client/package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-tool'));
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-api-remotes'), 'the client directly consumes remote.commands');
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'), 'the client consumes the native settings scope');
  for (const dependency of manifest.dsh.client.inject) {
    assert.ok(dshRequire.resolve(`${dependency}/package.json`), `${dependency} must resolve in a fresh native graph`);
  }
});

test('header utility derives activity from native stores and leaves terminal in the composer dock', t => {
  const mounted = mountClient(); t.after(() => mounted.dispose());
  const Utility = mounted.entries.get('conversation.session.header.utilities:coldx-activity');
  const calls = [];
  const session = { sessionId: 'parent', views: new Map([['trajectory', { eventNodes: [] }]]) };
  const tree = Utility({
    sessionId: 'parent',
    useSession(selector) { calls.push(['session']); return selector(session); },
    useProjection(name) { calls.push(['projection', name]); return { name }; },
    useSessions(selector) {
      calls.push(['sessions']);
      return selector({ subagentsByParent: { parent: { entries: [] } }, jobsBySession: { parent: [{ id: 'job' }] }, byId: {} });
    },
  });
  const activity = tree.props.children.find(child=>child.type===mounted.ActivityLens);
  assert.equal(activity.type, mounted.ActivityLens);
  assert.equal(activity.props.session, session);
  assert.equal(activity.props.trajectory, session.views.get('trajectory'));
  assert.deepEqual(activity.props.pages, { name: 'coldx.pages' });
  assert.deepEqual(activity.props.flow, { name: 'coldx.flow' });
  assert.deepEqual(activity.props.jobs, [{ id: 'job' }]);
  activity.props.onOpenSubagent({ parentSessionId: 'parent', childSessionId: 'child', mode: 'one-shot' });
  assert.deepEqual(mounted.openedSubagents, [{ parentSessionId: 'parent', childSessionId: 'child', mode: 'one-shot' }]);
  assert.deepEqual(calls, [['session'], ['projection', 'coldx.pages'], ['projection', 'coldx.flow'], ['sessions'], ['sessions'], ['sessions']]);
});


test('native Coding mode bridge preserves exact commands and surfaces native result text', async () => {
  for (const [reply, message] of [
    [{ ok: true, value: { result: { kind: 'success', text: 'accepted' } } }],
    [{ ok: false, error: 'permission denied' }, 'permission denied'],
    [{ ok: true }, '命令未被接收'],
    [{ ok: true, value: {} }, '命令未被接收'],
    [{ ok: true, value: { result: { kind: 'unknown' } } }, '命令未被接收'],
    [{ ok: true, value: { result: { kind: 'error', text: 'exact native result text' } } }, 'exact native result text'],
  ]) {
    const f = mountClient(reply);
    assert.ok(f.plugin.inject.includes('remote')); assert.ok(f.plugin.inject.includes('remote.commands'));
    const Entry = f.entries.get('conversation.input.add:');
    const props = Entry({ sessionId: 'owner', useProjection() {} }).props.children[0].props.modeItems.props;
    if (message === undefined) await props.executeCommand('/coldx-goal on');
    else await assert.rejects(props.executeCommand('/coldx-goal on'), new RegExp(message));
    assert.deepEqual(f.commands, [['owner', '/coldx-goal on', []]]);
    for (const sessionId of [undefined, '']) await Entry({ sessionId }).props.children[0].props.modeItems.props.executeCommand('/plan');
    await assert.rejects(Entry({ sessionId: '   ' }).props.children[0].props.modeItems.props.executeCommand('/plan'));
    assert.equal(f.commands.length, 1); f.dispose(); assert.equal(f.frostDisposed, 1);
  }
});

test('bundled client includes reviewed Frost factories and CSS', async () => {
  const source = await readFile(new URL('../plugin/client/client.js', import.meta.url), 'utf8');
  assert.ok(source.includes('frost:(function createFrostComponents'));
  assert.ok(source.includes('sessionControls:(function createSessionControls')); assert.ok(source.includes('--cx-sys-surface'));
  assert.ok(source.includes('attachments:(function createAttachmentComponents'));
  assert.ok(source.includes('cx-attachment-trigger'));
  assert.ok(source.includes('CodingModeControl'));
  assert.ok(source.includes('activity:(function createActivityComponents'));
  assert.ok(source.includes('terminal:(function createTerminalComponents'));
  assert.ok(source.includes('cx-activity-sheet'));
  assert.ok(source.includes('cx-terminal-panel'));
  assert.equal(source.includes('WorkModeControl'), false);
});

test('attachment control uses the native file-reference remote and input draft action', async () => {
  const f = mountClient();
  const Entry = f.entries.get('conversation.input.add:');
  const tree = Entry({
    sessionId: 'owner', input: { draft: '检查' },
    inputActions: { setDraft(value) { f.drafts.push(value); } }, useProjection() {},
  });
  const attachment = tree.props.children[0];
  assert.equal(attachment.type, f.AttachmentControl);
  const signal = new AbortController().signal;
  assert.deepEqual(await attachment.props.listFiles('src', signal), [{ path: 'README.md', kind: 'file' }]);
  assert.deepEqual(f.fileQueries, [['owner', 'src', signal]]);
  attachment.props.setDraft('检查 @README.md');
  assert.deepEqual(f.drafts, ['检查 @README.md']);
  await assert.rejects(Entry({ sessionId: '' }).props.children[0].props.listFiles('', signal), /打开一个会话/);
  f.dispose();
});

test('local upload sends bounded file bytes through the authenticated native connection', async () => {
  const uploaded = { path: '.coldx/uploads/notes.txt', name: 'notes.txt', bytes: 6, mime: 'text/plain', hash: 'fixture' };
  const f = mountClient({ ok: true, value: uploaded });
  const Entry = f.entries.get('conversation.input.add:');
  const props = Entry({ sessionId: 'owner' }).props.children[0].props;
  const file = new File(['hello!'], 'notes.txt', { type: 'text/plain' });
  const signal = new AbortController().signal;
  assert.deepEqual(await props.uploadFile(file, signal), uploaded);
  assert.deepEqual(f.entries.uploads, [['/api', 'coldxFiles/importFile', { args: { agentId: 'owner', request: { name: 'notes.txt', mime: 'text/plain', size: 6, base64: 'aGVsbG8h' } } }, signal]]);
  await assert.rejects(props.uploadFile({ name: 'large.bin', size: 8 * 1024 * 1024 + 1 }, signal), /8 MB/);
  await assert.rejects(Entry({ sessionId: '' }).props.children[0].props.uploadFile(file, signal), /打开一个会话/);
  assert.equal(f.entries.uploads.length, 1);
  f.dispose();
  const rejected = mountClient({ ok: false, error: { message: 'disk full' } });
  await assert.rejects(rejected.entries.get('conversation.input.add:')({ sessionId: 'owner' }).props.children[0].props.uploadFile(file, signal), /disk full/);
  rejected.dispose();
});
