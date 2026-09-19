// Self-contained factory: build.mjs serializes it into the native DSH client.
export function createWorkspaceShell(React) {
  const h = React.createElement;
  const number = value => Number.isFinite(value) && value >= 0 ? new Intl.NumberFormat('zh-CN').format(value) : '—';
  const duration = value => Number.isFinite(value) && value >= 0 ? `${number(Math.round(value))} ms` : '—';

  function Home() {
    return h('div', { className: 'cx-workspace-home' },
      h('h1', null, '今天想完成什么？'),
      h('p', null, '描述任务，或从左侧继续已有工作。'));
  }

  function KernelStatus({ snapshot, loading = false, error, onOpenChange } = {}) {
    const scheduler = snapshot?.scheduler;
    const session = snapshot?.session;
    const last = session?.last;
    const state = last?.state;
    const stateLabel = { queued: '排队中', running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消' }[state] ?? '暂无请求';
    const hasData = snapshot?.version === 1 && Boolean(session);
    const rows = hasData ? [
      ['请求', number(session.requestCount)],
      ['完成 / 失败 / 取消', `${number(session.completed)} / ${number(session.failed)} / ${number(session.cancelled)}`],
      ['全局运行 / 等待', `${number(scheduler?.active)} / ${number(scheduler?.queued)}`],
      ['最近请求', stateLabel],
      ...(last ? [
        ['等待 / 首段 / 总耗时', `${duration(state === 'queued' ? null : last.queueMs)} / ${duration(last.firstChunkMs)} / ${duration(['queued','running'].includes(state) ? null : last.durationMs)}`],
        [last.context?.complete === false ? '上下文字符（部分）' : '上下文字符', number(last.context?.totalChars)],
        ['工具调用', number(session.toolCount)],
        ...(last.usage ? [['提供方输入 / 输出 token', `${number(last.usage.inputTokens)} / ${number(last.usage.outputTokens)}`]] : []),
      ] : []),
    ] : [];
    const content = error ? h('p', { className: 'cx-kernel-status-error', role: 'alert' }, String(error?.message ?? error))
      : loading && !hasData ? h('p', { role: 'status' }, '正在读取运行状态…')
        : !hasData ? h('p', null, '本任务暂无运行数据。')
          : h(React.Fragment, null,
            h('p', { className: 'cx-kernel-status-description' }, '本任务实际请求与字符统计'),
            h('dl', null, ...rows.map(([label, value]) => h('div', { key: label }, h('dt', null, label), h('dd', null, value)))));
    return h('details', { className: 'cx-kernel-status', onToggle: event => onOpenChange?.(event.currentTarget.open), onKeyDown: event => {
      if (event.key !== 'Escape' || !event.currentTarget.open) return;
      event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false;
      event.currentTarget.querySelector('summary')?.focus();
    }, onBlur: event => {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
    } },
      h('summary', null,
        h('span', { className: 'cx-kernel-status-dot', 'aria-hidden': true }),
        h('span', null, '运行详情')),
      h('div', { className: 'cx-kernel-status-body' }, content));
  }

  return { Home, KernelStatus };
}
