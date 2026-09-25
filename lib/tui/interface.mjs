import readline from 'node:readline';

const MAX_ROWS = 800;
const MAX_DETAIL = 12_000;
const MAX_SEEN = 2_048;

export function parseTuiArguments(args) {
  const result = { url: 'http://127.0.0.1:3086', sessionId: undefined, help: false };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--help' || flag === '-h') { result.help = true; continue; }
    if (flag === '--url' || flag === '--session') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
      if (flag === '--url') result.url = value;
      else result.sessionId = value;
      continue;
    }
    throw new Error(`Unknown option: ${flag}`);
  }
  return result;
}

function clean(value) {
  return String(value ?? '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b./g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\r/g, '');
}

function blockText(blocks) {
  return (Array.isArray(blocks) ? blocks : []).filter(block => block?.type === 'text')
    .map(block => clean(block.text)).filter(Boolean).join('\n');
}

function isHumanMessage(data) {
  return !data?.source?.kind || data.source.kind === 'user' || data.source.kind === 'human';
}

function toolOutput(message) {
  const content = message?.content ?? [];
  const result = content.find(block => block?.type === 'tool-result');
  const value = blockText(result?.content ?? content);
  return value.length > MAX_DETAIL ? `${value.slice(0, MAX_DETAIL)}\n…（输出已截断）` : value;
}

function eventValue(item) { return item?.event ?? item; }

export function renderPlainHistory(events) {
  const rows = [];
  const calls = new Map();
  for (const item of events ?? []) {
    const event = eventValue(item), data = event?.data ?? {};
    if (event?.type === 'user/message' && isHumanMessage(data)) {
      const value = blockText(data.content);
      if (value) rows.push(`你：${value}`);
    } else if (event?.type === 'assistant/message') {
      const value = blockText(data.message?.content);
      if (value) rows.push(`ColdX：${value}`);
    } else if (event?.type === 'tool/call' && data.callId) {
      calls.set(data.callId, rows.length);
      rows.push(`工具：${clean(data.name || data.callId)} · 运行中`);
    } else if (event?.type === 'tool/result') {
      const id = data.message?.source?.callId, index = calls.get(id);
      const failed = data.error || data.message?.content?.some(block => block?.type === 'tool-result' && block.isError);
      if (index !== undefined) rows[index] = `工具：${rows[index].slice(3).replace(/ · 运行中$/, '')} · ${failed ? '失败' : '完成'}`;
      const output = toolOutput(data.message);
      if (output) rows.push(`  ${output.split('\n')[0]}${output.includes('\n') ? ' …' : ''}`);
    }
  }
  return rows.join('\n\n');
}

function runeWidth(char) {
  const code = char.codePointAt(0);
  if (/\p{Mark}/u.test(char)) return 0;
  return code >= 0x1100 && (code <= 0x115f || code >= 0x2329 && code <= 0x232a ||
    code >= 0x2e80 && code <= 0xa4cf || code >= 0xac00 && code <= 0xd7a3 ||
    code >= 0xf900 && code <= 0xfaff || code >= 0xfe10 && code <= 0xfe19 ||
    code >= 0xfe30 && code <= 0xfe6f || code >= 0xff00 && code <= 0xff60 ||
    code >= 0xffe0 && code <= 0xffe6 || code >= 0x1f300 && code <= 0x1faff) ? 2 : 1;
}

function fit(value, width) {
  let output = '', used = 0;
  for (const char of clean(value).replace(/\n/g, ' ')) {
    const size = runeWidth(char);
    if (used + size > width) break;
    output += char; used += size;
  }
  return output + ' '.repeat(Math.max(0, width - used));
}

function tail(value, width) {
  let output = '', used = 0;
  for (const char of [...clean(value)].reverse()) {
    const size = runeWidth(char);
    if (used + size > width) break;
    output = char + output; used += size;
  }
  return output;
}

function shortPath(value) {
  const parts = clean(value).replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts.at(-1) || '工作区';
}

function shortId(value) { return clean(value).slice(-8); }

function wrap(value, width) {
  const lines = [];
  for (const paragraph of clean(value).split('\n')) {
    let row = '', used = 0;
    for (const char of paragraph) {
      const size = runeWidth(char);
      if (used + size > width && row) { lines.push(row); row = ''; used = 0; }
      row += char; used += size;
    }
    lines.push(row);
  }
  return lines;
}

function ensureArray(value) { return Array.isArray(value) ? value : []; }
function sessionTitle(item) { return clean(item?.title || item?.projections?.values?.title || (item?.blank ? '新会话' : null) || item?.sessionId || '未命名会话'); }

export function createTui({ client, input = process.stdin, output = process.stdout, url = 'http://127.0.0.1:3086', openUrl = async () => {} }) {
  if (!client) throw new TypeError('ColdX TUI needs a Host client.');
  const state = {
    descriptor: null, sessions: [], selected: 0, sessionId: null, title: '', rows: [], seen: new Set(),
    tools: new Map(), drafts: new Map(), input: '', view: 'sessions', status: '', running: false,
    approvals: [], approvalIndex: 0, question: null, scroll: 0, expandedTools: false,
    connection: 'connecting', queueCount: 0, historyLimited: false, historyLimit: 0,
    recoverableDrafts: new Map(), deferredModes: new Map(), started: false, stopped: false,
  };
  let unsubscribe, onKeypress, onResize, keyTail = Promise.resolve(), renderTimer;
  let painted = [], paintedSize = '';

  function notice(message) { state.status = clean(message); scheduleRender(); }
  function currentApproval() { return state.approvals[state.approvalIndex] ?? null; }
  function removeApproval(approvalId) {
    const index = state.approvals.findIndex(frame => frame.approvalId === approvalId);
    if (index < 0) return false;
    state.approvals.splice(index, 1);
    if (index < state.approvalIndex) state.approvalIndex--;
    state.approvalIndex = Math.min(state.approvalIndex, Math.max(0, state.approvals.length - 1));
    scheduleRender();
    return true;
  }
  function append(row) {
    if (state.scroll > 0) {
      const width = Math.max(1, (output.columns || 80) - 1);
      state.scroll += row.kind === 'message' ? wrap(row.text, Math.max(1, width - 2)).length + 2
        : row.kind === 'tool' ? 1 : 0;
    }
    state.rows.push(row);
    if (state.rows.length > MAX_ROWS) {
      const removed = state.rows.splice(0, state.rows.length - MAX_ROWS);
      for (const [id, active] of state.tools) if (removed.includes(active)) state.tools.delete(id);
    }
    scheduleRender();
  }

  function applyEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (Number.isSafeInteger(event.seq)) {
      if (state.seen.has(event.seq)) return;
      state.seen.add(event.seq);
      if (state.seen.size > MAX_SEEN) state.seen.delete(state.seen.values().next().value);
    }
    const data = event.data ?? {};
    if (event.type === 'turn/start') { state.running = true; scheduleRender(); return; }
    if (event.type === 'turn/end') {
      state.running = false;
      const kind = data.reason?.kind;
      notice(kind === 'aborted' ? '本轮已中断' : kind === 'completed' ? '本轮完成' : `本轮结束${kind ? ` · ${clean(kind)}` : ''}`);
      return;
    }
    if (event.type === 'user/message' && isHumanMessage(data)) {
      const current = state.sessions.find(item => item.sessionId === state.sessionId);
      if (current) current.blank = false;
      const value = blockText(data.content);
      if (value) append({ kind: 'message', label: '你', text: value });
    } else if (event.type === 'assistant/chunk') {
      const chunk = data.chunk;
      if (chunk?.type !== 'text-delta' || !chunk.text) return;
      const key = `${data.turn ?? ''}:${data.step ?? ''}`;
      let draft = state.drafts.get(key);
      if (!draft) {
        draft = { kind: 'message', label: 'ColdX', text: '', draft: true };
        state.drafts.set(key, draft); append(draft);
      }
      draft.text += clean(chunk.text);
      if (draft.text.length > MAX_DETAIL) draft.text = draft.text.slice(-MAX_DETAIL);
      scheduleRender();
    } else if (event.type === 'assistant/message') {
      const key = `${data.turn ?? ''}:${data.step ?? ''}`;
      const draft = state.drafts.get(key);
      if (draft) {
        const index = state.rows.indexOf(draft);
        if (index >= 0) state.rows.splice(index, 1);
        state.drafts.delete(key);
      }
      const value = blockText(data.message?.content);
      if (value) append({ kind: 'message', label: 'ColdX', text: value });
    } else if (event.type === 'tool/call' || event.type === 'tool/code-dispatch-start') {
      const id = data.callId ?? data.subCallId;
      if (!id) return;
      const row = { kind: 'tool', name: clean(data.name || '工具'), status: '运行中', detail: '', id };
      state.tools.set(id, row); append(row);
    } else if (event.type === 'tool/result' || event.type === 'tool/code-dispatch') {
      const id = event.type === 'tool/result' ? data.message?.source?.callId : data.subCallId;
      const row = state.tools.get(id);
      if (!row) return;
      row.status = data.error || data.isError || data.message?.content?.some(block => block?.type === 'tool-result' && block.isError) ? '失败' : '完成';
      row.detail = event.type === 'tool/result' ? toolOutput(data.message) : blockText(data.content);
      scheduleRender();
    } else if (event.type === 'session/title' && data.title) {
      state.title = clean(data.title); scheduleRender();
    }
  }

  function onFrame(frame) {
    if (!frame || frame.sessionId && frame.sessionId !== state.sessionId) return;
    if (frame.type === 'session/event') return applyEvent(frame.event);
    if (frame.type === 'host/session-status') { state.running = Boolean(frame.running); scheduleRender(); return; }
    if (frame.type === 'session/queue') {
      state.queueCount = ensureArray(frame.items).filter(item => item?.placement === 'queued' || item?.placement === 'steering').length;
      scheduleRender(); return;
    }
    if (frame.type === 'session/history-limited' && frame.hasMore) {
      state.historyLimited = true; state.historyLimit = frame.limit || 100;
      notice('较早消息未加载；完整历史请到 Web 查看'); return;
    }
    if (frame.type === 'transport/status') {
      state.connection = frame.state === 'connected' ? 'connected' : 'reconnecting';
      notice(state.connection === 'connected' ? '事件流已恢复' : '事件流重连中，运行状态待同步');
      return;
    }
    if (frame.type === 'approval/requested' && frame.rpcId && frame.approvalId) {
      const index = state.approvals.findIndex(item => item.approvalId === frame.approvalId);
      if (index >= 0) state.approvals[index] = frame;
      else state.approvals.push(frame);
      notice(`有 ${state.approvals.length} 项操作等待批准`);
      return;
    }
    if (frame.type === 'approval/resolved') {
      if (frame.approvalId && removeApproval(frame.approvalId)) notice('批准请求已处理');
      return;
    }
    if (frame.type === 'question/requested') {
      state.question = frame; notice('有一个问题需要回答；请在 Web 中打开当前会话。'); return;
    }
    if (frame.type === 'question/resolved') { state.question = null; scheduleRender(); }
  }

  function bodyRows(width) {
    if (state.view === 'sessions') return state.sessions.length ? state.sessions.map((item, index) =>
      `${index === state.selected ? '›' : ' '} ${sessionTitle(item)}  ·  ${shortId(item.sessionId)}`)
      : ['没有现有会话。输入 /new 新建。'];
    const result = [];
    for (const row of state.rows) {
      const cached = row._wrapped;
      if (cached?.width === width && cached.text === row.text && cached.detail === row.detail &&
        cached.status === row.status && cached.draft === row.draft && cached.expanded === state.expandedTools) {
        result.push(...cached.lines); continue;
      }
      const lines = [];
      if (row.kind === 'message') {
        lines.push(`${row.label}${row.draft ? ' · 正在回复' : ''}`);
        for (const line of wrap(row.text, Math.max(1, width - 2))) lines.push(`  ${line}`);
        lines.push('');
      } else if (row.kind === 'tool') {
        lines.push(`  ${row.status === '完成' ? '✓' : row.status === '失败' ? '×' : '·'} ${row.name}  ${row.status}`);
        if (state.expandedTools && row.detail) for (const line of wrap(row.detail, Math.max(1, width - 4))) lines.push(`    ${line}`);
      }
      row._wrapped = { width, text: row.text, detail: row.detail, status: row.status,
        draft: row.draft, expanded: state.expandedTools, lines };
      result.push(...lines);
    }
    if (!result.length) result.push('这里还没有消息。直接输入任务即可开始。');
    return result;
  }

  function render() {
    if (!state.started || state.stopped || !output.isTTY) return;
    const width = Math.max(1, output.columns || 80), height = Math.max(1, output.rows || 24);
    // Leave the last column unused: writing there can trigger auto-wrap and
    // scroll the alternate buffer on Windows Terminal and narrow PTYs.
    const lineWidth = Math.max(1, width - 1);
    const divider = '─'.repeat(lineWidth);
    const title = state.view === 'sessions' ? '选择会话' : state.title || state.sessionId;
    const current = state.view === 'sessions' ? state.sessions[state.selected] : state.sessions.find(item => item.sessionId === state.sessionId);
    const workspace = shortPath(current?.cwd || state.descriptor?.cwd);
    const header = [`ColdX  /  ${title}`, `${workspace}  ·  ${state.view === 'sessions' ? `${state.sessions.length} 个会话` : shortId(state.sessionId)}`];
    const composer = state.view === 'sessions' && !state.input ? '↑ ↓ 选择  ·  Enter 打开  ·  /new 新建'
      : `› ${tail(`${state.input}▌`, Math.max(1, lineWidth - 2))}`;
    const approval = currentApproval();
    const detail = approval ? `批准 ${state.approvalIndex + 1}/${state.approvals.length} · ${clean(approval.toolName || '工具')} · Tab 切换 · y 一次允许 / n 拒绝`
      : state.question ? '问题待回答 · /open 在 Web 处理'
      : state.status || '/help 命令  ·  Esc / Ctrl+C 中断  ·  Ctrl+D 退出';
    const phase = state.connection === 'reconnecting' ? '重连中' : state.connection === 'connecting' ? '连接中'
      : state.running ? '运行中' : '就绪';
    const footer = [phase, state.queueCount ? `排队 ${state.queueCount}` : '', state.historyLimited ? '历史未完整' : '', detail].filter(Boolean).join(' · ');
    let lines;
    if (width < 40 || height < 10) {
      lines = Array(height).fill('');
      lines[0] = `ColdX · ${phase}`;
      if (height > 1) lines[1] = title;
      if (height > 3) lines[2] = state.view === 'sessions' ? sessionTitle(state.sessions[state.selected]) : state.rows.at(-1)?.text || '';
      if (height > 2) lines[height - 2] = state.view === 'sessions' && !state.input ? '↑↓ Enter · /new' : composer;
      if (height > 1) lines[height - 1] = approval
        ? `y准 n拒 · ${state.approvalIndex + 1}/${state.approvals.length} ${clean(approval.toolName || '工具')}`
        : state.question ? '/open · 问题待回答' : footer;
    } else {
      const bodyHeight = height - 6, all = bodyRows(lineWidth);
      let visible;
      if (state.view === 'sessions') {
        const first = Math.min(Math.max(0, state.selected - Math.floor(bodyHeight / 2)), Math.max(0, all.length - bodyHeight));
        visible = all.slice(first, first + bodyHeight);
      } else {
        const end = Math.max(0, all.length - state.scroll);
        visible = all.slice(Math.max(0, end - bodyHeight), end);
      }
      lines = [header[0], header[1], divider, ...visible,
        ...Array(Math.max(0, bodyHeight - visible.length)).fill(''), divider, composer, footer];
    }
    const next = lines.map(line => fit(line, lineWidth));
    const size = `${width}x${height}`;
    if (paintedSize !== size) { paintedSize = size; painted = []; }
    const changes = [];
    for (let index = 0; index < next.length; index++) if (next[index] !== painted[index]) {
      changes.push(`\x1b[${index + 1};1H\x1b[2K${next[index]}`);
    }
    if (changes.length) output.write(`\x1b[H${changes.join('')}`);
    painted = next;
  }

  function scheduleRender() {
    if (!state.started || state.stopped || !output.isTTY || renderTimer) return;
    renderTimer = setTimeout(() => { renderTimer = null; render(); }, 16);
    renderTimer.unref?.();
  }

  async function refreshSessions() {
    const selectedId = state.sessions[state.selected]?.sessionId;
    state.sessions = [...ensureArray(await client.sessions())].sort((left, right) =>
      (Number.isFinite(right.updatedAt) ? right.updatedAt : 0) - (Number.isFinite(left.updatedAt) ? left.updatedAt : 0));
    const previous = state.sessions.findIndex(item => item.sessionId === selectedId);
    state.selected = previous >= 0 ? previous : Math.min(state.selected, Math.max(0, state.sessions.length - 1));
    scheduleRender();
  }

  async function openSession(sessionId) {
    if (!sessionId) return;
    unsubscribe?.(); unsubscribe = null;
    state.sessionId = sessionId;
    state.title = sessionTitle(state.sessions.find(item => item.sessionId === sessionId) ?? { sessionId });
    state.rows = []; state.seen.clear(); state.tools.clear(); state.drafts.clear();
    state.approvals = []; state.approvalIndex = 0; state.question = null; state.running = false; state.scroll = 0;
    state.queueCount = 0; state.connection = 'connecting'; state.historyLimited = false; state.historyLimit = 0;
    state.view = 'chat'; state.input = ''; notice('正在读取会话…');
    try {
      unsubscribe = await client.subscribe(sessionId, onFrame);
      if (state.connection === 'connecting') state.connection = 'connected';
      notice('已连接到现有会话');
    } catch (error) { state.connection = 'reconnecting'; notice(`读取会话失败：${error.message}`); }
  }

  async function answerApproval(allow) {
    const pending = currentApproval();
    if (!pending) return;
    try {
      const receipt = await client.respond(pending.rpcId, { ok: true, value: {
        sessionId: state.sessionId, approvalId: pending.approvalId,
        outcome: allow ? 'allowed-once' : 'rejected',
      } });
      if (receipt?.accepted === true) {
        removeApproval(pending.approvalId);
        notice(allow ? '已批准这一次操作' : '已拒绝操作');
      } else notice(`批准未被接受：${clean(receipt?.reason || '请重试或在 Web 查看')}`);
    } catch (error) { notice(`提交批准失败：${error.message}`); }
  }

  function recoverDraft(sessionId, value, reason) {
    if (state.sessionId === sessionId && !state.input && state.view === 'chat') {
      state.input = value;
      notice(`发送失败：${reason}；草稿已恢复`);
      return;
    }
    const drafts = state.recoverableDrafts.get(sessionId) ?? [];
    drafts.push(value);
    state.recoverableDrafts.set(sessionId, drafts);
    notice(`发送失败：${reason}；原稿已保留，Ctrl+R 可取回`);
  }

  function swapRecoverableDraft() {
    const drafts = state.recoverableDrafts.get(state.sessionId) ?? [];
    if (!drafts.length) return notice('没有待恢复的草稿。');
    const recovered = drafts.shift();
    if (state.input) drafts.push(state.input);
    state.input = recovered;
    notice('已切换到保留的草稿；Ctrl+R 可切回。');
  }

  async function executeCommand(value) {
    const command = value.trim();
    if (command === '/help') return notice('/new /sessions /cancel /open /tools /quit · 空会话模式在首条消息生效');
    if (command === '/sessions') { await refreshSessions(); state.view = 'sessions'; return scheduleRender(); }
    if (command === '/new') {
      const owner = state.view === 'sessions' ? state.sessions[state.selected]
        : state.sessions.find(item => item.sessionId === state.sessionId);
      const cwd = owner?.cwd || state.descriptor?.cwd;
      const created = await client.createSession({ ...(cwd ? { cwd } : {}) });
      if (!created?.sessionId) throw new Error('Host 没有返回会话 ID。');
      await refreshSessions();
      if (!state.sessions.some(item => item.sessionId === created.sessionId)) state.sessions.unshift({ sessionId: created.sessionId, title: '新会话', blank: true, cwd });
      return openSession(created.sessionId);
    }
    if (command === '/cancel') {
      if (!state.sessionId) return notice('先打开一个会话。');
      const receipt = await client.cancel(state.sessionId);
      return notice(receipt?.accepted === false ? '中断未被接受' : '已请求中断');
    }
    if (command === '/open') {
      const target = new URL('/', url).href;
      await openUrl(target);
      return notice('已在浏览器打开 ColdX；请选择当前会话。');
    }
    if (command === '/tools') { state.expandedTools = !state.expandedTools; return notice(state.expandedTools ? '已展开真实工具输出' : '已折叠工具输出'); }
    if (command === '/quit' || command === '/exit') return stop();
    if (!state.sessionId) return notice('先选择会话或输入 /new。');
    const name = command.slice(1).split(/\s+/, 1)[0];
    const available = await client.commands(state.sessionId);
    if (!ensureArray(available).some(item => item?.name === name)) return notice(`未知命令：${command}。输入 /help 查看可用命令。`);
    const blank = state.sessions.find(item => item.sessionId === state.sessionId)?.blank;
    if (blank && (name === 'plan' || name === 'coldx-goal' && /^\/coldx-goal\s+(?:on|off)$/i.test(command))) {
      const pending = state.deferredModes.get(state.sessionId) ?? new Map();
      pending.set(name, command);
      state.deferredModes.set(state.sessionId, pending);
      return notice(`${command} 已暂存，将在首条消息提交前应用`);
    }
    const receipt = await client.executeCommand(state.sessionId, command);
    if (!receipt?.result) return notice(`${command} 未执行：Host 未返回命令结果`);
    if (receipt.result.kind === 'error') return notice(`${command} 执行失败：${clean(receipt.result.text || '未知错误')}`);
    notice(receipt.result.text || `${command} 已执行`);
  }

  async function submit() {
    const value = state.input.trim(); state.input = ''; scheduleRender();
    if (!value) return;
    try {
      if (value.startsWith('/')) return await executeCommand(value);
      if (!state.sessionId) { state.input = value; return notice('先选择会话或输入 /new。'); }
      const sessionId = state.sessionId;
      notice('正在提交消息…');
      // Keep keyboard input responsive while the Host request is in flight.
      void Promise.resolve().then(async () => {
        const pending = state.deferredModes.get(sessionId);
        for (const [name, line] of pending ?? []) {
          const receipt = await client.executeCommand(sessionId, line);
          if (!receipt?.result || receipt.result.kind !== 'success') {
            throw new Error(`${line} 应用失败：${clean(receipt?.result?.text || 'Host 未返回成功结果')}`);
          }
          pending.delete(name);
          const current = state.sessions.find(item => item.sessionId === sessionId);
          if (current) current.blank = false;
        }
        if (pending?.size === 0) state.deferredModes.delete(sessionId);
        return client.prompt(sessionId, value, { mode: 'queue' });
      })
        .then(receipt => receipt?.accepted === false
          ? recoverDraft(sessionId, value, 'Host 未接受消息')
          : notice('消息已提交，等待 Host 事件'))
        .catch(error => recoverDraft(sessionId, value, error.message));
    } catch (error) { state.input = value; notice(error.message); }
  }

  async function interrupt() {
    if (!state.sessionId) return notice('先选择会话。');
    try {
      const receipt = await client.cancel(state.sessionId);
      notice(receipt?.accepted === false ? '中断未被 Host 接受' : '已请求中断');
    } catch (error) { notice(`中断失败：${error.message}`); }
  }

  async function handleKey(str, key = {}) {
    if (state.stopped) return;
    if (key.ctrl && key.name === 'd') return stop();
    if (key.name === 'escape' || key.ctrl && key.name === 'c') return interrupt();
    if (key.ctrl && key.name === 'r') return swapRecoverableDraft();
    if (state.approvals.length && !state.input && key.name === 'tab') {
      state.approvalIndex = (state.approvalIndex + (key.shift ? -1 : 1) + state.approvals.length) % state.approvals.length;
      return scheduleRender();
    }
    if (state.approvals.length && !state.input && (str === 'y' || str === 'n')) return answerApproval(str === 'y');
    if (state.view === 'sessions' && !state.input) {
      if (key.name === 'up') { state.selected = Math.max(0, state.selected - 1); return scheduleRender(); }
      if (key.name === 'down') { state.selected = Math.min(state.sessions.length - 1, state.selected + 1); return scheduleRender(); }
      if (key.name === 'return' || key.name === 'enter') return openSession(state.sessions[state.selected]?.sessionId);
    }
    if (key.name === 'pageup') { state.scroll += Math.max(1, (output.rows || 24) - 8); return scheduleRender(); }
    if (key.name === 'pagedown') { state.scroll = Math.max(0, state.scroll - Math.max(1, (output.rows || 24) - 8)); return scheduleRender(); }
    if (key.name === 'return' || key.name === 'enter') return submit();
    if (key.name === 'backspace') { state.input = state.input.slice(0, -1); return scheduleRender(); }
    if (key.ctrl && key.name === 'u') { state.input = ''; return scheduleRender(); }
    if (key.ctrl || key.meta || !str || !/^[^\x00-\x1f\x7f]+$/u.test(str)) return;
    if (state.input.length < 10_000) { state.input += str; scheduleRender(); }
  }

  async function start({ sessionId } = {}) {
    if (state.started) return;
    state.descriptor = await client.describe();
    await refreshSessions();
    state.started = true;
    if (!input.isTTY || !output.isTTY) {
      output.write(`ColdX · ${clean(state.descriptor?.cwd || url)}\n`);
      for (const item of state.sessions) output.write(`${clean(item.sessionId)}  ${sessionTitle(item)}\n`);
      if (sessionId) {
        const history = await client.history(sessionId);
        const plain = renderPlainHistory(history?.events);
        if (plain) output.write(`\n${plain}\n`);
      }
      state.stopped = true; client.close(); return;
    }
    readline.emitKeypressEvents(input);
    input.setRawMode?.(true); input.resume?.();
    output.write('\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J');
    onKeypress = (str, key) => {
      keyTail = keyTail.then(() => handleKey(str, key)).catch(error => notice(`操作失败：${error.message}`));
    };
    onResize = () => scheduleRender();
    input.on('keypress', onKeypress); output.on?.('resize', onResize);
    render();
    if (sessionId) await openSession(sessionId);
  }

  async function stop() {
    if (state.stopped) return;
    state.stopped = true;
    if (renderTimer) clearTimeout(renderTimer);
    input.off?.('keypress', onKeypress); output.off?.('resize', onResize);
    unsubscribe?.(); unsubscribe = null;
    if (input.isTTY && output.isTTY) {
      input.setRawMode?.(false); input.pause?.();
      output.write('\x1b[?25h\x1b[?1049l');
    }
    client.close();
  }

  return { start, stop, state };
}
