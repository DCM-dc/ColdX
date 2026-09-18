// Self-contained: the native lazy client may serialize this factory with Function#toString.
export function createActivityComponents(React, frost = {}, motionSource) {
  const h = React.createElement;
  const join = (...values) => values.filter(Boolean).join(' ');
  const allowedStatuses = new Set(['running', 'waiting', 'completed', 'failed', 'cancelled', 'interrupted', 'stopping', 'inactive', 'unknown']);
  const computerStatuses = new Set(['running', 'stopping', 'completed', 'failed', 'cancelled', 'interrupted']);
  const jobStatuses = new Set(['running', 'stopping', 'completed', 'killed', 'failed']);
  const terminalStatuses = new Set(['completed', 'failed']);
  const statusLabels = {
    running: '进行中', waiting: '等待', completed: '完成', failed: '失败', cancelled: '已取消',
    interrupted: '已中断', stopping: '正在停止', inactive: '未运行', unknown: '状态未知',
    killed: '已终止', displayed: '已展示', selected: '已选择',
  };
  const statusTone = status => status === 'failed' ? 'danger' : status === 'waiting' || status === 'stopping' ? 'warning' : status === 'completed' ? 'success' : status === 'running' ? 'accent' : 'neutral';
  const labelStatus = status => statusLabels[status] ?? '状态未知';
  const finite = value => Number.isFinite(value) ? value : undefined;
  const nonblank = value => typeof value === 'string' && value.trim() ? value.trim() : undefined;
  const array = value => Array.isArray(value) ? value : [];

  function chatNodes(input) {
    if (Array.isArray(input?.chatNodes)) return input.chatNodes;
    const chat = input?.session?.chat;
    if (!Array.isArray(chat?.order) || typeof chat?.nodes?.get !== 'function') return [];
    return chat.order.map(key => chat.nodes.get(key)).filter(Boolean);
  }

  function trajectoryNodes(input) {
    const direct = input?.trajectory;
    if (Array.isArray(direct?.eventNodes)) return direct.eventNodes;
    const store = input?.session?.views;
    if (typeof store?.get === 'function') {
      const snapshot = store.get('trajectory');
      if (Array.isArray(snapshot?.eventNodes)) return snapshot.eventNodes;
    }
    return [];
  }

  function trajectorySnapshot(input) {
    if (input?.trajectory && typeof input.trajectory === 'object') return input.trajectory;
    const store = input?.session?.views;
    return typeof store?.get === 'function' ? store.get('trajectory') : undefined;
  }

  function callRoots(input) {
    const rows = chatNodes(input);
    const roots = [];
    const seen = new Set();
    for (const row of rows) {
      if (row?.kind !== 'tool-call' || !row.data?.root?.callId) continue;
      roots.push({ block: row.data.root, anchorSeq: finite(row.anchorSeq), truthSource: 'chat' });
      seen.add(row.data.root.callId);
    }
    if (!roots.length) {
      for (const node of trajectoryNodes(input)) {
        if (node?.kind !== 'tool-result' || !node.callId || seen.has(node.callId)) continue;
        roots.push({ block: node, anchorSeq: finite(node.seq), truthSource: 'trajectory' }); seen.add(node.callId);
      }
      for (const node of array(input?.session?.nodes)) {
        if (node?.kind !== 'tool-result' || !node.callId || seen.has(node.callId)) continue;
        roots.push({ block: node, anchorSeq: finite(node.seq), truthSource: 'chat' }); seen.add(node.callId);
      }
    }
    const trajectory = trajectorySnapshot(input);
    const running = trajectory?.runningCalls ?? input?.session?.runningCalls;
    const runningTruthSource = trajectory?.runningCalls !== undefined ? 'trajectory' : 'chat';
    for (const block of array(running)) {
      if (!block?.callId || seen.has(block.callId)) continue;
      roots.push({ block, anchorSeq: undefined, truthSource: runningTruthSource }); seen.add(block.callId);
    }
    return roots;
  }

  function walkBlocks(input) {
    const flat = [];
    const visit = (block, parentCallId, anchorSeq, depth) => {
      if (!block?.callId || depth > 256) return;
      flat.push({ block, parentCallId, anchorSeq, depth });
      for (const child of array(block.subCalls)) visit(child, block.callId, finite(child.seq) ?? anchorSeq, depth + 1);
    };
    for (const root of callRoots(input)) visit(root.block, undefined, root.anchorSeq, 0);
    return flat;
  }

  function normalizedStatus(value) {
    return allowedStatuses.has(value) ? value : 'unknown';
  }

  function presentationTitle(block) {
    const tool = block?.call?.name ?? block?.name;
    const browserLabels = { coldx_browser: '开启独立浏览器', browser_navigate: '打开网页', browser_navigate_back: '返回上一页',
      browser_snapshot: '读取页面结构', browser_take_screenshot: '查看页面截图', browser_click: '点击页面控件',
      browser_type: '输入文字', browser_press_key: '按下快捷键', browser_select_option: '选择页面选项',
      browser_mouse_click_xy: '点击截图位置', browser_mouse_move_xy: '移动指针', browser_mouse_drag_xy: '拖动页面元素',
      browser_mouse_wheel: '滚动页面', browser_tabs: '管理浏览器标签页', browser_close: '关闭浏览器' };
    if (tool === 'coldx_browser') return browserLabels.coldx_browser;
    if (typeof tool === 'string' && tool.startsWith('mcp__coldx_browser__') && browserLabels[tool.slice(20)]) return browserLabels[tool.slice(20)];
    return nonblank(block?.resultView?.title) ?? nonblank(block?.callView?.title) ?? nonblank(block?.call?.name) ?? nonblank(block?.name) ?? nonblank(block?.callId) ?? '未知调用';
  }

  function presentationLocations(block) {
    const locations = [];
    for (const location of array(block?.callView?.locations)) {
      const path = nonblank(location?.path);
      if (path) locations.push({ path, line: Number.isInteger(location.line) && location.line > 0 ? location.line : undefined });
    }
    if (block?.resultView?.card === 'read') {
      const path = nonblank(block.resultView.path);
      if (path) locations.push({ path, line: Number.isInteger(block.resultView.offset) && block.resultView.offset > 0 ? block.resultView.offset : undefined });
    }
    if (block?.resultView?.card === 'search') {
      if (block.resultView.shape === 'paths') for (const value of array(block.resultView.paths)) {
        const path = nonblank(value); if (path) locations.push({ path });
      }
      if (block.resultView.shape === 'matches') for (const file of array(block.resultView.files)) {
        const path = nonblank(file?.path); if (!path) continue;
        const matches = array(file.matches).filter(match => Number.isInteger(match?.lineNumber) && match.lineNumber > 0);
        if (matches.length) for (const match of matches) locations.push({ path, line: match.lineNumber });
        else locations.push({ path });
      }
    }
    const unique = new Map();
    for (const location of locations) unique.set(`${location.path}:${location.line ?? ''}`, location);
    return [...unique.values()];
  }

  function normalizeTool(block, anchorSeq, truthSource = 'chat', parentCallId, depth = 0) {
    const settled = block?.kind === 'tool-result';
    const status = settled ? (block.isError ? 'failed' : 'completed') : 'running';
    const locations = presentationLocations(block);
    const children = array(block?.subCalls).map(child => normalizeTool(child, finite(child.seq) ?? anchorSeq, truthSource, block.callId, depth + 1));
    const typedDetail = locations.length > 0 || ['diff', 'read', 'search', 'web', 'terminal'].includes(block?.resultView?.card);
    return {
      key: `call:${block.callId}`, lane: 'conversation', truthSource, sourceSeq: finite(block.seq) ?? anchorSeq,
      startedAt: finite(block.callTime) ?? finite(block.time), finishedAt: settled ? finite(block.time) : undefined,
      callId: block.callId, parentCallId, title: presentationTitle(block), status,
      statusLabel: labelStatus(status), presentation: { callView: block.callView ?? null, resultView: block.resultView ?? null, locations },
      detailAvailable: typedDetail, children, depth,
    };
  }

  function normalizeWorkflow(row) {
    const data = row?.data;
    const status = normalizedStatus(data?.status);
    return {
      key: `workflow:${row.key ?? row.id ?? row.anchorSeq}`, lane: 'conversation', truthSource: 'workflow',
      sourceSeq: finite(row.anchorSeq), title: nonblank(data?.name) ?? '工作流', status,
      statusLabel: labelStatus(status), presentation: { phases: array(data?.phases) },
      detailAvailable: array(data?.phases).length > 0, children: [], depth: 0,
    };
  }

  function normalizeCompaction(node, anchorSeq, source) {
    return {
      key: `compaction:${node?.key ?? node?.seq ?? anchorSeq}`, lane: 'conversation', truthSource: source,
      sourceSeq: finite(node?.seq) ?? anchorSeq, startedAt: finite(node?.time), finishedAt: finite(node?.time),
      title: '上下文已压缩', status: 'completed', statusLabel: '完成',
      presentation: node?.summary ? { summary: node.summary } : undefined,
      detailAvailable: Boolean(node?.summary), children: [], depth: 0,
    };
  }

  function cleanFailureMessage(value) {
    const message = nonblank(value);
    if (!message) return undefined;
    for (const rawLine of message.replace(/\r\n?/g, '\n').split('\n')) {
      const line = rawLine.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!line || /^at\s+/i.test(line) || /^(?:stack(?:\s+trace)?|prompt|reasoning)\s*[:=]/i.test(line)) continue;
      const sensitiveAt = line.search(/\s(?:stack(?:\s+trace)?|prompt|reasoning)\s*[:=]/i);
      const safe = (sensitiveAt >= 0 ? line.slice(0, sensitiveAt) : line).trim();
      if (safe) return safe.slice(0, 320);
    }
    return undefined;
  }

  function normalizeModelRetry(row) {
    const current = row?.data?.current;
    if (!current || typeof current !== 'object') return undefined;
    const status = current.retryState === 'scheduled' ? 'waiting'
      : current.retryState === 'started' ? 'running'
        : current.retryState === 'cancelled' ? 'cancelled' : 'unknown';
    const retry = Number.isInteger(current.retry) && current.retry > 0 ? current.retry : undefined;
    const maximum = current.mode === 'normal' && Number.isInteger(current.maxRetries) && current.maxRetries > 0 ? current.maxRetries : undefined;
    const detail = {};
    const provider = nonblank(current.provider), failureCode = nonblank(current.failure?.code), message = cleanFailureMessage(current.failure?.message);
    if (provider) detail.provider = provider.slice(0, 120);
    if (finite(current.delayMs) !== undefined && current.delayMs >= 0) detail.delayMs = current.delayMs;
    if (failureCode) detail.failureCode = failureCode.slice(0, 120);
    if (message) detail.message = message;
    const count = retry === undefined ? '' : maximum === undefined ? ` · 第 ${retry} 次` : ` · 第 ${retry}/${maximum} 次`;
    return {
      key: `model-retry:${row.key ?? current.retryId ?? current.seq ?? row.anchorSeq}`, lane: 'conversation', truthSource: 'chat',
      sourceSeq: finite(row.anchorSeq) ?? finite(current.seq), startedAt: finite(current.time),
      title: `模型请求重试${count}`, status, statusLabel: labelStatus(status),
      presentation: { retry: detail }, detailAvailable: Object.keys(detail).length > 0, children: [], depth: 0,
    };
  }

  function normalizeTurnError(row) {
    const node = row?.data ?? row;
    return {
      key: `turn-error:${row?.key ?? node?.seq}`, lane: 'conversation', truthSource: 'chat', sourceSeq: finite(row?.anchorSeq) ?? finite(node?.seq),
      startedAt: finite(node?.time), finishedAt: finite(node?.time), title: nonblank(node?.message) ?? '本轮执行失败',
      status: 'failed', statusLabel: '失败', detailAvailable: Boolean(nonblank(node?.message)), presentation: { error: nonblank(node?.message) }, children: [], depth: 0,
    };
  }

  function selectConversationActivity(input = {}) {
    const rows = chatNodes(input);
    const trajectory = trajectoryNodes(input);
    const records = callRoots(input).map(root => normalizeTool(root.block, root.anchorSeq, root.truthSource));
    for (const row of rows) {
      if (row?.kind === 'workflow-run' && row.data) records.push(normalizeWorkflow(row));
      else if (row?.kind === 'compaction' && row.data) records.push(normalizeCompaction(row.data, finite(row.anchorSeq), 'chat'));
      else if (row?.kind === 'model-retry' && row.data) {
        const retry = normalizeModelRetry(row);
        if (retry) records.push(retry);
      }
      else if (row?.kind === 'turn-error' && row.data) records.push(normalizeTurnError(row));
    }
    if (!rows.length) for (const node of trajectory) {
      if (node?.kind === 'compaction') records.push(normalizeCompaction(node, finite(node.seq), 'trajectory'));
      if (node?.kind === 'turn-error') records.push(normalizeTurnError(node));
    }
    if (!records.length) for (const item of array(input?.flow?.activity)) {
      const id = nonblank(item?.id), title = nonblank(item?.name);
      if (!id || !title) continue;
      const status = normalizedStatus(item.status);
      records.push({
        key: `flow:${id}`, lane: 'conversation', truthSource: 'coldx-flow', sourceSeq: finite(item.sequence), title,
        status, statusLabel: labelStatus(status), detailAvailable: false, children: [], depth: 0,
      });
    }
    records.sort((a, b) => (a.sourceSeq ?? Number.MAX_SAFE_INTEGER) - (b.sourceSeq ?? Number.MAX_SAFE_INTEGER) || (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.key.localeCompare(b.key));
    return records;
  }

  function mutationPaths(block) {
    if (block?.kind !== 'tool-result' || block.isError) return [];
    const callView = block.callView, resultView = block.resultView;
    const mutation = callView?.card === 'diff' || resultView?.card === 'diff'
      || block.call?.name === 'coldx_register_artifact'
      || (callView?.card === 'generic' && ['edit', 'delete', 'move'].includes(callView.kind));
    if (!mutation) return [];
    const paths = [];
    for (const diff of array(callView?.diffs)) { const path = nonblank(diff?.path); if (path) paths.push(path); }
    for (const diff of array(resultView?.diffs)) { const path = nonblank(diff?.path); if (path) paths.push(path); }
    for (const location of array(callView?.locations)) { const path = nonblank(location?.path); if (path) paths.push(path); }
    return [...new Set(paths)];
  }

  function normalizedFilePath(value, windowsHint = false) {
    const windows = /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value) || windowsHint;
    const text = windows ? value.replace(/\\/g, '/') : value;
    const drive = /^([a-z]):\//i.exec(text), share = /^\/\/[^/]+\/[^/]+(?:\/|$)/.exec(text);
    const prefix = drive ? `${drive[1].toUpperCase()}:/` : share ? `${share[0].replace(/\/$/, '')}/` : text.startsWith('/') ? '/' : '';
    // A drive-relative path or a URI is not a path relative to this workspace.
    if (!prefix && /^[a-z][a-z\d+.-]*:/i.test(text)) return { path: text, absolute: false, opaque: true, windows };
    const rest = drive ? text.slice(3) : share ? text.slice(share[0].length) : prefix ? text.slice(1) : text;
    const parts = [];
    for (const part of rest.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
      else if (part !== '..' || !prefix) parts.push(part);
    }
    return { path: `${prefix}${parts.join('/')}` || '.', absolute: Boolean(prefix), windows };
  }

  function workspaceFile(input, value) {
    const sessionId = input?.sessionId ?? input?.session?.sessionId;
    // SessionSummary.cwd is the native host-projected root. Never use the
    // currently selected *other* session or infer a root from command output.
    const rootValue = nonblank(input?.workspaceRoot) ?? nonblank(input?.sessionsState?.byId?.[sessionId]?.cwd);
    const candidate = rootValue ? normalizedFilePath(rootValue) : undefined;
    const root = candidate?.absolute ? candidate : undefined;
    const supplied = normalizedFilePath(value, root?.windows);
    const resolved = root && !supplied.absolute && !supplied.opaque
      ? normalizedFilePath(`${root.path.replace(/\/$/, '')}/${supplied.path}`, root.windows) : supplied;
    const rootPrefix = root ? `${root.path.replace(/\/$/, '')}/` : undefined;
    const path = rootPrefix && resolved.path.startsWith(rootPrefix) ? resolved.path.slice(rootPrefix.length) : resolved.path;
    // Keep filename case: even Windows workspaces may enable case-sensitive
    // directories. This is lexical grouping, not a filesystem/symlink claim.
    return { key: resolved.path, path };
  }

  function outputCategory(input, path) {
    const normalized = workspaceFile(input, path).path;
    // Only known helper formats in the reserved work area are folded. A .py
    // project deliverable or a PDF saved under work remains in the main list.
    return /^\.coldx\/work\/.+\.(?:py|pyc|js|mjs|cjs|ts|sh|bash|zsh|ps1|bat|cmd|c|cpp|h|hpp|log|tmp|json|jsonl)$/i.test(normalized) ? 'process' : 'output';
  }

  function selectActivityOutputs(input = {}) {
    const files = new Map(), pageOutputs = new Map();
    const sessionId = input?.sessionId ?? input?.session?.sessionId;
    const orderedBlocks = walkBlocks(input).map(item => ({ ...item, sourceSeq: finite(item.block.seq) ?? item.anchorSeq }))
      .sort((a, b) => (a.sourceSeq ?? Number.MAX_SAFE_INTEGER) - (b.sourceSeq ?? Number.MAX_SAFE_INTEGER)
        || (finite(a.block.time) ?? 0) - (finite(b.block.time) ?? 0));
    for (const { block, sourceSeq } of orderedBlocks) for (const path of mutationPaths(block)) {
      const file = workspaceFile(input, path);
      const key = `file:${JSON.stringify([sessionId ?? null, file.key])}`;
      let output = files.get(key);
      if (!output) {
        output = { key, kind: 'file', path: file.path, title: file.path, category: outputCategory(input, path),
          status: 'completed', callIds: [], locations: [] };
        files.set(key, output);
      }
      const operation = block.call?.name === 'coldx_register_artifact' ? 'register' : ['delete', 'move'].includes(block.callView?.kind) ? block.callView.kind : 'edit';
      Object.assign(output, { operation, statusLabel: operation === 'register' ? '已登记' : operation === 'delete' ? '已删除' : operation === 'move' ? '已移动' : '已修改',
        callId: block.callId, sourceSeq });
      if (!output.callIds.includes(block.callId)) output.callIds.push(block.callId);
      const locations = presentationLocations(block).filter(location => workspaceFile(input, location.path).key === file.key);
      for (const location of locations.length ? locations : [{ path: file.path }]) {
        let existing = output.locations.find(item => item.line === location.line);
        if (!existing) {
          existing = { path: file.path, line: location.line, callIds: [] };
          output.locations.push(existing);
        }
        if (!existing.callIds.includes(block.callId)) existing.callIds.push(block.callId);
      }
    }
    const pages = Array.isArray(input?.pages) ? input.pages : array(input?.pages?.pages);
    for (const page of pages) {
      const pageId = nonblank(page?.pageId), title = nonblank(page?.title) ?? nonblank(page?.subtitle);
      if (!pageId || !title) continue;
      const status = nonblank(page.status) ?? 'unknown';
      const revision = Number.isInteger(page.revision) && page.revision > 0 ? page.revision : undefined;
      const key = `page:${JSON.stringify([nonblank(page.sessionId) ?? sessionId ?? null, pageId, revision ?? null])}`;
      const output = { key, kind: 'page', pageId, title, subtitle: nonblank(page.subtitle), status, statusLabel: labelStatus(status),
        callId: nonblank(page.rootCallId), sourceSeq: finite(page.sequence), page };
      const existing = pageOutputs.get(key);
      if (!existing || (output.sourceSeq ?? Number.MAX_SAFE_INTEGER) >= (existing.sourceSeq ?? Number.MAX_SAFE_INTEGER)) pageOutputs.set(key, output);
    }
    const outputs = [...files.values(), ...pageOutputs.values()];
    outputs.sort((a, b) => (a.sourceSeq ?? Number.MAX_SAFE_INTEGER) - (b.sourceSeq ?? Number.MAX_SAFE_INTEGER) || a.key.localeCompare(b.key));
    return outputs;
  }

  function canonicalWebUrl(value) {
    const text = nonblank(value); if (!text) return undefined;
    try {
      const parsed = new URL(text);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
      parsed.hash = '';
      return { url: parsed.href, domain: parsed.hostname };
    } catch { return undefined; }
  }

  function contextRows(input) {
    const rows = chatNodes(input).filter(row => row?.kind === 'context').map(row => row.data).filter(Boolean);
    if (rows.length) return rows;
    return trajectoryNodes(input).filter(node => node?.kind === 'context');
  }

  function selectActivitySources(input = {}) {
    const webMap = new Map(), sessionMap = new Map(), workspaceMap = new Map();
    let webTruncated = false;
    for (const { block, anchorSeq } of walkBlocks(input)) {
      if (block?.kind !== 'tool-result' || block.isError) continue;
      const view = block.resultView;
      if (view?.card === 'web') {
        webTruncated ||= view.truncated === true;
        const values = view.kind === 'search' ? array(view.sources) : view.kind === 'fetch' ? [{ url: view.url, title: view.title, statusCode: view.statusCode, truncated: view.truncated }] : [];
        for (const source of values) {
          const parsed = canonicalWebUrl(source?.url); if (!parsed) continue;
          const existing = webMap.get(parsed.url);
          if (existing) {
            if (!existing.title && nonblank(source.title)) existing.title = nonblank(source.title);
            if (!existing.snippet && nonblank(source.snippet)) existing.snippet = nonblank(source.snippet);
            if (!existing.publishedAt && nonblank(source.publishedAt)) existing.publishedAt = nonblank(source.publishedAt);
            if (existing.statusCode === undefined && Number.isInteger(source.statusCode)) existing.statusCode = source.statusCode;
            if (!existing.callIds.includes(block.callId)) existing.callIds.push(block.callId);
            existing.truncated ||= source.truncated === true;
          } else webMap.set(parsed.url, {
            key: `web:${parsed.url}`, kind: 'web', url: parsed.url, domain: parsed.domain,
            title: nonblank(source.title), snippet: nonblank(source.snippet), publishedAt: nonblank(source.publishedAt),
            statusCode: Number.isInteger(source.statusCode) ? source.statusCode : undefined,
            truncated: source.truncated === true, callIds: [block.callId], sourceSeq: finite(block.seq) ?? anchorSeq,
          });
        }
      }
      const callKind = block.callView?.card === 'generic' ? block.callView.kind : undefined;
      const evidence = callKind === 'read' || callKind === 'search' || view?.card === 'read' || view?.card === 'search';
      if (evidence) for (const location of presentationLocations(block)) {
        const file = workspaceFile(input, location.path);
        const value = `${file.path}${location.line ? `:${location.line}` : ''}`;
        let source = workspaceMap.get(file.key);
        if (!source) {
          source = { key: `workspace:${file.key}`, kind: 'workspace', path: file.path, line: location.line, location: value,
            locations: [], callIds: [], sourceSeq: finite(block.seq) ?? anchorSeq };
          workspaceMap.set(file.key, source);
        }
        if (!source.callIds.includes(block.callId)) source.callIds.push(block.callId);
        const existing = source.locations.find(item => item.line === location.line);
        if (existing) { if (!existing.callIds.includes(block.callId)) existing.callIds.push(block.callId); }
        else source.locations.push({ path: file.path, line: location.line, location: value, callIds: [block.callId], sourceSeq: finite(block.seq) ?? anchorSeq });
        if (source.locations.length > 1) source.location = source.path;
      }
    }
    for (const context of contextRows(input)) {
      const source = context?.source;
      if (source?.kind !== 'session-reference' || source.form !== 'recall' || source.version !== 1) continue;
      for (const reference of array(source.references)) {
        const sessionId = nonblank(reference?.sessionId), label = nonblank(reference?.label);
        if (!sessionId || !label) continue;
        const capturedThroughSeq = finite(reference.capturedThroughSeq);
        const key = `${sessionId}:${capturedThroughSeq ?? ''}:${reference.inputIndex ?? ''}`;
        if (sessionMap.has(key)) continue;
        sessionMap.set(key, {
          key: `session:${key}`, kind: 'session', sessionId, label, capturedThroughSeq,
          compacted: reference.compacted === true, truncated: reference.truncated === true,
          originalMessages: Number.isInteger(reference.originalMessages) ? reference.originalMessages : undefined,
          retainedMessages: Number.isInteger(reference.retainedMessages) ? reference.retainedMessages : undefined,
          omittedMessages: Number.isInteger(reference.omittedMessages) ? reference.omittedMessages : undefined,
          omittedBytes: Number.isInteger(reference.omittedBytes) ? reference.omittedBytes : undefined,
        });
      }
    }
    const web = [...webMap.values()], session = [...sessionMap.values()], workspace = [...workspaceMap.values()];
    return { web, session, workspace, webTruncated, loadedCount: web.length + session.length + workspace.length };
  }

  function selectSubagentActivity(input = {}) {
    const catalog = input?.subagents;
    const entries = Array.isArray(catalog) ? catalog : array(catalog?.entries);
    const byId = input?.sessionsState?.byId ?? {};
    return entries.map((entry, index) => {
      const id = nonblank(entry?.id);
      const validMode = entry?.mode === 'one-shot' || entry?.mode === 'continuable';
      if (entry?.kind !== 'child' || !id || !validMode) return {
        key: `subagent:${id ?? `diagnostic-${index}`}`, id, kind: 'diagnostic',
        label: nonblank(entry?.label) ?? id ?? '子智能体记录不可用', status: 'unknown', statusLabel: '状态未知',
        reason: nonblank(entry?.reason) ?? (!id ? '记录缺少会话 ID' : !validMode ? '记录包含不支持的模式' : '记录不可用'),
        disabled: true, index,
      };
      const summary = typeof byId?.get === 'function' ? byId.get(id) : byId[id];
      // Native catalog activity describes storage residency, not execution:
      // running = live session record; inactive = persistence-only record.
      // A list row may not be loaded until its child is opened. Neither that
      // absence nor the unread `completed` reminder proves a task outcome.
      const execution = entry.execution;
      const executionStatus = ['running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(execution?.status)
        && Number.isInteger(execution.seq) && execution.seq >= 0 && Number.isFinite(execution.time) ? execution.status : undefined;
      const activity = summary?.running === true ? 'running' : executionStatus ?? (summary?.running === false ? 'inactive' : 'unknown');
      const failureLabels = { AUTH: '模型认证失败', RATE_LIMIT: '模型请求限流', TIMEOUT: '模型请求超时', TRANSPORT: '连接失败', SERVER: '模型服务异常', EMPTY_RESPONSE: '模型未返回内容', MODEL_NOT_FOUND: '模型不可用', NO_PROVIDER: '提供方不可用', PERMISSION_DENIED: '权限不足', APPROVAL_REQUIRED: '需要父任务处理权限', REFUSAL: '模型未执行此任务', MAX_TOKENS: '达到输出上限', HOST_STOPPED: '运行已中断' };
      const detail = activity === 'failed' || activity === 'interrupted' ? failureLabels[execution?.code] : undefined;
      const statusLabel = detail ?? (activity === 'running' ? '进行中' : activity === 'inactive' ? '暂无运行' : activity === 'unknown' ? '状态未载入' : labelStatus(activity));
      const title = (nonblank(summary?.displayTitle) ?? nonblank(entry.label) ?? '子任务')
        .split(/[\r\n。！？!?]/u, 1)[0].replace(/^\s*[#*\->\s]+/u, '').trim() || '子任务';
      const label = [...title].slice(0, 72).join('') + ([...title].length > 72 ? '…' : '');
      return {
        key: `subagent:${id}`, id, kind: 'child', label,
        notification: `${label}${activity === 'running' ? '进行中' : activity === 'completed' ? '已完成' : activity === 'failed' ? '未能完成' : activity === 'cancelled' ? '已取消' : activity === 'interrupted' ? '已中断' : '有了更新'}`,
        mode: entry.mode, modeLabel: entry.mode === 'one-shot' ? '单次任务' : '可继续', status: activity, statusLabel,
        hasChildren: entry.hasChildren === true, disabled: false, index, updatedAt: executionStatus ? execution.time : undefined,
        timing: summary?.projectionValues?.subagentTiming, tokenUsage: summary?.projectionValues?.tokenUsage,
      };
    }).sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || a.index - b.index);
  }

  function selectBackgroundActivity(input = {}) {
    return array(input?.jobs).filter(job => nonblank(job?.id) && nonblank(job?.label) && jobStatuses.has(job.status)).map((job, index) => ({
      key: `job:${job.id}`, lane: 'background', truthSource: 'job', id: job.id, kind: nonblank(job.kind) ?? 'other',
      title: job.label.trim(), status: job.status === 'killed' ? 'cancelled' : job.status,
      nativeStatus: job.status, statusLabel: labelStatus(job.status), detail: nonblank(job.detail),
      startedAt: finite(job.startedAt), finishedAt: finite(job.finishedAt), index,
    })).sort((a, b) => Number(['running', 'stopping'].includes(b.status)) - Number(['running', 'stopping'].includes(a.status)) || (b.startedAt ?? 0) - (a.startedAt ?? 0) || a.index - b.index);
  }

  function selectComputerActivity(input = {}) {
    if (input?.computer?.version !== 1 || !Array.isArray(input.computer.records)) return [];
    return input.computer.records.flatMap(record => {
      const callId = nonblank(record?.callId), surfaceLabel = nonblank(record?.surfaceLabel);
      if (!callId || !surfaceLabel || !computerStatuses.has(record.status)) return [];
      return [{
        key: `computer:${callId}`, callId, sourceSeq: finite(record.sourceSeq), startedAt: finite(record.startedAt), finishedAt: finite(record.finishedAt),
        status: record.status, surfaceLabel, previewAttachment: record.previewAttachment,
        streamActions: record.streamActions && typeof record.streamActions === 'object' ? record.streamActions : undefined,
      }];
    }).sort((a, b) => (a.sourceSeq ?? Number.MAX_SAFE_INTEGER) - (b.sourceSeq ?? Number.MAX_SAFE_INTEGER) || (a.startedAt ?? 0) - (b.startedAt ?? 0));
  }

  function selectTerminalEvidence(input = {}) {
    const terminals = [];
    for (const { block, anchorSeq } of walkBlocks(input)) {
      if (block?.kind !== 'tool-result' || block?.resultView?.card !== 'terminal' || typeof block.resultView.output !== 'string') continue;
      const exitCode = Number.isInteger(block.resultView.exitCode) ? block.resultView.exitCode : undefined;
      const signal = nonblank(block.resultView.signal);
      const status = block.isError || signal || (exitCode !== undefined && exitCode !== 0) ? 'failed' : 'completed';
      if (!terminalStatuses.has(status)) continue;
      terminals.push({
        key: `terminal:${block.callId}`, callId: block.callId,
        title: nonblank(block.resultView.title) ?? nonblank(block.callView?.title) ?? block.callId,
        command: nonblank(block.callView?.title), cwd: nonblank(block.callView?.cwd), output: block.resultView.output,
        exitCode, signal, status, sourceSeq: finite(block.seq) ?? anchorSeq,
      });
    }
    return terminals.sort((a, b) => (a.sourceSeq ?? Number.MAX_SAFE_INTEGER) - (b.sourceSeq ?? Number.MAX_SAFE_INTEGER));
  }

  function flattenRecords(records) {
    const result = [];
    const visit = record => { result.push(record); for (const child of array(record.children)) visit(child); };
    for (const record of records) visit(record);
    return result;
  }

  function lastByOrder(values) {
    return [...values].sort((a, b) => (a.sourceSeq ?? a.startedAt ?? 0) - (b.sourceSeq ?? b.startedAt ?? 0)).at(-1);
  }

  function selectNow({ input, timeline, subagents, jobs, computers, evidence }) {
    const pending = array(input?.session?.pending);
    if (pending.length) {
      const approval = pending.some(item => item?.kind === 'approval');
      return { kind: 'pending', text: approval ? '等待授权' : '等待你的选择', status: 'waiting', tone: 'warning' };
    }
    const liveComputer = lastByOrder(computers.filter(item => item.status === 'running' || item.status === 'stopping'));
    if (liveComputer) return { kind: 'computer', text: liveComputer.surfaceLabel, status: liveComputer.status, tone: statusTone(liveComputer.status), key: liveComputer.key };
    const flat = flattenRecords(timeline);
    const liveCall = lastByOrder(flat.filter(item => item.callId && item.status === 'running'));
    if (liveCall) return { kind: 'call', text: liveCall.title, status: 'running', tone: 'accent', key: liveCall.key };
    const workflow = lastByOrder(flat.filter(item => item.truthSource === 'workflow' && item.status === 'running'));
    if (workflow) return { kind: 'workflow', text: workflow.title, status: 'running', tone: 'accent', key: workflow.key };
    const childCount = subagents.filter(item => item.status === 'running').length;
    if (childCount) return { kind: 'subagent', text: `${childCount} 个子智能体运行中`, status: 'running', tone: 'accent' };
    const job = jobs.find(item => item.status === 'running' || item.status === 'stopping');
    if (job) return { kind: 'job', text: `${job.title} · ${job.statusLabel}`, status: job.status, tone: statusTone(job.status), key: job.key };
    if (input?.session?.running) return { kind: 'assistant', text: '正在生成回复', status: 'running', tone: 'accent' };
    const terminal = lastByOrder(flat.filter(item => ['completed', 'failed', 'cancelled', 'interrupted'].includes(item.status)));
    if (terminal) {
      const prefix = terminal.status === 'completed' ? '刚完成' : terminal.status === 'failed' ? '失败' : terminal.statusLabel;
      return { kind: 'terminal-record', text: `${prefix}：${terminal.title}`, status: terminal.status, tone: statusTone(terminal.status), key: terminal.key };
    }
    if (evidence) return { kind: 'evidence', text: '查看本次行动与证据', status: 'unknown', tone: 'neutral' };
    return { kind: 'idle', text: '查看本次行动与证据', status: 'unknown', tone: 'neutral' };
  }

  function selectActivityModel(input = {}) {
    const timeline = selectConversationActivity(input);
    const outputs = selectActivityOutputs(input);
    const sources = selectActivitySources(input);
    const subagents = selectSubagentActivity(input);
    const jobs = selectBackgroundActivity(input);
    const computers = selectComputerActivity(input);
    const terminals = selectTerminalEvidence(input);
    const flat = flattenRecords(timeline);
    const calls = flat.filter(item => Boolean(item.callId));
    const realChat = chatNodes(input).length > 0 || trajectoryNodes(input).length > 0 || array(input?.session?.nodes).length > 0;
    const evidence = Boolean(outputs.length || sources.loadedCount || subagents.length || jobs.length || computers.length || terminals.length || timeline.length);
    const visible = Boolean(evidence || array(input?.session?.pending).length || input?.session?.running || input?.session?.composerPhase === 'active' || realChat);
    const counts = { calls: calls.length, subagents: subagents.length, runningSubagents: subagents.filter(item => item.status === 'running').length, jobs: jobs.length, sources: sources.loadedCount, outputs: outputs.length, terminals: terminals.length };
    return { sessionId: input?.sessionId ?? input?.session?.sessionId, visible, timeline, outputs, sources, subagents, jobs, computers, terminals, counts, now: selectNow({ input, timeline, subagents, jobs, computers, evidence }) };
  }

  const Surface = frost.Surface ?? function Surface({ as: Tag = 'div', className, material, floating, children, ...props }) {
    return h(Tag, { ...props, className: join('cx-surface', className), 'data-material': material, 'data-floating': floating ? 'true' : undefined }, children);
  };
  const Action = frost.Action ?? function Action({ label, children, className, motion: _motion, ...props }) {
    return h('button', { ...props, type: props.type ?? 'button', className: join('cx-action', className), 'aria-label': props['aria-label'] ?? label }, children ?? label);
  };
  const Disclosure = frost.Disclosure ?? function Disclosure({ label, children, className, ...props }) {
    return h('details', { ...props, className: join('cx-disclosure', className) }, h('summary', null, label), children);
  };
  const press = (runtime, disabled = false) => frost.pressHandlers?.(runtime, disabled) ?? {};

  function useReducedMotionPreference(explicit) {
    const [system, setSystem] = React.useState(() => Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches));
    React.useEffect(() => {
      if (typeof explicit === 'boolean' || typeof globalThis.matchMedia !== 'function') return undefined;
      const media = globalThis.matchMedia('(prefers-reduced-motion: reduce)');
      const update = () => setSystem(Boolean(media.matches));
      update();
      if (typeof media.addEventListener === 'function') media.addEventListener('change', update);
      else media.addListener?.(update);
      return () => {
        if (typeof media.removeEventListener === 'function') media.removeEventListener('change', update);
        else media.removeListener?.(update);
      };
    }, [explicit]);
    return typeof explicit === 'boolean' ? explicit : system;
  }

  const icon = (name, path) => h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, 'data-icon': name }, h('path', { d: path }));
  const icons = {
    activity: ['activity', 'M4 13h3l2-7 4 12 2-7h5'],
    close: ['close', 'm6 6 12 12M6 18 18 6'],
    chevron: ['chevron', 'm8 10 4 4 4-4'],
    output: ['output', 'M4 5h16v14H4zM8 9h8M8 13h5'],
    agent: ['agent', 'M8 8a4 4 0 1 0 8 0 4 4 0 0 0-8 0Zm-3 12a7 7 0 0 1 14 0M18 4h3m-1.5-1.5v3'],
    source: ['source', 'M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1'],
    terminal: ['terminal', 'm5 7 4 5-4 5m6 0h8'],
    computer: ['computer', 'M4 5h16v12H4zM9 21h6m-3-4v4'],
    return: ['return', 'm9 7-5 5 5 5M4 12h10a6 6 0 0 1 6 6'],
  };
  const glyph = key => icon(...icons[key]);

  function timeLabel(value) {
    if (!Number.isFinite(value)) return '—';
    try { return new Date(value).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
    catch { return '—'; }
  }

  function durationLabel(startedAt, finishedAt) {
    if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) return '—';
    const ms = finishedAt - startedAt;
    return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
  }

  function GroupLabel({ icon, title, count, detail }) {
    return h('span', { className: 'cx-activity-group-label' }, glyph(icon), h('strong', null, title),
      detail && h('span', { className:'cx-activity-group-meta' }, detail), h('span', { className:'cx-activity-group-count' }, count));
  }

  function ActivityUtilityTrigger({ model, open, onToggle, triggerRef, runtime }) {
    const active = ['running', 'stopping'].includes(model.now.status);
    const action = open ? '收起工作面板' : '打开工作面板';
    const running = model.counts.calls ? `，${model.counts.calls} 个调用已载入` : '';
    return h('button', {
      ref: triggerRef, type: 'button', className: 'cx-action cx-activity-trigger', 'aria-label': `${action}${running}`, 'aria-expanded': open,
      'aria-controls': `cx-activity-panel-${model.sessionId ?? 'session'}`, 'data-live': active ? 'true' : undefined,
      onClick: onToggle, ...press(runtime),
    }, h('span', { className: 'cx-activity-trigger-icon' }, glyph('activity')), h('span', { className: 'cx-activity-trigger-label' }, '工作面板'), active && h('span', { className: 'cx-activity-trigger-dot', 'aria-hidden': true }));
  }

  function readableNow(now, timeline = []) {
    if (now.status === 'failed' && /no API key|MISSING_CREDENTIAL/i.test(now.text)) return '尚未配置模型 API Key';
    const record = flattenRecords(timeline).find(item => item.key === now.key);
    const command = record?.presentation?.callView?.card === 'terminal' || record?.presentation?.resultView?.card === 'terminal';
    return command ? now.status === 'running' ? '正在运行命令' : now.status === 'failed' ? '命令执行失败' : '命令执行已结束' : now.text;
  }

  function ActivityPinnedSummary({model, onOpen}) {
    if (!model.visible) return null;
    const {now, counts} = model;
    return h('div', {className:'cx-activity-pinned', 'aria-label':'行动摘要'},
      h('button', {type:'button', className:'cx-activity-pinned-current', onClick:event=>onOpen('timeline',event.currentTarget), 'aria-label':`查看进度：${readableNow(now,model.timeline)}`},
        h('span', {className:'cx-activity-live-mark', 'data-status':now.status, 'aria-hidden':true}),
        h('span', {className:'cx-activity-pinned-text', role:'status', 'aria-live':'polite'}, readableNow(now,model.timeline))),
      h('div', {className:'cx-activity-pinned-links'},
        counts.subagents > 0 && h('button', {type:'button', onClick:event=>onOpen('timeline',event.currentTarget), 'aria-label':`查看 ${counts.subagents} 个子智能体`}, glyph('agent'), counts.runningSubagents ? `${counts.runningSubagents} 运行中` : `${counts.subagents} 子任务`),
        counts.outputs > 0 && h('button', {type:'button', onClick:event=>onOpen('evidence',event.currentTarget), 'aria-label':`查看 ${counts.outputs} 个成果`}, glyph('output'), `${counts.outputs} 成果`),
        counts.sources > 0 && h('button', {type:'button', onClick:event=>onOpen('evidence',event.currentTarget), 'aria-label':`查看 ${counts.sources} 个来源`}, glyph('source'), `${counts.sources} 来源`)));
  }

  function NowStrip({ now, timeline = [] }) {
    const text = readableNow(now,timeline);
    return h('div', { className: 'cx-activity-now', 'data-tone': now.tone, role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
      h('span', { className: 'cx-activity-live-mark', 'data-status': now.status, 'data-latest': ['running', 'stopping'].includes(now.status) ? 'true' : undefined, 'aria-hidden': true }),
      h('div', null, h('span', { className: 'cx-activity-now-label' }, now.status === 'waiting' ? '需要你处理' : ['running', 'stopping'].includes(now.status) ? '当前进度' : '最近更新'), h('strong', {title:now.text}, text)));
  }

  function safeDetails(record) {
    const details = [];
    if (record?.presentation?.callView?.card === 'terminal' || record?.presentation?.resultView?.card === 'terminal') details.push(h('code', {key:'command',className:'cx-activity-command-detail'}, nonblank(record.presentation.callView?.title) ?? record.title));
    for (const location of array(record?.presentation?.locations)) details.push(h('code', { key: `${location.path}:${location.line ?? ''}` }, `${location.path}${location.line ? `:${location.line}` : ''}`));
    const phases = array(record?.presentation?.phases);
    for (const phase of phases) {
      const members = array(phase?.members);
      details.push(h('p', { key: phase?.key ?? phase?.phase ?? details.length }, `${nonblank(phase?.phase) ?? '未命名阶段'}${members.length ? ` · ${members.length} 个成员` : ''}`));
    }
    if (record?.presentation?.summary) details.push(h('p', { key: 'summary' }, record.presentation.summary));
    if (record?.presentation?.error) details.push(h('p', { key: 'error' }, record.presentation.error));
    const retry = record?.presentation?.retry;
    if (retry?.provider) details.push(h('p', { key: 'retry-provider' }, `提供方：${retry.provider}`));
    if (finite(retry?.delayMs) !== undefined) details.push(h('p', { key: 'retry-delay' }, `等待：${Math.round(retry.delayMs)}ms`));
    if (retry?.failureCode) details.push(h('p', { key: 'retry-code' }, `错误代码：${retry.failureCode}`));
    if (retry?.message) details.push(h('p', { key: 'retry-message' }, retry.message));
    return details;
  }

  function ActivityRow({ record, latestLiveKey, onBrowse, runtime, enteringKeys }) {
    const rowRef = React.useRef(null);
    const priorStatus = React.useRef(record.status);
    (React.useLayoutEffect ?? React.useEffect)(() => {
      if (enteringKeys?.has(record.key)) runtime?.materialize?.(rowRef.current);
    }, [record.key, runtime]);
    (React.useLayoutEffect ?? React.useEffect)(() => {
      const previous = priorStatus.current;
      priorStatus.current = record.status;
      if (previous === 'running' && ['completed', 'failed', 'cancelled', 'interrupted'].includes(record.status)) runtime?.confirm?.(rowRef.current);
    }, [record.status, runtime]);
    React.useEffect(() => () => runtime?.release?.(rowRef.current), [runtime]);
    const command = record?.presentation?.callView?.card === 'terminal' || record?.presentation?.resultView?.card === 'terminal';
    const core = h('div', { className: 'cx-activity-row-core' },
      h('span', { className: 'cx-activity-live-mark', 'data-status': record.status, 'data-latest': record.key === latestLiveKey ? 'true' : undefined, 'aria-hidden': true }),
      h('span', { className: 'cx-activity-row-title', title:record.title }, command ? '运行命令' : record.title),
      h('span', { className: 'cx-activity-row-time' }, timeLabel(record.startedAt)),
      h('span', { className: 'cx-activity-row-status', 'data-tone': statusTone(record.status) }, record.statusLabel));
    const detail = safeDetails(record);
    const content = (record.detailAvailable || command) && detail.length ? h('details', { onToggle: event => { if (event.currentTarget?.open) onBrowse?.(); } }, h('summary', null, core), h('div', { className: 'cx-activity-row-detail' }, detail)) : core;
    return h('li', { ref: rowRef, className: 'cx-activity-row', 'data-status': record.status, 'data-depth': record.depth ?? 0 }, content,
      array(record.children).length ? h('ol', { className: 'cx-activity-branch' }, record.children.map(child => h(ActivityRow, { key: child.key, record: child, latestLiveKey, onBrowse, runtime, enteringKeys }))) : null);
  }

  function ActivityTimeline({ records, onBrowse, runtime, knownRowKeys }) {
    const flat = flattenRecords(records);
    const latestLive = lastByOrder(flat.filter(item => item.status === 'running'));
    const enteringKeys = new Set(flat.filter(item => !knownRowKeys?.has(item.key)).map(item => item.key));
    (React.useLayoutEffect ?? React.useEffect)(() => {
      for (const record of flat) knownRowKeys?.add(record.key);
    }, [flat.map(item => item.key).join('\u0000'), knownRowKeys]);
    if (!records.length) return h('p', { className: 'cx-activity-empty' }, '还没有操作记录。');
    const ended = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
    const settled = record => flattenRecords([record]).every(item => ended.has(item.status));
    const current = records.filter(record => !settled(record)), history = records.filter(settled);
    const finished = flattenRecords(history), failures = finished.filter(record => record.status === 'failed').length;
    const rows = (values, live) => h('ol', { className:'cx-activity-timeline', 'aria-label':live ? '当前操作' : '已结束的操作' }, values.map(record => h(ActivityRow, {
      key:record.key,record,latestLiveKey:latestLive?.key,onBrowse,runtime:live ? runtime : undefined,enteringKeys:live ? enteringKeys : undefined,
    })));
    return h('section', {className:'cx-activity-operations','aria-label':'操作记录'},
      current.length ? h('div', {className:'cx-activity-live-operations'}, h('h3', null, '当前操作'),rows(current,true)) : null,
      history.length ? h(Disclosure, {className:'cx-activity-history',label:h('span',{className:'cx-activity-history-label'},h('strong',null,'已结束的操作'),h('span',null,finished.length),failures ? h('span',{className:'cx-activity-history-errors'},`${failures} 次失败`) : null),onToggle:event=>{if(event.currentTarget.open)onBrowse?.();}},rows(history,false)) : null);
  }

  function BackgroundLane({ jobs }) {
    if (!jobs.length) return null;
    return h('section', { className: 'cx-activity-background', 'aria-labelledby': 'cx-activity-background-title' },
      h('h3', { id: 'cx-activity-background-title' }, '后台活动'),
      h('ol', null, jobs.map(job => h('li', { key: job.key, 'data-status': job.status },
        h('span', { className: 'cx-activity-live-mark', 'data-status': job.status, 'aria-hidden': true }),
        h('span', { className: 'cx-activity-row-title' }, job.title),
        h('span', { className: 'cx-activity-row-time' }, durationLabel(job.startedAt, job.finishedAt)),
        h('span', { className: 'cx-activity-row-status', 'data-tone': statusTone(job.status) }, job.statusLabel),
        job.detail && h('small', null, job.detail)))));
  }

  function OutputGroup({ outputs, onOpenFile, onOpenOutput }) {
    if (!outputs.length) return null;
    const renderOutputs = rows => h('ul', null, rows.map(output => h('li', { key: output.key },
        h('div', null, h('strong', null, output.title), output.subtitle && h('small', null, output.subtitle), h('small', null, output.statusLabel)),
        output.kind === 'file' && output.operation !== 'delete' && onOpenFile ? h(Action, { className: 'cx-activity-inline-action', label: `打开 ${output.path}`, onClick: () => onOpenFile(output.path) }, '打开')
          : output.kind === 'page' && onOpenOutput ? h(Action, { className: 'cx-activity-inline-action', label: `打开 ${output.title}`, onClick: () => onOpenOutput(output) }, '打开') : null)));
    const primary = outputs.filter(output => output.category !== 'process'), process = outputs.filter(output => output.category === 'process');
    return h(Disclosure, { className: 'cx-activity-group cx-activity-output-group', label: h(GroupLabel,{icon:'output',title:'成果文件',count:outputs.length}), open: true },
      primary.length ? renderOutputs(primary) : null,
      process.length ? h(Disclosure, { className: 'cx-activity-process-files', label: h('span', null, h('strong', null, '过程文件'), h('span', null, ` · ${process.length}`)) }, renderOutputs(process)) : null);
  }

  function SubagentGroup({ sessionId, subagents, onOpenSubagent }) {
    if (!subagents.length) return null;
    const running = subagents.filter(item => item.status === 'running').length;
    const recent = [...subagents].sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || b.index - a.index);
    const renderRows = rows => h('ul', null, rows.map(agent => {
        const content = agent.kind === 'child' && onOpenSubagent
          ? h(Action, {
            className: 'cx-activity-agent-action', label: `打开子智能体 ${agent.label}`, disabled: agent.disabled,
            onClick: () => onOpenSubagent({ parentSessionId: sessionId, childSessionId: agent.id, mode: agent.mode }),
          }, h('span', { className: 'cx-activity-monogram', 'aria-hidden': true }, '🌸'),
          h('span', {className:'cx-activity-agent-copy'}, h('strong', {className:'cx-activity-agent-name'}, agent.label), h('small', {className:'cx-activity-agent-status','data-tone':statusTone(agent.status)}, agent.statusLabel)))
          : h('div', { className: 'cx-activity-agent-static', 'aria-disabled': agent.disabled || undefined },
            h('span', { className: 'cx-activity-monogram', 'aria-hidden': true }, agent.kind === 'child' ? '🌸' : '?'),
            h('span', {className:'cx-activity-agent-copy'}, h('strong', {className:'cx-activity-agent-name'}, agent.label), h('small', {className:'cx-activity-agent-status','data-tone':statusTone(agent.status)}, [agent.statusLabel, agent.reason].filter(Boolean).join(' · '))));
        return h('li', { key: agent.key, 'data-status': agent.status }, content);
      }));
    return h(Disclosure, { className: 'cx-activity-group cx-activity-subagents', label: h(GroupLabel,{icon:'agent',title:'子任务',count:subagents.length,detail:running ? `${running} 个进行中` : undefined}), open: true },
      renderRows(recent.slice(0, 3)),
      recent.length > 3 ? h(Disclosure, { label: `查看其余 ${recent.length - 3} 个子任务`, className: 'cx-activity-agent-history' }, renderRows(recent.slice(3))) : null);
  }

  function ComputerUseGroup({ records, renderComputerPreview }) {
    if (!records.length) return null;
    const recent = [...records].reverse();
    const renderRows = items => h('ul', null, items.map(record => {
        const actions = record.streamActions;
        const canToggle = actions && typeof actions.show === 'function' && typeof actions.hide === 'function';
        return h('li', { key: record.key, className:'cx-activity-computer-row' }, h('div', null, h('strong', null, record.surfaceLabel), h('small', null, labelStatus(record.status))),
          record.previewAttachment && renderComputerPreview ? renderComputerPreview(record) : null,
          canToggle ? h(Action, { className: 'cx-activity-inline-action', label: actions.visible ? '隐藏电脑画面' : '显示电脑画面', onClick: () => actions.visible ? actions.hide() : actions.show() }, actions.visible ? '隐藏画面' : '显示画面') : null);
      }));
    return h(Disclosure, { className: 'cx-activity-group', label: h(GroupLabel,{icon:'computer',title:'电脑使用',count:records.length}), open: true },
      renderRows(recent.slice(0,3)),
      recent.length > 3 && h(Disclosure, {className:'cx-activity-computer-history',label:`查看其余 ${recent.length - 3} 次操作`}, renderRows(recent.slice(3))));
  }

  function SourceLink({ source, onOpenExternal }) {
    const onClick = onOpenExternal ? event => { event.preventDefault(); onOpenExternal(source.url); } : undefined;
    return h('li', { className: 'cx-activity-source', key: source.key }, glyph('source'), h('div', null,
      h('a', { href: source.url, target: '_blank', rel: 'noopener noreferrer', onClick }, source.title ?? source.domain),
      h('small', null, `${source.domain}${source.publishedAt ? ` · ${source.publishedAt}` : ''}${source.statusCode ? ` · HTTP ${source.statusCode}` : ''}`),
      source.snippet && h('p', null, source.snippet), source.truncated && h('small', { className: 'cx-activity-truncated' }, '来源内容由工具截断')));
  }

  function SourceGroup({ sources, onOpenExternal, onOpenFile, onOpenSession }) {
    if (!sources.loadedCount) return null;
    return h(Disclosure, { className: 'cx-activity-group cx-activity-sources', label: h(GroupLabel,{icon:'source',title:'参考来源',count:sources.loadedCount}), open: true },
      sources.web.length ? h('section', null, h('h4', null, '网页'), h('ul', null, sources.web.map(source => h(SourceLink, { key: source.key, source, onOpenExternal }))), sources.webTruncated && h('p', { className: 'cx-activity-truncated' }, '来源列表由工具截断')) : null,
      sources.session.length ? h('section', null, h('h4', null, '会话回忆'), h('ul', null, sources.session.map(source => h('li', { key: source.key, className:'cx-activity-session-source' },
        onOpenSession ? h(Action, { className: 'cx-activity-source-action', label: `打开会话回忆 ${source.label}`, onClick: () => onOpenSession(source.sessionId) }, h('strong', null, source.label)) : h('strong', null, source.label),
        h('small', null, `${source.sessionId}${source.capturedThroughSeq !== undefined ? ` · 截取至 #${source.capturedThroughSeq}` : ''}`),
        source.compacted && h('small', null, `已压缩${source.retainedMessages !== undefined ? ` · 保留 ${source.retainedMessages} 条` : ''}`), source.truncated && h('small', null, '已截断'))))) : null,
      sources.workspace.length ? h('section', null, h('h4', null, '工作区证据'), h('ul', null, sources.workspace.map(source => {
        const locations = array(source.locations), multiple = locations.length > 1;
        const title = multiple ? source.path : source.location;
        return h('li', { key: source.key }, h('div', null,
          onOpenFile ? h(Action, { className: 'cx-activity-source-action', label: `打开 ${title}`, onClick: () => onOpenFile(source.path, multiple ? undefined : source.line) }, h('code', null, title)) : h('code', null, title),
          multiple ? h('div', { className: 'cx-activity-source-locations' }, locations.filter(location => location.line).map(location =>
            onOpenFile ? h(Action, { key: location.line, className: 'cx-activity-inline-action', label: `打开 ${source.path}:${location.line}`, onClick: () => onOpenFile(source.path, location.line) }, `第 ${location.line} 行`)
              : h('small', { key: location.line }, `第 ${location.line} 行`))) : null));
      }))) : null);
  }

  function TerminalGroup({ terminals }) {
    if (!terminals.length) return null;
    return h(Disclosure, { className: 'cx-activity-group', label: h(GroupLabel,{icon:'terminal',title:'终端结果',count:terminals.length}) },
      h('ul', null, terminals.map(item => h('li', { key: item.key, className:'cx-activity-terminal-item', 'data-status': item.status }, h('div', null, h('strong', null, item.title), item.cwd && h('small', null, item.cwd), h('small', null, item.signal ? `signal ${item.signal}` : item.exitCode !== undefined ? `exit ${item.exitCode}` : labelStatus(item.status))), h('pre', {tabIndex:0}, item.output)))));
  }

  function EvidenceShelf(props) {
    return h('aside', { className: 'cx-activity-evidence', 'aria-label': '成果与来源' },
      h(OutputGroup, props), props.computerControls, h(ComputerUseGroup, { records: props.computers, renderComputerPreview: props.renderComputerPreview }),
      h(SourceGroup, props), h(TerminalGroup, props),
      !props.outputs.length && !props.sources.loadedCount && !props.computers.length && !props.terminals.length ? h('p',{className:'cx-activity-empty'},'文件、网页来源和浏览器画面会显示在这里。') : null);
  }

  function ReturnToLive({ unseen, onReturn }) {
    return h(Action, { className: 'cx-activity-return', label: unseen ? `返回当前，${unseen} 条新记录` : '返回当前', onClick: onReturn }, glyph('return'), unseen ? `返回当前 · ${unseen}` : '返回当前');
  }

  function ActivityInspector({ model, panelRef, bodyRef, open, selectedTab, onSelectTab, onClose, onScroll, onBrowse, unseen, onReturn, runtime, knownRowKeys, pane, panelEvents, actions = {} }) {
    const titleId = `cx-activity-title-${model.sessionId ?? 'session'}`;
    const tabs = ['timeline', 'evidence'];
    const tabRefs = React.useRef(new Map());
    const railRef = React.useRef(null);
    const plateRef = React.useRef(null);
    const keyboardRef = React.useRef(false);
    const placeIndicator = (instant = false) => {
      const tab = tabRefs.current.get(selectedTab), rail = railRef.current, plate = plateRef.current;
      if (!tab || !rail || !plate || !tab.offsetWidth) return;
      runtime?.indicator?.(plate, { left: tab.offsetLeft, top: tab.offsetTop, width: tab.offsetWidth, height: tab.offsetHeight }, { keyboard: keyboardRef.current, instant });
      keyboardRef.current = false;
    };
    (React.useLayoutEffect ?? React.useEffect)(() => { placeIndicator(); }, [selectedTab, runtime]);
    React.useEffect(() => {
      if (typeof ResizeObserver !== 'function' || !railRef.current) return undefined;
      const observer = new ResizeObserver(() => placeIndicator(true)); observer.observe(railRef.current);
      return () => observer.disconnect();
    }, [runtime]);
    const chooseTab = (tab, keyboard = false) => { keyboardRef.current = keyboard; onSelectTab(tab); if (keyboard) tabRefs.current.get(tab)?.focus?.(); };
    const onTabsKeyDown = event => {
      const position = tabs.indexOf(selectedTab);
      const next = event.key === 'ArrowRight' ? (position + 1) % tabs.length : event.key === 'ArrowLeft' ? (position + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
      if (next === null) return; event.preventDefault(); chooseTab(tabs[next], true);
    };
    return h(pane ? 'dialog' : 'aside', {
      ref: panelRef, id: `cx-activity-panel-${model.sessionId ?? 'session'}`, className: `cx-surface cx-activity-sheet${pane ? ' cx-workbench-panel' : ''}`,
      'data-material': 'regular', 'data-floating': 'true', hidden: false, inert: !pane && !open ? true : undefined,
      'aria-labelledby': titleId, 'data-open': open ? 'true' : 'false',
      ...panelEvents,
    },
      pane ? h('header', {className:'cx-workbench-header'}, h('strong', {id:titleId}, '工作面板'), h(Action, {className:'cx-activity-close',label:'收起工作面板',onClick:onClose,motion:runtime}, glyph('close'))) : h('header', { className: 'cx-activity-header' }, h('div', null, h('h2', { id: titleId }, '工作面板')),
        h(Action, { className: 'cx-activity-close', label: '收起工作面板', onClick: onClose, motion: runtime }, glyph('close'))),
      pane ? h(pane.Tabs, {sessionId:model.sessionId ?? 'session'}) : h('div', { className: 'cx-activity-tabs', role: 'tablist', 'aria-label': '工作面板内容', ref: railRef, onKeyDown: onTabsKeyDown },
        h('span', { className: 'cx-activity-tab-plate', ref: plateRef, 'aria-hidden': true }),
        [['timeline', '进度'], ['evidence', '成果与来源']].map(([id, label]) => h('button', { key: id, ref: node => node ? tabRefs.current.set(id, node) : tabRefs.current.delete(id), type: 'button', role: 'tab', className: 'cx-action cx-activity-tab', 'aria-label': label, 'aria-selected': selectedTab === id, tabIndex: selectedTab === id ? 0 : -1, onClick: event => chooseTab(id, event.detail === 0), ...press(runtime) }, label))),
      h('div', { className: 'cx-activity-scroll', ref: bodyRef, onScroll },
        h('div', { className: 'cx-activity-grid' },
          h('section', { className: 'cx-activity-pane', 'data-pane': 'timeline', 'data-active': selectedTab === 'timeline', 'aria-label':'任务进度' },
            h(NowStrip, {now:model.now,timeline:model.timeline}),
            h(SubagentGroup, { sessionId: model.sessionId, subagents: model.subagents, onOpenSubagent: actions.onOpenSubagent }),
            h(ActivityTimeline, { records: model.timeline, onBrowse, runtime, knownRowKeys }), h(BackgroundLane, { jobs: model.jobs })),
          h('div', { className: 'cx-activity-pane', 'data-pane': 'evidence', 'data-active': selectedTab === 'evidence' },
            h(EvidenceShelf, { ...actions, sessionId: model.sessionId, outputs: model.outputs, computers: model.computers, sources: model.sources, terminals: model.terminals }))),
        unseen > 0 && h(ReturnToLive, { unseen, onReturn })));
  }

  function ActivityLens({ snapshot, sessionId, session, trajectory, flow, pages, subagents, jobs, sessionsState, computer, reducedMotion, onOpenChange, pane, ...actions }) {
    const readModel = () => selectActivityModel(snapshot ?? { sessionId, session, trajectory, flow, pages, subagents, jobs, sessionsState, computer });
    const model = React.useMemo
      ? React.useMemo(readModel, [snapshot, sessionId, session, trajectory, flow, pages, subagents, jobs, sessionsState, computer])
      : readModel();
    const currentSessionId = model.sessionId ?? sessionId ?? 'session';
    const initial = id => ({ sessionId: id, open: false, present: false, tab: 'timeline', follow: true, unseen: 0 });
    const [state, setState] = React.useState(() => initial(currentSessionId));
    const effectiveReducedMotion = useReducedMotionPreference(reducedMotion);
    const localUi = state.sessionId === currentSessionId ? state : initial(currentSessionId);
    const paneState = pane?.usePane(currentSessionId);
    const paneOpen = paneState?.active === 'timeline' || paneState?.active === 'evidence';
    const ui = pane ? {...localUi,open:paneOpen,present:localUi.present || paneOpen,tab:paneOpen ? paneState.active : localUi.tab} : localUi;
    const triggerRef = React.useRef(null), panelRef = React.useRef(null), bodyRef = React.useRef(null);
    const panelEvents = pane?.usePanel({sessionId:currentSessionId,panelRef,triggerRef,present:ui.present,visible:ui.open,onClose:()=>pane.close(currentSessionId,ui.tab)});
    const seenRowsRef = React.useRef({ sessionId: currentSessionId, keys: new Set() });
    if (seenRowsRef.current.sessionId !== currentSessionId) seenRowsRef.current = { sessionId: currentSessionId, keys: new Set() };
    const reducedMotionRef = React.useRef(effectiveReducedMotion); reducedMotionRef.current = effectiveReducedMotion;
    const runtimeRef = React.useRef(null), ownsRuntime = typeof motionSource === 'function';
    const runtime = (() => {
      if (runtimeRef.current) return runtimeRef.current;
      runtimeRef.current = ownsRuntime ? motionSource({ reducedMotion: () => reducedMotionRef.current }) : motionSource?.current ?? motionSource ?? null;
      return runtimeRef.current;
    })();
    const liveOpen = React.useRef(ui.open); liveOpen.current = ui.open;
    const liveSession = React.useRef(currentSessionId); liveSession.current = currentSessionId;
    const priorCount = React.useRef(flattenRecords(model.timeline).length);

    React.useEffect(() => {
      if (!pane || !paneOpen) return;
      setState(value => ({...(value.sessionId === currentSessionId ? value : initial(currentSessionId)),present:true,tab:paneState.active}));
    }, [currentSessionId, paneState?.active]);

    React.useEffect(() => {
      if (state.sessionId === currentSessionId) return undefined;
      runtime?.release?.(panelRef.current); runtime?.release?.(triggerRef.current);
      setState({...initial(currentSessionId),...(pane && paneOpen ? {present:true,tab:paneState.active} : {})}); priorCount.current = flattenRecords(model.timeline).length;
      return undefined;
    }, [currentSessionId]);

    React.useEffect(() => {
      const node = triggerRef.current;
      if (model.visible && node) runtime?.materialize?.(node);
      return () => runtime?.release?.(node);
    }, [currentSessionId, model.visible]);

    (React.useLayoutEffect ?? React.useEffect)(() => {
      if (pane) return undefined;
      const panel = panelRef.current;
      const root = panel?.closest?.('.wSkVaW_root');
      const header = root?.querySelector?.('.wSkVaW_header');
      if (!ui.present || !root || !header) return undefined;
      const align = () => {
        const top = Math.max(0, header.getBoundingClientRect().bottom - root.getBoundingClientRect().top);
        panel.style.setProperty('--cx-inspector-top', `${top}px`);
      };
      align();
      if (typeof ResizeObserver !== 'function') return undefined;
      const observer = new ResizeObserver(align);
      observer.observe(header); observer.observe(root);
      return () => observer.disconnect();
    }, [ui.present, currentSessionId]);

    React.useEffect(() => {
      if (pane) return undefined;
      if (!ui.present || !panelRef.current) return undefined;
      const node = panelRef.current;
      if (ui.open) {
        node.hidden = false; node.inert = false;
        runtime?.animate?.(node, { opacity: '1', transform: 'none' }, { duration: 180, from: { opacity: '0', transform: 'none' } });
      } else {
        node.inert = true;
        const finish = () => {
          if (liveSession.current !== currentSessionId || liveOpen.current) return;
          node.hidden = true; setState(value => value.sessionId === currentSessionId && !value.open ? { ...value, present: false } : value);
        };
        if (runtime?.animate) runtime.animate(node, { opacity: '0', transform: 'none' }, { duration: 140, onFinish: finish });
        else finish();
      }
      return undefined;
    }, [ui.open, ui.present, currentSessionId, runtime]);

    React.useEffect(() => {
      if (pane) return undefined;
      if (!ui.open) return undefined;
      const onKeyDown = event => {
        if (event.key !== 'Escape') return;
        event.preventDefault?.(); event.stopPropagation?.();
        setState(value => value.sessionId === currentSessionId ? { ...value, open: false } : value);
        onOpenChange?.(false); triggerRef.current?.focus?.();
      };
      document.addEventListener('keydown', onKeyDown);
      return () => document.removeEventListener('keydown', onKeyDown);
    }, [ui.open, currentSessionId, onOpenChange]);

    const rowCount = flattenRecords(model.timeline).length;
    (React.useLayoutEffect ?? React.useEffect)(() => {
      const added = Math.max(0, rowCount - priorCount.current); priorCount.current = rowCount;
      if (!ui.open || !added) return;
      if (ui.follow && bodyRef.current) bodyRef.current.scrollTop = 0;
      else setState(value => value.sessionId === currentSessionId ? { ...value, unseen: value.unseen + added } : value);
    }, [rowCount, ui.open, ui.follow, currentSessionId]);

    React.useEffect(() => () => {
      runtime?.release?.(panelRef.current); runtime?.release?.(triggerRef.current);
      if (ownsRuntime) runtime?.dispose?.();
    }, [runtime]);

    if (!model.visible && !pane) return null;
    const toggle = () => {
      const next = pane ? !pane.get(currentSessionId).active : !ui.open;
      if (pane) {
        if (next) pane.open(currentSessionId,ui.tab,triggerRef.current); else pane.close(currentSessionId);
        onOpenChange?.(next); return;
      }
      setState(value => value.sessionId === currentSessionId ? { ...value, open: next, present: next || value.present, unseen: next ? value.unseen : 0 } : value);
      onOpenChange?.(next);
    };
    const openView = (tab, origin) => {
      if (pane) pane.open(currentSessionId,tab,origin);
      else setState(value => value.sessionId === currentSessionId ? {...value,open:true,present:true,tab} : value);
      onOpenChange?.(true);
    };
    const close = () => { if (ui.open) toggle(); if (!pane) triggerRef.current?.focus?.(); };
    const onScroll = event => {
      const node = event.currentTarget;
      const atCurrent = node.scrollTop <= 32;
      if (atCurrent !== ui.follow || (atCurrent && ui.unseen)) setState(value => value.sessionId === currentSessionId ? { ...value, follow: atCurrent, unseen: atCurrent ? 0 : value.unseen } : value);
    };
    const onReturn = event => {
      const node = bodyRef.current; if (node) node.scrollTo?.({ top: 0, behavior: effectiveReducedMotion || event.detail === 0 ? 'auto' : 'smooth' });
      setState(value => value.sessionId === currentSessionId ? { ...value, follow: true, unseen: 0 } : value);
    };
    return h('div', { className: 'cx-activity-lens', 'data-session-id': currentSessionId },
      h(ActivityPinnedSummary, {model,onOpen:openView}),
      h(ActivityUtilityTrigger, { model, open: pane ? Boolean(paneState.active) : ui.open, onToggle: toggle, triggerRef, runtime }),
      ui.present && h(ActivityInspector, {
        pane, panelEvents,
        model, panelRef, bodyRef, open: ui.open, selectedTab: ui.tab, onSelectTab: tab => setState(value => value.sessionId === currentSessionId ? { ...value, tab } : value),
        onClose: close, onScroll, onBrowse: () => setState(value => value.sessionId === currentSessionId ? { ...value, follow: false } : value),
        unseen: ui.unseen, onReturn, runtime, knownRowKeys: seenRowsRef.current.keys, actions,
      }));
  }

  return {
    ActivityLens, ActivityDock: ActivityLens, ActivityUtilityTrigger, ActivityInspector, ActivityPinnedSummary, NowStrip, ActivityTimeline,
    ActivityRow, BackgroundLane, EvidenceShelf, OutputGroup, SubagentGroup, ComputerUseGroup, SourceGroup,
    TerminalGroup, ReturnToLive, selectActivityModel, selectActivitySources, selectActivityOutputs,
    selectConversationActivity, selectSubagentActivity, selectBackgroundActivity, selectComputerActivity,
    selectTerminalEvidence, flattenRecords,
  };
}

const selectorApi = createActivityComponents({ createElement() { return null; } }, {});
export const selectActivityModel = selectorApi.selectActivityModel;
export const selectActivitySources = selectorApi.selectActivitySources;
export const selectActivityOutputs = selectorApi.selectActivityOutputs;
export const selectConversationActivity = selectorApi.selectConversationActivity;
export const selectSubagentActivity = selectorApi.selectSubagentActivity;
export const selectBackgroundActivity = selectorApi.selectBackgroundActivity;
export const selectComputerActivity = selectorApi.selectComputerActivity;
export const selectTerminalEvidence = selectorApi.selectTerminalEvidence;
export const flattenRecords = selectorApi.flattenRecords;
