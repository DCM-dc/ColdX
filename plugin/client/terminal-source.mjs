// Self-contained: the native lazy client serializes this factory with Function#toString.
export function createTerminalComponents(React, activityApi, settingsScope, frost = {}, readTerminal) {
  const h = React.createElement;
  const terminalRecordLimit = 40;
  const terminalOutputLimit = 200_000;
  const terminalTotalLimit = 500_000;
  // Display ordering is anchored at the first observation of a call, independently
  // of whether its native projection or its process stream arrives first.
  const ordering = new Map();
  const nonblank = value => typeof value === 'string' && value.trim() ? value.trim() : undefined;
  const finite = value => Number.isFinite(value) ? value : undefined;
  const array = value => Array.isArray(value) ? value : [];

  function flatten(records) {
    const rows = [];
    const visit = record => { rows.push(record); for (const child of array(record?.children)) visit(child); };
    for (const record of array(records)) visit(record);
    return rows;
  }

  function truncateTerminalOutput(value, limit = 200_000) {
    const text = typeof value === 'string' ? value : '';
    if (!Number.isInteger(limit) || limit < 1 || text.length <= limit) return { text, truncated: false, omitted: 0 };
    return { text: `…\n${text.slice(-limit)}`, truncated: true, omitted: text.length - limit };
  }

  function selectTerminalRecords(input = {}) {
    const select = activityApi?.selectConversationActivity;
    if (typeof select !== 'function') return [];
    let rows = [];
    for (const record of flatten(select(input))) {
      const callView = record?.presentation?.callView;
      const resultView = record?.presentation?.resultView;
      if (callView?.card !== 'terminal' && resultView?.card !== 'terminal') continue;
      const running = record.status === 'running';
      const exitCode = Number.isInteger(resultView?.exitCode) ? resultView.exitCode : undefined;
      const signal = nonblank(resultView?.signal);
      const failed = !running && (record.status === 'failed' || signal !== undefined || (exitCode !== undefined && exitCode !== 0));
      rows.push({
        key: `terminal-panel:${record.callId}`,
        callId: record.callId,
        title: nonblank(resultView?.title) ?? nonblank(callView?.title) ?? '终端命令',
        command: nonblank(callView?.title),
        description: nonblank(callView?.description),
        cwd: nonblank(callView?.cwd),
        output: typeof resultView?.output === 'string' ? resultView.output : undefined,
        exitCode,
        signal,
        status: running ? 'running' : failed ? 'failed' : 'completed',
        startedAt: finite(record.startedAt),
        finishedAt: finite(record.finishedAt),
        sourceSeq: finite(record.sourceSeq),
      });
    }
    const sessionId = input.sessionId ?? input.session?.sessionId;
    const liveRecords = array(input.liveRecords).filter(record => typeof sessionId === 'string'
      && record.sessionId === sessionId && typeof record.callId === 'string' && typeof record.id === 'string');
    const nativeByCall = new Map(rows.map(record => [record.callId, record]));
    const orderByCall = new Map();
    const remember = record => {
      const identity = `${sessionId ?? ''}\u0000${record.callId}`;
      const anchor = ordering.get(identity) ?? { time: finite(record.startedAt) ?? finite(record.sourceSeq) ?? 0 };
      ordering.delete(identity); ordering.set(identity, anchor); orderByCall.set(record.callId, anchor);
      return anchor;
    };
    for (const record of rows) remember(record);
    const liveCalls = new Set(liveRecords.map(record => record.callId));
    rows = rows.filter(record => !liveCalls.has(record.callId));
    for (const live of liveRecords) {
      const native = nativeByCall.get(live.callId);
      const anchor = orderByCall.get(live.callId) ?? remember(live);
      anchor.primaryStreamId ??= live.id;
      const nativeSettled = live.background !== true && native && native.status !== 'running';
      const settled = nativeSettled && native.output;
      rows.push({ ...native, ...live, key: anchor.primaryStreamId === live.id ? `terminal-panel:${live.callId}` : `terminal-stream:${live.id}`, streaming: true,
        title: native?.title ?? live.command ?? '终端命令', command: live.command ?? native?.command,
        output: settled ? native.output : live.output,
        status: nativeSettled && live.status === 'running' ? native.status : live.status,
        // A background tool can finish admission while its native process continues.
        exitCode: live.exitCode ?? (nativeSettled ? native.exitCode : undefined), signal: live.signal ?? (nativeSettled ? native.signal : undefined),
        outputOmitted: settled ? 0 : live.outputOmitted, outputTruncated: settled ? false : live.outputTruncated,
      });
    }
    rows.sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running')
      || orderByCall.get(b.callId).time - orderByCall.get(a.callId).time
      || (a.key === b.key ? 0 : a.key < b.key ? 1 : -1));
    while (ordering.size > 2048) ordering.delete(ordering.keys().next().value);
    const visible = rows.slice(0, terminalRecordLimit);
    let remaining = terminalTotalLimit;
    for (let index = 0; index < visible.length; index += 1) {
      const record = visible[index];
      if (typeof record.output !== 'string') continue;
      const raw = record.output;
      const allowance = Math.min(terminalOutputLimit, remaining);
      let text = raw;
      let omitted = 0;
      if (raw.length > allowance) {
        if (allowance <= 0) text = '';
        else if (allowance <= 2) text = '…'.slice(0, allowance);
        else text = `…\n${raw.slice(-(allowance - 2))}`;
        omitted = raw.length - Math.max(0, allowance - 2);
      }
      record.output = text;
      record.outputTruncated = record.outputTruncated === true || omitted > 0;
      record.outputOmitted = (record.outputOmitted ?? 0) + omitted;
      remaining = Math.max(0, remaining - text.length);
    }
    return visible;
  }

  function useSettingsSnapshot() {
    const fallback = { status: 'unavailable', value: undefined, writable: false };
    if (!settingsScope) return fallback;
    if (typeof React.useSyncExternalStore === 'function') {
      return React.useSyncExternalStore(
        listener => settingsScope.subscribe(listener),
        () => settingsScope.getSnapshot(),
        () => settingsScope.getSnapshot(),
      );
    }
    const [snapshot, setSnapshot] = React.useState(() => settingsScope.getSnapshot());
    React.useEffect(() => settingsScope.subscribe(() => setSnapshot(settingsScope.getSnapshot())), []);
    return snapshot;
  }

  function TerminalSettingsRow() {
    const snapshot = useSettingsSnapshot();
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState('');
    const ready = snapshot?.status === 'ready';
    const enabled = ready && snapshot.value?.showTerminal === true;
    const writable = ready && snapshot.writable === true && !saving;
    const toggle = async () => {
      if (!writable) return;
      setSaving(true); setError('');
      try { await settingsScope.set('showTerminal', !enabled); }
      catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
      finally { setSaving(false); }
    };
    const state = saving ? '保存中' : snapshot?.status === 'loading' ? '正在读取' : snapshot?.status === 'unavailable' ? '当前不可用' : snapshot?.writable === false ? '只读' : enabled ? '已开启' : '已关闭';
    return h('div', { className: 'cx-terminal-settings' },
      h('div', { className: 'cx-terminal-settings-copy' },
        h('span', { className: 'cx-terminal-settings-title' }, '终端面板'),
        h('span', { className: 'cx-terminal-settings-description' }, '在输入框上方查看当前会话命令的实时输出、退出码，可收起。')),
      h('div', { className: 'cx-terminal-settings-action' },
        h('span', { className: 'cx-terminal-settings-state', 'aria-live': 'polite' }, state),
        h('button', {
          type: 'button', className: 'cx-terminal-switch', role: 'switch', 'aria-label': '显示终端面板',
          'aria-checked': enabled, disabled: !writable, 'data-on': enabled ? 'true' : 'false', onClick: toggle,
          ...(frost.pressHandlers?.() ?? {}),
        }, h('span', { className: 'cx-terminal-switch-thumb', 'aria-hidden': true }))),
      error && h('p', { className: 'cx-terminal-settings-error', role: 'alert' }, `保存失败：${error}`));
  }

  function TerminalRecord({ record }) {
    const bounded = record.output === undefined ? undefined : truncateTerminalOutput(record.output);
    const omitted = (record.outputOmitted ?? 0) + (bounded?.omitted ?? 0);
    const truncated = record.outputTruncated === true || bounded?.truncated === true;
    const state = record.status === 'running' ? record.stopping ? '正在停止' : '运行中' : record.status === 'cancelled' ? '已停止' : record.status === 'failed' ? '失败' : '完成';
    return h('article', { className: 'cx-terminal-record', 'data-status': record.status },
      h('header', { className: 'cx-terminal-record-header' },
        h('span', { className: 'cx-terminal-status-dot', 'aria-hidden': true }),
        h('div', { className: 'cx-terminal-command-wrap' },
          h('strong', null, record.command ?? record.title),
          record.cwd && h('span', { className: 'cx-terminal-cwd' }, record.cwd)),
        h('span', { className: 'cx-terminal-record-state' }, state)),
      record.description && h('p', { className: 'cx-terminal-description' }, record.description),
      record.status === 'running' && !bounded?.text
        ? h('div', { className: 'cx-terminal-awaiting' }, record.streaming ? '进程运行中，等待输出…' : '命令运行中，等待可用输出…')
        : h('div', { className: 'cx-terminal-result' },
          truncated && h('div', { className: 'cx-terminal-truncated' }, `输出过长，已显示末尾内容（省略 ${omitted.toLocaleString()} 字符）`),
          record.outputLossy && h('div', { className: 'cx-terminal-truncated' }, '原生缓冲已截断更早的输出，当前显示可读取的内容。'),
          record.outputUnavailable && h('div', { className: 'cx-terminal-truncated' }, '部分实时输出暂时不可读取。'),
          h('pre', { className: 'cx-terminal-output', tabIndex: 0 }, bounded?.text || (truncated ? '（较早输出已从面板中省略）' : '（命令没有返回文本输出）')),
          record.status !== 'running' && h('footer', { className: 'cx-terminal-exit' },
            record.exitCode !== undefined && h('span', null, `exit ${record.exitCode}`),
            record.signal && h('span', null, record.signal))));
  }

  function SessionTerminal({ sessionId, useSession, session: suppliedSession }) {
    const snapshot = useSettingsSnapshot();
    const session = typeof useSession === 'function' ? useSession(value => value) : suppliedSession;
    const resolvedSessionId = sessionId ?? session?.sessionId ?? 'session';
    const enabled = snapshot?.status === 'ready' && snapshot.value?.showTerminal === true;
    const [live, setLive] = React.useState(() => ({ sessionId: resolvedSessionId, records: [], error: '' }));
    React.useEffect(() => {
      const controller = new AbortController();
      if (!enabled || typeof readTerminal !== 'function') return () => controller.abort();
      setLive({ sessionId: resolvedSessionId, records: [], error: '' });
      let revision = -1;
      const delay = ms => new Promise(resolve => {
        const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, ms); controller.signal.addEventListener('abort', done, { once: true });
      });
      (async () => {
        while (!controller.signal.aborted) {
          try {
            const result = await readTerminal(resolvedSessionId, { afterRevision: revision, waitMs: 20_000 }, controller.signal);
            if (controller.signal.aborted) break;
            if (!Number.isSafeInteger(result?.revision) || !Array.isArray(result?.records)) throw new Error('Invalid terminal snapshot');
            revision = result.revision;
            setLive({ sessionId: resolvedSessionId, records: result.records, error: '' });
            // Coalesce busy parallel processes rather than repaint once per chunk.
            await delay(100);
          } catch {
            if (controller.signal.aborted) break;
            setLive(value => ({ ...value, error: '实时连接暂不可用，已完成的命令结果仍可查看。' }));
            await delay(2000);
          }
        }
      })();
      return () => controller.abort();
    }, [resolvedSessionId, enabled]);
    const liveRecords = live.sessionId === resolvedSessionId ? live.records : [];
    const records = React.useMemo
      ? React.useMemo(() => selectTerminalRecords({ session, sessionId: resolvedSessionId, liveRecords }), [session, resolvedSessionId, liveRecords])
      : selectTerminalRecords({ session, sessionId: resolvedSessionId, liveRecords });
    const [view, setView] = React.useState(() => ({ sessionId: resolvedSessionId, collapsed: false }));
    const current = view.sessionId === resolvedSessionId ? view : { sessionId: resolvedSessionId, collapsed: false };
    const bodyRef = React.useRef(null);
    React.useEffect(() => {
      if (view.sessionId !== resolvedSessionId) setView({ sessionId: resolvedSessionId, collapsed: false });
    }, [resolvedSessionId]);
    const first = records[0];
    React.useEffect(() => {
      if (!current.collapsed && bodyRef.current) bodyRef.current.scrollTop = 0;
    }, [resolvedSessionId, current.collapsed, first?.key]);
    if (!enabled) return null;
    return h('section', { className: 'cx-surface cx-terminal-panel', 'data-material': 'regular', 'data-collapsed': current.collapsed ? 'true' : 'false', 'aria-label': '当前会话终端' },
      h('header', { className: 'cx-terminal-panel-header' },
        h('div', null, h('h2', null, '终端'), h('p', null, '当前会话 · 原生命令输出')),
        h('button', {
          type: 'button', className: 'cx-terminal-collapse', 'aria-label': current.collapsed ? '展开终端' : '收起终端',
          'aria-expanded': !current.collapsed,
          onClick: () => setView(value => ({ sessionId: resolvedSessionId, collapsed: !(value.sessionId === resolvedSessionId && value.collapsed) })),
          ...(frost.pressHandlers?.() ?? {}),
        }, current.collapsed ? '⌃' : '⌄')),
      !current.collapsed && h('div', { className: 'cx-terminal-scroll', ref: bodyRef },
        live.sessionId === resolvedSessionId && live.error && h('p', { className: 'cx-terminal-connection', role: 'status' }, live.error),
        records.length ? records.map(record => h(TerminalRecord, { key: record.key, record }))
          : h('div', { className: 'cx-terminal-empty' }, h('strong', null, '等待终端命令'), h('span', null, 'AI 执行 shell、Python 或编译命令时，输出将在这里出现。'))));
  }

  return { TerminalSettingsRow, SessionTerminal, TerminalRecord, selectTerminalRecords, truncateTerminalOutput };
}

const selectorApi = createTerminalComponents({ createElement() { return null; } }, { selectConversationActivity: () => [] }, null, {});
export const truncateTerminalOutput = selectorApi.truncateTerminalOutput;
export function selectTerminalRecords(input, selectConversationActivity) {
  return createTerminalComponents({ createElement() { return null; } }, { selectConversationActivity }, null, {}).selectTerminalRecords(input);
}
